/**
 * BigQuery取込前処理
 *
 * Google Driveの取込フォルダにあるCSVを読み込み、
 * 「設定シート」の定義に従って整形・検証し、
 * BigQuery投入直前の中間テーブルへ出力します。
 *
 * 主な処理:
 * 1. ソース判定
 * 2. CSV読込
 * 3. ヘッダーマッピング
 * 4. 必須チェック
 * 5. 型正規化
 * 6. 正常行をstg_*へ出力（同一ソース×同一対象期間の既存行は洗い替え）
 * 7. 異常行を取込エラーへ出力
 * 8. 取込ログを記録
 * 9. 処理済みファイルを移動
 *
 * 対象期間の洗い替えについて:
 * ファイル名（{ソース名}_{対象期間}_{登録日時}.csv）から対象期間
 * （月次:YYYYMM／年度:YYYY）を抽出し、stg_*シートの管理列
 * 「_対象期間」で同じ対象期間の既存行を判定・削除してから
 * 新しい正常行を書き込む。これにより、同じ対象期間のファイルを
 * 複数回取込んでも重複データが積み上がらない。
 * 正常行が1件もないファイル（全行エラー等）は、既存データを
 * 誤って消さないよう洗い替えを行わない。
 */

const CONFIG = {
  CONFIG_SPREADSHEET_ID: '1mjxPFb9GcbaG780duU6xfTqX0bo3nse4_8S87w8WFOE',
  INPUT_FOLDER_ID: '1XYdfrXo4qkbhFwzYSBjivOEfzJV1-AEm',
  PROCESSED_FOLDER_ID: '1eulzLW04XIQe6a2r6n_HrGXU1j-OhmDZ',
  OUTPUT_SPREADSHEET_ID: '1AYlS1SWV_Ci1Vxl-yQWAel8uiL40LkZBvhWo7HLOgiA',

  CONFIG_SHEET_NAME: '設定シート',
  ERROR_SHEET_NAME: '取込エラー',
  LOG_SHEET_NAME: '取込ログ',

  LOCK_WAIT_MS: 30000
};

// stg_*シートで、対象期間（洗い替えキー）を保持する管理列
const PERIOD_COLUMN_NAME = '_対象期間';

const CONFIG_HEADERS = [
  'ソースID',
  'ソース名',
  'ファイル判定条件',
  '文字コード',
  '区切り文字',
  'ヘッダー行数',
  '元の列名',
  '統一項目名',
  'データ型',
  '必須列',
  '欠損時処理',
  '変換・補正ルール',
  '備考'
];


/**
 * メイン関数
 * 時間主導型トリガーから実行する関数です。
 */
function processImportFiles() {
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(CONFIG.LOCK_WAIT_MS);
  } catch (e) {
    throw new Error('別の取込処理が実行中です。今回の実行を中止します。');
  }

  try {
    validateConfigIds();

    const configMap = loadConfig();
    const inputFolder = DriveApp.getFolderById(CONFIG.INPUT_FOLDER_ID);
    const processedFolder = DriveApp.getFolderById(CONFIG.PROCESSED_FOLDER_ID);
    const outputSs = SpreadsheetApp.openById(CONFIG.OUTPUT_SPREADSHEET_ID);

    ensureSystemSheets(outputSs);

    // 取込フォルダ直下だけでなく、すべてのサブフォルダを再帰的に探索する
    const files = getCsvFilesRecursively(inputFolder);
    const allErrorRows = [];
    const allLogRows = [];

    for (const file of files) {
      const fileName = file.getName();

      // CSV以外は無視
      if (!fileName.toLowerCase().endsWith('.csv')) {
        continue;
      }

      const processedAt = new Date();

      try {
        const sourceConfig = detectSource(fileName, configMap);

        // 設定シートの判定条件に一致しないCSVは処理対象外
        if (!sourceConfig) {
          allLogRows.push([
            processedAt,
            fileName,
            '',
            '',
            0,
            0,
            0,
            'SKIP',
            'ファイル判定条件に一致しないため処理対象外'
          ]);
          continue;
        }

        const result = processCsvFile(file, sourceConfig, outputSs);

        allErrorRows.push(...result.errorRows);

        const status =
          result.errorCount === 0
            ? 'SUCCESS'
            : result.successCount > 0
              ? 'WARNING'
              : 'ERROR';

        allLogRows.push([
          processedAt,
          fileName,
          sourceConfig.sourceId,
          result.targetPeriod || '',
          result.totalCount,
          result.successCount,
          result.errorCount,
          status,
          result.message
        ]);

        // ファイル処理自体が最後まで完了した場合のみ移動
        moveToProcessedFolder(file, processedFolder);

      } catch (fileError) {
        allLogRows.push([
          processedAt,
          fileName,
          '',
          '',
          0,
          0,
          0,
          'ERROR',
          getErrorMessage(fileError)
        ]);

        // 予期しない例外時はファイルを移動しない
      }
    }

    writeErrorRows(outputSs, allErrorRows);
    writeLog(outputSs, allLogRows);

  } finally {
    lock.releaseLock();
  }
}


/**
 * 設定シートを読み込む。
 *
 * 戻り値:
 * {
 *   SALES: {
 *     sourceId: 'SALES',
 *     sourceName: '売上',
 *     fileRule: 'ファイル名が「売上_」で始まる',
 *     charset: 'UTF-8',
 *     delimiter: ',',
 *     headerRowCount: 1,
 *     fields: [...]
 *   }
 * }
 */
function loadConfig() {
  const ss = SpreadsheetApp.openById(CONFIG.CONFIG_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.CONFIG_SHEET_NAME);

  if (!sheet) {
    throw new Error(`設定シート「${CONFIG.CONFIG_SHEET_NAME}」が見つかりません。`);
  }

  const values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    throw new Error('設定シートに設定データがありません。');
  }

  const headers = values[0].map(v => String(v).trim());
  const col = {};

  headers.forEach((name, index) => {
    col[name] = index;
  });

  CONFIG_HEADERS.forEach(name => {
    if (col[name] === undefined) {
      throw new Error(`設定シートに必須列「${name}」がありません。`);
    }
  });

  const configMap = {};

  for (let r = 1; r < values.length; r++) {
    const row = values[r];

    const sourceId = trimString(row[col['ソースID']]);
    const sourceName = trimString(row[col['ソース名']]);
    const sourceColumn = trimString(row[col['元の列名']]);
    const targetColumn = trimString(row[col['統一項目名']]);

    // 空行は無視
    if (!sourceId && !sourceName && !sourceColumn && !targetColumn) {
      continue;
    }

    if (!sourceId) {
      throw new Error(`設定シート${r + 1}行目: ソースIDが空欄です。`);
    }

    if (!sourceColumn || !targetColumn) {
      throw new Error(
        `設定シート${r + 1}行目: 元の列名または統一項目名が空欄です。`
      );
    }

    const sourceLevel = {
      sourceId: sourceId,
      sourceName: sourceName,
      fileRule: trimString(row[col['ファイル判定条件']]),
      charset: trimString(row[col['文字コード']]) || 'UTF-8',
      delimiter: normalizeDelimiter(row[col['区切り文字']]),
      headerRowCount: parseHeaderRowCount(row[col['ヘッダー行数']])
    };

    if (!configMap[sourceId]) {
      configMap[sourceId] = {
        ...sourceLevel,
        fields: []
      };
    } else {
      validateSameSourceConfig(configMap[sourceId], sourceLevel, r + 1);
    }

    configMap[sourceId].fields.push({
      sourceColumn: sourceColumn,
      targetColumn: targetColumn,
      dataType: trimString(row[col['データ型']]).toUpperCase(),
      required: parseBoolean(row[col['必須列']]),
      missingAction: trimString(row[col['欠損時処理']]).toUpperCase(),
      transformRule: trimString(row[col['変換・補正ルール']]),
      note: trimString(row[col['備考']])
    });
  }

  if (Object.keys(configMap).length === 0) {
    throw new Error('有効な設定がありません。');
  }

  return configMap;
}


/**
 * ファイル名からソースを判定する。
 */
function detectSource(fileName, configMap) {
  for (const sourceConfig of Object.values(configMap)) {
    if (matchesFileRule(fileName, sourceConfig.fileRule, sourceConfig.sourceName)) {
      return sourceConfig;
    }
  }

  return null;
}


/**
 * CSVファイル1件を処理する。
 */
function processCsvFile(file, sourceConfig, outputSs) {
  const fileName = file.getName();

  // ファイル名から対象期間（月次:YYYYMM／年度:YYYY）を抽出する。
  // 抽出できない場合は洗い替えを行わず、従来どおりの追記のみとする。
  const targetPeriod = extractTargetPeriod_(fileName, sourceConfig);

  const rows = parseCsvFile(file, sourceConfig);

  if (rows.length < sourceConfig.headerRowCount) {
    throw new Error(
      `CSV行数がヘッダー行数(${sourceConfig.headerRowCount})未満です。`
    );
  }

  // ヘッダー行数が1なら1行目、2なら2行目を列ヘッダーとして扱う
  const headerIndex = sourceConfig.headerRowCount - 1;

  const csvHeader = rows[headerIndex].map((value, index) => {
    let header = trimString(value);
    if (index === 0) {
      header = removeBom(header);
    }
    return header;
  });

  const headerMapping = createHeaderMapping(csvHeader, sourceConfig);

  // 必須列自体がCSVに存在するか確認
  const missingColumns = sourceConfig.fields
    .filter(field => field.required)
    .filter(field => headerMapping[field.targetColumn] === undefined)
    .map(field => field.sourceColumn);

  if (missingColumns.length > 0) {
    throw new Error(
      'CSVに必須列が存在しません: ' + missingColumns.join(', ')
    );
  }

  const normalRows = [];
  const errorRows = [];
  let totalCount = 0;

  for (let r = sourceConfig.headerRowCount; r < rows.length; r++) {
    const rawRow = rows[r];

    // 完全空行は無視
    if (isEmptyRow(rawRow)) {
      continue;
    }

    totalCount++;

    const result = validateAndNormalizeRow(
      rawRow,
      r + 1,
      fileName,
      sourceConfig,
      headerMapping
    );

    if (result.errors.length > 0) {
      errorRows.push(...result.errors);
    } else {
      normalRows.push(result.normalizedRow);
    }
  }

  let washed = false;

  if (normalRows.length > 0) {
    writeStagingData(outputSs, sourceConfig, normalRows, targetPeriod);
    washed = !!targetPeriod;
  } else {
    // 正常行が1件もない場合、既存データを誤って消さないよう
    // 洗い替えは行わず、ヘッダーの存在確認のみ行う
    ensureStagingSheet(outputSs, sourceConfig);
  }

  const errorCount = countUniqueErrorRows(errorRows);

  let message;

  if (errorCount > 0) {
    message = `${errorCount}行にデータエラーがあります。`;
  } else if (!targetPeriod) {
    message = '正常終了（ファイル名から対象期間を判定できなかったため追記モードで処理しました）';
  } else if (washed) {
    message = '正常終了（対象期間を洗い替えました）';
  } else {
    message = '正常終了';
  }

  return {
    totalCount: totalCount,
    successCount: normalRows.length,
    errorCount: errorCount,
    errorRows: errorRows,
    targetPeriod: targetPeriod,
    message: message
  };
}


/**
 * 指定文字コード・区切り文字でCSVを読む。
 */
function parseCsvFile(file, sourceConfig) {
  const blob = file.getBlob();
  let text = blob.getDataAsString(sourceConfig.charset);

  text = removeBom(text);

  return Utilities.parseCsv(text, sourceConfig.delimiter);
}


/**
 * CSVヘッダーと設定シートを対応付ける。
 *
 * 戻り値:
 * {
 *   transaction_id: 0,
 *   sales_date: 1,
 *   ...
 * }
 */
function createHeaderMapping(csvHeader, sourceConfig) {
  const sourceColumnIndex = {};

  csvHeader.forEach((name, index) => {
    if (name && sourceColumnIndex[name] === undefined) {
      sourceColumnIndex[name] = index;
    }
  });

  const mapping = {};

  sourceConfig.fields.forEach(field => {
    const index = sourceColumnIndex[field.sourceColumn];

    if (index !== undefined) {
      mapping[field.targetColumn] = index;
    }
  });

  return mapping;
}


/**
 * CSVの1行を検証・正規化する。
 */
function validateAndNormalizeRow(
  rawRow,
  csvRowNumber,
  fileName,
  sourceConfig,
  headerMapping
) {
  const normalizedRow = [];
  const errors = [];

  sourceConfig.fields.forEach(field => {
    const sourceIndex = headerMapping[field.targetColumn];

    // 任意列そのものがCSVに存在しない場合
    if (sourceIndex === undefined) {
      normalizedRow.push(null);
      return;
    }

    const rawValue = rawRow[sourceIndex];
    const result = normalizeValue(rawValue, field);

    if (result.error) {
      errors.push([
        new Date(),
        fileName,
        sourceConfig.sourceId,
        csvRowNumber,
        field.targetColumn,
        valueForLog(rawValue),
        result.error
      ]);

      normalizedRow.push(null);
    } else {
      normalizedRow.push(result.value);
    }
  });

  return {
    normalizedRow: normalizedRow,
    errors: errors
  };
}


/**
 * 設定された型・必須・欠損処理に従って値を正規化する。
 */
function normalizeValue(rawValue, field) {
  const missing = isEmptyValue(rawValue);

  if (missing) {
    if (field.required || field.missingAction === 'エラー') {
      return {
        value: null,
        error: `必須項目「${field.sourceColumn}」が空欄です。`
      };
    }

    if (field.missingAction === 'NULL' || !field.missingAction) {
      return {
        value: null,
        error: null
      };
    }

    if (field.missingAction === '補正') {
      return applyCorrectionRule(field);
    }

    return {
      value: null,
      error: null
    };
  }

  switch (field.dataType) {
    case 'STRING':
      return {
        value: String(rawValue).trim(),
        error: null
      };

    case 'INTEGER':
      return normalizeInteger(rawValue);

    case 'FLOAT':
      return normalizeFloat(rawValue);

    case 'DATE':
      return normalizeDate(rawValue);

    case 'DATETIME':
      return normalizeDateTime(rawValue);

    case 'BOOLEAN':
      return normalizeBoolean(rawValue);

    default:
      return {
        value: null,
        error: `未対応のデータ型です: ${field.dataType}`
      };
  }
}


/**
 * DATEをYYYY-MM-DDへ正規化する。
 */
function normalizeDate(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return {
      value: Utilities.formatDate(
        value,
        Session.getScriptTimeZone(),
        'yyyy-MM-dd'
      ),
      error: null
    };
  }

  const text = trimString(value);

  let match = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if (match) {
    return buildDate(match[1], match[2], match[3]);
  }

  match = text.match(/^(\d{4})年(\d{1,2})月$/);
  if (match) {
    return buildDate(match[1], match[2], 1);
  }

  match = text.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (match) {
    return buildDate(match[1], match[2], match[3]);
  }

  match = text.match(/^(\d{4})[-\/](\d{1,2})$/);
  if (match) {
    return buildDate(match[1], match[2], 1);
  }

  return {
    value: null,
    error: `日付形式を解釈できません: ${text}`
  };
}


/**
 * INTEGERへ変換する。
 */
function normalizeInteger(value) {
  const result = parseNumber(value);

  if (result.error) {
    return result;
  }

  if (!Number.isInteger(result.value)) {
    return {
      value: null,
      error: `整数ではありません: ${value}`
    };
  }

  return result;
}


/**
 * FLOATへ変換する。
 */
function normalizeFloat(value) {
  return parseNumber(value);
}


/**
 * DATETIMEへ変換する。
 * YYYY-MM-DD HH:mm:ss形式で返す。
 */
function normalizeDateTime(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return {
      value: Utilities.formatDate(
        value,
        Session.getScriptTimeZone(),
        'yyyy-MM-dd HH:mm:ss'
      ),
      error: null
    };
  }

  const text = trimString(value);
  const match = text.match(
    /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/
  );

  if (!match) {
    return {
      value: null,
      error: `日時形式を解釈できません: ${text}`
    };
  }

  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] || 0)
  );

  if (isNaN(date)) {
    return {
      value: null,
      error: `日時として不正です: ${text}`
    };
  }

  return {
    value: Utilities.formatDate(
      date,
      Session.getScriptTimeZone(),
      'yyyy-MM-dd HH:mm:ss'
    ),
    error: null
  };
}


/**
 * BOOLEANへ変換する。
 */
function normalizeBoolean(value) {
  if (typeof value === 'boolean') {
    return {
      value: value,
      error: null
    };
  }

  const text = trimString(value).toLowerCase();

  if (['true', '1', 'yes', 'y', 'はい'].includes(text)) {
    return {
      value: true,
      error: null
    };
  }

  if (['false', '0', 'no', 'n', 'いいえ'].includes(text)) {
    return {
      value: false,
      error: null
    };
  }

  return {
    value: null,
    error: `BOOLEAN形式を解釈できません: ${value}`
  };
}


/**
 * 正常行をステージングシートへ書き込む。
 *
 * targetPeriodが判定できている場合は、書込み前に同一ソース×
 * 同一対象期間の既存行を削除してから追記する（洗い替え）。
 * targetPeriodがnullの場合は、従来どおり末尾への追記のみとする。
 */
function writeStagingData(outputSs, sourceConfig, rows, targetPeriod) {
  const staging = ensureStagingSheet(outputSs, sourceConfig);

  if (targetPeriod) {
    removeRowsForPeriod_(staging.sheet, staging.columnOrder, targetPeriod);
  }

  if (rows.length === 0) {
    return;
  }

  const reordered = rows.map(row =>
    reorderRowForSheet_(row, sourceConfig, targetPeriod, staging.columnOrder)
  );

  const startRow = Math.max(staging.sheet.getLastRow() + 1, 2);

  staging.sheet
    .getRange(startRow, 1, reordered.length, staging.columnOrder.length)
    .setValues(reordered);
}


/**
 * stg_*シートから、指定した対象期間（PERIOD_COLUMN_NAME列の値）と
 * 一致する既存行を削除する。
 */
function removeRowsForPeriod_(sheet, columnOrder, targetPeriod) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return;
  }

  const periodColumnIndex = columnOrder.indexOf(PERIOD_COLUMN_NAME);

  if (periodColumnIndex === -1) {
    return;
  }

  const numColumns = columnOrder.length;
  const allData = sheet.getRange(2, 1, lastRow - 1, numColumns).getValues();

  const remaining = allData.filter(
    row => String(row[periodColumnIndex]) !== String(targetPeriod)
  );

  if (remaining.length === allData.length) {
    // 削除対象なし
    return;
  }

  sheet.getRange(2, 1, lastRow - 1, numColumns).clearContent();

  if (remaining.length > 0) {
    sheet.getRange(2, 1, remaining.length, numColumns).setValues(remaining);
  }
}


/**
 * 設定シート順の正規化済み行を、実際のシートの列順
 * （columnOrder）に並べ替え、対象期間の値も追加する。
 */
function reorderRowForSheet_(row, sourceConfig, targetPeriod, columnOrder) {
  const valueByColumn = {};

  sourceConfig.fields.forEach((field, i) => {
    valueByColumn[field.targetColumn] = row[i];
  });

  valueByColumn[PERIOD_COLUMN_NAME] = targetPeriod || '';

  return columnOrder.map(columnName =>
    Object.prototype.hasOwnProperty.call(valueByColumn, columnName)
      ? valueByColumn[columnName]
      : null
  );
}


/**
 * エラー行を一括追記する。
 */
function writeErrorRows(outputSs, rows) {
  if (rows.length === 0) {
    return;
  }

  const sheet = outputSs.getSheetByName(CONFIG.ERROR_SHEET_NAME);
  const startRow = Math.max(sheet.getLastRow() + 1, 2);

  sheet
    .getRange(startRow, 1, rows.length, rows[0].length)
    .setValues(rows);
}


/**
 * ログを一括追記する。
 */
function writeLog(outputSs, rows) {
  if (rows.length === 0) {
    return;
  }

  const sheet = outputSs.getSheetByName(CONFIG.LOG_SHEET_NAME);
  const startRow = Math.max(sheet.getLastRow() + 1, 2);

  sheet
    .getRange(startRow, 1, rows.length, rows[0].length)
    .setValues(rows);
}


/**
 * 処理済みフォルダへファイルを移動する。
 */
function moveToProcessedFolder(file, processedFolder) {
  file.moveTo(processedFolder);
}


/**
 * 指定フォルダ以下にあるCSVファイルを再帰的に取得する。
 *
 * 例:
 * 取込フォルダ
 * ├─ 売上
 * │   └─ 2026
 * │       └─ 売上_202604.csv
 * └─ 原価
 *     └─ 2026
 *         └─ 原価_202604.csv
 *
 * のようにCSVが複数階層下にあっても取得できる。
 *
 * @param {Folder} folder 探索開始フォルダ
 * @return {File[]} 見つかったCSVファイルの配列
 */
function getCsvFilesRecursively(folder) {
  const result = [];

  // 現在のフォルダ直下にあるCSVを取得
  const files = folder.getFiles();

  while (files.hasNext()) {
    const file = files.next();

    if (file.getName().toLowerCase().endsWith('.csv')) {
      result.push(file);
    }
  }

  // 現在のフォルダ直下にあるサブフォルダを取得
  const subFolders = folder.getFolders();

  while (subFolders.hasNext()) {
    const subFolder = subFolders.next();

    // サブフォルダの中をさらに探索
    const childFiles = getCsvFilesRecursively(subFolder);
    result.push(...childFiles);
  }

  return result;
}


/**
 * ステージングシートを作成・取得する。
 *
 * シート名は常に「stg_」+ソースIDの小文字（例：SALES_BUDGET →
 * stg_sales_budget）で決定する。新しいソースを追加する場合も、
 * このフォールバック規則だけでシート名が一意に決まるため、
 * ソースIDとシート名の対応表を別途コードで管理する必要はない。
 *
 * ヘッダー（列構成）の検証は、順序ではなく「必要な列がすべて
 * 揃っているか」で行う。実際のシートの列順は columnOrder として
 * 返し、書込み時にはこの順序に合わせて値を並べ替える。
 */
function ensureStagingSheet(outputSs, sourceConfig) {
  const sheetName = 'stg_' + sourceConfig.sourceId.toLowerCase();
  const expectedHeaders = sourceConfig.fields
    .map(field => field.targetColumn)
    .concat([PERIOD_COLUMN_NAME]);

  let sheet = outputSs.getSheetByName(sheetName);

  if (!sheet) {
    sheet = outputSs.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
    sheet.setFrozenRows(1);
    return { sheet: sheet, columnOrder: expectedHeaders };
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
    sheet.setFrozenRows(1);
    return { sheet: sheet, columnOrder: expectedHeaders };
  }

  const existingHeaders = sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0]
    .map(v => trimString(v))
    .filter(v => v !== '');

  const existingSet = new Set(existingHeaders);
  const sameSet =
    existingHeaders.length === expectedHeaders.length &&
    expectedHeaders.every(header => existingSet.has(header));

  if (!sameSet) {
    throw new Error(
      `ステージングシート「${sheetName}」の項目構成が設定シートと一致しません` +
      `（列の過不足があります）。`
    );
  }

  return { sheet: sheet, columnOrder: existingHeaders };
}


/**
 * 取込エラー・取込ログシートを作成する。
 */
function ensureSystemSheets(outputSs) {
  ensureSheet(
    outputSs,
    CONFIG.ERROR_SHEET_NAME,
    [
      '処理日時',
      'ファイル名',
      'ソースID',
      'CSV行番号',
      'エラー対象項目',
      '元データ',
      'エラー内容'
    ]
  );

  ensureSheet(
    outputSs,
    CONFIG.LOG_SHEET_NAME,
    [
      '処理日時',
      'ファイル名',
      'ソースID',
      '対象期間',
      '総データ件数',
      '正常件数',
      'エラー件数',
      '処理結果',
      'メッセージ'
    ]
  );
}


/**
 * 指定ヘッダーでシートを作成する。
 */
function ensureSheet(ss, sheetName, headers) {
  let sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }

  return sheet;
}


/**
 * ファイル判定条件の「「〇〇」で始まる／を含む」を解析する。
 *
 * 例:
 * 「売上_」で始まる → { prefix: '売上_', mode: 'startsWith' }
 */
function extractBracketedRule_(rule) {
  const text = trimString(rule);

  let match = text.match(/「(.+?)」.*始まる/);
  if (match) {
    return { prefix: match[1], mode: 'startsWith' };
  }

  match = text.match(/「(.+?)」.*含/);
  if (match) {
    return { prefix: match[1], mode: 'includes' };
  }

  return null;
}


/**
 * ファイル判定条件を評価する。
 *
 * 現在の設定シート例:
 * ファイル名が「売上_」で始まる
 */
function matchesFileRule(fileName, rule, sourceName) {
  const parsed = extractBracketedRule_(rule);

  if (parsed) {
    return parsed.mode === 'startsWith'
      ? fileName.startsWith(parsed.prefix)
      : fileName.includes(parsed.prefix);
  }

  // 条件を解釈できない場合のフォールバック
  if (sourceName) {
    return fileName.startsWith(sourceName + '_');
  }

  return false;
}


/**
 * ファイル名（{プレフィックス}{対象期間}_{登録日時}.csv）から
 * 対象期間（月次:YYYYMM／年度:YYYY の数字部分）を抽出する。
 *
 * ファイル判定条件が「〜で始まる」形式でない場合や、
 * ファイル名が規則に沿っていない場合はnullを返す。
 */
function extractTargetPeriod_(fileName, sourceConfig) {
  const parsed = extractBracketedRule_(sourceConfig.fileRule);

  const prefix =
    parsed && parsed.mode === 'startsWith'
      ? parsed.prefix
      : sourceConfig.sourceName
        ? sourceConfig.sourceName + '_'
        : null;

  if (!prefix || fileName.indexOf(prefix) !== 0) {
    return null;
  }

  const rest = fileName.slice(prefix.length);
  const match = rest.match(/^(\d{4}|\d{6})(?:_|\.)/);

  return match ? match[1] : null;
}


/**
 * 数値文字列をNumberへ変換する。
 */
function parseNumber(value) {
  if (typeof value === 'number') {
    if (isFinite(value)) {
      return {
        value: value,
        error: null
      };
    }

    return {
      value: null,
      error: `数値として不正です: ${value}`
    };
  }

  let text = trimString(value);

  // (1,000)形式にも対応
  let negative = false;

  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }

  text = text
    .replace(/,/g, '')
    .replace(/[￥¥]/g, '')
    .replace(/円\/kg/gi, '')
    .replace(/円/g, '')
    .replace(/kg/gi, '')
    .replace(/時間/g, '')
    .replace(/hrs?/gi, '')
    .replace(/h/gi, '')
    .replace(/\s+/g, '');

  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) {
    return {
      value: null,
      error: `数値形式を解釈できません: ${value}`
    };
  }

  let number = Number(text);

  if (negative) {
    number = -number;
  }

  if (!isFinite(number)) {
    return {
      value: null,
      error: `数値として不正です: ${value}`
    };
  }

  return {
    value: number,
    error: null
  };
}


/**
 * 年月日からYYYY-MM-DDを作る。
 */
function buildDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);

  const date = new Date(y, m - 1, d);

  if (
    date.getFullYear() !== y ||
    date.getMonth() !== m - 1 ||
    date.getDate() !== d
  ) {
    return {
      value: null,
      error: `存在しない日付です: ${year}-${month}-${day}`
    };
  }

  return {
    value:
      String(y).padStart(4, '0') +
      '-' +
      String(m).padStart(2, '0') +
      '-' +
      String(d).padStart(2, '0'),
    error: null
  };
}


/**
 * 欠損時処理「補正」用。
 *
 * 現在の設定シートでは補正指定はありません。
 * 将来、固定値補完などを追加する場合はここに実装します。
 */
function applyCorrectionRule(field) {
  return {
    value: null,
    error:
      `項目「${field.sourceColumn}」は欠損時処理が「補正」ですが、` +
      '補正ロジックが未定義です。'
  };
}


/**
 * 同一ソースで文字コード等がバラバラになっていないか確認する。
 */
function validateSameSourceConfig(existing, incoming, rowNumber) {
  const checks = [
    ['sourceName', 'ソース名'],
    ['fileRule', 'ファイル判定条件'],
    ['charset', '文字コード'],
    ['delimiter', '区切り文字'],
    ['headerRowCount', 'ヘッダー行数']
  ];

  checks.forEach(([key, label]) => {
    if (String(existing[key]) !== String(incoming[key])) {
      throw new Error(
        `設定シート${rowNumber}行目: ` +
        `同一ソース内で「${label}」が不一致です。`
      );
    }
  });
}


/**
 * CONFIGのIDが設定されているか確認する。
 */
function validateConfigIds() {
  [
    'CONFIG_SPREADSHEET_ID',
    'INPUT_FOLDER_ID',
    'PROCESSED_FOLDER_ID',
    'OUTPUT_SPREADSHEET_ID'
  ].forEach(key => {
    const value = CONFIG[key];

    if (!value || String(value).includes('ここに')) {
      throw new Error(`CONFIG.${key} が未設定です。`);
    }
  });
}


/**
 * 区切り文字を正規化する。
 */
function normalizeDelimiter(value) {
  const text = trimString(value);

  if (!text) {
    return ',';
  }

  if (text === '\\t' || text.toLowerCase() === 'tab' || text === 'タブ') {
    return '\t';
  }

  return text.charAt(0);
}


/**
 * ヘッダー行数を整数にする。
 */
function parseHeaderRowCount(value) {
  const n = Number(value);

  if (Number.isInteger(n) && n >= 1) {
    return n;
  }

  return 1;
}


/**
 * TRUE/FALSEを解釈する。
 */
function parseBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  const text = trimString(value).toLowerCase();

  return ['true', '1', 'yes', 'y', 'はい', '必須'].includes(text);
}


/**
 * 同じCSV行に複数エラーがあっても、エラー件数は1行として数える。
 */
function countUniqueErrorRows(errorRows) {
  const set = new Set();

  errorRows.forEach(row => {
    set.add(row[1] + '::' + row[3]);
  });

  return set.size;
}


/**
 * 完全空行判定。
 */
function isEmptyRow(row) {
  return row.every(value => isEmptyValue(value));
}


/**
 * 空欄判定。
 */
function isEmptyValue(value) {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '')
  );
}


/**
 * 文字列化＋trim。
 */
function trimString(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}


/**
 * UTF-8 BOM除去。
 */
function removeBom(value) {
  return String(value).replace(/^﻿/, '');
}


/**
 * ログ記録用文字列。
 */
function valueForLog(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (
    Object.prototype.toString.call(value) === '[object Date]' &&
    !isNaN(value)
  ) {
    return Utilities.formatDate(
      value,
      Session.getScriptTimeZone(),
      'yyyy-MM-dd HH:mm:ss'
    );
  }

  return String(value);
}


/**
 * Errorオブジェクトからメッセージを取得する。
 */
function getErrorMessage(error) {
  if (!error) {
    return '不明なエラー';
  }

  return error.message ? String(error.message) : String(error);
}
