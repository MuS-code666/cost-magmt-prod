// コントロールパネル（GAS/06_コントロールパネル）に、02-03 と 04 のコードを同梱する。
//
// なぜ同梱するか:
//   パネルは「所有者として実行」の Web アプリで、一般社員が使う。Apps Script の「ライブラリ」で
//   呼ぶと、版（バージョン）の管理が毎回必要になる。そこで反映のたびに元のフォルダの .gs を
//   1つの関数の中に包んで（名前空間にして）パネルのフォルダに書き出す。
//   包むことで、元のコードの関数（processImportFiles や testSend_2026_08 など）は
//   ブラウザの google.script.run から直接呼べなくなり、パネルの画面が許した操作だけが動く。
//
// 使い方: リポジトリ直下で node scripts/build_panel.js（npm run gas:push:panel が自動で実行する）
//         先に npm run env:render で各フォルダの 環境設定_自動生成.gs を作っておくこと。
//
// 作るもの（Git には入れない。.gitignore 済み）:
//   GAS/06_コントロールパネル/同梱_取込・整形App.gs   → var ImportApp = { panelImportStatus, ... }
//   GAS/06_コントロールパネル/同梱_原価アラート.gs     → var AlertApp  = { panelAlertInfo, ... }

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const PANEL_DIR = 'GAS/06_コントロールパネル';

const BUNDLES = [
  { name: 'ImportApp', dir: 'GAS/02-03_取込・整形App', out: '同梱_取込・整形App.gs' },
  { name: 'AlertApp', dir: 'GAS/04_閾値超過アラート', out: '同梱_原価アラート.gs' }
];

// 環境設定（const ENV）を先頭に置く。ほかのファイルは名前順（Apps Script の並びと同じ）。
function sourceFiles(dir) {
  const files = fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.gs')).sort();
  const envFile = '環境設定_自動生成.gs';
  if (!files.includes(envFile)) throw new Error(dir + ' に ' + envFile + ' がありません。先に npm run env:render を実行してください。');
  return [envFile].concat(files.filter((f) => f !== envFile));
}

function buildBundle(b) {
  const files = sourceFiles(b.dir);
  const parts = [];
  const exported = [];
  files.forEach((f) => {
    const text = fs.readFileSync(path.join(root, b.dir, f), 'utf8').replace(/\r\n/g, '\n');
    // パネルに公開するのは、行頭で宣言された panel で始まる関数だけ（_ で終わる内部用は除く）
    for (const m of text.matchAll(/^function\s+(panel[A-Z]\w*)\s*\(/gm)) if (!m[1].endsWith('_')) exported.push(m[1]);
    parts.push('// ---- ' + b.dir + '/' + f + ' ----\n' + text.trim() + '\n');
  });
  if (!exported.length) throw new Error(b.dir + ' に panel で始まる関数がありません（パネル連携.gs）。');

  const body = [
    '// ============================================================',
    '// 自動生成ファイル。手で編集しない（Git にも入れない）。',
    '// 元: ' + b.dir + '/*.gs　生成: node scripts/build_panel.js',
    '// パネルから呼べるのは ' + b.name + '.' + exported.join(' / ' + b.name + '.') + ' だけ。',
    '// ============================================================',
    '',
    'var ' + b.name + ' = (function() {',
    parts.join('\n'),
    'return {',
    exported.map((n) => '  ' + n + ': ' + n).join(',\n'),
    '};',
    '})();',
    ''
  ].join('\n');

  // 文法エラーがあれば、ここで止める（Apps Script に反映してから気づくのを防ぐ）
  new vm.Script(body, { filename: b.out });
  return { body, exported };
}

function buildPanel() {
  const written = [];
  BUNDLES.forEach((b) => {
    const { body, exported } = buildBundle(b);
    fs.writeFileSync(path.join(root, PANEL_DIR, b.out), body, 'utf8');
    written.push(PANEL_DIR + '/' + b.out + '（' + b.name + ': ' + exported.join(', ') + '）');
  });
  return written;
}

module.exports = { buildPanel };

if (require.main === module) {
  try {
    buildPanel().forEach((w) => console.log('  生成: ' + w));
  } catch (e) {
    console.error('エラー: ' + e.message);
    process.exit(1);
  }
}
