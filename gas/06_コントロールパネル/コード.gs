// ============================================================
// 原価管理 コントロールパネル（GAS Webアプリ）
//
// 毎月の作業（ファイル登録 → 取込 → BigQuery への反映 → 確認 → 分析）を、1つの画面から始める。
// 取込（02）・反映（03）・アラート判定（04）のコードは、反映のときに scripts/build_panel.js が
// ImportApp・AlertApp の中に同梱する（同梱_*.gs。手で編集しない）。
// ファイル登録（01）と自然言語検索（05）は、それぞれの Web アプリを新しいタブで開く。
//
// 権限は2段階:
//   担当者 = 組織内のだれでも。状況の確認、取込、通常の反映、アラートの試し判定ができる。
//   管理者 = このスクリプトの所有者と、スクリプトプロパティ PANEL_ADMINS に書いた人。
//            マスタだけの更新、指定月のやり直し、Chat への送信、保守メニューも使える。
// Web アプリは「所有者として実行」なので、担当者に BigQuery や Drive の権限を渡す必要はない。
// そのかわり、だれが何をしたかを中間シートの「パネル操作ログ」に残す。
//
// 修正の反映: リポジトリ直下で npm run gas:push:panel（手順は gas/README.md）。
// ============================================================

const PANEL_CONFIG = {
  TITLE: '原価管理 コントロールパネル',
  ADMINS_PROPERTY: 'PANEL_ADMINS',
  OP_LOG_SHEET: 'パネル操作ログ',
  LOCK_WAIT_MS: 3000
};


// ============================================================
// 画面
// ============================================================

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle(PANEL_CONFIG.TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 最初に1回呼ぶ。利用者・権限・リンク・アラートの閾値を返す */
function panelInit() {
  const user = currentUser_();
  const id = ENV.SCRIPT_IDS;
  const result = {
    envName: ENV.ENV_NAME,
    user: { email: user.email, isAdmin: user.isAdmin },
    links: {
      fileUpload: ENV.FILE_UPLOAD_URL,
      nlSearch: ENV.NL_SEARCH_URL,
      dashboard: ENV.DASHBOARD_URL
    },
    alert: AlertApp.panelAlertInfo(),
    admin: null
  };
  if (user.isAdmin) {
    const script = function(scriptId) { return scriptId ? 'https://script.google.com/d/' + scriptId + '/edit' : ''; };
    result.admin = {
      editors: [
        { label: '01 ファイル登録', url: script(id.fileUpload) },
        { label: '02-03 取込・整形App', url: script(id.importApp) },
        { label: '04 原価アラート', url: script(id.alert) },
        { label: '05 自然言語検索', url: script(id.nlSearch) },
        { label: '06 コントロールパネル', url: script(id.panel) }
      ],
      data: [
        { label: '取込フォルダ', url: 'https://drive.google.com/drive/folders/' + ENV.INPUT_FOLDER_ID },
        { label: '処理済みフォルダ', url: 'https://drive.google.com/drive/folders/' + ENV.PROCESSED_FOLDER_ID },
        { label: '取込_設定シート', url: 'https://docs.google.com/spreadsheets/d/' + ENV.CONFIG_SPREADSHEET_ID + '/edit' },
        { label: '中間テーブル（stg_*・取込ログ・パネル操作ログ）', url: 'https://docs.google.com/spreadsheets/d/' + ENV.STAGING_SPREADSHEET_ID + '/edit' },
        { label: 'BigQuery', url: 'https://console.cloud.google.com/bigquery?project=' + ENV.PROJECT_ID }
      ],
      admins: adminList_()
    };
  }
  return result;
}


// ============================================================
// 画面から呼ぶ操作（google.script.run）
// 名前が _ で終わらない関数は画面から呼べるので、ここに置くものは権限を必ず確かめる。
// ============================================================

// --- 読むだけ（担当者）---

function panelGetImportStatus() {
  currentUser_();
  return ImportApp.panelImportStatus(20);
}

function panelGetLoadStatus() {
  currentUser_();
  return ImportApp.panelLoadStatus();
}

function panelAlertPreview(yearMonth) {
  currentUser_();
  return AlertApp.panelAlertCheck(yearMonth, false);
}

// --- 書き込む（担当者）---

function panelRunImport() {
  return runOperation_('取込（中間シートの作成）', false, function() {
    const r = ImportApp.panelRunImport();
    return { result: r, summary: r.logs.length + 'ファイル処理・エラー' + r.errors.length + '行' };
  });
}

function panelRunLoad(kind, yearMonth) {
  const ops = {
    all: { label: 'BigQuery へ反映（マスタ更新＋新しい月の追加）', admin: false },
    masters: { label: 'BigQuery へ反映（マスタだけ）', admin: true },
    reload: { label: 'BigQuery へ反映（' + yearMonth + ' のやり直し）', admin: true }
  };
  const op = ops[kind];
  if (!op) throw new Error('不明な操作です: ' + kind);
  let year = null;
  let month = null;
  if (kind === 'reload') {
    const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(yearMonth));
    if (!m) throw new Error('やり直す年月を選んでください。');
    year = Number(m[1]);
    month = Number(m[2]);
  }
  return runOperation_(op.label, op.admin, function() {
    const r = ImportApp.panelLoad(kind, year, month);
    return { result: r, summary: r.ok ? '成功' : '失敗: ' + r.error, failed: !r.ok };
  });
}

// --- 書き込む（管理者）---

function panelAlertSend(yearMonth) {
  return runOperation_('アラートを Chat に送信（' + yearMonth + '）', true, function() {
    const r = AlertApp.panelAlertCheck(yearMonth, true);
    return { result: r, summary: r.status + (r.sent ? '・送信' : '・送信なし') };
  });
}


// ============================================================
// 権限・排他・操作ログ
// ============================================================

function currentUser_() {
  const email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email) {
    throw new Error('利用者のメールアドレスを確認できません。組織の Google アカウントで開いてください。');
  }
  const owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  return { email: email, isAdmin: email === owner || adminList_().indexOf(email) >= 0 };
}

// スクリプトプロパティ PANEL_ADMINS（カンマ・空白・改行区切りのメールアドレス）
function adminList_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PANEL_CONFIG.ADMINS_PROPERTY) || '';
  return raw.split(/[\s,、]+/).map(function(s) { return s.trim().toLowerCase(); }).filter(Boolean);
}

/**
 * 書き込む操作の共通処理: 権限の確認 → 同時実行の防止 → 実行 → 操作ログ。
 * fn は { result, summary, failed } を返す。画面には result を返す。
 */
function runOperation_(label, adminOnly, fn) {
  const user = currentUser_();
  if (adminOnly && !user.isAdmin) throw new Error('この操作は管理者だけが実行できます。');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(PANEL_CONFIG.LOCK_WAIT_MS)) {
    throw new Error('ほかの人が取込・反映を実行中です。終わってから、もう一度押してください。');
  }
  const startedAt = new Date();
  let outcome = null;
  let error = null;
  try {
    outcome = fn();
    return outcome.result;
  } catch (e) {
    error = e;
    throw e;
  } finally {
    lock.releaseLock();
    writeOpLog_(startedAt, user.email, label,
      error ? '失敗' : (outcome && outcome.failed ? '失敗' : '成功'),
      error ? String(error.message || error) : (outcome ? outcome.summary : ''));
  }
}

// 操作ログは中間テーブルのスプレッドシートに残す。書けなくても操作自体は止めない。
function writeOpLog_(startedAt, email, label, status, detail) {
  try {
    const ss = SpreadsheetApp.openById(ENV.STAGING_SPREADSHEET_ID);
    let sheet = ss.getSheetByName(PANEL_CONFIG.OP_LOG_SHEET);
    if (!sheet) {
      sheet = ss.insertSheet(PANEL_CONFIG.OP_LOG_SHEET);
      sheet.appendRow(['日時', '利用者', '操作', '結果', '所要秒', '詳細']);
      sheet.setFrozenRows(1);
    }
    const seconds = Math.round((Date.now() - startedAt.getTime()) / 1000);
    sheet.appendRow([startedAt, email, label, status, seconds, String(detail || '').slice(0, 1000)]);
  } catch (e) {
    console.error('パネル操作ログを書けませんでした: ' + e.message);
  }
}
