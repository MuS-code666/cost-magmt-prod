/**
 * ============================================================
 * 中間シート → BigQuery 差分ロード
 *
 * 利用者が実行する関数は4つだけ：
 *   1) loadMastersToBigQuery()
 *      マスタ9表を全件洗い替え
 *
 *   2) loadNewHistoryMonths()
 *      中間シートに存在し、BigQueryに未登録の月だけ追加
 *
 *   3) reloadSpecifiedHistoryMonth()
 *      「設定」シートで指定した1か月だけ洗い替え
 *
 *   4) loadAllToBigQuery()
 *      マスタ更新 → 新規ヒストリー月追加
 *
 * 前提：BigQuery Advanced Service を有効化済みであること。
 * ============================================================
 */

const APP_CONFIG = {
  // スタンドアロンGASでも対象スプレッドシートを確実に開けるよう、
  // ここだけは実際のSpreadsheet IDへ置き換える。
  spreadsheetId: '1AYlS1SWV_Ci1Vxl-yQWAel8uiL40LkZBvhWo7HLOgiA',
  settingsSheetName: '設定'
};


// ============================================================
// 利用者向け実行関数
// ============================================================

/** マスタ9表を全件洗い替え */
function loadMastersToBigQuery() {
  const ctx = getContext_();
  const specs = getMasterSpecs_();

  // 全シートを先に検証してから書き込む。
  const prepared = specs.map(function(spec) {
    return prepareMasterTable_(ctx.ss, spec);
  });

  prepared.forEach(function(item) {
    loadCsvToWholeTable_(
      ctx.cfg,
      ctx.cfg.masterDataset,
      item.spec.tableId,
      item.rows
    );

    console.log(
      '[MASTER] ' + item.spec.tableId +
      ' : ' + (item.rows.length - 1) + '件 ロード完了'
    );
  });

  console.log('マスタ9表の更新が正常終了しました。');
}


/** BigQueryに存在しない月だけヒストリー6表へ追加 */
function loadNewHistoryMonths() {
  const ctx = getContext_();
  const specs = getHistorySpecs_();

  // 先に全シートを読んで検証する。
  const prepared = specs.map(function(spec) {
    return prepareHistoryTable_(ctx.ss, spec);
  });

  prepared.forEach(function(item) {
    const existingMonths = getExistingMonths_(
      ctx.cfg,
      item.spec.tableId
    );

    const sourceMonths = Object.keys(item.rowsByMonth).sort();

    sourceMonths.forEach(function(monthKey) {
      if (existingMonths.has(monthKey)) {
        console.log(
          '[HISTORY] ' + item.spec.tableId + ' ' + monthKey +
          ' : BigQuery登録済みのためスキップ'
        );
        return;
      }

      const rows = [item.spec.columns].concat(item.rowsByMonth[monthKey]);

      loadCsvToMonthlyPartition_(
        ctx.cfg,
        item.spec.tableId,
        monthKey,
        rows
      );

      console.log(
        '[HISTORY] ' + item.spec.tableId + ' ' + monthKey +
        ' : ' + item.rowsByMonth[monthKey].length + '件 新規ロード'
      );
    });
  });

  console.log('新規ヒストリー月の追加が正常終了しました。');
}


/** 設定シートで指定した1か月だけヒストリー6表を洗い替え */
function reloadSpecifiedHistoryMonth() {
  const ctx = getContext_();
  const specs = getHistorySpecs_();

  const year = ctx.cfg.reloadYear;
  const month = ctx.cfg.reloadMonth;
  const monthKey = formatMonthKey_(year, month);

  // 6表すべてに対象月データがあることを先に確認する。
  // 途中まで更新される状態を避けるため、書込み前に全件検証する。
  const prepared = specs.map(function(spec) {
    const item = prepareHistoryTable_(ctx.ss, spec);

    if (!item.rowsByMonth[monthKey] || item.rowsByMonth[monthKey].length === 0) {
      throw new Error(
        '[RELOAD] ' + spec.sheetName +
        ' に ' + monthKey + ' のデータがありません。'
      );
    }

    return item;
  });

  prepared.forEach(function(item) {
    const rows = [item.spec.columns].concat(item.rowsByMonth[monthKey]);

    loadCsvToMonthlyPartition_(
      ctx.cfg,
      item.spec.tableId,
      monthKey,
      rows
    );

    console.log(
      '[RELOAD] ' + item.spec.tableId + ' ' + monthKey +
      ' : ' + item.rowsByMonth[monthKey].length + '件 洗い替え完了'
    );
  });

  console.log('指定月 ' + monthKey + ' の再ロードが正常終了しました。');
}


/** 通常の一括更新：マスタ更新後、新規ヒストリー月だけ追加 */
function loadAllToBigQuery() {
  loadMastersToBigQuery();
  loadNewHistoryMonths();
  console.log('BigQuery更新処理が正常終了しました。');
}


// ============================================================
// テーブル定義
// ============================================================

function getMasterSpecs_() {
  return [
    {
      sheetName: 'mst_products',
      tableId: 'products',
      columns: [
        'product_code', 'product_name', 'customer_code', 'material_code',
        'factory_code', 'standard_productivity_kg_h', 'standard_sales_price',
        'sales_staff_code', 'standard_load_rate'
      ],
      map: mapProduct_
    },
    {
      sheetName: 'mst_customers',
      tableId: 'customers',
      columns: ['customer_code', 'customer_name', 'sales_staff_code'],
      map: mapCustomer_
    },
    {
      sheetName: 'mst_materials',
      tableId: 'materials',
      columns: ['material_code', 'material_name', 'unit_price', 'primary_vendor_code'],
      map: mapMaterial_
    },
    {
      sheetName: 'mst_factories',
      tableId: 'factories',
      columns: ['factory_code', 'factory_name', 'annual_factory_rent'],
      map: mapFactory_
    },
    {
      sheetName: 'mst_machines',
      tableId: 'machines',
      columns: [
        'machine_code', 'machine_name', 'factory_code',
        'rated_power_kw', 'annual_depreciation'
      ],
      map: mapMachine_
    },
    {
      sheetName: 'mst_workers',
      tableId: 'workers',
      columns: ['worker_code', 'worker_name', 'factory_code', 'machine_code'],
      map: mapWorker_
    },
    {
      sheetName: 'mst_sales_staff',
      tableId: 'sales_staff',
      columns: ['sales_staff_code', 'sales_staff_name'],
      map: mapSalesStaff_
    },
    {
      sheetName: 'mst_vendors',
      tableId: 'vendors',
      columns: ['vendor_code', 'vendor_name', 'vendor_type'],
      map: mapVendor_
    },
    {
      sheetName: 'mst_cost_accounts',
      tableId: 'cost_accounts',
      columns: ['cost_account_code', 'cost_account_name', 'allocation_method'],
      map: mapCostAccount_
    }
  ];
}


function getHistorySpecs_() {
  return [
    {
      sheetName: 'stg_sales',
      tableId: 'sales',
      columns: [
        'transaction_id', 'sales_date', 'target_month', 'customer_code',
        'product_code', 'lot_no', 'quantity_kg', 'unit_price', 'sales_amount',
        'sales_staff_code', 'loaded_at'
      ],
      map: mapSales_
    },
    {
      sheetName: 'stg_production',
      tableId: 'production',
      columns: [
        'production_date', 'target_month', 'lot_no', 'factory_code',
        'machine_code', 'worker_code', 'product_code', 'material_code',
        'material_qty_kg', 'production_qty_kg', 'defect_qty_kg',
        'setup_hours', 'production_hours', 'note', 'loaded_at'
      ],
      map: mapProduction_
    },
    {
      sheetName: 'stg_cost',
      tableId: 'costs',
      columns: [
        'cost_id', 'posting_date', 'target_month', 'cost_account_code',
        'factory_code', 'machine_code', 'vendor_code', 'lot_no', 'description',
        'unit_price', 'quantity', 'amount', 'note', 'loaded_at'
      ],
      map: mapCost_
    },
    {
      sheetName: 'stg_monthly_report',
      tableId: 'monthly_reports',
      columns: [
        'target_month', 'factory_code', 'category',
        'sequence_no', 'content', 'loaded_at'
      ],
      map: mapMonthlyReport_
    },
    {
      sheetName: 'stg_sales_budget',
      tableId: 'sales_budgets',
      columns: [
        'target_month', 'cost_account_code', 'customer_code',
        'budget_amount', 'note', 'loaded_at'
      ],
      map: mapSalesBudget_
    },
    {
      sheetName: 'stg_cost_budget',
      tableId: 'cost_budgets',
      columns: [
        'target_month', 'cost_account_code', 'factory_code', 'machine_code',
        'budget_amount', 'note', 'loaded_at'
      ],
      map: mapCostBudget_
    }
  ];
}


// ============================================================
// マスタ：行変換
// ============================================================

function mapProduct_(row, headers) {
  return [
    code_(value_(row, headers, '製品CD')),
    text_(value_(row, headers, '製品名')),
    code_(value_(row, headers, '専売先顧客CD')),
    code_(value_(row, headers, '材料CD')),
    code_(value_(row, headers, '製造工場CD')),
    num_(value_(row, headers, '標準生産能率(kg/h)')),
    num_(value_(row, headers, '標準販売単価(円/kg)')),
    code_(value_(row, headers, '営業担当者CD')),
    num_(value_(row, headers, '標準負荷率'))
  ];
}

function mapCustomer_(row, headers) {
  return [
    code_(value_(row, headers, '顧客CD')),
    text_(value_(row, headers, '顧客名')),
    ''
  ];
}

function mapMaterial_(row, headers) {
  return [
    code_(value_(row, headers, '材料CD')),
    text_(value_(row, headers, '材料名')),
    num_(value_(row, headers, '標準仕入単価(円/kg)')),
    code_(value_(row, headers, '主仕入先CD'))
  ];
}

function mapFactory_(row, headers) {
  return [
    code_(value_(row, headers, '工場CD')),
    text_(value_(row, headers, '工場名')),
    int_(value_(row, headers, '年間工場賃借料'))
  ];
}

function mapMachine_(row, headers) {
  return [
    code_(value_(row, headers, 'マシンCD')),
    text_(value_(row, headers, 'マシン名')),
    code_(value_(row, headers, '工場CD')),
    num_(value_(row, headers, '定格電力(kW)')),
    int_(value_(row, headers, '年間減価償却費'))
  ];
}

function mapWorker_(row, headers) {
  return [
    code_(value_(row, headers, '作業員CD')),
    text_(value_(row, headers, '作業員名')),
    code_(value_(row, headers, '所属工場CD')),
    code_(value_(row, headers, '担当マシンCD'))
  ];
}

function mapSalesStaff_(row, headers) {
  return [
    code_(value_(row, headers, '営業担当者CD')),
    text_(value_(row, headers, '営業担当者名'))
  ];
}

function mapVendor_(row, headers) {
  return [
    code_(value_(row, headers, '支払先CD')),
    text_(value_(row, headers, '支払先名')),
    text_(value_(row, headers, '支払先区分'))
  ];
}

function mapCostAccount_(row, headers) {
  const code = code_(value_(row, headers, '費用科目CD'));
  const name = text_(value_(row, headers, '費用科目'));

  let allocationMethod = 'PRODUCTION_HOURS';
  if (name === '売上高') allocationMethod = 'NONE';
  if (name === '原材料費') allocationMethod = 'DIRECT';

  return [code, name, allocationMethod];
}


// ============================================================
// ヒストリー：行変換
// ============================================================

function mapSales_(row, headers, loadedAt) {
  const salesDate = value_(row, headers, 'sales_date');

  return [
    code_(value_(row, headers, 'transaction_id')),
    dateStr_(salesDate),
    monthStartStr_(salesDate),
    code_(value_(row, headers, 'customer_code')),
    code_(value_(row, headers, 'product_code')),
    code_(value_(row, headers, 'lot_no')),
    num_(value_(row, headers, 'sales_quantity_kg')),
    num_(value_(row, headers, 'unit_price_yen_per_kg')),
    int_(value_(row, headers, 'sales_amount_yen')),
    code_(value_(row, headers, 'sales_rep_code')),
    timestampStr_(loadedAt)
  ];
}

function mapProduction_(row, headers, loadedAt) {
  const productionDate = value_(row, headers, 'production_date');

  return [
    dateStr_(productionDate),
    monthStartStr_(productionDate),
    code_(value_(row, headers, 'lot_no')),
    code_(value_(row, headers, 'factory_code')),
    code_(value_(row, headers, 'machine_code')),
    code_(value_(row, headers, 'worker_code')),
    code_(value_(row, headers, 'product_code')),
    code_(value_(row, headers, 'material_code')),
    num_(value_(row, headers, 'material_quantity_kg')),
    num_(value_(row, headers, 'production_quantity_kg')),
    num_(value_(row, headers, 'defect_quantity_kg')),
    num_(value_(row, headers, 'setup_time_h')),
    num_(value_(row, headers, 'production_time_h')),
    text_(value_(row, headers, 'note')),
    timestampStr_(loadedAt)
  ];
}

function mapCost_(row, headers, loadedAt) {
  const postingDate = value_(row, headers, 'posting_date');

  return [
    code_(value_(row, headers, 'cost_id')),
    dateStr_(postingDate),
    monthStartStr_(postingDate),
    code_(value_(row, headers, 'cost_item_code')),
    code_(value_(row, headers, 'department_code')),
    code_(value_(row, headers, 'machine_code')),
    code_(value_(row, headers, 'supplier_code')),
    code_(value_(row, headers, 'lot_no')),
    text_(value_(row, headers, 'description_or_material_name')),
    num_(value_(row, headers, 'unit_price_yen')),
    num_(value_(row, headers, 'quantity')),
    int_(value_(row, headers, 'cost_amount_yen')),
    text_(value_(row, headers, 'detail_note')),
    timestampStr_(loadedAt)
  ];
}

function mapMonthlyReport_(row, headers, loadedAt) {
  return [
    monthStartStr_(value_(row, headers, 'report_month')),
    code_(value_(row, headers, 'factory_code')),
    text_(value_(row, headers, 'report_category')),
    int_(value_(row, headers, 'sequence_no')),
    text_(value_(row, headers, 'report_text')),
    timestampStr_(loadedAt)
  ];
}

function mapSalesBudget_(row, headers, loadedAt) {
  return [
    monthStartStr_(value_(row, headers, '年月')),
    code_(value_(row, headers, '科目CD')),
    code_(value_(row, headers, '顧客CD')),
    int_(value_(row, headers, '予算額')),
    text_(value_(row, headers, '備考')),
    timestampStr_(loadedAt)
  ];
}

function mapCostBudget_(row, headers, loadedAt) {
  return [
    monthStartStr_(value_(row, headers, '年月')),
    code_(value_(row, headers, '科目CD')),
    code_(value_(row, headers, '部門CD')),
    code_(value_(row, headers, 'マシンCD')),
    int_(value_(row, headers, '予算額')),
    text_(value_(row, headers, '備考')),
    timestampStr_(loadedAt)
  ];
}


// ============================================================
// 読込・検証
// ============================================================

function getContext_() {
  if (!APP_CONFIG.spreadsheetId || APP_CONFIG.spreadsheetId === 'YOUR_SPREADSHEET_ID') {
    throw new Error('APP_CONFIG.spreadsheetId を実際のSpreadsheet IDへ変更してください。');
  }

  const ss = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const cfg = getSettings_(ss);

  return { ss: ss, cfg: cfg };
}


/** 「設定」シートのA列=キー、B列=値を読み込む */
function getSettings_(ss) {
  const sheet = ss.getSheetByName(APP_CONFIG.settingsSheetName);
  if (!sheet) {
    throw new Error('設定シート「' + APP_CONFIG.settingsSheetName + '」が見つかりません。');
  }

  const values = sheet.getDataRange().getValues();
  const map = {};

  values.forEach(function(row) {
    const key = text_(row[0]);
    if (key) map[key] = row[1];
  });

  const projectId = requiredSetting_(map, 'PROJECT_ID');
  const masterDataset = requiredSetting_(map, 'MASTER_DATASET');
  const historyDataset = requiredSetting_(map, 'HISTORY_DATASET');
  const location = requiredSetting_(map, 'LOCATION');

  const reloadYear = Number(requiredSetting_(map, 'RELOAD_YEAR'));
  const reloadMonth = Number(requiredSetting_(map, 'RELOAD_MONTH'));

  if (!Number.isInteger(reloadYear) || reloadYear < 2000 || reloadYear > 2100) {
    throw new Error('RELOAD_YEAR が不正です: ' + map.RELOAD_YEAR);
  }

  if (!Number.isInteger(reloadMonth) || reloadMonth < 1 || reloadMonth > 12) {
    throw new Error('RELOAD_MONTH は1～12で指定してください: ' + map.RELOAD_MONTH);
  }

  return {
    projectId: String(projectId).trim(),
    masterDataset: String(masterDataset).trim(),
    historyDataset: String(historyDataset).trim(),
    location: String(location).trim(),
    reloadYear: reloadYear,
    reloadMonth: reloadMonth
  };
}


function requiredSetting_(map, key) {
  const value = map[key];
  if (value === '' || value === null || value === undefined) {
    throw new Error('設定シートの ' + key + ' が未設定です。');
  }

  if (String(value).indexOf('YOUR_') === 0) {
    throw new Error('設定シートの ' + key + ' を実際の値へ変更してください。');
  }

  return value;
}


function prepareMasterTable_(ss, spec) {
  const sheetData = readSheet_(ss, spec.sheetName);
  const output = [spec.columns];

  for (let i = 1; i < sheetData.values.length; i++) {
    const row = sheetData.values[i];
    if (isBlankRow_(row)) continue;
    output.push(spec.map(row, sheetData.headers));
  }

  if (output.length <= 1) {
    throw new Error('ロード対象データがありません: ' + spec.sheetName);
  }

  return { spec: spec, rows: output };
}


function prepareHistoryTable_(ss, spec) {
  const sheetData = readSheet_(ss, spec.sheetName);
  const loadedAt = new Date();
  const rowsByMonth = {};
  const targetMonthIndex = spec.columns.indexOf('target_month');

  if (targetMonthIndex === -1) {
    throw new Error('内部定義エラー：target_month がありません: ' + spec.tableId);
  }

  for (let i = 1; i < sheetData.values.length; i++) {
    const row = sheetData.values[i];
    if (isBlankRow_(row)) continue;

    const mapped = spec.map(row, sheetData.headers, loadedAt);
    const monthKey = monthKeyFromDateString_(mapped[targetMonthIndex]);

    if (!rowsByMonth[monthKey]) rowsByMonth[monthKey] = [];
    rowsByMonth[monthKey].push(mapped);
  }

  if (Object.keys(rowsByMonth).length === 0) {
    throw new Error('ロード対象データがありません: ' + spec.sheetName);
  }

  return { spec: spec, rowsByMonth: rowsByMonth };
}


function readSheet_(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('シートが見つかりません: ' + sheetName);
  }

  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) {
    throw new Error('ヘッダーまたはデータがありません: ' + sheetName);
  }

  const headers = values[0].map(function(v) {
    return String(v).trim();
  });

  return { values: values, headers: headers };
}


// ============================================================
// BigQuery：既存年月確認
// ============================================================

function getExistingMonths_(cfg, tableId) {
  const query =
    'SELECT DISTINCT FORMAT_DATE(\'%Y-%m\', target_month) AS ym ' +
    'FROM `' + cfg.projectId + '.' + cfg.historyDataset + '.' + tableId + '` ' +
    'WHERE target_month IS NOT NULL ' +
    'ORDER BY ym';

  const rows = runQuery_(cfg, query);
  const months = new Set();

  rows.forEach(function(row) {
    if (row.length > 0 && row[0]) months.add(String(row[0]));
  });

  return months;
}


function runQuery_(cfg, query) {
  const request = {
    query: query,
    useLegacySql: false,
    location: cfg.location
  };

  let result = BigQuery.Jobs.query(request, cfg.projectId);
  const jobId = result.jobReference && result.jobReference.jobId;

  while (!result.jobComplete) {
    Utilities.sleep(500);
    result = BigQuery.Jobs.getQueryResults(
      cfg.projectId,
      jobId,
      { location: cfg.location }
    );
  }

  let apiRows = result.rows || [];

  while (result.pageToken) {
    result = BigQuery.Jobs.getQueryResults(
      cfg.projectId,
      jobId,
      {
        location: cfg.location,
        pageToken: result.pageToken
      }
    );

    apiRows = apiRows.concat(result.rows || []);
  }

  return apiRows.map(function(row) {
    return row.f.map(function(cell) {
      return cell.v;
    });
  });
}


// ============================================================
// BigQuery：ロード
// ============================================================

/** マスタ用：通常テーブル全体を全件洗い替え */
function loadCsvToWholeTable_(cfg, datasetId, tableId, rows) {
  const blob = rowsToCsvBlob_(rows, tableId + '.csv');

  const job = {
    jobReference: {
      projectId: cfg.projectId,
      location: cfg.location
    },
    configuration: {
      load: {
        destinationTable: {
          projectId: cfg.projectId,
          datasetId: datasetId,
          tableId: tableId
        },
        sourceFormat: 'CSV',
        skipLeadingRows: 1,
        writeDisposition: 'WRITE_TRUNCATE',
        createDisposition: 'CREATE_NEVER',
        fieldDelimiter: ',',
        encoding: 'UTF-8',
        allowQuotedNewlines: true
      }
    }
  };

  const result = BigQuery.Jobs.insert(job, cfg.projectId, blob);
  waitForBigQueryJob_(cfg, result.jobReference.jobId);
}


/** ヒストリー用：指定月パーティションだけ洗い替え */
function loadCsvToMonthlyPartition_(cfg, tableId, monthKey, rows) {
  const partitionId = monthKey.replace('-', '');
  const blob = rowsToCsvBlob_(rows, tableId + '_' + partitionId + '.csv');

  const job = {
    jobReference: {
      projectId: cfg.projectId,
      location: cfg.location
    },
    configuration: {
      load: {
        destinationTable: {
          projectId: cfg.projectId,
          datasetId: cfg.historyDataset,
          tableId: tableId + '$' + partitionId
        },
        sourceFormat: 'CSV',
        skipLeadingRows: 1,
        writeDisposition: 'WRITE_TRUNCATE',
        createDisposition: 'CREATE_NEVER',
        fieldDelimiter: ',',
        encoding: 'UTF-8',
        allowQuotedNewlines: true
      }
    }
  };

  const result = BigQuery.Jobs.insert(job, cfg.projectId, blob);
  waitForBigQueryJob_(cfg, result.jobReference.jobId);
}


function rowsToCsvBlob_(rows, fileName) {
  const csvText = rows
    .map(function(row) {
      return row.map(csvEscape_).join(',');
    })
    .join('\n');

  return Utilities.newBlob(
    csvText,
    'application/octet-stream',
    fileName
  );
}


function waitForBigQueryJob_(cfg, jobId) {
  for (let i = 0; i < 60; i++) {
    const job = BigQuery.Jobs.get(
      cfg.projectId,
      jobId,
      { location: cfg.location }
    );

    if (job.status.state === 'DONE') {
      if (job.status.errorResult) {
        throw new Error(
          'BigQueryロード失敗: ' +
          JSON.stringify(job.status.errors || job.status.errorResult)
        );
      }
      return;
    }

    Utilities.sleep(1000);
  }

  throw new Error('BigQueryジョブが時間内に終了しませんでした: ' + jobId);
}


// ============================================================
// 値変換・CSV共通関数
// ============================================================

function value_(row, headers, headerName) {
  const index = headers.indexOf(headerName);
  if (index === -1) {
    throw new Error('列が見つかりません: ' + headerName);
  }
  return row[index];
}


function isBlankRow_(row) {
  return row.every(function(v) {
    return v === '' || v === null || v === undefined;
  });
}


function text_(value) {
  if (value === '' || value === null || value === undefined) return '';
  return String(value).trim();
}


function code_(value) {
  if (value === '' || value === null || value === undefined) return '';
  if (typeof value === 'number') return String(Math.trunc(value));
  return String(value).trim();
}


function num_(value) {
  if (value === '' || value === null || value === undefined) return '';
  const n = Number(value);
  if (isNaN(n)) throw new Error('数値に変換できません: ' + value);
  return String(n);
}


function int_(value) {
  if (value === '' || value === null || value === undefined) return '';
  const n = Number(value);
  if (isNaN(n)) throw new Error('整数に変換できません: ' + value);
  return String(Math.round(n));
}


function dateObj_(value) {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) throw new Error('不正な日付です: ' + value);
    return value;
  }

  const s = String(value).trim();

  // 2024年04月 / 2024年04月24日
  let m = s.match(/^(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?$/);
  if (m) {
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      m[3] ? Number(m[3]) : 1
    );
  }

  // 2024-04 / 2024-04-24 / 2024/04 / 2024/04/24
  m = s.match(/^(\d{4})[-\/](\d{1,2})(?:[-\/](\d{1,2}))?$/);
  if (m) {
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      m[3] ? Number(m[3]) : 1
    );
  }

  const d = new Date(value);
  if (isNaN(d.getTime())) throw new Error('日付に変換できません: ' + value);
  return d;
}


function dateStr_(value) {
  return Utilities.formatDate(
    dateObj_(value),
    'Asia/Tokyo',
    'yyyy-MM-dd'
  );
}


function monthStartStr_(value) {
  const d = dateObj_(value);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  return Utilities.formatDate(first, 'Asia/Tokyo', 'yyyy-MM-dd');
}


function timestampStr_(date) {
  return Utilities.formatDate(
    date,
    'UTC',
    "yyyy-MM-dd'T'HH:mm:ss'Z'"
  );
}


function formatMonthKey_(year, month) {
  return String(year) + '-' + String(month).padStart(2, '0');
}


function monthKeyFromDateString_(dateString) {
  const s = String(dateString).trim();
  const m = s.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) {
    throw new Error('target_month形式が不正です: ' + dateString);
  }
  return m[1] + '-' + m[2];
}


function csvEscape_(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);

  if (
    s.includes(',') ||
    s.includes('"') ||
    s.includes('\n') ||
    s.includes('\r')
  ) {
    return '"' + s.replace(/"/g, '""') + '"';
  }

  return s;
}
