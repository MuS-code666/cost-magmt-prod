CREATE TABLE `cost-mgmt-prod-507701.history.sales` (
transaction_id STRING NOT NULL,
sales_date DATE NOT NULL,
target_month DATE NOT NULL,
customer_code STRING NOT NULL,
product_code STRING NOT NULL,
lot_no STRING,
quantity_kg NUMERIC,
unit_price NUMERIC,
sales_amount INT64,
sales_staff_code STRING,
loaded_at TIMESTAMP
)
PARTITION BY DATE_TRUNC(target_month, MONTH)
CLUSTER BY product_code, customer_code;


CREATE TABLE `cost-mgmt-prod-507701.history.production` (
production_date DATE NOT NULL,
target_month DATE NOT NULL,
lot_no STRING NOT NULL,
factory_code STRING NOT NULL,
machine_code STRING NOT NULL,
worker_code STRING,
product_code STRING NOT NULL,
material_code STRING NOT NULL,
material_qty_kg NUMERIC,
production_qty_kg NUMERIC,
defect_qty_kg NUMERIC,
setup_hours NUMERIC,
production_hours NUMERIC,
note STRING,
loaded_at TIMESTAMP
)
PARTITION BY DATE_TRUNC(target_month, MONTH)
CLUSTER BY factory_code, machine_code, product_code;


CREATE TABLE `cost-mgmt-prod-507701.history.costs` (
cost_id STRING NOT NULL,
posting_date DATE NOT NULL,
target_month DATE NOT NULL,
cost_account_code STRING NOT NULL,
factory_code STRING,
machine_code STRING,
vendor_code STRING,
lot_no STRING,
description STRING,
unit_price NUMERIC,
quantity NUMERIC,
amount INT64,
note STRING,
loaded_at TIMESTAMP
)
PARTITION BY DATE_TRUNC(target_month, MONTH)
CLUSTER BY cost_account_code, factory_code, machine_code;


CREATE TABLE `cost-mgmt-prod-507701.history.monthly_reports` (
target_month DATE NOT NULL,
factory_code STRING,
category STRING,
sequence_no INT64,
content STRING,
loaded_at TIMESTAMP
)
PARTITION BY DATE_TRUNC(target_month, MONTH)
CLUSTER BY factory_code;


CREATE TABLE `cost-mgmt-prod-507701.history.sales_budgets` (
target_month DATE NOT NULL,
cost_account_code STRING,
customer_code STRING NOT NULL,
budget_amount INT64,
note STRING,
loaded_at TIMESTAMP
)
PARTITION BY DATE_TRUNC(target_month, MONTH)
CLUSTER BY customer_code;


CREATE TABLE `cost-mgmt-prod-507701.history.cost_budgets` (
target_month DATE NOT NULL,
cost_account_code STRING NOT NULL,
factory_code STRING NOT NULL,
machine_code STRING NOT NULL,
budget_amount INT64,
note STRING,
loaded_at TIMESTAMP
)
PARTITION BY DATE_TRUNC(target_month, MONTH)
CLUSTER BY cost_account_code, factory_code, machine_code;
