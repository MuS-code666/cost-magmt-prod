# 月報コメント生成プロンプト

- 用途: 原価月報の「部門別コメント」をClaudeに生成させる（Phase5 Task 5-4）
- 送信データの範囲: `requirements.md` の送信データポリシーに従う（ワーストN行＋部門集計のみ）
- 数値の役割分担: 数値の計算・整形はすべてSQL側で行う。Claudeは解釈・要因仮説・アクション提案のみ担当する

## 変更履歴

| 日付 | 変更内容・理由 |
| --- | --- |
| 2026-09-20 | 初版。数値を再計算させないため、万円・%への換算までSQLで済ませる構成にした。要因は単価/数量の内訳がv_varianceに無いため、データから言える範囲の仮説に限定した |

## 使い方

1. 下記「入力取得SQL」の `{{TARGET_MONTH}}` を対象月の初日（例: `2026-08-01`）に置き換え、BigQuery MCP（`execute_sql`）で2本とも実行する。`target_month` の絞り込みは必須（省略・全期間スキャンは禁止）。
2. 実行結果（クエリA・クエリB）を、下記「生成ルール」とあわせてClaudeに渡し、月報コメントを生成させる。
3. 生成後は Task 5-5 の突合手順で、コメント内の全数値が入力結果と一致することを確認する。

## 入力取得SQL

### クエリA: 部門別ワースト10行

`cost_budget_variance_rank` は `v_variance` の共通定義（年月×部門内で原価予算差異額が大きい順）。Looker Studio P3と同じ。

```sql
SELECT
  factory_code,
  factory_name,
  cost_budget_variance_rank AS rank,
  product_code,
  product_name,
  customer_name,
  cost_budget_status,
  ROUND(total_cost / 10000, 1) AS total_cost_man,
  ROUND(budget_cost / 10000, 1) AS budget_cost_man,
  ROUND(cost_budget_variance_amount / 10000, 1) AS variance_man,
  ROUND(cost_budget_variance_rate * 100, 1) AS variance_pct,
  ROUND(SAFE_DIVIDE(direct_material_cost, total_cost) * 100, 1) AS direct_material_share_pct,
  ROUND(defect_rate * 100, 1) AS defect_rate_pct,
  ROUND(productivity_vs_standard_rate, 2) AS productivity_vs_standard,
  ROUND(prior_year_total_cost / 10000, 1) AS prior_year_cost_man,
  ROUND(cost_yoy_amount / 10000, 1) AS cost_yoy_man,
  ROUND(cost_yoy_rate * 100, 1) AS cost_yoy_pct
FROM `cost-mgmt-prod-507701.mart.v_variance`
WHERE target_month = DATE '{{TARGET_MONTH}}'
  AND cost_budget_variance_rank <= 10
ORDER BY factory_code, cost_budget_variance_rank
```

### クエリB: 部門集計

```sql
SELECT
  factory_code,
  factory_name,
  COUNT(*) AS product_count,
  COUNTIF(cost_budget_status = 'OVER_BUDGET') AS over_budget_count,
  COUNTIF(cost_budget_status = 'NO_BUDGET') AS no_budget_count,
  ROUND(SUM(total_cost) / 10000, 1) AS total_cost_man,
  ROUND(SUM(budget_cost) / 10000, 1) AS budget_cost_man,
  ROUND(SUM(cost_budget_variance_amount) / 10000, 1) AS variance_man,
  ROUND(SAFE_DIVIDE(SUM(cost_budget_variance_amount), NULLIF(SUM(budget_cost), 0)) * 100, 1) AS variance_pct
FROM `cost-mgmt-prod-507701.mart.v_variance`
WHERE target_month = DATE '{{TARGET_MONTH}}'
GROUP BY factory_code, factory_name
ORDER BY factory_code
```

## 生成ルール（Claudeへの指示）

あなたは製造業の原価管理担当者を補佐するアナリストです。上記クエリA・Bの結果だけを根拠に、部門ごとの月報コメントを作成してください。

### 数値のルール（最重要）

- 数値は入力の列の値を一字一句そのまま引用する。単位は列名に従う（`_man` = 万円、`_pct` = %、`productivity_vs_standard` = 倍率）。
- 足し算・引き算・割合の計算、丸め直し、単位換算はしない。「約8割」「およそ半分」のような派生表現も禁止する。
- 入力に存在しない数値は書かない。必要な数値が無い場合は書かずに、末尾の「追加確認が必要なデータ」に、必要な集計の内容を書く。
- 差異は符号付きで書く（超過は `+`、未達は `-`）。`variance_pct` が NULL の行は「予算なし」と書く。
- 順位は `rank` の値のみ使う。

### 内容のルール

- 「超過」と書いてよいのは `cost_budget_status = 'OVER_BUDGET'` の行だけ。`WITHIN_BUDGET` の行は超過として扱わない。
- 部門集計（クエリB）が予算内でも、製品単位の超過は報告する。その場合は「部門全体では予算内だが、個別製品で超過が出ている」という関係を明記する。
- 要因は、入力列（`direct_material_share_pct`、`defect_rate_pct`、`productivity_vs_standard`、`cost_yoy_*`）から言えることに限る。単価差異・数量差異の内訳は入力に無いため、断定しない。推測は「〜の可能性がある」と書き、仮説であることを明示する。
- `productivity_vs_standard` は 1 より大きいほど標準より高効率、小さいほど低効率。
- 前年比（`cost_yoy_*`）は総原価の比較であり、生産量の違いを含む。`prior_year_cost_man` が 0 の行は前年データなしとして扱い、前年比に言及しない。
- 部署名・個人名は創作しない。担当は機能名（購買、生産技術、営業など）で示してよい。

### 出力形式

部門ごとに、次の4見出しで出力する（各見出し1〜2文、部門あたり300字程度）。

```
■ {factory_name}（{factory_code}）
【主要差異】rank=1の製品を中心に、予算比の金額と率を書く。率が特に大きい製品があれば、入力の中から1件だけ補足してよい。
【要因】入力列から言える範囲の要因と、その仮説。
【コメント】部門全体の収支（クエリB）との関係、前年同月との比較など。
【次月アクション】確認・打診レベルの具体的な行動を1〜2件。
```

全部門の後に、次の見出しを1つ付ける（無ければ「なし」）。

```
【追加確認が必要なデータ】コメントの精度を上げるために必要だが入力に無かったデータ。
```

出力例（形式の参考。数値・製品・要因は実データに置き換えること）:

```
■ 第二成形工場（300002）
【主要差異】製品P48が予算比+42.7万円（+25.7%）で部門内最大の超過。
【要因】直接材料費比率が87.5%と高く、材料費の動きが総原価に効きやすい構成。単価と数量のどちらが主因かは入力からは判別できない。
【コメント】部門全体では予算比-242.3万円（-10%）で予算内。個別製品の超過が他製品の未達で相殺されている。
【次月アクション】P48の材料の調達単価と使用量の推移を確認し、超過の主因を切り分ける。
```
