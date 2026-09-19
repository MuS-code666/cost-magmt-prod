/**
 * 原価管理システム - ファイル登録
 *
 * Excelファイルを受け取り、
 * Googleスプレッドシートへ一時変換した後、
 * 先頭シートの内容をCSV化して所定のフォルダへ保存する。
 */

// =====================================================
// 設定
// =====================================================

const CONFIG = {
  TIMEZONE: 'Asia/Tokyo',

  FOLDER_IDS: {
    '売上': '1-o6BBUyPxSTenYbB4Uy1Vpho3xwifTzD',
    '原価': '1cemGBB3z0yZNXDOWPjVKUkO-49eMZdeP',
    '生産': '1RoXiMmcHrW5a0K2xNsKDglf2hu_n6YSo',
    '月報': '1C5kkeROQ3akC8NXUdtcc2xu7AWkIMpUD'
  },

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
  return HtmlService
    .createHtmlOutputFromFile('index')
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

    // 入力チェック
    validateForm_(formObject);

    const sourceType = formObject.sourceType;
    const targetMonth = formObject.targetMonth;
    const fileBlob = formObject.uploadFile;

    const folderId = CONFIG.FOLDER_IDS[sourceType];
    const originalFileName = fileBlob.getName();

    // 対象年月
    const targetYYYYMM = convertTargetMonth_(targetMonth);

    // 登録日
    const uploadDate = Utilities.formatDate(
      new Date(),
      CONFIG.TIMEZONE,
      'MMdd'
    );

    // 出力ファイル名
    const outputFileName =
      `${sourceType}_${targetYYYYMM}_${uploadDate}.csv`;

    // 同名ファイル確認
    if (fileExists_(folderId, outputFileName)) {
      return {
        success: false,
        message: '同名のファイルが既に登録されています。'
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
     * getDisplayValues() を使うことで、
     * Excel上で表示されている値に近い形でCSV化する。
     *
     * 例：
     * 2026/09/05
     * 10.5%
     * ¥1,000
     *
     * など。
     */
    const values =
      sheet
        .getRange(
          1,
          1,
          lastRow,
          lastColumn
        )
        .getDisplayValues();

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
// CSV変換
// =====================================================

function convertArrayToCsv_(values) {

  return values
    .map(function(row) {

      return row
        .map(function(value) {

          return escapeCsvValue_(value);

        })
        .join(',');

    })
    .join('\r\n');
}


// =====================================================
// CSVセルのエスケープ
// =====================================================

function escapeCsvValue_(value) {

  if (
    value === null ||
    value === undefined
  ) {
    return '';
  }

  let text =
    String(value);

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

function validateForm_(formObject) {

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

  if (
    !Object.prototype.hasOwnProperty.call(
      CONFIG.FOLDER_IDS,
      formObject.sourceType
    )
  ) {
    throw new Error(
      'ソース種別が正しくありません。'
    );
  }

  if (!formObject.targetMonth) {
    throw new Error(
      '対象年月を入力してください。'
    );
  }

  const monthPattern =
    /^\d{4}年-(0[1-9]|1[0-2])月$/;

  if (
    !monthPattern.test(
      formObject.targetMonth
    )
  ) {
    throw new Error(
      '対象年月は「2026年-09月」の形式で入力してください。'
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
// 年月変換
//
// 2026年-09月
// ↓
// 202609
// =====================================================

function convertTargetMonth_(targetMonth) {

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
// 同名ファイル存在チェック
// =====================================================

function fileExists_(folderId, fileName) {

  const escapedName =
    escapeDriveQuery_(fileName);

  const escapedFolderId =
    escapeDriveQuery_(folderId);

  const query =
    `'${escapedFolderId}' in parents ` +
    `and name = '${escapedName}' ` +
    `and trashed = false`;

  const result =
    Drive.Files.list({

      q: query,

      fields:
        'files(id,name)',

      pageSize:
        1,

      supportsAllDrives:
        true,

      includeItemsFromAllDrives:
        true
    });

  return (
    result.files &&
    result.files.length > 0
  );
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
