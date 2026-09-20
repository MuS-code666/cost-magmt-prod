"""月報コメント内の数値を v_variance の生の値と突合する（Phase5 Task 5-5）。

使い方:
    python validate_comment.py comments/2026-08.md          # 突合（不一致があれば終了コード1）
    python validate_comment.py comments/2026-08.md --plain  # 注記を外した読み用テキストを出力

コメント内の数値は [[数値|部門コード|製品コード|列名]] の形で注記する。
部門集計の数値は製品コードを * にする。
検証内容:
  1. 注記された数値が、v_varianceの生の列から再計算した値と一致するか
  2. 注記されていない数値（製品コード・順位・年月などを除く）が残っていないか
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

PROJECT = "cost-mgmt-prod-507701"
MARKER = re.compile(r"\[\[([^|\]]*)\|([^|\]]*)\|([^|\]]*)\|([^\]]*)\]\]")
IGNORED = [r"\d{4}年\d{1,2}月", r"P\d+", r"\d{6}", r"rank\s*\d+", r"順位\d+(?:〜\d+)?", r"顧客企業\d+"]
NUMBER = re.compile(r"(?<![A-Za-z0-9_.])[+-]?\d+(?:\.\d+)?")
SIGNED_COLUMNS = {"variance_man", "variance_pct", "cost_yoy_man", "cost_yoy_pct"}


def dec(value):
    return None if value is None else Decimal(value)


def rounded(value, places):
    if value is None:
        return None
    return value.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)


def safe_div(a, b):
    return None if a is None or not b else a / b


def service_account_key():
    """読み取り専用SAの鍵パス。環境変数、無ければリポジトリの .mcp.json から取る。"""
    from_env = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if from_env:
        return from_env
    mcp_json = Path(__file__).resolve().parents[2] / ".mcp.json"
    config = json.loads(mcp_json.read_text(encoding="utf-8"))
    return config["mcpServers"]["bigquery"]["env"]["GOOGLE_APPLICATION_CREDENTIALS"]


def fetch_rows(month):
    sql = f"""
    SELECT factory_code, product_code, cost_budget_status,
           total_cost, budget_cost, cost_budget_variance_amount, cost_budget_variance_rate,
           direct_material_cost, defect_rate, productivity_vs_standard_rate,
           prior_year_total_cost, cost_yoy_amount, cost_yoy_rate, cost_budget_variance_rank
    FROM `{PROJECT}.mart.v_variance`
    WHERE target_month = DATE '{month}-01'
    """
    key_path = service_account_key()
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as config_dir:
        env = {**os.environ, "CLOUDSDK_CONFIG": config_dir}
        auth = subprocess.run(
            [shutil.which("gcloud"), "auth", "activate-service-account", f"--key-file={key_path}"],
            capture_output=True, text=True, encoding="utf-8", env=env,
        )
        if auth.returncode != 0:
            sys.exit(f"サービスアカウントの認証に失敗:\n{auth.stderr}")
        result = subprocess.run(
            [shutil.which("bq"), "query", f"--project_id={PROJECT}", "--use_legacy_sql=false", "--format=json", "--max_rows=10000"],
            input=sql, capture_output=True, text=True, encoding="utf-8", env=env,
        )
    if result.returncode != 0:
        sys.exit(f"bq query failed:\n{result.stderr}")
    rows = json.loads(result.stdout)
    if not rows:
        sys.exit(f"{month} のデータが v_variance にありません")
    return rows


def product_value(row, column):
    total = dec(row["total_cost"])
    man = Decimal(10000)
    table = {
        "total_cost_man": lambda: rounded(total / man, 1),
        "budget_cost_man": lambda: rounded(dec(row["budget_cost"]) / man, 1),
        "variance_man": lambda: rounded(dec(row["cost_budget_variance_amount"]) / man, 1),
        "variance_pct": lambda: rounded(dec(row["cost_budget_variance_rate"]) * 100 if row["cost_budget_variance_rate"] is not None else None, 1),
        "direct_material_share_pct": lambda: rounded(safe_div(dec(row["direct_material_cost"]), total) * 100 if safe_div(dec(row["direct_material_cost"]), total) is not None else None, 1),
        "defect_rate_pct": lambda: rounded(dec(row["defect_rate"]) * 100 if row["defect_rate"] is not None else None, 1),
        "productivity_vs_standard": lambda: rounded(dec(row["productivity_vs_standard_rate"]), 2),
        "prior_year_cost_man": lambda: rounded(dec(row["prior_year_total_cost"]) / man, 1),
        "cost_yoy_man": lambda: rounded(dec(row["cost_yoy_amount"]) / man, 1),
        "cost_yoy_pct": lambda: rounded(dec(row["cost_yoy_rate"]) * 100 if row["cost_yoy_rate"] is not None else None, 1),
        "rank": lambda: Decimal(row["cost_budget_variance_rank"]),
    }
    if column not in table:
        raise KeyError(f"未対応の列名: {column}")
    return table[column]()


def factory_value(rows, factory, column):
    group = [r for r in rows if r["factory_code"] == factory]
    if not group:
        raise KeyError(f"部門 {factory} のデータがありません")
    man = Decimal(10000)
    total = sum(dec(r["total_cost"]) for r in group)
    budget = sum(dec(r["budget_cost"]) for r in group)
    variance = sum(dec(r["cost_budget_variance_amount"]) for r in group)
    ratio = safe_div(variance, budget)
    table = {
        "product_count": lambda: Decimal(len(group)),
        "over_budget_count": lambda: Decimal(sum(r["cost_budget_status"] == "OVER_BUDGET" for r in group)),
        "no_budget_count": lambda: Decimal(sum(r["cost_budget_status"] == "NO_BUDGET" for r in group)),
        "total_cost_man": lambda: rounded(total / man, 1),
        "budget_cost_man": lambda: rounded(budget / man, 1),
        "variance_man": lambda: rounded(variance / man, 1),
        "variance_pct": lambda: rounded(ratio * 100 if ratio is not None else None, 1),
    }
    if column not in table:
        raise KeyError(f"部門集計で未対応の列名: {column}")
    return table[column]()


def expected_value(rows, factory, product, column):
    if product == "*":
        return factory_value(rows, factory, column)
    for row in rows:
        if row["factory_code"] == factory and row["product_code"] == product:
            return product_value(row, column)
    raise KeyError(f"製品 {factory}/{product} のデータがありません")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        sys.exit(__doc__)
    path = Path(args[0])
    text = path.read_text(encoding="utf-8")

    if "--plain" in sys.argv:
        print(MARKER.sub(lambda m: m.group(1), text))
        return

    month_match = re.fullmatch(r"(\d{4}-\d{2})", path.stem)
    if not month_match:
        sys.exit("ファイル名は YYYY-MM.md にしてください")
    rows = fetch_rows(month_match.group(1))

    failures = 0
    checked = 0
    for m in MARKER.finditer(text):
        token, factory, product, column = (g.strip() for g in m.groups())
        label = f"{factory}/{product} {column}"
        try:
            expected = expected_value(rows, factory, product, column)
        except KeyError as e:
            print(f"FAIL  {label}  comment={token}  {e}")
            failures += 1
            continue
        checked += 1
        try:
            actual = Decimal(token.lstrip("+"))
        except Exception:
            print(f"FAIL  {label}  comment={token!r} は数値として読めません")
            failures += 1
            continue
        problems = []
        if expected is None:
            problems.append("v_variance側がNULL（コメントに数値を書いてはいけない）")
        elif actual != expected:
            problems.append(f"値の不一致 expected={expected}")
        elif column in SIGNED_COLUMNS and expected != 0:
            want = "+" if expected > 0 else "-"
            if token[0] != want:
                problems.append(f"符号表記の誤り（{want}を付ける）")
        if problems:
            failures += 1
            print(f"FAIL  {label}  comment={token}  " + " / ".join(problems))
        else:
            print(f"PASS  {label}  comment={token}  expected={expected}")

    residue = MARKER.sub("", text)
    for pattern in IGNORED:
        residue = re.sub(pattern, "", residue)
    for m in NUMBER.finditer(residue):
        start = max(0, m.start() - 12)
        print(f"FAIL  注記のない数値 {m.group()!r}  …{residue[start:m.end() + 8].strip()}…")
        failures += 1

    print(f"\n{path.name}: 突合 {checked} 件、失敗 {failures} 件")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
