// ============================================================
// 原価 閾値超過アラート（Phase5 Task 5-6）
//
// 毎月5日の朝、前月分の v_variance を確認し、閾値を超えた製品があるときだけ
// Google Chat に1通で通知する。閾値を超えた製品がなければ何も送らない（沈黙）。
//
// 対象の定義（Looker Studio P3ワースト表と共通）:
//   年月×部門内で cost_budget_variance_rank <= RANK_LIMIT かつ 予算超過（OVER_BUDGET）
//   のうち、差異率と差異額がどちらも閾値以上の行。
//
// 事前準備: スクリプトプロパティ CHAT_WEBHOOK_URL に Google Chat の Webhook URL を保存する。
// ============================================================

const ALERT_CONFIG = {
  PROJECT_ID: 'cost-mgmt-prod-507701',
  LOCATION: 'asia-northeast1',
  VIEW: 'mart.v_variance',
  RANK_LIMIT: 10,
  MIN_VARIANCE_PCT: 30,
  MIN_VARIANCE_MAN: 30,
  TRIGGER_DAY: 5,
  TRIGGER_HOUR: 9
};


// ============================================================
// エントリポイント
// ============================================================

// 月次トリガーから呼ばれる。手動実行すると、実行時点の前月分を判定する。
function checkThresholdAlert() {
  const month = previousMonthStart_(new Date());
  try {
    runForMonth_(month, true);
  } catch (e) {
    postToChat_('【原価アラート】' + monthLabel_(month) + '分のアラート処理でエラーが発生しました。\n' + e.message);
    throw e;
  }
}

// 月次トリガーを登録する（毎月 TRIGGER_DAY 日の TRIGGER_HOUR 時台）。何度実行しても1つだけになる。
function setupMonthlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'checkThresholdAlert') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkThresholdAlert')
    .timeBased()
    .onMonthDay(ALERT_CONFIG.TRIGGER_DAY)
    .atHour(ALERT_CONFIG.TRIGGER_HOUR)
    .create();
  Logger.log('毎月' + ALERT_CONFIG.TRIGGER_DAY + '日 ' + ALERT_CONFIG.TRIGGER_HOUR + '時台のトリガーを登録しました');
}


// ============================================================
// テスト用（エディタの「実行」から選んで使う）
// ============================================================

// 送信せず、送るはずのメッセージをログに出す（アラートが出る月）
function testDryRun_2026_08() { runForMonth_('2026-08-01', false); }

// 実際にChatへ送信する（アラートが出る月。通知が届くはず）
function testSend_2026_08() { runForMonth_('2026-08-01', true); }

// 実際にChatへ送信する（閾値超過なしの月。何も届かないはず）
function testSend_2026_06() { runForMonth_('2026-06-01', true); }


// ============================================================
// 判定と通知
// ============================================================

function runForMonth_(month, send) {
  const total = queryRows_(
    "SELECT COUNT(*) AS n FROM `" + ALERT_CONFIG.PROJECT_ID + "." + ALERT_CONFIG.VIEW + "` " +
    "WHERE target_month = DATE '" + month + "'"
  );

  if (Number(total[0].n) === 0) {
    const notice = '【原価アラート】' + monthLabel_(month) + '分のデータが v_variance にありません。' +
      'データ取込が完了しているか確認してください（アラート判定は実行していません）。';
    Logger.log(notice);
    if (send) postToChat_(notice);
    return;
  }

  const rows = queryRows_(buildAlertSql_(month));
  if (rows.length === 0) {
    Logger.log(monthLabel_(month) + '：閾値超過なし（通知しません）');
    return;
  }

  const message = buildMessage_(month, rows);
  Logger.log(message);
  if (send) postToChat_(message);
}

function buildAlertSql_(month) {
  const c = ALERT_CONFIG;
  return (
    "SELECT factory_code, factory_name, cost_budget_variance_rank AS rank, " +
    "product_code, product_name, customer_name, " +
    "ROUND(total_cost / 10000, 1) AS total_cost_man, " +
    "ROUND(budget_cost / 10000, 1) AS budget_cost_man, " +
    "ROUND(cost_budget_variance_amount / 10000, 1) AS variance_man, " +
    "ROUND(cost_budget_variance_rate * 100, 1) AS variance_pct " +
    "FROM `" + c.PROJECT_ID + "." + c.VIEW + "` " +
    "WHERE target_month = DATE '" + month + "' " +
    "AND cost_budget_variance_rank <= " + c.RANK_LIMIT + " " +
    "AND cost_budget_status = 'OVER_BUDGET' " +
    "AND cost_budget_variance_rate * 100 >= " + c.MIN_VARIANCE_PCT + " " +
    "AND cost_budget_variance_amount / 10000 >= " + c.MIN_VARIANCE_MAN + " " +
    "ORDER BY factory_code, cost_budget_variance_rank"
  );
}

function buildMessage_(month, rows) {
  const c = ALERT_CONFIG;
  const lines = [
    '【原価アラート】' + monthLabel_(month),
    '部門内の予算差異ワースト' + c.RANK_LIMIT + 'のうち、差異率' + c.MIN_VARIANCE_PCT + '%以上かつ差異額' +
      c.MIN_VARIANCE_MAN + '万円以上の製品が' + rows.length + '件あります。'
  ];

  let currentFactory = null;
  rows.forEach(function(r) {
    if (r.factory_code !== currentFactory) {
      currentFactory = r.factory_code;
      lines.push('');
      lines.push('■ ' + r.factory_name + '（' + r.factory_code + '）');
    }
    lines.push(
      '・' + r.product_name + '（' + r.customer_name + '）　予算比' + signed_(r.variance_man) + '万円（' +
      signed_(r.variance_pct) + '%）　実績' + r.total_cost_man + '万円／予算' + r.budget_cost_man + '万円　部門内' + r.rank + '位'
    );
  });

  lines.push('');
  lines.push('詳細は原価ダッシュボードのP3（ワースト表）で確認してください。');
  return lines.join('\n');
}

function postToChat_(text) {
  const url = PropertiesService.getScriptProperties().getProperty('CHAT_WEBHOOK_URL');
  if (!url) throw new Error('スクリプトプロパティ CHAT_WEBHOOK_URL が未設定です');

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({ text: text }),
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('Chatへの送信に失敗しました（HTTP ' + response.getResponseCode() + '）');
  }
}


// ============================================================
// ユーティリティ
// ============================================================

function previousMonthStart_(now) {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function monthLabel_(month) {
  return month.slice(0, 4) + '年' + Number(month.slice(5, 7)) + '月';
}

function signed_(value) {
  return Number(value) > 0 ? '+' + value : String(value);
}

// BigQueryを実行し、列名をキーにしたオブジェクトの配列で返す
function queryRows_(query) {
  const c = ALERT_CONFIG;
  let result = BigQuery.Jobs.query({ query: query, useLegacySql: false, location: c.LOCATION }, c.PROJECT_ID);
  const jobId = result.jobReference && result.jobReference.jobId;

  while (!result.jobComplete) {
    Utilities.sleep(500);
    result = BigQuery.Jobs.getQueryResults(c.PROJECT_ID, jobId, { location: c.LOCATION });
  }

  const names = result.schema.fields.map(function(f) { return f.name; });
  let apiRows = result.rows || [];
  while (result.pageToken) {
    result = BigQuery.Jobs.getQueryResults(c.PROJECT_ID, jobId, { location: c.LOCATION, pageToken: result.pageToken });
    apiRows = apiRows.concat(result.rows || []);
  }

  return apiRows.map(function(row) {
    const obj = {};
    row.f.forEach(function(cell, i) { obj[names[i]] = cell.v; });
    return obj;
  });
}
