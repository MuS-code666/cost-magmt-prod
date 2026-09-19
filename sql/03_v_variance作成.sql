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
   3. 生産実績
   まず製品単位に集約
   ============================================================ */
production_by_product AS (

  SELECT
    target_month,
    product_code,

    SUM(material_qty_kg) AS material_qty_kg,
    SUM(production_qty_kg) AS production_qty_kg,
    SUM(defect_qty_kg) AS defect_qty_kg,

    SUM(setup_hours) AS setup_hours,
    SUM(production_hours) AS production_hours

  FROM `cost-mgmt-prod-507701.history.production`

  GROUP BY
    target_month,
    product_code
),


/* ============================================================
   4. 生産実績を顧客単位へ変換
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
    SUM(pr.production_hours) AS production_hours

  FROM production_by_product pr

  INNER JOIN `cost-mgmt-prod-507701.master.products` p
    ON pr.product_code = p.product_code

  GROUP BY
    pr.target_month,
    p.customer_code
),


/* ============================================================
   5. 直接材料費
   ============================================================ */
direct_material_cost_by_product AS (

  SELECT
    c.target_month,
    p.product_code,

    SUM(c.amount) AS direct_material_cost

  FROM `cost-mgmt-prod-507701.history.costs` c

  INNER JOIN `cost-mgmt-prod-507701.master.cost_accounts` ca
    ON c.cost_account_code = ca.cost_account_code

  INNER JOIN `cost-mgmt-prod-507701.history.production` p
    ON c.target_month = p.target_month
   AND c.lot_no = p.lot_no

  WHERE
    ca.allocation_method = 'DIRECT'

  GROUP BY
    c.target_month,
    p.product_code
),


/* ============================================================
   6. 製品×マシンの生産時間
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
   7. マシン全体の生産時間
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
   8. 製品×工場の生産時間
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
   9. 工場全体の生産時間
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
   10. 間接費
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
   11. マシン単位間接費を製品へ配賦
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
   12. 工場共通費を製品へ配賦
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
   13. 間接費を製品単位へ統合
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
   14. 売上を製品単位へ集約
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
   15. 製品別採算
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
   16. 製品採算を顧客単位へ集約
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
   17. 年月×顧客の全キー
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
)


/* ============================================================
   18. 最終結果
   ============================================================ */
SELECT

  k.target_month,

  k.customer_code,

  c.customer_name,

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

LEFT JOIN `cost-mgmt-prod-507701.master.customers` c
  ON k.customer_code = c.customer_code;
