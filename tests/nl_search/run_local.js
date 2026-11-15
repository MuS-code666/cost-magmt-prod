// 自然言語検索の「Claude 以外」の処理を手元で検証する（BigQuery・Claude には接続しない）。
// テストセットの期待値を「Claude が理想どおりに返した出力」として流し、
// 辞書照合・期間の展開・既定の明示・SQL の組み立て・画面から来る条件の検証を確かめる。
// 使い方: リポジトリ直下で npm run test:nl

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const gasDir = path.join(root, 'gas', '05_自然言語検索');

// GAS と同じく、全ファイルを1つのグローバルスコープで読み込む
const context = vm.createContext({ console: console });
const files = ['カタログ_自動生成.gs', '設定.gs', '条件の確定.gs', 'SQL.gs', '条件変換.gs', 'テスト.gs'];
vm.runInContext(files.map((f) => fs.readFileSync(path.join(gasDir, f), 'utf8')).join('\n;\n') +
  '\n;globalThis.__nl = { NL_CATALOG, NL_TESTSET, nlResolve_, nlParsePeriod_, nlBuildQuery_, nlValidateCondition_, ' +
  'nlScoreCase_, nlScoreReport_, nlSystemPrompt_, nlOutputSchema_, nlResolveValue_, nlSqlForDisplay_ };', context);
const nl = context.__nl;

// サンプルデータのマスタ（既成ファイル/中間テーブル.xlsx: 工場2・製品50・顧客25）
const pad = (n) => ('0' + n).slice(-2);
const masters = {
  factory: ['第一成形工場', '第二成形工場'],
  product: Array.from({ length: 50 }, (_, i) => '成形部品P' + pad(i + 1)),
  customer: Array.from({ length: 25 }, (_, i) => '顧客企業' + pad(i + 1) + '株式会社')
};

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) { failures++; console.log('NG ' + name + (detail ? ': ' + detail : '')); }
};
const today = nl.NL_TESTSET.today;

// ------------------------------------------------------------
// 1. テストセット: 期待値をそのまま Claude の出力として流す（満点になるはず）
// ------------------------------------------------------------
function llmFromExpected(c) {
  const e = c.expected;
  if (c.status === 'unsupported') {
    return { type: 'unsupported', metric: 'none', metric_term: '', period: '', filters: [], group_by: [],
      compare: 'none', order_by: 'none', order_dir: 'desc', limit: 0, unsupported_reason: e.reason };
  }
  return {
    type: e.type, metric: e.metric, metric_term: '', period: e.period,
    filters: e.filters.map((f) => ({ dim: f.dim, text: f.text })),
    group_by: e.group_by, compare: e.compare || 'none',
    order_by: e.order ? e.order.by : 'none', order_dir: e.order ? e.order.dir : 'desc', limit: e.limit || 0,
    unsupported_reason: 'none'
  };
}
const results = nl.NL_TESTSET.cases.map((c) => nl.nlScoreCase_(c, llmFromExpected(c), masters, today));
results.filter((r) => r.detail.length).forEach((r) => check('testset ' + r.id, false, r.detail.join(' / ')));
console.log(nl.nlScoreReport_(results).split('\n').slice(0, 8).join('\n'));

// ------------------------------------------------------------
// 2. Claude が年なし・相対の書き方で返しても、同じ期間に確定する
// ------------------------------------------------------------
const periods = [
  ['last_month', 'last_month', '2026-09-01', '2026-09-01'],
  ['this_month', 'this_month', '2026-10-01', '2026-10-01'],
  ['month(9)', 'month(2026-09)', '2026-09-01', '2026-09-01'],
  ['month(11)', 'month(2025-11)', '2025-11-01', '2025-11-01'],
  ['month(2026-9)', 'month(2026-09)', '2026-09-01', '2026-09-01'],
  ['last_n_months(3)', 'last_n_months(3)', '2026-07-01', '2026-09-01'],
  ['last_n_months(12)', 'last_n_months(12)', '2025-10-01', '2026-09-01'],
  ['range(2025-04,2025-09)', 'range(2025-04,2025-09)', '2025-04-01', '2025-09-01'],
  ['current_fiscal_year', 'current_fiscal_year', '2026-04-01', '2026-09-01'],
  ['previous_fiscal_year', 'fiscal_year(2025)', '2025-04-01', '2026-03-01'],
  ['fiscal_year(2025)', 'fiscal_year(2025)', '2025-04-01', '2026-03-01'],
  ['fiscal_half(H1)', 'fiscal_half(2026,H1)', '2026-04-01', '2026-09-01'],
  ['fiscal_half(2025,H2)', 'fiscal_half(2025,H2)', '2025-10-01', '2026-03-01']
];
periods.forEach(([token, canonical, start, end]) => {
  const p = nl.nlParsePeriod_(token, today);
  check('period ' + token, p.token === canonical && p.start === start && p.end === end, JSON.stringify(p));
});
check('期首月の今期は当月のみ（速報）', (() => {
  const p = nl.nlParsePeriod_('current_fiscal_year', '2026-04-10');
  return p.start === '2026-04-01' && p.end === '2026-04-01' && p.partial;
})());
['month(13)', 'last_n_months(37)', 'range(2026-09,2026-01)', 'yesterday', ''].forEach((t) => {
  let threw = false;
  try { nl.nlParsePeriod_(t, today); } catch (e) { threw = true; }
  check('不正な期間を拒否 ' + JSON.stringify(t), threw);
});

// ------------------------------------------------------------
// 3. 値の辞書
// ------------------------------------------------------------
[
  ['factory', '第一工場', '第一成形工場'], ['factory', '第2工場', '第二成形工場'], ['factory', '第二成形工場', '第二成形工場'],
  ['factory', '２工場', '第二成形工場'], ['product', 'P5', '成形部品P05'], ['product', '部品p12', '成形部品P12'],
  ['product', '成形部品P50', '成形部品P50'], ['customer', '顧客3', '顧客企業03株式会社'],
  ['customer', '顧客企業12', '顧客企業12株式会社'], ['customer', '顧客企業07（株）', '顧客企業07株式会社']
].forEach(([dim, text, value]) => {
  const r = nl.nlResolveValue_(dim, text, masters);
  check('辞書 ' + text, r.status === 'ok' && r.value === value, JSON.stringify(r));
});
check('辞書 第三工場は候補を出す', (() => {
  const r = nl.nlResolveValue_('factory', '第三工場', masters);
  return r.status === 'choice' && r.candidates.length === 2;
})());
check('辞書 P60 は見つからない', nl.nlResolveValue_('product', 'P60', masters).status !== 'ok');

// ------------------------------------------------------------
// 4. SQL: 期待値どおりの条件で組み立て、値が SQL 本文に入らないことを確かめる
// ------------------------------------------------------------
const okCases = nl.NL_TESTSET.cases.filter((c) => c.status === 'ok');
okCases.forEach((c) => {
  const res = nl.nlResolve_(llmFromExpected(c), c.question, today, masters);
  const q = nl.nlBuildQuery_(res.condition, res.period);
  const leaked = res.condition.filters.some((f) => q.sql.indexOf(f.value) >= 0);
  check('SQL ' + c.id + ' 値はパラメータで渡す', !leaked);
  check('SQL ' + c.id + ' 年月の絞り込みあり', /`年月` BETWEEN @start AND @end/.test(q.sql));
  check('SQL ' + c.id + ' LIMIT あり', /\nLIMIT \d+$/.test(q.sql));
});
['T009', 'T020', 'T026', 'T031'].forEach((id) => {
  const c = okCases.find((x) => x.id === id);
  const res = nl.nlResolve_(llmFromExpected(c), c.question, today, masters);
  console.log('\n--- ' + id + ' ' + c.question + '\n' + nl.nlSqlForDisplay_(nl.nlBuildQuery_(res.condition, res.period)));
});

// ------------------------------------------------------------
// 5. 画面から来る条件の検証（画面の値は信用しない）
// ------------------------------------------------------------
const good = { metric: 'total_cost', period: 'last_month', filters: [{ dim: 'factory', value: '第一成形工場' }],
  group_by: ['product'], compare: 'prev_year', order: { by: 'diff', dir: 'desc' }, limit: 5 };
check('検証 正しい条件は通る', nl.nlValidateCondition_(good, today, masters).ok);
const bad = [
  ['未知のキー', Object.assign({}, good, { sql: 'DROP TABLE x' })],
  ['未知の指標', Object.assign({}, good, { metric: 'sales' })],
  ['マスタにない値', Object.assign({}, good, { filters: [{ dim: 'factory', value: "x' OR '1'='1" }] })],
  ['列名の差し込み', Object.assign({}, good, { group_by: ['`製品`; DROP'] })],
  ['切り口が多すぎる', Object.assign({}, good, { group_by: ['product', 'factory', 'customer'] })],
  ['差で並べるのに比較なし', Object.assign({}, good, { compare: null })],
  ['件数が上限超え', Object.assign({}, good, { limit: 1000 })],
  ['件数が小数', Object.assign({}, good, { limit: 2.5 })],
  ['期間が不正', Object.assign({}, good, { period: 'range(2020-01,2026-12)' })],
  ['絞り込みに余計なキー', Object.assign({}, good, { filters: [{ dim: 'factory', value: '第一成形工場', op: 'LIKE' }] })]
];
bad.forEach(([name, cond]) => check('検証 拒否: ' + name, !nl.nlValidateCondition_(cond, today, masters).ok));

// ------------------------------------------------------------
// 6. プロンプトとスキーマ
// ------------------------------------------------------------
const prompt = nl.nlSystemPrompt_();
check('プロンプトが質問によらず同じ', prompt === nl.nlSystemPrompt_());
check('スキーマが JSON にできる', !!JSON.stringify(nl.nlOutputSchema_()));
console.log('\nシステムプロンプト: ' + prompt.length + '文字');

console.log(failures === 0 ? '\nすべて合格' : '\n不合格 ' + failures + '件');
process.exitCode = failures === 0 ? 0 : 1;
