-- ================================================================
-- 自然言語検索 STEP 2: explore データセットと意味層ビュー v_cost
--
-- 目的（2026-10-25）
--   自然言語検索（GAS Webアプリ）が参照する唯一のビュー。
--   mart.v_variance の原価系の列だけを、日本語の列名と説明付きで出す。
--   設計の全体は nl_search/README.md を参照。
--
-- 設計ルール
--   A. 1行 = 年月 × 製品。工場・顧客は v_variance と同じく製品マスタ経由
--      （1製品 = 1工場・1顧客）。
--   B. 合計してよい「額・量」だけを出す。率（差異率・kg当たり原価）や
--      差異額は行単位の値を出さず、カタログ（nl_search/catalog/metrics.json）
--      の集計式で SUM から再計算する。率の平均による誤りを防ぐため。
--   C. 前年差異列（prior_year_total_cost, cost_yoy_*）は出さない。前年比較は
--      GAS が同じビューを前年同月の期間で引いて結合する。
--   D. 売上・利益・生産性の列は今回の対象外（原価系から開始する決定）。
--   E. v_variance はパーティション剪定が保証されない（03 のコメント E）。
--      このビューへのクエリは GAS 側で 年月 の絞り込みを必須とし、
--      maximumBytesBilled で上限を掛ける。
-- ================================================================

CREATE SCHEMA IF NOT EXISTS `cost-mgmt-prod-507701.explore`
OPTIONS (
  location = 'asia-northeast1',
  description = '自然言語検索用の意味層。利用者向けのビューと検索ログだけを置く'
);


CREATE OR REPLACE VIEW `cost-mgmt-prod-507701.explore.v_cost`
(
  `年月` OPTIONS(description = '月初日。月次集計の基準日。期間は必ずこの列で絞る'),
  `工場` OPTIONS(description = '製品の製造工場名。社内では「部門」とも呼ぶ（原価データの部門CD = 工場CD）'),
  `製品` OPTIONS(description = '製品名（成形部品P01 など）'),
  `顧客` OPTIONS(description = '製品の専売先の顧客名'),
  `工場コード` OPTIONS(description = '突合用。検索・絞り込みには 工場 を使う'),
  `製品コード` OPTIONS(description = '突合用。検索・絞り込みには 製品 を使う'),
  `顧客コード` OPTIONS(description = '突合用。検索・絞り込みには 顧客 を使う'),
  `直接材料費` OPTIONS(description = '原材料費（円）。ロットで製品に直接紐づけた額。年月は原価の計上月ではなく生産月'),
  `間接費` OPTIONS(description = '電力費・労務費・減価償却費・工場賃借料（円）を生産時間の比率で製品に配賦した額'),
  `総原価` OPTIONS(description = '直接材料費 + 間接費（円）'),
  `原価予算` OPTIONS(description = '工場×マシン単位の原価予算（円）を実績の生産時間比率で製品に配賦した額。実績生産がない月・製品は 0（予算なし）'),
  `生産量kg` OPTIONS(description = '生産量（kg、history.production の production_qty_kg の合計）。kg当たり原価の分母')
)
OPTIONS (
  description = '原価の月次データ（実績・予算）。1行 = 年月 × 製品。率は行の値を平均せず、額の合計から計算し直すこと'
)
AS
SELECT
  target_month,
  factory_name,
  product_name,
  customer_name,
  factory_code,
  product_code,
  customer_code,
  direct_material_cost,
  indirect_cost,
  total_cost,
  budget_cost,
  production_qty_kg
FROM `cost-mgmt-prod-507701.mart.v_variance`;


-- ================================================================
-- 検索ログ
--   誰が何を聞き、どう解釈され、利用者が何を選び直したかを残す。
--   週次の辞書見直し（nl_search/README.md の「運用」）の材料にする。
-- ================================================================

CREATE TABLE IF NOT EXISTS `cost-mgmt-prod-507701.explore.nl_search_log` (
  logged_at TIMESTAMP NOT NULL,
  request_id STRING NOT NULL,
  stage STRING NOT NULL,          -- 'interpret'（候補提示）| 'execute'（実行）
  user_email STRING,
  question STRING,
  llm_condition JSON,             -- Claude が返した条件 JSON（そのまま）
  resolved_condition JSON,        -- 辞書・カタログで確定した条件
  user_choices JSON,              -- 利用者が候補から選んだ値・切り替えた指標
  status STRING,                  -- 'ok' | 'needs_choice' | 'unsupported' | 'error'
  error_message STRING,
  estimated_bytes INT64,
  elapsed_ms INT64
)
PARTITION BY DATE(logged_at)
OPTIONS (
  description = '自然言語検索の利用ログ。辞書・カタログ・テストセットの改善に使う'
);
