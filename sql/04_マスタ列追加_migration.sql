-- ============================================================
-- マスタ5表の列追加マイグレーション
--
-- DataRoad コード.gs（getMasterSpecs_）が出力する列と、
-- 01_マスタ用データセット作成.sqlで作成済みの既存テーブルの
-- 列数が一致していなかったため、不足していた列を追加する。
--
-- ALTER TABLE ADD COLUMNで追加した列は既存テーブルの末尾に
-- 追加される。DataRoad コード.gsの出力列順もこれらの列を
-- 末尾に配置しているため、追加後の列順はDataRoadの出力と一致する。
--
-- 既存行の追加列の値はNULLになるが、loadMastersToBigQuery()は
-- 実行のたびに対象テーブルを全件洗い替え（WRITE_TRUNCATE）する
-- ため、次回実行時に実データで上書きされる。
-- ============================================================

ALTER TABLE `cost-mgmt-prod-507701.master.materials`
  ADD COLUMN IF NOT EXISTS primary_vendor_code STRING;

ALTER TABLE `cost-mgmt-prod-507701.master.factories`
  ADD COLUMN IF NOT EXISTS annual_factory_rent NUMERIC;

ALTER TABLE `cost-mgmt-prod-507701.master.machines`
  ADD COLUMN IF NOT EXISTS rated_power_kw NUMERIC,
  ADD COLUMN IF NOT EXISTS annual_depreciation NUMERIC;

ALTER TABLE `cost-mgmt-prod-507701.master.workers`
  ADD COLUMN IF NOT EXISTS machine_code STRING;

ALTER TABLE `cost-mgmt-prod-507701.master.vendors`
  ADD COLUMN IF NOT EXISTS vendor_type STRING;
