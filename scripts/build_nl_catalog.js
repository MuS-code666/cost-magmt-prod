// 自然言語検索のカタログ・辞書・テストセット（JSON）を、GAS に同梱する .gs に変換する。
// 正は nl_search/catalog/*.json と tests/nl_search/testset.json。生成物は手で編集しない。
// 使い方: リポジトリ直下で npm run nl:build（npm run gas:push:nl からも呼ばれる）

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

const sources = [
  ['NL_CATALOG', 'nl_search/catalog/metrics.json'],
  ['NL_ALIASES', 'nl_search/catalog/aliases.json'],
  ['NL_TESTSET', 'tests/nl_search/testset.json']
];

const lines = [
  '// ============================================================',
  '// 自動生成ファイル。手で編集しない。',
  '// 元データ: ' + sources.map((s) => s[1]).join(', '),
  '// 再生成: リポジトリ直下で npm run nl:build',
  '// ============================================================',
  ''
];
sources.forEach(([name, file]) => {
  lines.push('const ' + name + ' = ' + JSON.stringify(read(file), null, 2) + ';');
  lines.push('');
});

const out = path.join(root, 'gas', '05_自然言語検索', 'カタログ_自動生成.gs');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n'), 'utf8');
console.log('生成しました: ' + path.relative(root, out));
