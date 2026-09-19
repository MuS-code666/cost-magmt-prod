/**
 * 原価管理システム - ファイル登録
 *
 * Excelファイルを受け取り、
 * Googleスプレッドシートへ一時変換した後、
 * 先頭シートの内容をCSV化して所定のフォルダへ保存する。
 *
 * アップロード先フォルダ・対象期間の粒度（月次/年度）は
 * 「取込_設定シート」スプレッドシートの「アップロード設定」シートで管理する。
 * ソース種別を追加・変更する場合はこのシートを編集するだけでよく、
 * 本コードやindex.htmlの修正は不要。
 */

// =====================================================
// 設定
// =====================================================

const CONFIG = {
  TIMEZONE: 'Asia/Tokyo',

  SOURCE_CONFIG_SPREADSHEET_ID: '1mjxPFb9GcbaG780duU6xfTqX0bo3nse4_8S87w8WFOE',
  SOURCE_CONFIG_SHEET_NAME: 'アップロード設定',

  GOOGLE_SHEET_MIME:
    'application/vnd.google-apps.spreadsheet',

  XLSX_MIME:
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',

  XLS_MIME:
    'application/vnd.ms-excel',

  CSV_MIME:
    'text/csv'
};


// =====================================================
// Webアプリ表示
// =====================================================

function doGet() {

  const template =
    HtmlService.createTemplateFromFile('index');

  const sourceConfigMap =
    getSourceConfigMap_();

  template.sourceConfigJson =
    JSON.stringify(
      Object.keys(sourceConfigMap).map(function(sourceType) {
        return {
          sourceType: sourceType,
          isAnnual: sourceConfigMap[sourceType].isAnnual
        };
      })
    );

  return template
    .evaluate()
    .setTitle('原価管理システム-ファイル登録');
}


// =====================================================
// メイン処理
// =====================================================

function uploadFile(formObject) {

  let temporarySpreadsheetId = null;
  const lock = LockService.getScriptLock();

  try {

    // 二重登録防止
    lock.waitLock(30000);

    const sourceConfigMap = getSourceConfigMap_();

    // 入力チェック
    validateForm_(formObject, sourceConfigMap);

    const sourceType = formObject.sourceType;
    const sourceConfig = sourceConfigMap[sourceType];
    const fileBlob = formObject.uploadFile;
    const folderId = sourceConfig.folderId;
    const originalFileName = fileBlob.getName();

    // 対象期間（月次: YYYYMM / 年度: YYYY）
    const targetPeriod = convertTargetPeriod_(
      formObject.targetMonth,
      sourceConfig.isAnnual
    );

    // 登録日時（同日の再アップロードでもファイル名が衝突しないよう秒まで含める）
    const registeredAt = Utilities.formatDate(
      new Date(),
      CONFIG.TIMEZONE,
      'yyyyMMdd_HHmmss'
    );

    // 出力ファイル名
    const outputFileName =
      `${sourceType}_${targetPeriod}_${registeredAt}.csv`;

    // ---------------------------------------------------
    // 同一ソース種別×対象期間の既存ファイル確認
    //
    // ファイル名の完全一致ではなく、「同じソース種別・同じ対象期間」の
    // ファイルが既に存在するかどうかで判定する。
    // 登録日時が異なるだけで同日中の訂正アップロードを誤って
    // ブロックしないようにするため。
    //
    // 既存ファイルがある場合は自動で拒否・自動で上書きのどちらも行わず、
    // 利用者に確認を求める（confirmOverwrite === 'true' で再送された
    // 場合のみ追加登録を許可する）。
    // ---------------------------------------------------
    const existingFiles = findFilesForPeriod_(
      folderId,
      sourceType,
      targetPeriod
    );

    if (
      existingFiles.length > 0 &&
      formObject.confirmOverwrite !== 'true'
    ) {
      return {
        success: false,
        duplicatePeriod: true,
        message:
          `対象期間「${formObject.targetMonth}」の${sourceType}データは、` +
          `既に${existingFiles.length}件登録されています` +
          `（例: ${existingFiles[0]}）。追加登録しますか？` +
          '（既存ファイルは自動的には削除されません）',
        existingFiles: existingFiles
      };
    }

    // Excel MIMEタイプ
    const excelMimeType =
      getExcelMimeType_(originalFileName);

    const excelBlob = fileBlob
      .copyBlob()
      .setName(originalFileName)
      .setContentType(excelMimeType);

    // =================================================
    // Excel → 一時Googleスプレッドシート
    // =================================================

    const tempFileMetadata = {
      name:
        `TEMP_${Date.now()}_${originalFileName}`,

      mimeType:
        CONFIG.GOOGLE_SHEET_MIME
    };

    const convertedFile =
      Drive.Files.create(
        tempFileMetadata,
        excelBlob,
        {
          fields: 'id,name'
        }
      );

    temporarySpreadsheetId =
      convertedFile.id;

    if (!temporarySpreadsheetId) {
      throw new Error(
        'ExcelファイルのGoogleスプレッドシート変換に失敗しました。'
      );
    }

    // =================================================
    // 一時Googleスプレッドシートを開く
    // =================================================

    const spreadsheet =
      SpreadsheetApp.openById(
        temporarySpreadsheetId
      );

    const sheets =
      spreadsheet.getSheets();

    if (
      !sheets ||
      sheets.length === 0
    ) {
      throw new Error(
        'Excelファイル内にシートがありません。'
      );
    }

    // 先頭シート
    const sheet =
      sheets[0];

    // =================================================
    // データ取得
    // =================================================

    const lastRow =
      sheet.getLastRow();

    const lastColumn =
      sheet.getLastColumn();

    if (
      lastRow === 0 ||
      lastColumn === 0
    ) {
      throw new Error(
        'Excelファイルにデータがありません。'
      );
    }

    /*
     * getValues() で生の値（Date／数値／文字列）を取得し、
     * 型に応じて明示的にテキスト化する（cellValueToText_）。
     *
     * getDisplayValues() はExcelのセル表示形式（%表示・桁区切り・
     * 通貨記号・日付書式など）にそのまま依存してしまい、元データの
     * 書式が変わると中間S生成側の正規化ロジックで解釈できなくなる
     * リスクがあったため、生値からの明示変換に変更している。
     */
    const values =
      sheet
        .getRange(
          1,
          1,
          lastRow,
          lastColumn
        )
        .getValues();

    // =================================================
    // CSV文字列生成
    // =================================================

    const csvText =
      convertArrayToCsv_(values);

    // UTF-8のCSV Blob
    const csvBlob =
      Utilities.newBlob(
        csvText,
        CONFIG.CSV_MIME,
        outputFileName
      );

    // =================================================
    // 指定Google Driveフォルダへ保存
    // =================================================

    const csvMetadata = {
      name: outputFileName,
      mimeType: CONFIG.CSV_MIME,
      parents: [
        folderId
      ]
    };

    const createdFile =
      Drive.Files.create(
        csvMetadata,
        csvBlob,
        {
          fields:
            'id,name,webViewLink',

          supportsAllDrives:
            true
        }
      );

    if (
      !createdFile ||
      !createdFile.id
    ) {
      throw new Error(
        'CSVファイルをGoogle Driveへ保存できませんでした。'
      );
    }

    // 正常終了
    return {
      success: true,
      message:
        'アップロードが完了しました',
      fileName:
        outputFileName,
      fileId:
        createdFile.id,
      fileUrl:
        createdFile.webViewLink || ''
    };


  } catch (error) {

    console.error(error);

    return {
      success: false,
      message:
        convertErrorMessage_(error)
    };


  } finally {

    // =================================================
    // 一時Googleスプレッドシート削除
    // =================================================

    if (temporarySpreadsheetId) {

      try {

        Drive.Files.remove(
          temporarySpreadsheetId,
          {
            supportsAllDrives: true
          }
        );

      } catch (deleteError) {

        console.error(
          '一時ファイル削除エラー:',
          deleteError
        );
      }
    }

    try {
      lock.releaseLock();
    } catch (e) {
      // 何もしない
    }
  }
}


// =====================================================
// アップロード設定（ソース種別 → フォルダID／期間区分）
//
// 「取込_設定シート」スプレッドシート内の「アップロード設定」シートを
// 単一の設定源とする。列構成：
//   A列: ソース種別（例：売上／原価／生産／月報／売上予算／原価予算）
//   B列: アップロード先フォルダID
//   C列: 区分（"月次" または "年度"）
// =====================================================

function getSourceConfigMap_() {

  const ss =
    SpreadsheetApp.openById(
      CONFIG.SOURCE_CONFIG_SPREADSHEET_ID
    );

  const sheet =
    ss.getSheetByName(
      CONFIG.SOURCE_CONFIG_SHEET_NAME
    );

  if (!sheet) {
    throw new Error(
      `設定シート「${CONFIG.SOURCE_CONFIG_SHEET_NAME}」が見つかりません。`
    );
  }

  const values =
    sheet.getDataRange().getValues();

  const map = {};

  for (let r = 1; r < values.length; r++) {

    const sourceType = trimText_(values[r][0]);
    const folderId = trimText_(values[r][1]);
    const periodType = trimText_(values[r][2]);

    if (!sourceType) {
      continue;
    }

    if (!folderId) {
      throw new Error(
        `「${CONFIG.SOURCE_CONFIG_SHEET_NAME}」シート${r + 1}行目: ` +
        `アップロード先フォルダIDが空欄です（${sourceType}）。`
      );
    }

    map[sourceType] = {
      folderId: folderId,
      isAnnual: periodType === '年度'
    };
  }

  if (Object.keys(map).length === 0) {
    throw new Error(
      `「${CONFIG.SOURCE_CONFIG_SHEET_NAME}」シートに有効な設定がありません。`
    );
  }

  return map;
}


// =====================================================
// CSV変換
// =====================================================

function convertArrayToCsv_(values) {

  return values
    .map(function(row) {

      return row
        .map(function(value) {

          return escapeCsvValue_(
            cellValueToText_(value)
          );

        })
        .join(',');

    })
    .join('\r\n');
}


/**
 * セルの生の値を、型に応じてCSV用テキストへ変換する。
 * Excelの表示形式（書式設定）には依存させない。
 */
function cellValueToText_(value) {

  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return '';
  }

  if (
    Object.prototype.toString.call(value) === '[object Date]' &&
    !isNaN(value)
  ) {

    const hasTime =
      value.getHours() !== 0 ||
      value.getMinutes() !== 0 ||
      value.getSeconds() !== 0;

    return Utilities.formatDate(
      value,
      CONFIG.TIMEZONE,
      hasTime ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd'
    );
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  return String(value);
}


// =====================================================
// CSVセルのエスケープ
// =====================================================

function escapeCsvValue_(text) {

  /*
   * CSV仕様：
   *
   * カンマ
   * 改行
   * "
   *
   * のいずれかを含む場合は
   * 全体を " で囲む。
   *
   * セル内の " は "" に変換する。
   */

  if (text.includes('"')) {
    text =
      text.replace(
        /"/g,
        '""'
      );
  }

  if (
    text.includes(',') ||
    text.includes('\n') ||
    text.includes('\r') ||
    text.includes('"')
  ) {

    text =
      '"' +
      text +
      '"';
  }

  return text;
}


// =====================================================
// 入力チェック
// =====================================================

function validateForm_(formObject, sourceConfigMap) {

  if (!formObject) {
    throw new Error(
      '入力データを取得できませんでした。'
    );
  }

  if (!formObject.uploadFile) {
    throw new Error(
      'Excelファイルを選択してください。'
    );
  }

  const fileName =
    formObject.uploadFile.getName();

  if (!fileName) {
    throw new Error(
      'ファイル名を取得できませんでした。'
    );
  }

  if (!isExcelFile_(fileName)) {
    throw new Error(
      'Excelファイル（.xlsx または .xls）を選択してください。'
    );
  }

  if (!formObject.sourceType) {
    throw new Error(
      'ソース種別を選択してください。'
    );
  }

  const sourceConfig =
    sourceConfigMap[formObject.sourceType];

  if (!sourceConfig) {
    throw new Error(
      'ソース種別が正しくありません。'
    );
  }

  if (!formObject.targetMonth) {
    throw new Error(
      sourceConfig.isAnnual
        ? '対象年度を選択してください。'
        : '対象年月を選択してください。'
    );
  }

  const pattern =
    sourceConfig.isAnnual
      ? /^\d{4}年度$/
      : /^\d{4}年-(0[1-9]|1[0-2])月$/;

  if (!pattern.test(formObject.targetMonth)) {
    throw new Error(
      sourceConfig.isAnnual
        ? '対象年度は「2026年度」の形式で入力してください。'
        : '対象年月は「2026年-09月」の形式で入力してください。'
    );
  }
}


// =====================================================
// Excelファイル判定
// =====================================================

function isExcelFile_(fileName) {

  const lower =
    fileName.toLowerCase();

  return (
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xls')
  );
}


// =====================================================
// Excel MIME Type取得
// =====================================================

function getExcelMimeType_(fileName) {

  const lower =
    fileName.toLowerCase();

  if (lower.endsWith('.xlsx')) {
    return CONFIG.XLSX_MIME;
  }

  if (lower.endsWith('.xls')) {
    return CONFIG.XLS_MIME;
  }

  throw new Error(
    '対応していないファイル形式です。'
  );
}


// =====================================================
// 対象期間変換
//
// 月次： 2026年-09月 → 202609
// 年度： 2026年度     → 2026
// =====================================================

function convertTargetPeriod_(targetMonth, isAnnual) {

  if (isAnnual) {

    const match =
      targetMonth.match(/^(\d{4})年度$/);

    if (!match) {
      throw new Error(
        '対象年度の形式が正しくありません。'
      );
    }

    return match[1];
  }

  const match =
    targetMonth.match(
      /^(\d{4})年-(\d{2})月$/
    );

  if (!match) {
    throw new Error(
      '対象年月の形式が正しくありません。'
    );
  }

  return match[1] + match[2];
}


// =====================================================
// 同一ソース種別×対象期間の既存ファイル検索
// =====================================================

function findFilesForPeriod_(folderId, sourceType, targetPeriod) {

  const prefix =
    sourceType + '_' + targetPeriod + '_';

  const escapedPrefix =
    escapeDriveQuery_(prefix);

  const escapedFolderId =
    escapeDriveQuery_(folderId);

  const query =
    `'${escapedFolderId}' in parents ` +
    `and name contains '${escapedPrefix}' ` +
    `and trashed = false`;

  const result =
    Drive.Files.list({

      q: query,

      fields:
        'files(id,name)',

      pageSize:
        50,

      supportsAllDrives:
        true,

      includeItemsFromAllDrives:
        true
    });

  const files =
    result.files || [];

  // "contains"は部分一致のため、前方一致であることを念のため再確認する
  return files
    .filter(function(f) {
      return f.name.indexOf(prefix) === 0;
    })
    .map(function(f) {
      return f.name;
    });
}


// =====================================================
// Drive検索文字列エスケープ
// =====================================================

function escapeDriveQuery_(value) {

  return String(value)
    .replace(
      /\\/g,
      '\\\\'
    )
    .replace(
      /'/g,
      "\\'"
    );
}


// =====================================================
// 文字列化＋trim
// =====================================================

function trimText_(value) {

  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}


// =====================================================
// エラー表示用
// =====================================================

function convertErrorMessage_(error) {

  const originalMessage =
    error && error.message
      ? error.message
      : String(error);

  if (
    originalMessage.includes(
      'File not found'
    )
  ) {

    return (
      'アップロードに失敗しました。' +
      '保存先フォルダが見つからない、またはアクセス権限がありません。'
    );
  }

  if (
    originalMessage.includes(
      'Permission'
    ) ||
    originalMessage.includes(
      'permission'
    ) ||
    originalMessage.includes(
      'Insufficient'
    ) ||
    originalMessage.includes(
      '403'
    )
  ) {

    return (
      'アップロードに失敗しました。' +
      'Google Driveへのアクセス権限を確認してください。'
    );
  }

  return (
    'アップロードに失敗しました。' +
    originalMessage
  );
}
