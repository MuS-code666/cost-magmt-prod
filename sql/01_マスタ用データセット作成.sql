CREATE TABLE `cost-mgmt-prod-507701.master.products` (
  product_code STRING NOT NULL,
  product_name STRING,
  customer_code STRING,
  material_code STRING,
  factory_code STRING,
  standard_productivity_kg_h NUMERIC,
  standard_sales_price NUMERIC,
  sales_staff_code STRING,
  standard_load_rate NUMERIC
);

CREATE TABLE `cost-mgmt-prod-507701.master.customers` (
  customer_code STRING NOT NULL,
  customer_name STRING,
  sales_staff_code STRING
);

CREATE TABLE `cost-mgmt-prod-507701.master.materials` (
  material_code STRING NOT NULL,
  material_name STRING,
  unit_price NUMERIC,
  primary_vendor_code STRING
);

CREATE TABLE `cost-mgmt-prod-507701.master.factories` (
  factory_code STRING NOT NULL,
  factory_name STRING,
  annual_factory_rent NUMERIC
);


CREATE TABLE `cost-mgmt-prod-507701.master.machines` (
  machine_code STRING NOT NULL,
  machine_name STRING,
  factory_code STRING,
  rated_power_kw NUMERIC,
  annual_depreciation NUMERIC
);

CREATE TABLE `cost-mgmt-prod-507701.master.workers` (
  worker_code STRING NOT NULL,
  worker_name STRING,
  factory_code STRING,
  machine_code STRING
);

CREATE TABLE `cost-mgmt-prod-507701.master.sales_staff` (
  sales_staff_code STRING NOT NULL,
  sales_staff_name STRING
);

CREATE TABLE `cost-mgmt-prod-507701.master.vendors` (
  vendor_code STRING NOT NULL,
  vendor_name STRING,
  vendor_type STRING
);

CREATE TABLE `cost-mgmt-prod-507701.master.cost_accounts` (
  cost_account_code STRING NOT NULL,
  cost_account_name STRING,
  allocation_method STRING
);
