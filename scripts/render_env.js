// 環境ごとの値（config/env.json）から、その環境用のファイルを作る。
// 生成物は手で編集しない。値を変えるときは config/env.json を直して、もう一度実行する。
//
// 使い方: リポジトリ直下で npm run env:render
//         別の設定ファイルを使うとき: node scripts/render_env.js config/env.顧客名.json
//
// 作るもの:
//   GAS/*/環境設定_自動生成.gs     各 GAS が使う ID（const ENV）
//   GAS/*/.clasp.json              clasp の反映先（scriptId）
//   .mcp.json                      Claude Code から BigQuery を読む設定
//   build/sql/*.sql, build/prompts/*.md
//                                  sql/・prompts/ の {{PROJECT_ID}} などを実際の値にしたもの
//                                  （BigQuery のエディタに貼るのはこちら）

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const DEFAULT_ENV = 'config/env.json';

function loadEnv(envPath) {
  const file = path.resolve(root, envPath || process.env.COST_MGMT_ENV || DEFAULT_ENV);
  if (!fs.existsSync(file)) {
    throw new Error(file + ' がありません。config/env.example.json をコピーして値を入れてください。');
  }
  const env = JSON.parse(fs.readFileSync(file, 'utf8'));
  const unfilled = [];
  (function walk(node, keyPath) {
    if (node && typeof node === 'object') {
      Object.keys(node).forEach((k) => walk(node[k], keyPath.concat(k)));
    } else if (typeof node === 'string' && node.includes('ここに')) {
      unfilled.push(keyPath.join('.'));
    }
  })(env, []);
  if (unfilled.length) {
    throw new Error(path.relative(root, file) + ' に未記入の値があります: ' + unfilled.join(', '));
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(env.gcp.projectId)) {
    throw new Error('gcp.projectId の形式が正しくありません: ' + env.gcp.projectId);
  }
  return { env, file };
}

// sql/・prompts/・カタログで使う置き換え記号
function placeholders(env) {
  return {
    PROJECT_ID: env.gcp.projectId,
    LOCATION: env.gcp.location
  };
}

// 環境の値（PROJECT_ID・LOCATION）だけを置き換える。
// それ以外の {{...}}（月報テンプレートの {{TARGET_MONTH}} など）は、使う側で埋めるためそのまま残す。
function renderText(text, env) {
  const map = placeholders(env);
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => (key in map ? map[key] : m));
}

function gasEnvFile(env, values) {
  return [
    '// ============================================================',
    '// 自動生成ファイル。手で編集しない。',
    '// 元データ: config/env.json（' + env.envName + '）',
    '// 再生成: リポジトリ直下で npm run env:render',
    '// ============================================================',
    '',
    'const ENV = ' + JSON.stringify(values, null, 2) + ';',
    ''
  ].join('\n');
}

function write(rel, content, written) {
  const out = path.join(root, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, content, 'utf8');
  written.push(rel);
}

function renderAll(envPath) {
  const { env, file } = loadEnv(envPath);
  const g = env.gas;
  const written = [];

  // フォルダ = Apps Script のプロジェクト1つ。02（中間S生成）と 03（DataRoad）は
  // 同じプロジェクト「取込・整形App」に入っているため、1フォルダ・1つの ENV にまとめる。
  const gasProjects = {
    'GAS/01_ファイル登録': {
      scriptId: g.fileUpload.scriptId,
      env: { SOURCE_CONFIG_SPREADSHEET_ID: g.fileUpload.sourceConfigSpreadsheetId }
    },
    'GAS/02-03_取込・整形App': {
      scriptId: g.importApp.scriptId,
      env: {
        CONFIG_SPREADSHEET_ID: g.importApp.configSpreadsheetId,
        INPUT_FOLDER_ID: g.importApp.inputFolderId,
        PROCESSED_FOLDER_ID: g.importApp.processedFolderId,
        OUTPUT_SPREADSHEET_ID: g.importApp.outputSpreadsheetId,
        DATAROAD_SPREADSHEET_ID: g.importApp.dataRoadSpreadsheetId
      }
    },
    'GAS/04_閾値超過アラート': {
      scriptId: g.alert.scriptId,
      env: { PROJECT_ID: env.gcp.projectId, LOCATION: env.gcp.location }
    },
    'GAS/05_自然言語検索': {
      scriptId: g.nlSearch.scriptId,
      env: { PROJECT_ID: env.gcp.projectId, LOCATION: env.gcp.location }
    }
  };
  const clasp = (scriptId) => JSON.stringify({ scriptId: scriptId, fileExtension: 'gs' }, null, 2) + '\n';
  Object.keys(gasProjects).forEach((dir) => {
    write(dir + '/環境設定_自動生成.gs', gasEnvFile(env, gasProjects[dir].env), written);
    write(dir + '/.clasp.json', clasp(gasProjects[dir].scriptId), written);
  });

  const mcp = {
    mcpServers: {
      bigquery: {
        command: 'npx',
        args: ['-y', '@toolbox-sdk/server', '--prebuilt', 'bigquery', '--stdio'],
        env: {
          GOOGLE_APPLICATION_CREDENTIALS: env.mcp.bigqueryCredentialsPath,
          BIGQUERY_PROJECT: env.gcp.projectId
        }
      }
    }
  };
  write('.mcp.json', JSON.stringify(mcp, null, 2) + '\n', written);

  ['sql', 'prompts'].forEach((dir) => {
    fs.readdirSync(path.join(root, dir))
      .filter((name) => /\.(sql|md)$/.test(name))
      .forEach((name) => {
        const text = fs.readFileSync(path.join(root, dir, name), 'utf8');
        write('build/' + dir + '/' + name, renderText(text, env), written);
      });
  });

  return { env, file, written };
}

module.exports = { loadEnv, renderText };

if (require.main === module) {
  try {
    const { env, file, written } = renderAll(process.argv[2]);
    console.log('環境: ' + env.envName + '（' + path.relative(root, file) + '）');
    written.forEach((rel) => console.log('  生成: ' + rel));
  } catch (e) {
    console.error('エラー: ' + e.message);
    process.exit(1);
  }
}
