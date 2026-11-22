// ============================================================
// コントロールパネル（06）から呼ぶ関数
//
// 06 は反映のとき、このフォルダの .gs をまとめて ImportApp という名前の中に同梱する
// （scripts/build_panel.js）。06 から呼べるのは、ここにある panel で始まる関数だけ。
// エディタから実行する関数（processImportFiles など）はそのまま残し、ここでは包むだけにする。
// 画面に結果を出すため、処理結果を値で返す。日時は画面に渡せる文字列にする。
//
// このファイルの関数のうち、panelImportStatus と panelLoadStatus は読むだけなので、
// 取込・整形App のエディタで動作確認に使ってよい。
// ============================================================

const PANEL_HISTORY_LABELS = {
  sales: '売上',
  production: '生産',
  costs: '原価',
  monthly_reports: '月報',
  sales_budgets: '売上予算',
  cost_budgets: '原価予算'
};


/** 取込フォルダで待っている CSV、直近の取込ログ、直近のエラー行（読むだけ） */
function panelImportStatus(logLimit) {
  validateConfigIds();
  const limit = Number(logLimit) || 20;
  const configMap = loadConfig();

  const pending = getCsvFilesRecursively(DriveApp.getFolderById(CONFIG.INPUT_FOLDER_ID))
    .filter(function(file) { return file.getName().toLowerCase().endsWith('.csv'); })
    .map(function(file) {
      const source = detectSource(file.getName(), configMap);
      return {
        name: file.getName(),
        updated: panelFormatDate_(file.getLastUpdated()),
        source: source ? source.sourceName : '',
        recognized: !!source
      };
    });

  const ss = SpreadsheetApp.openById(CONFIG.OUTPUT_SPREADSHEET_ID);
  return {
    pending: pending,
    logs: panelReadTail_(ss, CONFIG.LOG_SHEET_NAME, limit).map(panelLogRow_),
    errors: panelReadTail_(ss, CONFIG.ERROR_SHEET_NAME, 50).map(panelErrorRow_)
  };
}


/** 取込フォルダの CSV を整形して中間シート（stg_*）に書く（processImportFiles を実行） */
function panelRunImport() {
  // ログの「処理日時」で今回の分を見分ける。時計の誤差を見込んで1秒前から数える。
  const startedAt = new Date(Date.now() - 1000);
  processImportFiles();

  const ss = SpreadsheetApp.openById(CONFIG.OUTPUT_SPREADSHEET_ID);
  const isThisRun = function(row) { return row[0] instanceof Date && row[0] >= startedAt; };
  return {
    logs: panelReadTail_(ss, CONFIG.LOG_SHEET_NAME, 200).filter(isThisRun).map(panelLogRow_),
    errors: panelReadTail_(ss, CONFIG.ERROR_SHEET_NAME, 500).filter(isThisRun).map(panelErrorRow_)
  };
}


/** 履歴6表について、中間シートにある月と BigQuery に入っている月（読むだけ） */
function panelLoadStatus() {
  const ctx = getContext_();
  const specs = getHistorySpecs_();

  // BigQuery 側は1回のクエリでまとめて調べる
  const loaded = {};
  const sql = specs.map(function(spec) {
    return "SELECT '" + spec.tableId + "' AS t, FORMAT_DATE('%Y-%m', target_month) AS ym " +
      'FROM `' + ctx.cfg.projectId + '.' + ctx.cfg.historyDataset + '.' + spec.tableId + '` ' +
      'WHERE target_month IS NOT NULL GROUP BY ym';
  }).join(' UNION ALL ');
  runQuery_(ctx.cfg, sql).forEach(function(row) {
    (loaded[row[0]] = loaded[row[0]] || []).push(String(row[1]));
  });

  const tables = specs.map(function(spec) {
    const item = {
      tableId: spec.tableId,
      label: PANEL_HISTORY_LABELS[spec.tableId] || spec.tableId,
      sheetName: spec.sheetName,
      stagingMonths: [],
      loadedMonths: (loaded[spec.tableId] || []).sort(),
      error: ''
    };
    try {
      item.stagingMonths = Object.keys(prepareHistoryTable_(ctx.ss, spec).rowsByMonth).sort();
    } catch (e) {
      // シートが空のときもここに来る。画面では「中間シートにデータなし／読めない」と出す。
      item.error = getErrorMessage(e);
    }
    return item;
  });

  return { tables: tables };
}


/**
 * BigQuery へ反映する。
 *   kind = 'all'      マスタ全件入れ替え ＋ 未登録の月だけ追加（通常の毎月の反映）
 *   kind = 'masters'  マスタだけ入れ替え
 *   kind = 'reload'   year 年 month 月の履歴だけ入れ替え（訂正したとき）
 * 途中で失敗しても、それまでのメッセージを返す（ok: false）。
 */
function panelLoad(kind, year, month) {
  return panelCaptureLog_(function() {
    if (kind === 'all') loadAllToBigQuery();
    else if (kind === 'masters') loadMastersToBigQuery();
    else if (kind === 'reload') reloadSpecifiedHistoryMonth(Number(year), Number(month));
    else throw new Error('不明な処理です: ' + kind);
  });
}


// ------------------------------------------------------------
// 内部用
// ------------------------------------------------------------

// DataRoad の関数は進み具合を console.log に出すので、それを集めて画面に返す
function panelCaptureLog_(fn) {
  const messages = [];
  const original = console.log;
  console.log = function() {
    messages.push(Array.prototype.map.call(arguments, String).join(' '));
    return original.apply(console, arguments);
  };
  try {
    fn();
    return { ok: true, messages: messages };
  } catch (e) {
    return { ok: false, messages: messages, error: getErrorMessage(e) };
  } finally {
    console.log = original;
  }
}

// シートの末尾 limit 行（見出し行を除く）を、新しいものが先になる順で返す
function panelReadTail_(ss, sheetName, limit) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const count = Math.min(limit, last - 1);
  return sheet.getRange(last - count + 1, 1, count, sheet.getLastColumn()).getValues().reverse();
}

function panelLogRow_(r) {
  return {
    at: panelFormatDate_(r[0]), file: String(r[1]), sourceId: String(r[2]), period: String(r[3]),
    total: Number(r[4]) || 0, success: Number(r[5]) || 0, error: Number(r[6]) || 0,
    status: String(r[7]), message: String(r[8] || '')
  };
}

function panelErrorRow_(r) {
  return {
    at: panelFormatDate_(r[0]), file: String(r[1]), sourceId: String(r[2]), csvRow: String(r[3]),
    field: String(r[4]), raw: String(r[5]).slice(0, 200), message: String(r[6] || '')
  };
}

function panelFormatDate_(value) {
  if (!(value instanceof Date)) return String(value || '');
  return Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
}
