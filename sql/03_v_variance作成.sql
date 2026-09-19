-- ================================================================
-- v_variance
--
-- パフォーマンスレビュー対応（2026-09-19）
-- 元テーブルへの FROM/JOIN 回数を減らすための構造変更。
-- ビジネスロジック・出力列は変更前と同一。
--   A. history.production への FROM/JOIN を1箇所（production_base）に集約し、
--      マシン／工場の稼働時間シェア4系統はウィンドウ関数で同時に算出する
--      （6回スキャン → 1回）
--   B. history.sales への FROM を1箇所（sales_base）に集約し、
--      顧客粒度・製品粒度の2集計はそこから作る（2回 → 1回）
--   C. history.costs への FROM を1箇所（costs_base）に集約し、
--      DIRECT／PRODUCTION_HOURS の2集計はそこから作る（2回 → 1回）
--   D. 「UNION DISTINCTでキー一覧を作ってから同じCTEに再LEFT JOIN」
--      パターンを、COALESCEキーによる FULL OUTER JOIN 連結に置き換える
--      （product_profit内の旧k、最終結果直前の旧keys）
--   E. target_month のパーティション剪定は、ビュー構造では保証できない
--      ため対応しない。運用でカバーする：
--        - EXPLAIN / 実行計画で、呼び出し側の target_month 絞り込みが
--          production_base / costs_base / sales_base のパーティション
--          剪定まで届いているか定期的に検証する
--        - Looker Studio側は target_month を必須フィルタとする
--        - Claude MCP側はプロンプト・スキルのテンプレートで
--          target_month 絞り込みを必須にする
-- ================================================================

CREATE OR REPLACE VIEW `cost-mgmt-prod-507701.mart.v_variance` AS

WITH

/* ============================================================
   0-A. 生産実績（行レベル）
   history.production への FROM/JOIN はこのCTEのみに限定する。
   lot_no を保持するため、直接材料費側の結合にもそのまま使える。
   ============================================================ */
production_base AS (

  SELECT
    pr.target_month,
    pr.lot_no,
    pr.factory_code,
    pr.machine_code,
    pr.product_code,

    pr.material_qty_kg,
    pr.production_qty_kg,
    pr.defect_qty_kg,
    pr.setup_hours,
    pr.production_hours,

    m.standard_productivity_kg_h

  FROM `cost-mgmt-prod-507701.history.production` pr

  LEFT JOIN `cost-mgmt-prod-507701.master.products` m
    ON pr.product_code = m.product_code
),


/* ============================================================
   0-B. マシン／工場の稼働時間シェアをウィンドウ関数でまとめて算出
   production_base を1回スキャンし、4つの集計値を同時に付与する。
   ============================================================ */
production_with_totals AS (

  SELECT
    target_month,
    factory_code,
    machine_code,
    product_code,
    production_hours,

    SUM(production_hours) OVER (
      PARTITION BY target_month, factory_code, machine_code, product_code
    ) AS product_machine_hours,

    SUM(production_hours) OVER (
      PARTITION BY target_month, factory_code, machine_code
    ) AS machine_total_hours,

    SUM(production_hours) OVER (
      PARTITION BY target_month, factory_code, product_code
    ) AS product_factory_hours,

    SUM(production_hours) OVER (
      PARTITION BY target_month, factory_code
    ) AS factory_total_hours

  FROM production_base
),


/* ============================================================
   1. 生産実績（製品単位）
   ============================================================ */
production_by_product AS (

  SELECT
    target_month,
    product_code,

    SUM(material_qty_kg) AS material_qty_kg,
    SUM(production_qty_kg) AS production_qty_kg,
    SUM(defect_qty_kg) AS defect_qty_kg,
    SUM(setup_hours) AS setup_hours,
    SUM(production_hours) AS production_hours,

    SAFE_DIVIDE(
      SUM(production_qty_kg),
      NULLIF(ANY_VALUE(standard_productivity_kg_h), 0)
    ) AS standard_hours

  FROM production_base

  GROUP BY
    target_month,
    product_code
),


/* ============================================================
   2. 生産実績を顧客単位へ変換
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
   3. マシン／工場の稼働時間シェア（製品単位・全体）
   production_with_totals から重複行を落とすだけ。
   ============================================================ */
product_machine_hours AS (

  SELECT DISTINCT
    target_month,
    factory_code,
    machine_code,
    product_code,
    product_machine_hours AS product_hours

  FROM production_with_totals
),

machine_total_hours AS (

  SELECT DISTINCT
    target_month,
    factory_code,
    machine_code,
    machine_total_hours AS total_hours

  FROM production_with_totals
),

product_factory_hours AS (

  SELECT DISTINCT
    target_month,
    factory_code,
    product_code,
    product_factory_hours AS product_hours

  FROM production_with_totals
),

factory_total_hours AS (

  SELECT DISTINCT
    target_month,
    factory_code,
    factory_total_hours AS total_hours

  FROM production_with_totals
),


/* ============================================================
   4-A. 原価実績（行レベル、allocation_methodを付与）
   history.costs への FROM はこのCTEのみに限定する。
   ============================================================ */
costs_base AS (

  SELECT
    c.target_month AS cost_target_month,
    c.cost_account_code,
    c.factory_code,
    c.machine_code,
    c.lot_no,
    c.amount,
    ca.allocation_method

  FROM `cost-mgmt-prod-507701.history.costs` c

  INNER JOIN `cost-mgmt-prod-507701.master.cost_accounts` ca
    ON c.cost_account_code = ca.cost_account_code

  WHERE
    ca.allocation_method IN ('DIRECT', 'PRODUCTION_HOURS')
),


/* ============================================================
   4-B. 直接材料費
   costs_base × production_base（lot_no結合）。
   対象年月は production 側（生産実施月）を正とする。
   ============================================================ */
direct_material_cost_by_product AS (

  SELECT
    p.target_month,
    p.product_code,

    SUM(cb.amount) AS direct_material_cost

  FROM costs_base cb

  INNER JOIN production_base p
    ON cb.lot_no = p.lot_no

  WHERE
    cb.allocation_method = 'DIRECT'

  GROUP BY
    p.target_month,
    p.product_code
),


/* ============================================================
   4-C. 間接費（実績）
   ============================================================ */
indirect_cost AS (

  SELECT
    cost_target_month AS target_month,
    factory_code,
    machine_code,
    cost_account_code,

    SUM(amount) AS indirect_cost

  FROM costs_base

  WHERE
    allocation_method = 'PRODUCTION_HOURS'

  GROUP BY
    cost_target_month,
    factory_code,
    machine_code,
    cost_account_code
),


/* ============================================================
   5. マシン単位間接費（実績）を製品へ配賦
   ============================================================ */
machine_allocated_cost AS (

  SELECT
    c.target_month,
    p.product_code,

    SUM(
      c.indirect_cost
      *
      SAFE_DIVIDE(p.product_hours, t.total_hours)
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
   6. 工場共通費（実績）を製品へ配賦
   ============================================================ */
factory_allocated_cost AS (

  SELECT
    c.target_month,
    p.product_code,

    SUM(
      c.indirect_cost
      *
      SAFE_DIVIDE(p.product_hours, t.total_hours)
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
   7. 間接費（実績）を製品単位へ統合
   ============================================================ */
indirect_cost_by_product AS (

  SELECT
    target_month,
    product_code,
    SUM(allocated_cost) AS indirect_cost

  FROM (

    SELECT * FROM machine_allocated_cost

    UNION ALL

    SELECT * FROM factory_allocated_cost
  )

  GROUP BY
    target_month,
    product_code
),


/* ============================================================
   8. 原価予算（マシン単位）
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
   9. 原価予算を製品へ配賦
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
      SAFE_DIVIDE(p.product_hours, t.total_hours)
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
   10. 原価予算を顧客単位へ集約
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
   11-A. 売上実績（行レベル）
   history.sales への FROM はこのCTEのみに限定する。
   ============================================================ */
sales_base AS (

  SELECT
    target_month,
    customer_code,
    product_code,
    quantity_kg,
    sales_amount

  FROM `cost-mgmt-prod-507701.history.sales`
),

sales_actual AS (

  SELECT
    target_month,
    customer_code,

    SUM(quantity_kg) AS sales_qty_kg,
    SUM(sales_amount) AS actual_sales_amount

  FROM sales_base

  GROUP BY
    target_month,
    customer_code
),

sales_by_product AS (

  SELECT
    target_month,
    product_code,

    SUM(quantity_kg) AS sales_qty_kg,
    SUM(sales_amount) AS sales_amount

  FROM sales_base

  GROUP BY
    target_month,
    product_code
),


/* ============================================================
   11-B. 売上予算
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
   11-C. 売上実績（前年同月）
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
   12. 製品別採算
   3つのCTEをCOALESCEキーで FULL OUTER JOIN し、
   両者のキー全体集合を1回のシャッフルで得る。
   ============================================================ */
product_profit AS (

  SELECT
    base.target_month,
    base.product_code,

    p.customer_code,

    COALESCE(base.sales_qty_kg, 0) AS sales_qty_kg,
    COALESCE(base.sales_amount, 0) AS sales_amount,
    COALESCE(base.direct_material_cost, 0) AS direct_material_cost,
    COALESCE(base.indirect_cost, 0) AS indirect_cost,

    COALESCE(base.direct_material_cost, 0)
      + COALESCE(base.indirect_cost, 0)
      AS total_cost,

    COALESCE(base.sales_amount, 0)
      - COALESCE(base.direct_material_cost, 0)
      - COALESCE(base.indirect_cost, 0)
      AS actual_profit

  FROM (

    SELECT
      COALESCE(s.target_month, d.target_month, i.target_month)
        AS target_month,
      COALESCE(s.product_code, d.product_code, i.product_code)
        AS product_code,

      s.sales_qty_kg,
      s.sales_amount,
      d.direct_material_cost,
      i.indirect_cost

    FROM sales_by_product s

    FULL OUTER JOIN direct_material_cost_by_product d
      ON s.target_month = d.target_month
     AND s.product_code = d.product_code

    FULL OUTER JOIN indirect_cost_by_product i
      ON COALESCE(s.target_month, d.target_month) = i.target_month
     AND COALESCE(s.product_code, d.product_code) = i.product_code

  ) base

  LEFT JOIN `cost-mgmt-prod-507701.master.products` p
    ON base.product_code = p.product_code
),


/* ============================================================
   13. 製品採算を顧客単位へ集約
   ============================================================ */
profit_by_customer AS (

  SELECT
    target_month,
    customer_code,

    SUM(direct_material_cost) AS direct_material_cost,
    SUM(indirect_cost) AS indirect_cost,
    SUM(total_cost) AS total_cost,
    SUM(actual_profit) AS actual_profit

  FROM product_profit

  GROUP BY
    target_month,
    customer_code
),


/* ============================================================
   14. 製品採算（前年同月）
   ============================================================ */
profit_by_customer_prior_year AS (

  SELECT
    DATE_ADD(target_month, INTERVAL 1 YEAR) AS target_month,
    customer_code,

    actual_profit AS prior_year_profit

  FROM profit_by_customer
),


/* ============================================================
   15. 年月×顧客の全キー＋主要指標
   5つのCTEをCOALESCEキーで FULL OUTER JOIN し、
   その場で列も取得する（二重取得・重複排除シャッフルなし）。
   ============================================================ */
base AS (

  SELECT
    COALESCE(
      sa.target_month, sb.target_month, pr.target_month,
      pc.target_month, bc.target_month
    ) AS target_month,

    COALESCE(
      sa.customer_code, sb.customer_code, pr.customer_code,
      pc.customer_code, bc.customer_code
    ) AS customer_code,

    sa.sales_qty_kg,
    sa.actual_sales_amount,

    sb.budget_sales_amount,

    pr.material_qty_kg,
    pr.production_qty_kg,
    pr.defect_qty_kg,
    pr.setup_hours,
    pr.production_hours,
    pr.standard_hours,

    pc.direct_material_cost,
    pc.indirect_cost,
    pc.total_cost,
    pc.actual_profit,

    bc.budget_cost

  FROM sales_actual sa

  FULL OUTER JOIN sales_budget sb
    ON sa.target_month = sb.target_month
   AND sa.customer_code = sb.customer_code

  FULL OUTER JOIN production_by_customer pr
    ON COALESCE(sa.target_month, sb.target_month) = pr.target_month
   AND COALESCE(sa.customer_code, sb.customer_code) = pr.customer_code

  FULL OUTER JOIN profit_by_customer pc
    ON COALESCE(sa.target_month, sb.target_month, pr.target_month)
       = pc.target_month
   AND COALESCE(sa.customer_code, sb.customer_code, pr.customer_code)
       = pc.customer_code

  FULL OUTER JOIN budget_cost_by_customer bc
    ON COALESCE(
         sa.target_month, sb.target_month, pr.target_month, pc.target_month
       ) = bc.target_month
   AND COALESCE(
         sa.customer_code, sb.customer_code, pr.customer_code, pc.customer_code
       ) = bc.customer_code
)


/* ============================================================
   16. 最終結果
   ============================================================ */
SELECT

  base.target_month,
  base.customer_code,
  c.customer_name,

  -- ---------------- 売上：実績・予算・前年 ----------------

  COALESCE(base.sales_qty_kg, 0) AS sales_qty_kg,
  COALESCE(base.actual_sales_amount, 0) AS actual_sales_amount,
  COALESCE(base.budget_sales_amount, 0) AS budget_sales_amount,

  COALESCE(base.actual_sales_amount, 0)
    - COALESCE(base.budget_sales_amount, 0)
    AS sales_budget_variance_amount,

  SAFE_DIVIDE(
    COALESCE(base.actual_sales_amount, 0)
      - COALESCE(base.budget_sales_amount, 0),
    NULLIF(COALESCE(base.budget_sales_amount, 0), 0)
  ) AS sales_budget_variance_rate,

  COALESCE(spy.prior_year_sales_amount, 0) AS prior_year_sales_amount,

  COALESCE(base.actual_sales_amount, 0)
    - COALESCE(spy.prior_year_sales_amount, 0)
    AS sales_yoy_amount,

  SAFE_DIVIDE(
    COALESCE(base.actual_sales_amount, 0)
      - COALESCE(spy.prior_year_sales_amount, 0),
    NULLIF(spy.prior_year_sales_amount, 0)
  ) AS sales_yoy_rate,

  -- ---------------- 原価・利益：実績 ----------------

  COALESCE(base.direct_material_cost, 0) AS direct_material_cost,
  COALESCE(base.indirect_cost, 0) AS indirect_cost,
  COALESCE(base.total_cost, 0) AS total_cost,
  COALESCE(base.actual_profit, 0) AS actual_profit,

  SAFE_DIVIDE(
    base.actual_profit,
    NULLIF(base.actual_sales_amount, 0)
  ) AS actual_profit_rate,

  -- ---------------- 利益：前年 ----------------

  COALESCE(ppy.prior_year_profit, 0) AS prior_year_profit,

  COALESCE(base.actual_profit, 0)
    - COALESCE(ppy.prior_year_profit, 0)
    AS profit_yoy_amount,

  SAFE_DIVIDE(
    COALESCE(base.actual_profit, 0)
      - COALESCE(ppy.prior_year_profit, 0),
    NULLIF(ABS(ppy.prior_year_profit), 0)
  ) AS profit_yoy_rate,

  -- ---------------- 原価：予算対比 ----------------

  COALESCE(base.budget_cost, 0) AS budget_cost,

  COALESCE(base.total_cost, 0) - COALESCE(base.budget_cost, 0)
    AS cost_budget_variance_amount,

  SAFE_DIVIDE(
    COALESCE(base.total_cost, 0) - COALESCE(base.budget_cost, 0),
    NULLIF(base.budget_cost, 0)
  ) AS cost_budget_variance_rate,

  CASE

    WHEN
      base.budget_cost IS NULL
      OR base.budget_cost = 0
    THEN 'NO_BUDGET'

    WHEN
      COALESCE(base.total_cost, 0)
      <= base.budget_cost
    THEN 'WITHIN_BUDGET'

    ELSE 'OVER_BUDGET'

  END AS cost_budget_status,

  -- ---------------- 生産実績 ----------------

  COALESCE(base.material_qty_kg, 0) AS material_qty_kg,
  COALESCE(base.production_qty_kg, 0) AS production_qty_kg,
  COALESCE(base.defect_qty_kg, 0) AS defect_qty_kg,
  COALESCE(base.setup_hours, 0) AS setup_hours,
  COALESCE(base.production_hours, 0) AS production_hours,

  SAFE_DIVIDE(
    base.defect_qty_kg,
    NULLIF(base.material_qty_kg, 0)
  ) AS defect_rate,

  SAFE_DIVIDE(
    base.production_qty_kg,
    NULLIF(base.production_hours, 0)
  ) AS actual_productivity_kg_h,

  SAFE_DIVIDE(
    base.total_cost,
    NULLIF(base.production_qty_kg, 0)
  ) AS cost_per_production_kg,

  -- ---------------- 標準生産能率との差異 ----------------

  COALESCE(base.standard_hours, 0) AS standard_production_hours,

  base.standard_hours
  -
  base.production_hours
    AS production_hours_variance,

  -- 1.0=標準どおり。1より大きい=標準より高効率（実績時間が標準より少ない）
  SAFE_DIVIDE(
    base.standard_hours,
    NULLIF(base.production_hours, 0)
  ) AS productivity_vs_standard_rate,

  -- ---------------- 売上予算ステータス ----------------

  CASE

    WHEN
      base.budget_sales_amount IS NULL
      OR base.budget_sales_amount = 0
    THEN 'NO_BUDGET'

    WHEN
      base.actual_sales_amount
      >= base.budget_sales_amount
    THEN 'ACHIEVED'

    ELSE 'BELOW_BUDGET'

  END AS sales_budget_status


FROM base

LEFT JOIN sales_actual_prior_year spy
  USING (
    target_month,
    customer_code
  )

LEFT JOIN profit_by_customer_prior_year ppy
  USING (
    target_month,
    customer_code
  )

LEFT JOIN `cost-mgmt-prod-507701.master.customers` c
  ON base.customer_code = c.customer_code;


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
