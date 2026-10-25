// ============================================================
// テスト（エディタの「実行」から選んで使う）
//
// nlCheckSetup:  APIキー・BigQuery・Claude の接続を1回ずつ確認する
// nlRunTestset:  テストセット（tests/nl_search/testset.json）全問を Claude に通して採点する
// 採点（nlScoreCase_ / nlScoreReport_）は手元の tests/nl_search/run_local.js でも同じものを使う。
// ============================================================

function nlCheckSetup() {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('ANTHROPIC_API_KEY');
  Logger.log('ANTHROPIC_API_KEY: ' + (key ? '設定済み（' + key.trim().length + '文字）' : '未設定'));
  Logger.log('モデル: ' + (props.getProperty('CLAUDE_MODEL') || NL_CONFIG.CLAUDE_MODEL_DEFAULT));

  CacheService.getScriptCache().remove(NL_CONFIG.MASTER_CACHE_KEY);
  const masters = nlGetMasters_();
  Logger.log('BigQuery: 工場 ' + masters.factory.length + '件 / 製品 ' + masters.product.length + '件 / 顧客 ' + masters.customer.length + '件');

  const today = nlToday_();
  const llm = nlConvertQuestion_('先月の原価を工場別に', today);
  Logger.log('Claude: ' + JSON.stringify(llm));
  const resolved = nlResolve_(llm, '先月の原価を工場別に', today, masters);
  const q = nlBuildQuery_(resolved.condition, resolved.period);
  Logger.log('SQL:\n' + nlSqlForDisplay_(q));
  Logger.log('見積もり: ' + nlRunQuery_(q, true).bytes + ' bytes');
}

// 5問ずつ並列に Claude を呼ぶ。今日の日付はテストセットの today に固定する
function nlRunTestset() {
  const today = NL_TESTSET.today;
  const masters = nlGetMasters_();
  const cases = NL_TESTSET.cases;
  const results = [];
  for (let i = 0; i < cases.length; i += 5) {
    const batch = cases.slice(i, i + 5);
    const responses = UrlFetchApp.fetchAll(batch.map(function(c) { return nlClaudeRequest_(c.question, today); }));
    batch.forEach(function(c, j) {
      try {
        results.push(nlScoreCase_(c, nlParseClaudeResponse_(responses[j]), masters, today));
      } catch (e) {
        results.push({ id: c.id, question: c.question, scored: c.status !== 'unsupported', status_ok: false, elements: {}, defaults_ok: false, detail: [e.message] });
      }
    });
  }
  Logger.log(nlScoreReport_(results));
}


// ============================================================
// 採点（純粋な処理）
// ============================================================

const NL_SCORE_ELEMENTS = ['metric', 'group_by', 'period', 'filters', 'compare'];

function nlScoreCase_(testCase, llm, masters, today) {
  const exp = testCase.expected;
  const res = nlResolve_(llm, testCase.question, today, masters);
  const r = {
    id: testCase.id, question: testCase.question, scored: testCase.status !== 'unsupported',
    status_ok: res.status === testCase.status, elements: {}, defaults_ok: true, detail: []
  };
  if (!r.status_ok) r.detail.push('status: ' + res.status + '（期待 ' + testCase.status + '）');

  if (testCase.status !== 'unsupported') {
    const c = res.condition || { metric: null, group_by: [], period: null, filters: [], compare: null, order: null, limit: null };
    const sameSet = function(a, b) { return a.length === b.length && a.every(function(v) { return b.indexOf(v) >= 0; }); };
    const filterKeys = function(list) { return list.map(function(f) { return f.dim + ':' + f.value; }); };
    // 期間はトークンの書き方ではなく、展開した月の範囲で比べる（「9月」→ month(9) と last_month は同じ）
    const months = function(token) {
      if (!token) return null;
      const p = nlParsePeriod_(token, today);
      return p.start + '〜' + p.end;
    };
    const got = {
      metric: c.metric,
      group_by: c.group_by,
      period: months(c.period),
      filters: filterKeys(c.filters),
      compare: c.compare || null
    };
    const want = {
      metric: exp.metric,
      group_by: exp.group_by,
      period: months(exp.period),
      filters: filterKeys(exp.filters),
      compare: exp.compare || null
    };
    NL_SCORE_ELEMENTS.forEach(function(el) {
      const ok = Array.isArray(want[el]) ? sameSet(got[el], want[el]) : got[el] === want[el];
      r.elements[el] = ok;
      if (!ok) r.detail.push(el + ': ' + JSON.stringify(got[el]) + '（期待 ' + JSON.stringify(want[el]) + '）');
    });
    if (exp.order && JSON.stringify([c.order, c.limit]) !== JSON.stringify([exp.order, exp.limit])) {
      r.detail.push('order/limit: ' + JSON.stringify([c.order, c.limit]) + '（期待 ' + JSON.stringify([exp.order, exp.limit]) + '）※採点外');
    }
    (testCase.default_used || []).forEach(function(term) {
      if (!(res.defaults_used || []).some(function(d) { return d.term === term; })) {
        r.defaults_ok = false;
        r.detail.push('既定の明示なし: 「' + term + '」');
      }
    });
  }
  return r;
}

function nlScoreReport_(results) {
  const scored = results.filter(function(r) { return r.scored; });
  const rate = function(ok, n) { return n ? Math.round(ok / n * 1000) / 10 + '%' : '-'; };
  const lines = ['テストセット採点: ' + results.length + '問'];
  lines.push('status: ' + rate(results.filter(function(r) { return r.status_ok; }).length, results.length));
  NL_SCORE_ELEMENTS.forEach(function(el) {
    const n = scored.length;
    const ok = scored.filter(function(r) { return r.elements[el]; }).length;
    lines.push(el + ': ' + rate(ok, n) + '（' + ok + '/' + n + '）');
  });
  lines.push('既定の明示: ' + rate(results.filter(function(r) { return r.defaults_ok; }).length, results.length));
  const ng = results.filter(function(r) { return r.detail.length > 0; });
  if (ng.length) {
    lines.push('', '不一致:');
    ng.forEach(function(r) { lines.push(r.id + ' ' + r.question + '\n  ' + r.detail.join('\n  ')); });
  }
  return lines.join('\n');
}
