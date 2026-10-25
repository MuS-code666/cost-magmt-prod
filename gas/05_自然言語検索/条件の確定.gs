// ============================================================
// 条件の確定（辞書・期間・用語の衝突・検証）
//
// Claude が返した条件JSONを、辞書とカタログで確定させる。GAS のサービスは使わない
// 純粋な処理だけを置き、手元でも tests/nl_search/run_local.js で検証できるようにする。
// ============================================================

const NL_DIMS = ['factory', 'product', 'customer', 'month'];
const NL_FILTER_DIMS = ['factory', 'product', 'customer'];
const NL_COMPARES = ['prev_year', 'prev_month'];
const NL_ORDER_BY = ['value', 'diff', 'rate'];
const NL_CONDITION_KEYS = ['metric', 'period', 'filters', 'group_by', 'compare', 'order', 'limit'];

function nlMetric_(metricId) {
  return NL_CATALOG.metrics.filter(function(m) { return m.metric_id === metricId; })[0] || null;
}

function nlDimension_(dim) {
  return NL_CATALOG.dimensions.filter(function(d) { return d.dim === dim; })[0] || null;
}

function nlCompareLabel_(compare) {
  const c = NL_CATALOG.compares.filter(function(x) { return x.compare === compare; })[0];
  return c ? c.label : '';
}


// ============================================================
// 段階1: Claude の出力 → 確定した条件と、利用者に見せる候補
// ============================================================

// llm: 条件変換.gs のスキーマに沿った Claude の出力
// masters: { factory: [...], product: [...], customer: [...] }（v_cost にある正式名称）
function nlResolve_(llm, question, today, masters) {
  const limits = NL_CATALOG.limits;
  const metric = nlMetric_(llm.metric);

  if (llm.type === 'unsupported' || !metric) {
    return { status: 'unsupported', unsupported: nlUnsupported_(question, llm.unsupported_reason) };
  }

  const notes = [];

  let period;
  let periodDefaulted = false;
  try {
    period = nlParsePeriod_(llm.period || 'last_month', today);
  } catch (e) {
    period = nlParsePeriod_('last_month', today);
    periodDefaulted = true;
    notes.push('期間「' + llm.period + '」を解釈できなかったため、先月で集計します。');
  }
  if (period.partial) notes.push('当月を含むため、確定前の値（速報）です。');

  const groupBy = nlUnique_(llm.group_by || []).filter(function(d) {
    return metric.allowed_group_by.indexOf(d) >= 0;
  }).slice(0, limits.max_group_by);
  if (llm.type === 'trend' && groupBy.indexOf('month') < 0) {
    if (groupBy.length >= limits.max_group_by) groupBy.pop();
    groupBy.unshift('month');
  }

  let compare = NL_COMPARES.indexOf(llm.compare) >= 0 ? llm.compare : null;
  if (compare && metric.allowed_compare.indexOf(compare) < 0) {
    notes.push(metric.label + 'は' + nlCompareLabel_(compare) + 'との比較に対応していないため、比較なしで集計します。');
    compare = null;
  }

  let order = null;
  let limit = null;
  const wantsRanking = llm.type === 'ranking' || (NL_ORDER_BY.indexOf(llm.order_by) >= 0 && llm.limit > 0);
  if (wantsRanking && groupBy.length > 0) {
    let by = NL_ORDER_BY.indexOf(llm.order_by) >= 0 ? llm.order_by : 'value';
    if (by !== 'value' && !compare) by = 'value';
    order = { by: by, dir: llm.order_dir === 'asc' ? 'asc' : 'desc' };
    limit = llm.limit > 0 ? Math.min(Math.floor(llm.limit), limits.max_ranking_limit) : 10;
  }

  const filters = [];
  const filterChips = [];
  (llm.filters || []).forEach(function(f) {
    if (NL_FILTER_DIMS.indexOf(f.dim) < 0) return;
    const r = nlResolveValue_(f.dim, f.text, masters);
    const value = r.status === 'ok' ? r.value : null;
    if (value !== null && filters.some(function(x) { return x.dim === f.dim && x.value === value; })) return;
    filters.push({ dim: f.dim, value: value });
    filterChips.push({
      dim: f.dim,
      label: nlDimension_(f.dim).label,
      text: f.text,
      value: value,
      via: r.via || null,
      status: r.status,
      candidates: r.candidates || []
    });
  });

  const condition = {
    metric: metric.metric_id,
    period: period.token,
    filters: filters,
    group_by: groupBy,
    compare: compare,
    order: order,
    limit: limit
  };

  if (order && metric.metric_id.indexOf('cost_budget_variance') === 0 && groupBy.indexOf('product') >= 0 &&
      !filters.some(function(f) { return f.dim === 'factory'; })) {
    notes.push('月報・閾値アラートのワーストNは工場内の順位です。この結果は工場をまたいだ全社の順位です。');
  }

  return {
    status: filters.some(function(f) { return f.value === null; }) ? 'needs_choice' : 'ok',
    type: nlConditionType_(condition),
    condition: condition,
    metric_term: llm.metric_term || '',
    defaults_used: nlDefaultsUsed_(question, metric.metric_id),
    period: period,
    period_defaulted: periodDefaulted,
    compare_period: compare ? nlComparePeriod_(period, compare) : null,
    filter_chips: filterChips,
    notes: notes
  };
}

// 型は条件の中身から決める（Claude の type は解釈の手がかりにだけ使う）
function nlConditionType_(c) {
  if (c.order && c.limit) return 'ranking';
  if (c.group_by.indexOf('month') >= 0) return 'trend';
  if (c.group_by.length > 0) return 'breakdown';
  if (c.compare) return 'compare';
  return 'aggregate';
}

function nlUnsupported_(question, reason) {
  const q = nlNormalize_(question);
  const hit = NL_CATALOG.out_of_scope.filter(function(o) {
    return o.terms.some(function(t) { return q.indexOf(nlNormalize_(t)) >= 0; });
  })[0];
  const byReason = {
    cause_analysis: {
      message: '要因の分析は、この画面では扱っていません。「どこが増えたか」なら確認できます。',
      suggest: ['先月の原価を製品別に前年と比べて', '先月の原価を工場別に前年と比べて']
    },
    forecast: {
      message: '予測は扱っていません。原価予算との比較なら確認できます。',
      suggest: ['今期の予算差異を工場別に', '今期の原価予算を工場別に']
    }
  };
  if (hit) return { reason: 'out_of_scope', message: hit.message, suggest: [] };
  if (byReason[reason]) return { reason: reason, message: byReason[reason].message, suggest: byReason[reason].suggest };
  return {
    reason: reason || 'other',
    message: 'この質問には答えられません。原価（総原価・材料費・間接費・予算差異・kg当たり原価）を、期間・工場・製品・顧客で集計できます。',
    suggest: []
  };
}


// ============================================================
// 値の辞書（正規化 → 完全一致 → 別名 → 規則 → あいまい一致）
// あいまい一致は候補を返すだけで、自動では確定しない。
// ============================================================

function nlNormalize_(text) {
  const kanji = { '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9' };
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/株式会社|\(株\)/g, '')
    .replace(/[一二三四五六七八九]/g, function(c) { return kanji[c]; })
    .replace(/\s+/g, '');
}

function nlResolveValue_(dim, text, masters) {
  const names = masters[dim] || [];
  const n = nlNormalize_(text);
  if (!n) return { status: 'not_found', candidates: [] };

  const exact = names.filter(function(name) { return nlNormalize_(name) === n; })[0];
  if (exact) return { status: 'ok', value: exact, via: 'exact' };

  const alias = NL_ALIASES.aliases.filter(function(a) {
    return a.dim === dim && nlNormalize_(a.alias) === n && names.indexOf(a.canonical) >= 0;
  })[0];
  if (alias) return { status: 'ok', value: alias.canonical, via: 'alias' };

  const byPattern = NL_ALIASES.patterns.filter(function(p) { return p.dim === dim; }).map(function(p) {
    const m = n.match(new RegExp(p.regex));
    return m ? p.canonical_template.replace('{2桁}', ('0' + m[1]).slice(-2)) : null;
  }).filter(function(v) { return v && names.indexOf(v) >= 0; })[0];
  if (byPattern) return { status: 'ok', value: byPattern, via: 'pattern' };

  const candidates = names.map(function(name) {
    return { name: name, score: nlSimilarity_(n, nlNormalize_(name)) };
  }).filter(function(s) { return s.score >= 0.2; }).sort(function(a, b) {
    return b.score - a.score || (a.name < b.name ? -1 : 1);
  }).slice(0, 3).map(function(s) { return s.name; });
  return { status: candidates.length ? 'choice' : 'not_found', candidates: candidates };
}

// 2文字ずつの重なり（Dice 係数）。0〜1
function nlSimilarity_(a, b) {
  const grams = function(s) {
    if (s.length < 2) return [s];
    const g = [];
    for (let i = 0; i < s.length - 1; i++) g.push(s.slice(i, i + 2));
    return g;
  };
  const ga = grams(a);
  const gb = grams(b);
  const rest = gb.slice();
  let hit = 0;
  ga.forEach(function(g) {
    const i = rest.indexOf(g);
    if (i >= 0) { hit++; rest.splice(i, 1); }
  });
  return (2 * hit) / (ga.length + gb.length);
}


// ============================================================
// 期間トークン（nl_search/catalog/aliases.json の period_tokens）
// 月は「年×12 + 月−1」の通し番号で計算する。年度は4月始まり。
// ============================================================

function nlParsePeriod_(token, today) {
  const t = String(token || '').replace(/\s+/g, '');
  const cur = nlMonthIndex_(today);
  const fyStartMonth = NL_ALIASES.period_tokens.fiscal_year_start_month;
  const fyStart = function(idx) {
    const y = Math.floor(idx / 12);
    return (idx % 12 + 1 >= fyStartMonth ? y : y - 1) * 12 + fyStartMonth - 1;
  };
  const ym = function(y, m) {
    if (m < 1 || m > 12) throw new Error('月の指定が不正です: ' + token);
    return y * 12 + m - 1;
  };

  let m;
  let start;
  let end;
  let canonical = t;
  if (t === 'this_month') {
    start = end = cur;
  } else if (t === 'last_month') {
    start = end = cur - 1;
  } else if ((m = t.match(/^month\((\d{4})-(\d{1,2})\)$/))) {
    start = end = ym(+m[1], +m[2]);
    canonical = 'month(' + nlMonthString_(start) + ')';
  } else if ((m = t.match(/^month\((\d{1,2})\)$/))) {
    let y = Math.floor(cur / 12);
    if (ym(y, +m[1]) > cur) y--;
    start = end = ym(y, +m[1]);
    canonical = 'month(' + nlMonthString_(start) + ')';
  } else if ((m = t.match(/^last_n_months\((\d{1,2})\)$/))) {
    end = cur - 1;
    start = end - Number(m[1]) + 1;
    canonical = 'last_n_months(' + Number(m[1]) + ')';
  } else if ((m = t.match(/^range\((\d{4})-(\d{1,2}),(\d{4})-(\d{1,2})\)$/))) {
    start = ym(+m[1], +m[2]);
    end = ym(+m[3], +m[4]);
    canonical = start === end ? 'month(' + nlMonthString_(start) + ')'
      : 'range(' + nlMonthString_(start) + ',' + nlMonthString_(end) + ')';
  } else if (t === 'current_fiscal_year') {
    start = fyStart(cur);
    end = Math.max(start, cur - 1);
  } else if (t === 'previous_fiscal_year') {
    start = fyStart(cur) - 12;
    end = start + 11;
    canonical = 'fiscal_year(' + Math.floor(start / 12) + ')';
  } else if ((m = t.match(/^fiscal_year\((\d{4})\)$/))) {
    start = ym(+m[1], fyStartMonth);
    end = start + 11;
  } else if ((m = t.match(/^fiscal_half\((?:(\d{4}),)?(H[12])\)$/i))) {
    const fy = m[1] ? Number(m[1]) : Math.floor(fyStart(cur) / 12);
    const half = m[2].toUpperCase();
    start = ym(fy, fyStartMonth) + (half === 'H2' ? 6 : 0);
    end = start + 5;
    canonical = 'fiscal_half(' + fy + ',' + half + ')';
  } else {
    throw new Error('期間を解釈できません: ' + token);
  }

  if (start > end) throw new Error('期間の開始が終了より後です: ' + token);
  const months = end - start + 1;
  if (months > NL_CATALOG.limits.max_months) {
    throw new Error('期間は' + NL_CATALOG.limits.max_months + 'か月以内にしてください: ' + token);
  }
  return {
    token: canonical,
    start: nlMonthString_(start) + '-01',
    end: nlMonthString_(end) + '-01',
    months: months,
    label: nlRangeLabel_(start, end),
    partial: end >= cur
  };
}

// 比較先の期間。前年同月は12か月前、前月は同じ長さだけ前（3か月なら直前の3か月）
function nlComparePeriod_(period, compare) {
  const shift = compare === 'prev_year' ? 12 : period.months;
  const start = nlMonthIndex_(period.start) - shift;
  const end = nlMonthIndex_(period.end) - shift;
  return {
    compare: compare,
    shift: shift,
    start: nlMonthString_(start) + '-01',
    end: nlMonthString_(end) + '-01',
    label: nlRangeLabel_(start, end)
  };
}

function nlMonthIndex_(dateText) {
  return Number(dateText.slice(0, 4)) * 12 + Number(dateText.slice(5, 7)) - 1;
}

function nlMonthString_(idx) {
  return Math.floor(idx / 12) + '-' + ('0' + (idx % 12 + 1)).slice(-2);
}

function nlRangeLabel_(start, end) {
  const label = function(idx) { return Math.floor(idx / 12) + '年' + (idx % 12 + 1) + '月'; };
  return start === end ? label(start) : label(start) + '〜' + label(end);
}


// ============================================================
// 用語の衝突（nl_search/catalog/metrics.json の conflicts）
// 指標を一意に指す言い方が質問になく、衝突する用語だけで決まった場合に
// 「既定を使った」印を返す。画面では黄色のチップと切り替えボタンにする。
// ============================================================

function nlDefaultsUsed_(question, metricId) {
  const metric = nlMetric_(metricId);
  const terms = NL_CATALOG.conflicts.map(function(c) { return c.term; });
  const q = nlNormalize_(question);
  const explicit = metric.synonyms.some(function(s) {
    return terms.indexOf(s) < 0 && q.indexOf(nlNormalize_(s)) >= 0;
  });
  if (explicit) return [];
  return NL_CATALOG.conflicts.filter(function(c) {
    return q.indexOf(nlNormalize_(c.term)) >= 0 && c.candidates.indexOf(metricId) >= 0;
  }).map(function(c) {
    return {
      term: c.term,
      alternatives: c.candidates.filter(function(id) { return id !== metricId && nlMetric_(id); })
    };
  });
}


// ============================================================
// 段階2: 画面から送られた条件の検証（画面の値は信用しない）
// ============================================================

function nlValidateCondition_(input, today, masters) {
  const errors = [];
  const limits = NL_CATALOG.limits;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['条件がありません'] };

  Object.keys(input).forEach(function(k) {
    if (NL_CONDITION_KEYS.indexOf(k) < 0) errors.push('未知の項目: ' + k);
  });

  const metric = nlMetric_(input.metric);
  if (!metric) errors.push('指標が不正です');

  let period = null;
  try {
    period = nlParsePeriod_(input.period, today);
  } catch (e) {
    errors.push(e.message);
  }

  const groupBy = Array.isArray(input.group_by) ? input.group_by : null;
  if (!groupBy) {
    errors.push('切り口が不正です');
  } else {
    if (groupBy.length > limits.max_group_by) errors.push('切り口は' + limits.max_group_by + 'つまでです');
    if (nlUnique_(groupBy).length !== groupBy.length) errors.push('切り口が重複しています');
    groupBy.forEach(function(d) {
      if (NL_DIMS.indexOf(d) < 0 || (metric && metric.allowed_group_by.indexOf(d) < 0)) errors.push('使えない切り口: ' + d);
    });
  }

  const compare = input.compare === undefined ? null : input.compare;
  if (compare !== null && (NL_COMPARES.indexOf(compare) < 0 || (metric && metric.allowed_compare.indexOf(compare) < 0))) {
    errors.push('比較先が不正です');
  }

  const filters = Array.isArray(input.filters) ? input.filters : null;
  if (!filters) {
    errors.push('絞り込みが不正です');
  } else {
    filters.forEach(function(f) {
      if (!f || typeof f !== 'object' || Object.keys(f).some(function(k) { return k !== 'dim' && k !== 'value'; })) {
        errors.push('絞り込みの形が不正です');
      } else if (NL_FILTER_DIMS.indexOf(f.dim) < 0) {
        errors.push('絞り込みの項目が不正です: ' + f.dim);
      } else if (typeof f.value !== 'string' || (masters[f.dim] || []).indexOf(f.value) < 0) {
        errors.push(nlDimension_(f.dim).label + 'の値が見つかりません: ' + f.value);
      }
    });
  }

  const order = input.order === undefined ? null : input.order;
  const limit = input.limit === undefined ? null : input.limit;
  if (order !== null) {
    if (typeof order !== 'object' || Object.keys(order).some(function(k) { return k !== 'by' && k !== 'dir'; }) ||
        NL_ORDER_BY.indexOf(order.by) < 0 || ['asc', 'desc'].indexOf(order.dir) < 0) {
      errors.push('並び順が不正です');
    } else if (order.by !== 'value' && compare === null) {
      errors.push('差・増減率で並べるには比較先が必要です');
    }
    if (!groupBy || groupBy.length === 0) errors.push('並び順を指定するには切り口が必要です');
    if (limit === null) errors.push('件数がありません');
  }
  if (limit !== null) {
    if (typeof limit !== 'number' || Math.floor(limit) !== limit || limit < 1 || limit > limits.max_ranking_limit) {
      errors.push('件数は1〜' + limits.max_ranking_limit + 'で指定してください');
    }
    if (order === null) errors.push('件数を指定するには並び順が必要です');
  }

  if (errors.length) return { ok: false, errors: errors };
  return {
    ok: true,
    period: period,
    condition: {
      metric: metric.metric_id,
      period: period.token,
      filters: filters.map(function(f) { return { dim: f.dim, value: f.value }; }),
      group_by: groupBy.slice(),
      compare: compare,
      order: order ? { by: order.by, dir: order.dir } : null,
      limit: limit
    }
  };
}

function nlUnique_(list) {
  return list.filter(function(v, i) { return list.indexOf(v) === i; });
}
