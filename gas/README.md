# GAS の改修ループ（Claude Code + clasp）

Apps Script のコードをこのリポジトリで編集し、コマンドで Apps Script に反映する。変更履歴は Git に残る。

現在 clasp で反映できるのは `04_閾値超過アラート` のみ（`01`〜`03` は従来どおり）。

## 初回のみの準備

1. リポジトリ直下で `npm install`（clasp を導入する）。
2. [script.google.com/home/usersettings](https://script.google.com/home/usersettings) で「Google Apps Script API」をオンにする。
3. リポジトリ直下で `npx clasp login` を実行し、ブラウザで許可する。認証情報はこの PC の `~/.clasprc.json` に保存され、Git には入らない。

## 修正するたびの流れ

1. `GAS/04_閾値超過アラート/` の `.gs` を編集する（Claude Code に依頼してよい）。
2. リポジトリ直下で `npm run gas:status` を実行し、反映されるファイルを確認する。
3. `npm run gas:push` で Apps Script に反映する。
4. Apps Script のエディタで、確認したい関数を実行して動作を確認する（例: `testDryRun_2026_08` は送信せずログだけ出す）。
5. 動作を確認できたら、CLAUDE.md の Git 運用ルールに従い、コミットして push する。

## 注意

- **push は Apps Script 側のファイルを、手元のファイルで丸ごと置き換える。** Apps Script のエディタで直接編集した内容は、次の push で消える。エディタで直接直した場合は、先に `cd GAS/04_閾値超過アラート && npx clasp pull` で手元に取り込み、内容を確認してからコミットする。
- トリガーとスクリプトプロパティ（Webhook URL）は push しても変わらない。
- `npm run gas:*` は `GAS/04_閾値超過アラート/` に移動して clasp を実行する。フォルダを移動せずに `clasp push --project …` と指定すると、clasp のパス検査に弾かれる。
- `.clasp.json` の `scriptId` は場所を示す番号で、認証情報ではないためコミットしてよい。`rootDir` は書かない。

## 別の GAS プロジェクトも反映したい場合

そのフォルダに `.clasp.json`（`scriptId` と `"fileExtension": "gs"`）を置き、`package.json` の `scripts` に `gas:push` と同じ形の行を追加する。Apps Script のスクリプト ID は、プロジェクトの設定の「ID」で確認できる。push は `appsscript.json` も置き換えるため、フォルダ内の `appsscript.json` が Apps Script 側の最新と同じか、先に `clasp pull` で確認する。
