-- ================================================================
-- 自然言語検索 STEP 2 の検証: explore.v_cost
--
-- 1. 突合: v_cost の月別合計が mart.v_variance と一致するか
-- 2. dry run: 年月で絞ったときに読み込み量が減るか（パーティション剪定）
--
-- 各クエリは単独で選択して実行する。結果は nl_search/README.md の
-- 「STEP 2 検証記録」に残す。
-- ================================================================


-- ----------------------------------------------------------------
-- 1. 突合（期待: mismatched_months = 0、variance_mismatched_months = 0）
--    月別に 行数・総原価・直接材料費・間接費・原価予算・生産量 を比べる。
--    間接費は配賦計算で小数が出るため、1円未満の差は一致とみなす。
--    あわせて、カタログの「総原価 − 原価予算」が v_variance の
--    cost_budget_variance_amount の合計（月報・アラートの値）と一致するかも見る。
-- ----------------------------------------------------------------
WITH
v_cost_monthly AS (
  SELECT
    `年月` AS target_month,
    COUNT(*) AS row_count,
    SUM(`総原価`) AS total_cost,
    SUM(`直接材料費`) AS direct_material_cost,
    SUM(`間接費`) AS indirect_cost,
    SUM(`原価予算`) AS budget_cost,
    SUM(`生産量kg`) AS production_qty_kg,
    SUM(`総原価`) - SUM(`原価予算`) AS budget_variance
  FROM `cost-mgmt-prod-507701.explore.v_cost`
  WHERE `年月` BETWEEN '2024-04-01' AND '2027-03-01'
  GROUP BY 1
),
v_variance_monthly AS (
  SELECT
    target_month,
    COUNT(*) AS row_count,
    SUM(total_cost) AS total_cost,
    SUM(direct_material_cost) AS direct_material_cost,
    SUM(indirect_cost) AS indirect_cost,
    SUM(budget_cost) AS budget_cost,
    SUM(production_qty_kg) AS production_qty_kg,
    SUM(cost_budget_variance_amount) AS budget_variance
  FROM `cost-mgmt-prod-507701.mart.v_variance`
  WHERE target_month BETWEEN '2024-04-01' AND '2027-03-01'
  GROUP BY 1
)
SELECT
  COUNT(*) AS months,
  COUNTIF(
    a.target_month IS NULL OR b.target_month IS NULL
    OR a.row_count != b.row_count
    OR ABS(a.total_cost - b.total_cost) >= 1
    OR ABS(a.direct_material_cost - b.direct_material_cost) >= 1
    OR ABS(a.indirect_cost - b.indirect_cost) >= 1
    OR ABS(a.budget_cost - b.budget_cost) >= 1
    OR ABS(a.production_qty_kg - b.production_qty_kg) >= 0.001
  ) AS mismatched_months,
  COUNTIF(ABS(a.budget_variance - b.budget_variance) >= 1) AS variance_mismatched_months,
  SUM(a.row_count) AS v_cost_rows,
  SUM(b.row_count) AS v_variance_rows
FROM v_cost_monthly a
FULL OUTER JOIN v_variance_monthly b
  USING (target_month);


-- ----------------------------------------------------------------
-- 2-A. dry run: 1か月に絞った場合
--      実行はせず、エディタ右上の「このクエリを実行すると ○○ が処理されます」
--      の値を記録する。
-- ----------------------------------------------------------------
SELECT `製品`, SUM(`総原価`) AS value
FROM `cost-mgmt-prod-507701.explore.v_cost`
WHERE `年月` = '2026-09-01'
GROUP BY `製品`;


-- ----------------------------------------------------------------
-- 2-B. dry run: 期間を絞らない場合（比較用。実行はしない）
--      2-A より大きく、2-A が十分小さければ剪定が効いている。
--      ほぼ同じ値なら剪定が効いておらず、全期間を毎回読んでいる。
-- ----------------------------------------------------------------
SELECT `製品`, SUM(`総原価`) AS value
FROM `cost-mgmt-prod-507701.explore.v_cost`
GROUP BY `製品`;
