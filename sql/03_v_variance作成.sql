CREATE OR REPLACE VIEW `cost-mgmt-prod-507701.mart.v_variance` AS

WITH

/* ============================================================
   1. 売上実績
   粒度：年月 × 顧客
   ============================================================ */
sales_actual AS (

  SELECT
    target_month,
    customer_code,

    SUM(quantity_kg) AS sales_qty_kg,
    SUM(sales_amount) AS actual_sales_amount

  FROM `cost-mgmt-prod-507701.history.sales`

  GROUP BY
    target_month,
    customer_code
),


/* ============================================================
   2. 売上予算
   粒度：年月 × 顧客
   ============================================================ */
sales_budget AS (

  SELECT
    target_month,
    customer_code,

    SUM(budget_amount) AS budget_sales_amount

  FROM `cost-mgmt-prod-507701.history.sales_budgets`

  GROUP BY
    target_month,
    customer_code
),


/* ============================================================
   3. 売上実績（前年同月）
   target_monthを1年後ろへずらし、当年月のキーで直接結合できる形にする
   ============================================================ */
sales_actual_prior_year AS (

  SELECT
    DATE_ADD(target_month, INTERVAL 1 YEAR) AS target_month,
    customer_code,

    actual_sales_amount AS prior_year_sales_amount

  FROM sales_actual
),


/* ============================================================
   4. 生産実績
   まず製品単位に集約。あわせて、標準生産能率（製品マスタ）から
   「標準時間で生産した場合にかかったはずの時間」を算出する。
   ============================================================ */
production_by_product AS (

  SELECT
    pr.target_month,
    pr.product_code,

    SUM(pr.material_qty_kg) AS material_qty_kg,
    SUM(pr.production_qty_kg) AS production_qty_kg,
    SUM(pr.defect_qty_kg) AS defect_qty_kg,

    SUM(pr.setup_hours) AS setup_hours,
    SUM(pr.production_hours) AS production_hours,

    SAFE_DIVIDE(
      SUM(pr.production_qty_kg),
      NULLIF(ANY_VALUE(m.standard_productivity_kg_h), 0)
    ) AS standard_hours

  FROM `cost-mgmt-prod-507701.history.production` pr

  LEFT JOIN `cost-mgmt-prod-507701.master.products` m
    ON pr.product_code = m.product_code

  GROUP BY
    pr.target_month,
    pr.product_code
),


/* ============================================================
   5. 生産実績を顧客単位へ変換
   製品マスタを利用
   ============================================================ */
production_by_customer AS (

  SELECT
    pr.target_month,
    p.customer_code,

    SUM(pr.material_qty_kg) AS material_qty_kg,
    SUM(pr.production_qty_kg) AS production_qty_kg,
    SUM(pr.defect_qty_kg) AS defect_qty_kg,
    SUM(pr.setup_hours) AS setup_hours,
    SUM(pr.production_hours) AS production_hours,
    SUM(pr.standard_hours) AS standard_hours

  FROM production_by_product pr

  INNER JOIN `cost-mgmt-prod-507701.master.products` p
    ON pr.product_code = p.product_code

  GROUP BY
    pr.target_month,
    p.customer_code
),


/* ============================================================
   6. 直接材料費
   ロットNo.のみで生産実績と結合する。原価の計上月（posting_date）と
   生産実施月（production_date）がずれるケース（例：月末納品・
   翌月生産）でも取りこぼさないよう、対象年月は生産側
   （production.target_month）を正とする。
   ============================================================ */
direct_material_cost_by_product AS (

  SELECT
    p.target_month,
    p.product_code,

    SUM(c.amount) AS direct_material_cost

  FROM `cost-mgmt-prod-507701.history.costs` c

  INNER JOIN `cost-mgmt-prod-507701.master.cost_accounts` ca
    ON c.cost_account_code = ca.cost_account_code

  INNER JOIN `cost-mgmt-prod-507701.history.production` p
    ON c.lot_no = p.lot_no

  WHERE
    ca.allocation_method = 'DIRECT'

  GROUP BY
    p.target_month,
    p.product_code
),


/* ============================================================
   7. 製品×マシンの生産時間
   ============================================================ */
product_machine_hours AS (

  SELECT
    target_month,
    factory_code,
    machine_code,
    product_code,

    SUM(production_hours) AS product_hours

  FROM `cost-mgmt-prod-507701.history.production`

  GROUP BY
    target_month,
    factory_code,
    machine_code,
    product_code
),


/* ============================================================
   8. マシン全体の生産時間
   ============================================================ */
machine_total_hours AS (

  SELECT
    target_month,
    factory_code,
    machine_code,

    SUM(production_hours) AS total_hours

  FROM `cost-mgmt-prod-507701.history.production`

  GROUP BY
    target_month,
    factory_code,
    machine_code
),


/* ============================================================
   9. 製品×工場の生産時間
   ============================================================ */
product_factory_hours AS (

  SELECT
    target_month,
    factory_code,
    product_code,

    SUM(production_hours) AS product_hours

  FROM `cost-mgmt-prod-507701.history.production`

  GROUP BY
    target_month,
    factory_code,
    product_code
),


/* ============================================================
   10. 工場全体の生産時間
   ============================================================ */
factory_total_hours AS (

  SELECT
    target_month,
    factory_code,

    SUM(production_hours) AS total_hours

  FROM `cost-mgmt-prod-507701.history.production`

  GROUP BY
    target_month,
    factory_code
),


/* ============================================================
   11. 間接費（実績）
   ============================================================ */
indirect_cost AS (

  SELECT
    c.target_month,
    c.factory_code,
    c.machine_code,
    c.cost_account_code,

    SUM(c.amount) AS indirect_cost

  FROM `cost-mgmt-prod-507701.history.costs` c

  INNER JOIN `cost-mgmt-prod-507701.master.cost_accounts` ca
    ON c.cost_account_code = ca.cost_account_code

  WHERE
    ca.allocation_method = 'PRODUCTION_HOURS'

  GROUP BY
    c.target_month,
    c.factory_code,
    c.machine_code,
    c.cost_account_code
),


/* ============================================================
   12. マシン単位間接費（実績）を製品へ配賦
   ============================================================ */
machine_allocated_cost AS (

  SELECT
    c.target_month,
    p.product_code,

    SUM(
      c.indirect_cost
      *
      SAFE_DIVIDE(
        p.product_hours,
        t.total_hours
      )
    ) AS allocated_cost

  FROM indirect_cost c

  INNER JOIN product_machine_hours p
    ON c.target_month = p.target_month
   AND c.factory_code = p.factory_code
   AND c.machine_code = p.machine_code

  INNER JOIN machine_total_hours t
    ON c.target_month = t.target_month
   AND c.factory_code = t.factory_code
   AND c.machine_code = t.machine_code

  WHERE
    c.machine_code IS NOT NULL

  GROUP BY
    c.target_month,
    p.product_code
),


/* ============================================================
   13. 工場共通費（実績）を製品へ配賦
   ============================================================ */
factory_allocated_cost AS (

  SELECT
    c.target_month,
    p.product_code,

    SUM(
      c.indirect_cost
      *
      SAFE_DIVIDE(
        p.product_hours,
        t.total_hours
      )
    ) AS allocated_cost

  FROM indirect_cost c

  INNER JOIN product_factory_hours p
    ON c.target_month = p.target_month
   AND c.factory_code = p.factory_code

  INNER JOIN factory_total_hours t
    ON c.target_month = t.target_month
   AND c.factory_code = t.factory_code

  WHERE
    c.machine_code IS NULL

  GROUP BY
    c.target_month,
    p.product_code
),


/* ============================================================
   14. 間接費（実績）を製品単位へ統合
   ============================================================ */
indirect_cost_by_product AS (

  SELECT
    target_month,
    product_code,
    SUM(allocated_cost) AS indirect_cost

  FROM (

    SELECT *
    FROM machine_allocated_cost

    UNION ALL

    SELECT *
    FROM factory_allocated_cost
  )

  GROUP BY
    target_month,
    product_code
),


/* ============================================================
   15. 原価予算（マシン単位）
   原価予算は費用科目を問わず、必ず工場×マシン単位で作成されている
   （原材料費であっても「生産構成で配分」済みのため、実績のような
   lot_no・DIRECT/PRODUCTION_HOURSの区別は不要）。
   ============================================================ */
cost_budget_by_machine AS (

  SELECT
    target_month,
    factory_code,
    machine_code,

    SUM(budget_amount) AS budget_cost

  FROM `cost-mgmt-prod-507701.history.cost_budgets`

  GROUP BY
    target_month,
    factory_code,
    machine_code
),


/* ============================================================
   16. 原価予算を製品へ配賦
   実績の間接費配賦と同じ基準（そのマシンの実績生産時間シェア）で
   配分する。そのため、対象月の実績生産がまだない場合（将来の
   予算月など）は配賦できず、この月の原価予算は顧客別には
   反映されない点に留意する。
   ============================================================ */
budget_cost_by_product AS (

  SELECT
    b.target_month,
    p.product_code,

    SUM(
      b.budget_cost
      *
      SAFE_DIVIDE(
        p.product_hours,
        t.total_hours
      )
    ) AS allocated_budget_cost

  FROM cost_budget_by_machine b

  INNER JOIN product_machine_hours p
    ON b.target_month = p.target_month
   AND b.factory_code = p.factory_code
   AND b.machine_code = p.machine_code

  INNER JOIN machine_total_hours t
    ON b.target_month = t.target_month
   AND b.factory_code = t.factory_code
   AND b.machine_code = t.machine_code

  GROUP BY
    b.target_month,
    p.product_code
),


/* ============================================================
   17. 原価予算を顧客単位へ集約
   ============================================================ */
budget_cost_by_customer AS (

  SELECT
    b.target_month,
    p.customer_code,

    SUM(b.allocated_budget_cost) AS budget_cost

  FROM budget_cost_by_product b

  INNER JOIN `cost-mgmt-prod-507701.master.products` p
    ON b.product_code = p.product_code

  GROUP BY
    b.target_month,
    p.customer_code
),


/* ============================================================
   18. 売上を製品単位へ集約
   ============================================================ */
sales_by_product AS (

  SELECT
    target_month,
    product_code,

    SUM(quantity_kg) AS sales_qty_kg,
    SUM(sales_amount) AS sales_amount

  FROM `cost-mgmt-prod-507701.history.sales`

  GROUP BY
    target_month,
    product_code
),


/* ============================================================
   19. 製品別採算
   ============================================================ */
product_profit AS (

  SELECT
    k.target_month,
    k.product_code,

    p.customer_code,

    COALESCE(s.sales_qty_kg, 0)
      AS sales_qty_kg,

    COALESCE(s.sales_amount, 0)
      AS sales_amount,

    COALESCE(d.direct_material_cost, 0)
      AS direct_material_cost,

    COALESCE(i.indirect_cost, 0)
      AS indirect_cost,

    COALESCE(d.direct_material_cost, 0)
      +
    COALESCE(i.indirect_cost, 0)
      AS total_cost,

    COALESCE(s.sales_amount, 0)
      -
    COALESCE(d.direct_material_cost, 0)
      -
    COALESCE(i.indirect_cost, 0)
      AS actual_profit

  FROM (

    SELECT target_month, product_code
    FROM sales_by_product

    UNION DISTINCT

    SELECT target_month, product_code
    FROM direct_material_cost_by_product

    UNION DISTINCT

    SELECT target_month, product_code
    FROM indirect_cost_by_product

  ) k

  LEFT JOIN sales_by_product s
    USING (
      target_month,
      product_code
    )

  LEFT JOIN direct_material_cost_by_product d
    USING (
      target_month,
      product_code
    )

  LEFT JOIN indirect_cost_by_product i
    USING (
      target_month,
      product_code
    )

  LEFT JOIN `cost-mgmt-prod-507701.master.products` p
    ON k.product_code = p.product_code
),


/* ============================================================
   20. 製品採算を顧客単位へ集約
   ============================================================ */
profit_by_customer AS (

  SELECT
    target_month,
    customer_code,

    SUM(direct_material_cost)
      AS direct_material_cost,

    SUM(indirect_cost)
      AS indirect_cost,

    SUM(total_cost)
      AS total_cost,

    SUM(actual_profit)
      AS actual_profit

  FROM product_profit

  GROUP BY
    target_month,
    customer_code
),


/* ============================================================
   21. 製品採算（前年同月）
   ============================================================ */
profit_by_customer_prior_year AS (

  SELECT
    DATE_ADD(target_month, INTERVAL 1 YEAR) AS target_month,
    customer_code,

    actual_profit AS prior_year_profit

  FROM profit_by_customer
),


/* ============================================================
   22. 年月×顧客の全キー
   ============================================================ */
keys AS (

  SELECT
    target_month,
    customer_code
  FROM sales_actual

  UNION DISTINCT

  SELECT
    target_month,
    customer_code
  FROM sales_budget

  UNION DISTINCT

  SELECT
    target_month,
    customer_code
  FROM production_by_customer

  UNION DISTINCT

  SELECT
    target_month,
    customer_code
  FROM profit_by_customer

  UNION DISTINCT

  SELECT
    target_month,
    customer_code
  FROM budget_cost_by_customer
)


/* ============================================================
   23. 最終結果
   ============================================================ */
SELECT

  k.target_month,

  k.customer_code,

  c.customer_name,

  -- ---------------- 売上：実績・予算・前年 ----------------

  COALESCE(
    sa.sales_qty_kg,
    0
  ) AS sales_qty_kg,

  COALESCE(
    sa.actual_sales_amount,
    0
  ) AS actual_sales_amount,

  COALESCE(
    sb.budget_sales_amount,
    0
  ) AS budget_sales_amount,

  COALESCE(
    sa.actual_sales_amount,
    0
  )
  -
  COALESCE(
    sb.budget_sales_amount,
    0
  ) AS sales_budget_variance_amount,

  SAFE_DIVIDE(

    COALESCE(
      sa.actual_sales_amount,
      0
    )
    -
    COALESCE(
      sb.budget_sales_amount,
      0
    ),

    NULLIF(
      COALESCE(
        sb.budget_sales_amount,
        0
      ),
      0
    )

  ) AS sales_budget_variance_rate,

  COALESCE(
    spy.prior_year_sales_amount,
    0
  ) AS prior_year_sales_amount,

  COALESCE(sa.actual_sales_amount, 0)
  -
  COALESCE(spy.prior_year_sales_amount, 0)
    AS sales_yoy_amount,

  SAFE_DIVIDE(
    COALESCE(sa.actual_sales_amount, 0)
    -
    COALESCE(spy.prior_year_sales_amount, 0),
    NULLIF(spy.prior_year_sales_amount, 0)
  ) AS sales_yoy_rate,

  -- ---------------- 原価・利益：実績 ----------------

  COALESCE(
    pc.direct_material_cost,
    0
  ) AS direct_material_cost,

  COALESCE(
    pc.indirect_cost,
    0
  ) AS indirect_cost,

  COALESCE(
    pc.total_cost,
    0
  ) AS total_cost,

  COALESCE(
    pc.actual_profit,
    0
  ) AS actual_profit,

  SAFE_DIVIDE(
    pc.actual_profit,
    NULLIF(
      sa.actual_sales_amount,
      0
    )
  ) AS actual_profit_rate,

  -- ---------------- 利益：前年 ----------------

  COALESCE(
    ppy.prior_year_profit,
    0
  ) AS prior_year_profit,

  COALESCE(pc.actual_profit, 0)
  -
  COALESCE(ppy.prior_year_profit, 0)
    AS profit_yoy_amount,

  SAFE_DIVIDE(
    COALESCE(pc.actual_profit, 0)
    -
    COALESCE(ppy.prior_year_profit, 0),
    NULLIF(ABS(ppy.prior_year_profit), 0)
  ) AS profit_yoy_rate,

  -- ---------------- 原価：予算対比 ----------------

  COALESCE(
    bc.budget_cost,
    0
  ) AS budget_cost,

  COALESCE(pc.total_cost, 0)
  -
  COALESCE(bc.budget_cost, 0)
    AS cost_budget_variance_amount,

  SAFE_DIVIDE(
    COALESCE(pc.total_cost, 0)
    -
    COALESCE(bc.budget_cost, 0),
    NULLIF(bc.budget_cost, 0)
  ) AS cost_budget_variance_rate,

  CASE

    WHEN
      bc.budget_cost IS NULL
      OR bc.budget_cost = 0
    THEN 'NO_BUDGET'

    WHEN
      COALESCE(pc.total_cost, 0)
      <= bc.budget_cost
    THEN 'WITHIN_BUDGET'

    ELSE 'OVER_BUDGET'

  END AS cost_budget_status,

  -- ---------------- 生産実績 ----------------

  COALESCE(
    pr.material_qty_kg,
    0
  ) AS material_qty_kg,

  COALESCE(
    pr.production_qty_kg,
    0
  ) AS production_qty_kg,

  COALESCE(
    pr.defect_qty_kg,
    0
  ) AS defect_qty_kg,

  COALESCE(
    pr.setup_hours,
    0
  ) AS setup_hours,

  COALESCE(
    pr.production_hours,
    0
  ) AS production_hours,

  SAFE_DIVIDE(
    pr.defect_qty_kg,
    NULLIF(
      pr.material_qty_kg,
      0
    )
  ) AS defect_rate,

  SAFE_DIVIDE(
    pr.production_qty_kg,
    NULLIF(
      pr.production_hours,
      0
    )
  ) AS actual_productivity_kg_h,

  SAFE_DIVIDE(
    pc.total_cost,
    NULLIF(
      pr.production_qty_kg,
      0
    )
  ) AS cost_per_production_kg,

  -- ---------------- 標準生産能率との差異 ----------------

  COALESCE(
    pr.standard_hours,
    0
  ) AS standard_production_hours,

  pr.standard_hours
  -
  pr.production_hours
    AS production_hours_variance,

  -- 1.0=標準どおり。1より大きい=標準より高効率（実績時間が標準より少ない）
  SAFE_DIVIDE(
    pr.standard_hours,
    NULLIF(
      pr.production_hours,
      0
    )
  ) AS productivity_vs_standard_rate,

  -- ---------------- 売上予算ステータス ----------------

  CASE

    WHEN
      sb.budget_sales_amount IS NULL
      OR sb.budget_sales_amount = 0
    THEN 'NO_BUDGET'

    WHEN
      sa.actual_sales_amount
      >= sb.budget_sales_amount
    THEN 'ACHIEVED'

    ELSE 'BELOW_BUDGET'

  END AS sales_budget_status


FROM keys k

LEFT JOIN sales_actual sa
  USING (
    target_month,
    customer_code
  )

LEFT JOIN sales_budget sb
  USING (
    target_month,
    customer_code
  )

LEFT JOIN sales_actual_prior_year spy
  USING (
    target_month,
    customer_code
  )

LEFT JOIN production_by_customer pr
  USING (
    target_month,
    customer_code
  )

LEFT JOIN profit_by_customer pc
  USING (
    target_month,
    customer_code
  )

LEFT JOIN profit_by_customer_prior_year ppy
  USING (
    target_month,
    customer_code
  )

LEFT JOIN budget_cost_by_customer bc
  USING (
    target_month,
    customer_code
  )

LEFT JOIN `cost-mgmt-prod-507701.master.customers` c
  ON k.customer_code = c.customer_code;


-- ================================================================
-- データ品質チェック用ビュー
--
-- v_varianceの各CTEはマスタ未登録の製品コードや、直接材料費の
-- ロットNo.が生産実績と一致しないデータを、エラーにせず黙って
-- 集計から除外する設計になっている（INNER JOINによる暗黙の除外）。
-- 本ビューは、そうした「集計から漏れているデータ」を検知するための
-- ものであり、定期的に内容を確認することを推奨する。
-- ================================================================

CREATE OR REPLACE VIEW `cost-mgmt-prod-507701.mart.v_data_quality_orphans` AS

SELECT
  'PRODUCTION_PRODUCT_NOT_IN_MASTER' AS issue_type,
  pr.target_month,
  pr.product_code AS key_value,
  CAST(NULL AS STRING) AS lot_no,
  COUNT(*) AS row_count

FROM `cost-mgmt-prod-507701.history.production` pr

LEFT JOIN `cost-mgmt-prod-507701.master.products` p
  ON pr.product_code = p.product_code

WHERE
  p.product_code IS NULL

GROUP BY
  pr.target_month,
  pr.product_code

UNION ALL

SELECT
  'DIRECT_COST_LOT_NOT_IN_PRODUCTION' AS issue_type,
  c.target_month,
  c.cost_account_code AS key_value,
  c.lot_no,
  COUNT(*) AS row_count

FROM `cost-mgmt-prod-507701.history.costs` c

INNER JOIN `cost-mgmt-prod-507701.master.cost_accounts` ca
  ON c.cost_account_code = ca.cost_account_code

LEFT JOIN `cost-mgmt-prod-507701.history.production` pr
  ON c.lot_no = pr.lot_no

WHERE
  ca.allocation_method = 'DIRECT'
  AND pr.lot_no IS NULL

GROUP BY
  c.target_month,
  c.cost_account_code,
  c.lot_no;
