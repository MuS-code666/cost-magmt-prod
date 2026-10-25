# 自然言語検索（原価）設計

「先月の第二工場の原価を製品別に前年と比べて」のような質問から、検索条件の候補を提示し、利用者が確認・選択してから BigQuery で集計する機能。

設計の土台は、共有された資料「自然言語検索 意味層設計」と「自然言語検索 成果物イメージ」（いずれも 2026-10 作成）。資料の仮の例を、本リポジトリの実テーブルに置き換えたのがこの文書。

## 決定事項（2026-10-25）

| 項目 | 決定 |
| --- | --- |
| 利用画面 | GAS の Web アプリ（`gas/05_自然言語検索/`、clasp で反映） |
| 条件への変換 | GAS から Claude API を呼ぶ。Claude は条件 JSON を返すだけで、SQL は書かない |
| 対象範囲 | `mart.v_variance` の原価系指標から開始（売上・利益・生産性は対象外） |
| 「部門」の扱い | 部門 = 工場。原価 CSV の「部門CD」は `factory_code` に取り込まれている |
| LLM に渡す指標 | 全件投入（指標 7 件。資料 07 の `mode: full`） |
| カタログと辞書の置き場所 | リポジトリの JSON（`catalog/`）を正とし、GAS に同梱する。資料は Sheets / BigQuery を想定しているが、保守者が少ないうちは Git で履歴を持つほうが確実なため |
| 会計年度 | 4月始まり。年度は開始年で呼ぶ（2026年度 = 2026-04〜2027-03） |
| クエリの実行主体（資料 Q7） | Web アプリを「自分（msudo）として実行」し、アクセスは組織内に限定する。見せる範囲は全員同じ。ログに利用者のメールアドレスを残す |
| Claude への送信範囲 | 質問文とカタログ（指標の定義・同義語）だけ。BigQuery のデータ行は送らない（`requirements.md` の「自然言語検索」節） |

## 構成

```
利用者 ─ 質問 ─▶ GAS Webアプリ
                  │ ① Claude API: 質問 → 条件 JSON（カタログの語彙だけで書く）
                  │ ② 辞書（catalog/aliases.json）: 値・期間を正式名称とトークンに確定
                  │ ③ カタログ（catalog/metrics.json）: 指標・集計式・許可する切り口を確定
                  │ ④ 検証 + dry run（見積もりバイト数）
                  ▼
           条件の候補（チップ）を提示 ── 利用者が確認・選択 ──▶ 実行
                                                             │ ⑤ SQL 組み立て（許可リスト + パラメータ）
                                                             ▼
                                              BigQuery explore.v_cost ─▶ 結果表
```

- ビュー: `sql/05_explore_v_cost作成.sql`（`explore.v_cost` と検索ログ `explore.nl_search_log`）
- 指標カタログ: `catalog/metrics.json`
- 値の辞書・期間トークン: `catalog/aliases.json`

## 2段階の流れ（候補提示 → 選択 → 実行）

資料 07 の「2段階（`two_step`）」は、指標が 30 件を超えたときに LLM へ渡す指標を絞る方式の名前。ここでいう2段階は利用者の操作の流れなので、以下では「確認フロー」と呼ぶ。

### 段階1: 解釈（`interpret`）

1. Claude が質問を条件 JSON に変換する（下記スキーマ）。不正な JSON なら 1 回だけ再生成する。
2. GAS が辞書・カタログで条件を確定する。確定できない項目は「候補」として返す。
   - 値のあいまい一致: 上位 3 件を候補にし、自動では確定しない
   - 用語の衝突（「原価」「差異」「予算」）: カタログの `conflicts` で既定を選び、既定を使ったことをチップに明示する（切り替えボタン付き）
   - 期間: トークンを今日の日付で展開し、「2026年9月」のように具体的な月で表示する
3. dry run で見積もりバイト数を出す。
4. 画面に条件チップ（指標・期間・絞り込み・切り口・比較）と見積もりを出す。範囲外の質問は `unsupported` として、代わりに確認できる見方を出す。

### 段階2: 実行（`execute`）

1. 利用者が確定した条件（チップの選択結果）を GAS に送る。
2. GAS は画面から来た条件を信用せず、段階1と同じ検証をやり直す（指標・列名は許可リスト、値は辞書で確定済みの正式名称のみ）。
3. SQL を組み立てて実行し、結果表を返す。実行した SQL は「SQL を見る」で表示できるようにする。

各段階の入出力は `explore.nl_search_log` に残す。

## 条件 JSON（Claude の出力）

```json
{
  "type": "breakdown",
  "metric_term": "原価",
  "metric": "total_cost",
  "period": "last_month",
  "filters": [{ "dim": "factory", "text": "第二工場" }],
  "group_by": ["product"],
  "compare": "prev_year",
  "order": { "by": "value", "dir": "desc" },
  "limit": 10
}
```

| キー | 取り得る値 | 必須 |
| --- | --- | --- |
| `type` | `aggregate` / `breakdown` / `compare` / `ranking` / `trend` / `unsupported` | 必須 |
| `metric_term` | 質問に出てきた指標の言い方そのまま（衝突解決とチップ表示に使う） | 必須（unsupported 以外） |
| `metric` | `metrics.json` の `metric_id` | 必須（unsupported 以外） |
| `period` | `aliases.json` の期間トークン | 必須（unsupported 以外）。質問にないときは `last_month` |
| `filters` | `dim` は factory / product / customer、`text` は利用者の言い方のまま（正式名称への変換は GAS が行う） | 任意 |
| `group_by` | factory / product / customer / month を 2 個まで | breakdown・ranking は 1 個以上、trend は `month` を含む |
| `compare` | `prev_year` / `prev_month` | compare は必須 |
| `order` | `by`: `value` / `diff` / `rate`、`dir`: `desc` / `asc` | ranking は必須。`diff`・`rate` は compare とセット |
| `limit` | 1〜50 | ranking は必須 |
| `reason`, `suggest` | unsupported のときの理由と代わりの型 | unsupported は必須 |

スキーマにないキーが含まれていたら、捨てずに拒否する（資料 14 の規則 1）。

### 型ごとの対応

| 型 | 質問の例 | 補足 |
| --- | --- | --- |
| 集計 aggregate | 先月の原価はいくら | group_by なし |
| 内訳 breakdown | 工場別・製品別に | |
| 比較 compare | 前年と比べてどう | 同じビューを比較先の期間で引き、切り口のキーで FULL OUTER JOIN する |
| ランキング ranking | 予算オーバーが大きい上位10製品 | 「ワースト」はこの型。月報・アラートのワーストNは「工場内の順位」なので、工場の絞り込みがない場合は全社順位になる旨を画面に出す |
| 推移 trend | 直近12か月の推移 | |
| 範囲外 unsupported | なぜ増えたのか／来期の予測／売上 | `catalog/metrics.json` の `out_of_scope` の文面を出す |

## SQL の組み立て規則

- 列名・ビュー名は `metrics.json` から来た固定の文字列だけを SQL に書き込む。利用者の入力や Claude の出力を SQL に直接入れない。
- 値（期間の開始・終了月、工場名・製品名・顧客名）はすべて BigQuery のクエリパラメータで渡す。パラメータは列名には使えないため、列名は上の許可リストで守る。
- `年月` の絞り込みは必須。`v_variance` はパーティション剪定が保証されないため（`sql/03` のコメント E）、ジョブに `maximumBytesBilled` を設定し、実行前の dry run で見積もりを出す。
- 行数は `limits.max_rows`（200）、ランキングは 50 件で打ち切る。

組み立て後の例（先月の第二成形工場の原価を製品別に）:

```sql
SELECT `製品`, SUM(`総原価`) AS value
FROM `cost-mgmt-prod-507701.explore.v_cost`
WHERE `年月` BETWEEN @start AND @end
  AND `工場` = @factory
GROUP BY `製品`
ORDER BY value DESC
LIMIT 200;
-- @start = 2026-09-01 / @end = 2026-09-01 / @factory = '第二成形工場'
```

## STEP 1 棚卸し（v_variance → explore.v_cost）

| v_variance の列 | 問題 | v_cost での対応 |
| --- | --- | --- |
| `target_month` | 英字の列名。パーティション剪定が保証されない | `年月`。GAS で絞り込み必須 |
| `factory_code` / `factory_name` | 利用者は「部門」とも呼ぶ | `工場`（「部門」は `dimensions` の同義語で吸収）。コードは突合用に別列 |
| `product_*` / `customer_*` | コードと名称が並ぶ | 名称を `製品` `顧客`、コードは突合用に別列 |
| `direct_material_cost` | 年月が原価の計上月ではなく生産月 | `直接材料費`。説明に明記 |
| `indirect_cost` | 配賦の基準が列名から分からない | `間接費`。説明に配賦の基準を明記 |
| `total_cost` | — | `総原価` |
| `budget_cost` | 実績生産がない月・製品は 0（予算なし） | `原価予算`。説明に明記 |
| `production_qty_kg` | — | `生産量kg`（kg当たり原価の分母） |
| `cost_budget_variance_amount` | 行の値。合計は再計算と一致 | 出さない。カタログで `総原価 − 原価予算` |
| `cost_budget_variance_rate` / `cost_yoy_rate` / `cost_per_production_kg` | 行単位の率。平均すると誤る | 出さない。カタログで額の合計から再計算 |
| `prior_year_total_cost` / `cost_yoy_amount` | 前年に実績があり当年にない製品が漏れる | 出さない。比較は同じビューを前年の期間で引く |
| `cost_budget_status` / `cost_budget_variance_rank` | 行単位の判定・順位 | 出さない。ランキング型で表現 |
| 売上・利益・生産性の列 | 対象範囲外。売上予算は顧客単位の値が製品行に複製される | 出さない |

## 未決事項

| # | 内容 | 決めること | 状態 |
| --- | --- | --- | --- |
| 1 | Claude のモデルと API キーの置き場所 | モデルはテストセットで比較して決める。キーはスクリプトプロパティに置き、リポジトリには入れない | 実装時 |
| 2 | 職種プリセット | 利用者が少ないうちは置かず、カタログの既定（`conflicts.default`）だけで運用する | 仮決定 |

## 進め方

| STEP | 成果物 | 状態 |
| --- | --- | --- |
| 1 棚卸し | 上の表 | 済 |
| 2 ビュー化 | `sql/05_explore_v_cost作成.sql`。BigQuery で作成し、v_variance との合計の突合と dry run（期間あり・なし）を記録する（`sql/06_explore_v_cost検証.sql`） | 済（下の検証記録） |
| 3 カタログと辞書 | `catalog/metrics.json`、`catalog/aliases.json` | 初版 |
| 4 テストセット | 30〜50 問と期待する条件 JSON（`tests/nl_search/`）。聞き返し・範囲外を 2〜3 割含める | 未着手 |
| 5 変換と改善 | GAS Web アプリ、5 要素（指標・切り口・期間・絞り込み・比較）の採点 | 未着手 |

## STEP 2 検証記録（2026-10-25、`sql/06_explore_v_cost検証.sql`）

| 項目 | 結果 | 判定 |
| --- | --- | --- |
| 突合（2024-04〜2027-03） | 36か月・1,608行。行数・総原価・直接材料費・間接費・原価予算・生産量の不一致 0か月。総原価 − 原価予算 と `cost_budget_variance_amount` の合計の不一致 0か月 | 合格 |
| dry run: 1か月に絞る（2-A） | 628.46 KB | — |
| dry run: 絞らない（2-B） | 642.13 KB | 剪定はほぼ効かない |

- 期間で絞っても読み込み量がほとんど減らない。`v_variance` の前年同月 CTE が月を1年ずらして結合しているため、期間の条件が元テーブルの剪定まで届かないと考えられる（`sql/03` のコメント E の想定どおり）。
- 現状は全期間でも 1 MB 未満で、オンデマンド課金の最低単位（1クエリ 10 MB）を下回るため、対応しない。
- `maximumBytesBilled` は 100 MB とする。全期間の読み込み量の 100 倍以上の余裕があり、データが想定外に増えたときだけ止まる。
- 実データの投入などで 2-B が 10 MB を超えたら再測定し、v_cost を `v_variance` 経由でなく history から直接組む（前年列を持たない）構成を検討する。

## 運用

- 週 1 回、`explore.nl_search_log` から「候補から選ばれた値」「切り替えられた指標」「範囲外になった質問」を集計し、`aliases.json` の追加（`source: "log"`）とカタログの同義語・`not_for` の見直しに使う。
- マスタに工場・製品・顧客を追加したら、同じ変更で `aliases.json` を見直す。
- 指標を追加するときは、先にテストセットにその指標の質問を足す。
