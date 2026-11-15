// 新しい環境（顧客の Google Cloud・Apps Script）を config/env.json の値で作る。
// 手順の全体は docs/環境構築手順.md を参照。
//
// 使い方（リポジトリ直下で）:
//   npm run setup -- check              読むだけ。環境の状態を一覧で確かめる
//   npm run setup -- bigquery [--apply] BigQuery の API 有効化・データセット・テーブル・ビューを作る
//   npm run setup -- iam [--apply]      開発者・実行用アカウント・読み取り専用 SA の権限を付ける
//   npm run setup -- gas [--apply]      Apps Script のプロジェクトを作り（scriptId が空のもの）、コードを反映する
//
// --apply を付けないときは、実行するコマンドを表示するだけで何も変更しない。
// どのステップも、すでにあるもの（データセット・テーブル・SA・スクリプト）は作り直さずに飛ばす。
// 別の設定ファイルを使うとき: 環境変数 COST_MGMT_ENV=config/env.顧客名.json

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadEnv, renderAll } = require('./render_env');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const step = args.find((a) => !a.startsWith('--'));
const APPLY = args.includes('--apply');

// sql/ のうち新しい環境で流すもの（04 は旧環境向けの列追加、06 は検証用なので流さない）
const SQL_FILES = [
  { file: '01_マスタ用データセット作成.sql', dataset: 'master', kind: 'tables' },
  { file: '02_ヒストリー用データセット作成.sql', dataset: 'history', kind: 'tables' },
  { file: '03_v_variance作成.sql', dataset: 'mart', kind: 'views' },
  { file: '05_explore_v_cost作成.sql', dataset: 'explore', kind: 'views' }
];
const DATASETS = [
  { id: 'master', description: 'マスタ（製品・顧客・工場などの台帳）' },
  { id: 'history', description: '月次実績（売上・生産・原価・予算など）' },
  { id: 'mart', description: '集計ビュー（v_variance）' }
  // explore は sql/05 の CREATE SCHEMA で作る
];
const GAS_PROJECTS = [
  { key: 'fileUpload', dir: 'GAS/01_ファイル登録', title: 'アップロード画面app' },
  { key: 'importApp', dir: 'GAS/02-03_取込・整形App', title: '取込・整形App' },
  { key: 'alert', dir: 'GAS/04_閾値超過アラート', title: '原価アラート' },
  { key: 'nlSearch', dir: 'GAS/05_自然言語検索', title: '原価 自然言語検索' }
];

// ---------------------------------------------------------------
// コマンド実行
// ---------------------------------------------------------------

// bq は Python 製で、Windows では標準入力を Shift_JIS として読む。日本語の列名を含む SQL を正しく渡すため UTF-8 モードにする
const SPAWN_ENV = Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });

const quote = (s) => (/^[A-Za-z0-9_\-.:=/@]+$/.test(s) ? s : '"' + String(s).replace(/"/g, '\\"') + '"');

// 読むだけのコマンド。--apply に関係なく実行する
function query(cmd, cmdArgs, options) {
  const r = spawnSync([cmd].concat(cmdArgs.map(quote)).join(' '), Object.assign({ shell: true, encoding: 'utf8', env: SPAWN_ENV }, options || {}));
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// 変更するコマンド。--apply のときだけ実行し、それ以外は表示するだけ
function change(label, cmd, cmdArgs, options) {
  const line = [cmd].concat(cmdArgs.map(quote)).join(' ');
  if (!APPLY) {
    console.log('  [実行予定] ' + label + '\n      ' + line);
    return true;
  }
  console.log('  [実行] ' + label);
  const r = spawnSync(line, Object.assign({ shell: true, encoding: 'utf8', env: SPAWN_ENV }, options || {}));
  if (r.status !== 0) {
    console.error('      失敗: ' + ((r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' / ')));
    return false;
  }
  return true;
}

function need(env, unfilled, keys) {
  // access.developers のような配列は access.developers.0 などとして記録されるので、前方一致で見る
  const missing = keys.filter((k) => unfilled.some((u) => u === k || u.startsWith(k + '.')));
  if (missing.length) {
    throw new Error('config/env.json に先に記入してください: ' + missing.join(', '));
  }
}

const saEmail = (env) => env.access.readonlyServiceAccount + '@' + env.gcp.projectId + '.iam.gserviceaccount.com';

function listTables(project, dataset) {
  const r = query('bq', ['ls', '--format=json', '--max_results=1000', project + ':' + dataset]);
  if (!r.ok) return null; // データセットが無い
  try { return JSON.parse(r.out || '[]').map((t) => t.tableReference.tableId); } catch (e) { return []; }
}

// ---------------------------------------------------------------
// check: 読むだけ
// ---------------------------------------------------------------

function stepCheck(env, unfilled) {
  const p = env.gcp.projectId;
  const rows = [];
  const add = (item, ok, note) => rows.push({ item, ok, note: note || '' });

  add('config/env.json の記入', unfilled.length === 0, unfilled.length ? '未記入: ' + unfilled.join(', ') : '');

  const acct = query('gcloud', ['config', 'get-value', 'account']);
  add('gcloud のログイン', acct.ok && !!acct.out, acct.out || 'gcloud auth login が必要');

  if (unfilled.includes('gcp.projectId')) return print(rows);

  const proj = query('gcloud', ['projects', 'describe', p, '--format=value(projectId)']);
  const reauth = /Reauthentication|refreshing your current auth tokens/.test(proj.err);
  add('GCP プロジェクト', proj.ok, proj.ok ? p : (reauth ? 'gcloud の再ログインが必要（gcloud auth login）' : '見つからないか、権限がない'));
  if (!proj.ok) return print(rows);

  const bill = query('gcloud', ['billing', 'projects', 'describe', p, '--format=value(billingEnabled)']);
  add('請求先アカウントの紐付け', bill.out === 'True', bill.ok ? (bill.out === 'True' ? '' : '未設定') : '確認できない（課金の閲覧権限がない）');

  const api = query('gcloud', ['services', 'list', '--enabled', '--project', p, '--filter=config.name=bigquery.googleapis.com', '--format=value(config.name)']);
  add('BigQuery API', api.out.includes('bigquery'), api.out ? '' : '無効');

  SQL_FILES.forEach((s) => {
    const tables = listTables(p, s.dataset);
    add('データセット ' + s.dataset, tables !== null, tables === null ? '無い' : (tables.length + ' 個のテーブル・ビュー'));
  });

  const sa = query('gcloud', ['iam', 'service-accounts', 'describe', saEmail(env), '--project', p, '--format=value(email)']);
  add('読み取り専用 SA', sa.ok, sa.ok ? saEmail(env) : '無い');

  const pol = query('gcloud', ['projects', 'get-iam-policy', p, '--format=json']);
  if (pol.ok) {
    const bindings = JSON.parse(pol.out).bindings || [];
    const hasRole = (member, role) => bindings.some((b) => b.role === role && (b.members || []).includes(member));
    const people = env.access.developers.map((m) => ({ who: '開発者', m, roles: ['roles/bigquery.user', 'roles/bigquery.dataEditor'] }))
      .concat([{ who: '実行用', m: env.access.runner, roles: ['roles/bigquery.jobUser', 'roles/bigquery.dataEditor'] }])
      .concat([{ who: '読み取り専用 SA', m: 'serviceAccount:' + saEmail(env), roles: ['roles/bigquery.jobUser', 'roles/bigquery.dataViewer'] }]);
    people.forEach(({ who, m, roles }) => {
      const lack = roles.filter((r) => !hasRole(m, r) && !hasRole(m, 'roles/owner') && !hasRole(m, 'roles/bigquery.admin'));
      add('権限（' + who + '） ' + m.replace(/^\w+:/, ''), lack.length === 0, lack.length ? '不足: ' + lack.join(', ') : '');
    });
  } else {
    add('IAM ポリシー', false, '読めない（権限がない）');
  }

  const scripts = query('npx', ['clasp', 'list-scripts'], { cwd: root });
  GAS_PROJECTS.forEach((g) => {
    const id = env.gas[g.key].scriptId;
    const found = id && scripts.out.includes(id);
    add('Apps Script ' + g.title, !!found, !id ? 'scriptId が空（未作成）' : (found ? '' : 'clasp から見えない（未ログインか権限なし）'));
  });

  return print(rows);
}

function print(rows) {
  console.log('');
  rows.forEach((r) => console.log((r.ok ? '  ○ ' : '  × ') + r.item + (r.note ? '  … ' + r.note : '')));
  const ng = rows.filter((r) => !r.ok).length;
  console.log('\n' + (ng ? ng + ' 件の確認が必要です。' : 'すべて揃っています。'));
  return ng === 0;
}

// ---------------------------------------------------------------
// bigquery: API・データセット・テーブル・ビュー
// ---------------------------------------------------------------

function stepBigquery(env, unfilled) {
  need(env, unfilled, ['gcp.projectId']);
  const p = env.gcp.projectId;
  const loc = env.gcp.location;
  renderAll(); // build/sql を最新にする

  change('BigQuery API を有効にする', 'gcloud', ['services', 'enable', 'bigquery.googleapis.com', '--project', p]);

  DATASETS.forEach((d) => {
    if (listTables(p, d.id) !== null) return console.log('  [済み] データセット ' + d.id);
    change('データセット ' + d.id + ' を作る（' + loc + '）', 'bq', ['--location=' + loc, 'mk', '--dataset', '--description', d.description, p + ':' + d.id]);
  });

  SQL_FILES.forEach((s) => {
    const sql = fs.readFileSync(path.join(root, 'build/sql', s.file), 'utf8');
    if (s.kind === 'tables') {
      const existing = listTables(p, s.dataset) || [];
      if (existing.length) {
        return console.log('  [飛ばす] ' + s.file + '（' + s.dataset + ' にテーブルがすでにある: ' + existing.length + ' 個）');
      }
    }
    // 流す前に dry run（見積もりだけ）で文法と参照先を確かめ、エラーなら止める
    if (APPLY) {
      const dry = query('bq', ['query', '--dry_run', '--use_legacy_sql=false', '--project_id=' + p, '--location=' + loc], { input: sql });
      if (!dry.ok) throw new Error(s.file + ' の確認（dry run）でエラー: ' + (dry.err || dry.out).split('\n').slice(-2).join(' / '));
    }
    // ビュー（CREATE OR REPLACE）と IF NOT EXISTS は何度流しても同じ結果になる
    if (!change(s.file + ' を流す', 'bq', ['query', '--use_legacy_sql=false', '--project_id=' + p, '--location=' + loc], { input: sql })) {
      throw new Error(s.file + ' を流せませんでした。上のエラーを確認してください。');
    }
  });
}

// ---------------------------------------------------------------
// iam: 権限
// ---------------------------------------------------------------

function stepIam(env, unfilled) {
  need(env, unfilled, ['gcp.projectId', 'access.developers', 'access.runner']);
  const p = env.gcp.projectId;
  const sa = saEmail(env);
  const bind = (member, role) =>
    change(member + ' に ' + role, 'gcloud', ['projects', 'add-iam-policy-binding', p, '--member=' + member, '--role=' + role, '--condition=None', '--quiet', '--format=none']);

  env.access.developers.forEach((m) => {
    bind(m, 'roles/bigquery.user');
    bind(m, 'roles/bigquery.dataEditor');
  });
  bind(env.access.runner, 'roles/bigquery.jobUser');
  bind(env.access.runner, 'roles/bigquery.dataEditor');

  const exists = query('gcloud', ['iam', 'service-accounts', 'describe', sa, '--project', p, '--format=value(email)']).ok;
  if (exists) {
    console.log('  [済み] 読み取り専用 SA ' + sa);
  } else {
    change('読み取り専用 SA を作る', 'gcloud', ['iam', 'service-accounts', 'create', env.access.readonlyServiceAccount,
      '--display-name', 'BigQuery 読み取り専用（Claude Code の MCP 用）', '--project', p]);
  }
  bind('serviceAccount:' + sa, 'roles/bigquery.jobUser');
  bind('serviceAccount:' + sa, 'roles/bigquery.dataViewer');

  // 鍵ファイルは作らない。開発者がこの SA になりすまして読む（組織ポリシーで鍵の作成が禁止されていても使える）
  env.access.developers.forEach((m) => {
    change(m + ' がこの SA になりすませるようにする', 'gcloud', ['iam', 'service-accounts', 'add-iam-policy-binding', sa,
      '--member=' + m, '--role=roles/iam.serviceAccountTokenCreator', '--project', p, '--quiet', '--format=none']);
  });

  console.log('\n  Claude Code から BigQuery を読むには、各開発者が自分の PC で次を1回実行する（ブラウザで許可）:');
  console.log('      gcloud auth application-default login --impersonate-service-account=' + sa);
}

// ---------------------------------------------------------------
// gas: Apps Script のプロジェクト作成と反映
// ---------------------------------------------------------------

function stepGas(env, file, unfilled) {
  // GAS が開くスプレッドシート・フォルダの ID は先に必要（docs/環境構築手順.md の Drive の手順）
  need(env, unfilled, ['gcp.projectId', 'gas.fileUpload', 'gas.importApp']);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  let created = false;

  GAS_PROJECTS.forEach((g) => {
    if (env.gas[g.key].scriptId) return console.log('  [済み] ' + g.title + '（' + env.gas[g.key].scriptId + '）');
    if (!APPLY) return console.log('  [実行予定] Apps Script のプロジェクト「' + g.title + '」を作り、scriptId を config/env.json に書く\n      npx clasp create-script --type standalone --title ' + quote(g.title));
    // 作業フォルダの appsscript.json を上書きしないよう、一時フォルダで作って scriptId だけ受け取る
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clasp-create-'));
    console.log('  [実行] Apps Script のプロジェクト「' + g.title + '」を作る');
    const r = spawnSync(['npx', '--prefix', quote(root), 'clasp', 'create-script', '--type', 'standalone', '--title', quote(g.title)].join(' '),
      { shell: true, encoding: 'utf8', cwd: tmp });
    const claspFile = path.join(tmp, '.clasp.json');
    if (r.status !== 0 || !fs.existsSync(claspFile)) {
      throw new Error(g.title + ' を作れませんでした: ' + (r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' / '));
    }
    const id = JSON.parse(fs.readFileSync(claspFile, 'utf8')).scriptId;
    fs.rmSync(tmp, { recursive: true, force: true });
    raw.gas[g.key].scriptId = id;
    env.gas[g.key].scriptId = id;
    created = true;
    console.log('      scriptId: ' + id);
  });

  if (created) {
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    console.log('  config/env.json に scriptId を書きました。');
  }

  if (APPLY) renderAll(path.relative(root, file));
  GAS_PROJECTS.forEach((g) => {
    if (!env.gas[g.key].scriptId && APPLY) return;
    change(g.title + ' にコードを反映する', 'npx', ['--prefix', root, 'clasp', 'push', '--force'], { cwd: path.join(root, g.dir) });
  });
}

// ---------------------------------------------------------------

function main() {
  const steps = { check: stepCheck, bigquery: stepBigquery, iam: stepIam, gas: stepGas };
  if (!steps[step]) {
    console.log('使い方: npm run setup -- <check|bigquery|iam|gas> [--apply]');
    process.exit(1);
  }
  const { env, file, unfilled } = loadEnv(undefined, { allowUnfilled: true });
  console.log('環境: ' + env.envName + '（' + path.relative(root, file) + '）  ステップ: ' + step +
    (step === 'check' ? '' : (APPLY ? '  ※変更を実行します' : '  ※表示のみ（--apply で実行）')));
  const ok = step === 'gas' ? stepGas(env, file, unfilled) : steps[step](env, unfilled);
  if (step === 'check' && !ok) process.exit(1);
}

try {
  main();
} catch (e) {
  console.error('エラー: ' + e.message);
  process.exit(1);
}
