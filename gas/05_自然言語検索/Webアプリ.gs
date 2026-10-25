// ============================================================
// Webアプリの入口（画面から google.script.run で呼ばれる関数）
//
// 段階1 nlInterpret: 質問 → Claude → 辞書・カタログで確定 → 候補と見積もりを返す（実行しない）
// 段階2 nlExecute:   画面で確認・選択した条件を検証し直してから、SQL を組み立てて実行する
// どちらも explore.nl_search_log に記録する。
// ============================================================

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('原価 自然言語検索')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// 画面の選択肢（指標・切り口・比較先・工場/製品/顧客の一覧）
function nlGetOptions() {
  return {
    metrics: NL_CATALOG.metrics.map(function(m) {
      return { id: m.metric_id, label: m.label, description: m.description, format: m.format, allowed_group_by: m.allowed_group_by };
    }),
    dimensions: NL_CATALOG.dimensions.map(function(d) { return { dim: d.dim, label: d.label }; }),
    compares: NL_CATALOG.compares.map(function(c) { return { compare: c.compare, label: c.label }; }),
    limits: NL_CATALOG.limits,
    masters: nlGetMasters_(),
    examples: ['先月の原価を工場別に', '第二工場の材料費を前年と比べて', '今期、予算オーバーが大きい上位10製品', '直近12か月のkg当たり原価の推移']
  };
}

function nlInterpret(question) {
  const started = Date.now();
  const q = String(question || '').trim();
  const log = { request_id: Utilities.getUuid(), stage: 'interpret', question: q };
  try {
    if (!q) throw nlFatal_('質問を入力してください');
    if (q.length > NL_CONFIG.QUESTION_MAX_CHARS) throw nlFatal_('質問は' + NL_CONFIG.QUESTION_MAX_CHARS + '文字以内で入力してください');

    const today = nlToday_();
    const llm = nlConvertQuestion_(q, today);
    log.llm_condition = llm;

    const result = nlResolve_(llm, q, today, nlGetMasters_());
    result.request_id = log.request_id;
    if (result.status === 'ok') {
      result.estimated_bytes = nlRunQuery_(nlBuildQuery_(result.condition, result.period), true).bytes;
      log.estimated_bytes = result.estimated_bytes;
    }
    log.resolved_condition = result.condition || null;
    log.status = result.status;
    return result;
  } catch (e) {
    log.status = 'error';
    log.error_message = e.message;
    return { status: 'error', request_id: log.request_id, message: e.message };
  } finally {
    log.elapsed_ms = Date.now() - started;
    nlWriteLog_(log);
  }
}

// choices: 画面で利用者が変えた内容（指標の切り替え・候補の選択など）。ログにだけ使う
function nlExecute(requestId, condition, choices) {
  const started = Date.now();
  const log = { request_id: String(requestId || Utilities.getUuid()), stage: 'execute', user_choices: choices || null };
  try {
    const v = nlValidateCondition_(condition, nlToday_(), nlGetMasters_());
    if (!v.ok) throw nlFatal_('条件が正しくありません: ' + v.errors.join(' / '));
    log.resolved_condition = v.condition;

    const q = nlBuildQuery_(v.condition, v.period);
    const res = nlRunQuery_(q, false);
    log.status = 'ok';
    log.estimated_bytes = res.bytes;
    return nlFormatResult_(v.condition, v.period, q, res);
  } catch (e) {
    log.status = 'error';
    log.error_message = e.message;
    return { status: 'error', message: e.message };
  } finally {
    log.elapsed_ms = Date.now() - started;
    nlWriteLog_(log);
  }
}

// 結果を画面用に整える。数値の列は Number にし、見出しと書式を付ける
function nlFormatResult_(cond, period, q, res) {
  const metric = nlMetric_(cond.metric);
  const numeric = { value: metric.format, compare_value: metric.format, diff: metric.format, rate: 'percent' };
  const labels = {
    value: metric.label,
    compare_value: cond.compare ? nlCompareLabel_(cond.compare) : '',
    diff: '差',
    rate: '増減率'
  };
  NL_CATALOG.dimensions.forEach(function(d) { labels[d.column] = d.dim === 'month' ? '年月' : d.label; });

  return {
    status: 'ok',
    type: nlConditionType_(cond),
    condition: cond,
    period: period,
    compare_period: q.compare_period,
    columns: res.names.map(function(name) {
      return { key: name, label: labels[name] || name, format: numeric[name] || (name === NL_CATALOG.period_column ? 'month' : 'text') };
    }),
    rows: res.rows.map(function(row) {
      return row.map(function(v, i) { return numeric[res.names[i]] && v !== null ? Number(v) : v; });
    }),
    truncated: res.rows.length >= (cond.limit || NL_CATALOG.limits.max_rows),
    bytes: res.bytes,
    sql: nlSqlForDisplay_(q)
  };
}

function nlToday_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

// ログの書き込みに失敗しても、検索そのものは止めない
function nlWriteLog_(log) {
  try {
    let email = '';
    try { email = Session.getActiveUser().getEmail(); } catch (e) { email = ''; }
    const json = function(v) { return v === undefined || v === null ? null : JSON.stringify(v); };
    const res = BigQuery.Tabledata.insertAll({
      rows: [{
        insertId: log.request_id + ':' + log.stage + ':' + Date.now(),
        json: {
          logged_at: new Date().toISOString(),
          request_id: log.request_id,
          stage: log.stage,
          user_email: email,
          question: log.question || null,
          llm_condition: json(log.llm_condition),
          resolved_condition: json(log.resolved_condition),
          user_choices: json(log.user_choices),
          status: log.status || null,
          error_message: log.error_message || null,
          estimated_bytes: log.estimated_bytes === undefined ? null : log.estimated_bytes,
          elapsed_ms: log.elapsed_ms
        }
      }]
    }, NL_CONFIG.PROJECT_ID, NL_CONFIG.LOG_TABLE.datasetId, NL_CONFIG.LOG_TABLE.tableId);
    if (res.insertErrors) console.warn('検索ログを書き込めませんでした: ' + JSON.stringify(res.insertErrors));
  } catch (e) {
    console.warn('検索ログを書き込めませんでした: ' + e.message);
  }
}
