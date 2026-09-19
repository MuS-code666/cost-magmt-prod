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
--
-- Looker Studio Phase 4-1 対応（2026-09-19）
-- F. 出力粒度を「年月×顧客」から「年月×製品」へ変更。
--      - 従来の顧客粒度では、Looker Studio側で製品別・部門別の
--        分析ができなかったため。
--      - 顧客（customer_code / customer_name）・部門（factory_code /
--        factory_name）は、製品マスタ（master.products）経由で
--        1製品につき1顧客・1工場として付与する。
--      - 原価予算（cost_budget_*）・生産実績は元々工場×マシン単位 /
--        製品単位で計算できるため、この変更で安全に製品行へ展開できる。
--      - 売上予算（budget_sales_amount 以下 sales_budget_* 列）は
--        history.sales_budgets が「年月×顧客」単位でしか記録されて
--        いないため、同一顧客の複数製品行に同じ値が複製される。
--        製品をまたいでSUMすると水増しされるため、
--        「顧客単位に集計する場合のみ使用可（SUMではなくAVG/MAX等で
--        重複排除するか、顧客単位に絞り込んで参照する）」という制約が
--        つく。Looker Studio側のフィールド説明で明示すること。
--
-- Looker Studio Phase 4-3 対応（2026-09-19）
-- G. 原価（total_cost）の前年差異列が存在しなかったため追加。
--      - 利益・売上には前年差異（profit_yoy_*, sales_yoy_*）があったが、
--        原価自体の前年差異がなく、P1サマリーの「前年差異」スコアカード
--        （原価の急変を見つける用途）を作れなかったため。
--      - prior_year_total_cost, cost_yoy_amount, cost_yoy_rate を追加。
--        計算方法は既存の profit_yoy_* と同じ仕組み
--        （product_profit を1年ずらして自己結合）。
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
   2. マシン／工場の稼働時間シェア（製品単位・全体）
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
   3-A. 原価実績（行レベル、allocation_methodを付与）
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
   3-B. 直接材料費
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
   3-C. 間接費（実績）
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
   4. マシン単位間接費（実績）を製品へ配賦
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
   5. 工場共通費（実績）を製品へ配賦
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
   6. 間接費（実績）を製品単位へ統合
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
   7. 原価予算（マシン単位）
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
   8. 原価予算を製品へ配賦
   実績の間接費配賦と同じ基準（そのマシンの実績生産時間シェア）で
   配分する。そのため、対象月の実績生産がまだない場合（将来の
   予算月など）は配賦できず、この月の原価予算は製品別には
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
   9-A. 売上実績（行レベル）
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
   9-B. 売上予算（顧客単位）
   history.sales_budgets が「年月×顧客」でしか記録されていないため、
   製品粒度へは配賦できない。最終結果では、この値を同一顧客の
   全製品行へそのまま複製する（下記の最終SELECTのコメント参照）。
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
   9-C. 売上実績（前年同月・製品単位）
   target_monthを1年後ろへずらし、当年月のキーで直接結合できる形にする
   ============================================================ */
sales_by_product_prior_year AS (

  SELECT
    DATE_ADD(target_month, INTERVAL 1 YEAR) AS target_month,
    product_code,

    sales_amount AS prior_year_sales_amount

  FROM sales_by_product
),


/* ============================================================
   10. 製品別採算
   3つのCTEをCOALESCEキーで FULL OUTER JOIN し、
   両者のキー全体集合を1回のシャッフルで得る。
   顧客・工場は最終SELECTで製品マスタ経由で付与するため、
   ここでは持たない。
   ============================================================ */
product_profit AS (

  SELECT
    COALESCE(s.target_month, d.target_month, i.target_month)
      AS target_month,
    COALESCE(s.product_code, d.product_code, i.product_code)
      AS product_code,

    COALESCE(s.sales_qty_kg, 0) AS sales_qty_kg,
    COALESCE(s.sales_amount, 0) AS sales_amount,
    COALESCE(d.direct_material_cost, 0) AS direct_material_cost,
    COALESCE(i.indirect_cost, 0) AS indirect_cost,

    COALESCE(d.direct_material_cost, 0)
      + COALESCE(i.indirect_cost, 0)
      AS total_cost,

    COALESCE(s.sales_amount, 0)
      - COALESCE(d.direct_material_cost, 0)
      - COALESCE(i.indirect_cost, 0)
      AS actual_profit

  FROM sales_by_product s

  FULL OUTER JOIN direct_material_cost_by_product d
    ON s.target_month = d.target_month
   AND s.product_code = d.product_code

  FULL OUTER JOIN indirect_cost_by_product i
    ON COALESCE(s.target_month, d.target_month) = i.target_month
   AND COALESCE(s.product_code, d.product_code) = i.product_code
),


/* ============================================================
   11. 製品別採算（前年同月）
   ============================================================ */
product_profit_prior_year AS (

  SELECT
    DATE_ADD(target_month, INTERVAL 1 YEAR) AS target_month,
    product_code,

    actual_profit AS prior_year_profit,
    total_cost AS prior_year_total_cost

  FROM product_profit
),


/* ============================================================
   12. 年月×製品の全キー＋主要指標
   product_profit（実績・原価）／production_by_product（生産実績）／
   budget_cost_by_product（原価予算）をCOALESCEキーで
   FULL OUTER JOIN し、その場で列も取得する。
   ============================================================ */
base AS (

  SELECT
    COALESCE(
      pp.target_month, prb.target_month, bcp.target_month
    ) AS target_month,

    COALESCE(
      pp.product_code, prb.product_code, bcp.product_code
    ) AS product_code,

    pp.sales_qty_kg,
    pp.sales_amount AS actual_sales_amount,

    prb.material_qty_kg,
    prb.production_qty_kg,
    prb.defect_qty_kg,
    prb.setup_hours,
    prb.production_hours,
    prb.standard_hours,

    pp.direct_material_cost,
    pp.indirect_cost,
    pp.total_cost,
    pp.actual_profit,

    bcp.allocated_budget_cost AS budget_cost

  FROM product_profit pp

  FULL OUTER JOIN production_by_product prb
    ON pp.target_month = prb.target_month
   AND pp.product_code = prb.product_code

  FULL OUTER JOIN budget_cost_by_product bcp
    ON COALESCE(pp.target_month, prb.target_month) = bcp.target_month
   AND COALESCE(pp.product_code, prb.product_code) = bcp.product_code
)


/* ============================================================
   13. 最終結果（年月×製品）
   ============================================================ */
SELECT

  base.target_month,
  base.product_code,
  mp.product_name,

  -- 顧客・工場（部門）は製品マスタ経由（1製品=1顧客・1工場の前提）
  mp.customer_code,
  c.customer_name,
  mp.factory_code,
  f.factory_name,

  -- ---------------- 売上：実績・予算・前年 ----------------

  COALESCE(base.sales_qty_kg, 0) AS sales_qty_kg,
  COALESCE(base.actual_sales_amount, 0) AS actual_sales_amount,

  -- 売上予算は「年月×顧客」単位でしか記録がないため、
  -- 同一顧客の全製品行に同じ値が複製される。
  -- 製品別にSUMすると顧客の予算額が水増しされるので、
  -- 顧客単位で集計する場合（＝この顧客の1行に集約する場合）のみ
  -- 使用すること。Looker Studio側では既定の集計方法をSUM以外
  -- （AVGやMAX等）にするか、顧客単位の表でのみ表示すること。
  COALESCE(sb.budget_sales_amount, 0) AS budget_sales_amount,

  COALESCE(base.actual_sales_amount, 0)
    - COALESCE(sb.budget_sales_amount, 0)
    AS sales_budget_variance_amount,

  SAFE_DIVIDE(
    COALESCE(base.actual_sales_amount, 0)
      - COALESCE(sb.budget_sales_amount, 0),
    NULLIF(COALESCE(sb.budget_sales_amount, 0), 0)
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

  -- ---------------- 原価：前年対比 ----------------

  COALESCE(ppy.prior_year_total_cost, 0) AS prior_year_total_cost,

  COALESCE(base.total_cost, 0) - COALESCE(ppy.prior_year_total_cost, 0)
    AS cost_yoy_amount,

  SAFE_DIVIDE(
    COALESCE(base.total_cost, 0) - COALESCE(ppy.prior_year_total_cost, 0),
    NULLIF(ppy.prior_year_total_cost, 0)
  ) AS cost_yoy_rate,

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

  -- ---------------- 原価：予算対比（製品単位に配賦済み・合計可） ----------------

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

  -- ---------------- 売上予算ステータス（顧客単位。上記と同じ注意点） ----------------

  CASE

    WHEN
      sb.budget_sales_amount IS NULL
      OR sb.budget_sales_amount = 0
    THEN 'NO_BUDGET'

    WHEN
      base.actual_sales_amount
      >= sb.budget_sales_amount
    THEN 'ACHIEVED'

    ELSE 'BELOW_BUDGET'

  END AS sales_budget_status


FROM base

LEFT JOIN `cost-mgmt-prod-507701.master.products` mp
  ON base.product_code = mp.product_code

LEFT JOIN `cost-mgmt-prod-507701.master.customers` c
  ON mp.customer_code = c.customer_code

LEFT JOIN `cost-mgmt-prod-507701.master.factories` f
  ON mp.factory_code = f.factory_code

LEFT JOIN sales_budget sb
  ON base.target_month = sb.target_month
 AND mp.customer_code = sb.customer_code

LEFT JOIN sales_by_product_prior_year spy
  ON base.target_month = spy.target_month
 AND base.product_code = spy.product_code

LEFT JOIN product_profit_prior_year ppy
  ON base.target_month = ppy.target_month
 AND base.product_code = ppy.product_code;


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
