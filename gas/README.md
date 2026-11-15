# GAS の改修ループ（Claude Code + clasp）

Apps Script のコードをこのリポジトリで編集し、コマンドで Apps Script に反映する。変更履歴は Git に残る。

フォルダ1つが Apps Script のプロジェクト1つに対応する。4つとも clasp で反映する。

| フォルダ | Apps Script のプロジェクト | 状態の確認 | 反映 |
| --- | --- | --- | --- |
| `01_ファイル登録` | アップロード画面app（Web アプリ） | `npm run gas:status:upload` | `npm run gas:push:upload` |
| `02-03_取込・整形App` | 取込・整形App（02 中間S生成と 03 DataRoad の2ファイル） | `npm run gas:status:import` | `npm run gas:push:import` |
| `04_閾値超過アラート` | 原価アラート | `npm run gas:status` | `npm run gas:push` |
| `05_自然言語検索` | 原価 自然言語検索（Web アプリ） | `npm run gas:status:nl` | `npm run gas:push:nl` |

プロジェクト ID やスプレッドシート ID などの環境ごとの値は、コードに直接書かず `config/env.json` に書く。各フォルダの `環境設定_自動生成.gs`（`const ENV`）と `.clasp.json` は、そこから `npm run env:render` で作る（手で編集しない）。反映のコマンドは、先に `env:render` を自動で実行する。

**Web アプリ（01・05）は、反映しただけでは公開中の版が変わらない。** 動作を確認したら、そのフォルダで `npx clasp list-deployments` で公開中のデプロイ ID（`@HEAD` でないほう）を確かめ、`npx clasp update-deployment <デプロイID> --description "<変更内容>"` で新しい版にする。URL は変わらない。反映前の確認は、`@HEAD` のデプロイ ID の URL の末尾を `/dev` にすると、最新のコードで開ける。

## 05_自然言語検索 の反映

- カタログ・辞書・テストセットの正は `nl_search/catalog/*.json` と `tests/nl_search/testset.json`。`カタログ_自動生成.gs` は手で編集しない。
- `npm run test:nl` で `カタログ_自動生成.gs` を作り直し、Claude・BigQuery を使わない部分（辞書・期間・検証・SQL の組み立て）を手元で検証する。
- `npm run gas:push:nl` は、上のテストに合格したときだけ Apps Script に反映する。
- Web アプリの公開範囲は `appsscript.json` の `webapp`（所有者として実行・組織内のみ）。コードを反映しても、公開中の Web アプリは「デプロイを管理」で新しいバージョンにするまで変わらない。
- スクリプトプロパティ `ANTHROPIC_API_KEY`（必須）と `CLAUDE_MODEL`（任意）は push しても変わらない。

## 初回のみの準備

1. リポジトリ直下で `npm install`（clasp を導入する）。
2. [script.google.com/home/usersettings](https://script.google.com/home/usersettings) で「Google Apps Script API」をオンにする。
3. リポジトリ直下で `npx clasp login` を実行し、ブラウザで許可する。認証情報はこの PC の `~/.clasprc.json` に保存され、Git には入らない。

## 修正するたびの流れ

1. 対象フォルダの `.gs` を編集する（Claude Code に依頼してよい）。
2. リポジトリ直下で、上の表の「状態の確認」のコマンドを実行し、反映されるファイルを確認する。
3. 上の表の「反映」のコマンドで Apps Script に反映する。
4. Apps Script のエディタで、確認したい関数を実行して動作を確認する（例: `testDryRun_2026_08` は送信せずログだけ出す）。
5. 動作を確認できたら、CLAUDE.md の Git 運用ルールに従い、コミットして push する。

## 注意

- **push は Apps Script 側のファイルを、手元のファイルで丸ごと置き換える。** Apps Script のエディタで直接編集した内容は、次の push で消える。エディタで直接直した場合は、先にそのフォルダで `npx clasp pull` を実行して手元に取り込み、内容を確認してからコミットする。
- トリガーとスクリプトプロパティ（Webhook URL）は push しても変わらない。
- `npm run gas:*` は対象フォルダに移動して clasp を実行する。フォルダを移動せずに `clasp push --project …` と指定すると、clasp のパス検査に弾かれる。
- `.clasp.json` の `scriptId` は場所を示す番号で、認証情報ではないためコミットしてよい。`.clasp.json` は `config/env.json` の `gas.*.scriptId` から自動生成する。`rootDir` は書かない。

## 別の GAS プロジェクトも反映したい場合

`config/env.json` にスクリプト ID を追加し、`scripts/render_env.js` でそのフォルダの `.clasp.json`（`scriptId` と `"fileExtension": "gs"`）を作るようにしたうえで、`package.json` の `scripts` に `gas:push` と同じ形の行を追加する。Apps Script のスクリプト ID は、プロジェクトの設定の「ID」で確認できる。push は `appsscript.json` も置き換えるため、フォルダ内の `appsscript.json` が Apps Script 側の最新と同じか、先に `clasp pull` で確認する。
