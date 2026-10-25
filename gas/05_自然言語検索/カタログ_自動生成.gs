// ============================================================
// 自動生成ファイル。手で編集しない。
// 元データ: nl_search/catalog/metrics.json, nl_search/catalog/aliases.json, tests/nl_search/testset.json
// 再生成: リポジトリ直下で npm run nl:build
// ============================================================

const NL_CATALOG = {
  "version": "2026-10-25",
  "view": "cost-mgmt-prod-507701.explore.v_cost",
  "period_column": "年月",
  "unit_note": "金額はすべて円。v_cost の列説明（BigQuery の OPTIONS）が列の定義の正",
  "metrics": [
    {
      "metric_id": "total_cost",
      "label": "総原価",
      "expr": "SUM(`総原価`)",
      "format": "yen",
      "description": "製品の実績原価（円）。直接材料費と、生産時間で配賦した間接費の合計。原価予算は含まない。",
      "synonyms": [
        "原価",
        "総原価",
        "実績原価",
        "製造原価",
        "コスト",
        "かかった費用",
        "費用"
      ],
      "not_for": "「予算」「計画」を聞かれたら budget_cost。予算との差は cost_budget_variance。",
      "worse_when": "up",
      "allowed_group_by": [
        "factory",
        "product",
        "customer",
        "month"
      ],
      "allowed_compare": [
        "prev_year",
        "prev_month"
      ],
      "example_questions": [
        "先月の原価はいくら",
        "工場別の原価を前年と比べて",
        "原価が大きい上位5製品"
      ],
      "owner": "未定"
    },
    {
      "metric_id": "direct_material_cost",
      "label": "直接材料費",
      "expr": "SUM(`直接材料費`)",
      "format": "yen",
      "description": "原材料費（円）。ロットで製品に直接紐づけた額。年月は原価の計上月ではなく生産月。",
      "synonyms": [
        "材料費",
        "直接材料費",
        "原材料費",
        "材料代",
        "樹脂代"
      ],
      "not_for": "電力・人件費などは indirect_cost。両方の合計は total_cost。",
      "worse_when": "up",
      "allowed_group_by": [
        "factory",
        "product",
        "customer",
        "month"
      ],
      "allowed_compare": [
        "prev_year",
        "prev_month"
      ],
      "example_questions": [
        "先月の材料費を製品別に",
        "材料費の直近12か月の推移"
      ],
      "owner": "未定"
    },
    {
      "metric_id": "indirect_cost",
      "label": "間接費",
      "expr": "SUM(`間接費`)",
      "format": "yen",
      "description": "電力費・労務費・減価償却費・工場賃借料（円）を、生産時間の比率で製品に配賦した額。",
      "synonyms": [
        "間接費",
        "加工費",
        "経費",
        "配賦費",
        "製造間接費"
      ],
      "not_for": "費目別（電力費だけ等）の内訳は出せない。費目別を聞かれたら unsupported。",
      "worse_when": "up",
      "allowed_group_by": [
        "factory",
        "product",
        "customer",
        "month"
      ],
      "allowed_compare": [
        "prev_year",
        "prev_month"
      ],
      "example_questions": [
        "第二成形工場の間接費を前年と比べて",
        "間接費が大きい製品は"
      ],
      "owner": "未定"
    },
    {
      "metric_id": "budget_cost",
      "label": "原価予算",
      "expr": "SUM(`原価予算`)",
      "format": "yen",
      "description": "原価予算（円）。工場×マシン単位の予算を実績の生産時間比率で製品に配賦した額。実績生産がない月・製品は 0。",
      "synonyms": [
        "予算",
        "原価予算",
        "予算原価",
        "計画",
        "予定原価"
      ],
      "not_for": "実際にかかった額は total_cost。売上予算はこの検索の対象外。",
      "worse_when": null,
      "allowed_group_by": [
        "factory",
        "product",
        "customer",
        "month"
      ],
      "allowed_compare": [
        "prev_year",
        "prev_month"
      ],
      "example_questions": [
        "今期の原価予算を工場別に"
      ],
      "owner": "未定"
    },
    {
      "metric_id": "cost_budget_variance",
      "label": "原価予算差異額",
      "expr": "SUM(`総原価`) - SUM(`原価予算`)",
      "format": "yen",
      "description": "総原価 − 原価予算（円）。プラスは予算超過（悪化）。予算 0 の行も総原価がそのまま差異に入る（月報・閾値アラートと同じ計算）。",
      "synonyms": [
        "予算差異",
        "原価予算差異",
        "予実差",
        "予算との差",
        "予算オーバー",
        "予算超過額",
        "差異"
      ],
      "not_for": "前年との差は compare: prev_year を使う（この指標ではない）。率を聞かれたら cost_budget_variance_rate。",
      "worse_when": "up",
      "allowed_group_by": [
        "factory",
        "product",
        "customer",
        "month"
      ],
      "allowed_compare": [
        "prev_year",
        "prev_month"
      ],
      "example_questions": [
        "先月の予算差異を工場別に",
        "予算オーバーが大きい上位10製品"
      ],
      "owner": "未定"
    },
    {
      "metric_id": "cost_budget_variance_rate",
      "label": "原価予算差異率",
      "expr": "SAFE_DIVIDE(SUM(`総原価`) - SUM(`原価予算`), NULLIF(SUM(`原価予算`), 0))",
      "format": "percent",
      "description": "(総原価 − 原価予算) ÷ 原価予算。行の率を平均せず、額の合計から計算し直す。予算 0 のときは空欄。",
      "synonyms": [
        "予算差異率",
        "差異率",
        "予算比",
        "予算超過率",
        "予算との差（%）"
      ],
      "not_for": "額を聞かれたら cost_budget_variance。",
      "worse_when": "up",
      "allowed_group_by": [
        "factory",
        "product",
        "customer",
        "month"
      ],
      "allowed_compare": [
        "prev_year",
        "prev_month"
      ],
      "example_questions": [
        "先月の予算差異率を工場別に",
        "差異率が高い製品トップ5"
      ],
      "owner": "未定"
    },
    {
      "metric_id": "cost_per_kg",
      "label": "kg当たり原価",
      "expr": "SAFE_DIVIDE(SUM(`総原価`), NULLIF(SUM(`生産量kg`), 0))",
      "format": "yen_per_kg",
      "description": "総原価 ÷ 生産量（円/kg）。行の値を平均せず、合計どうしで割る。生産量 0 のときは空欄。",
      "synonyms": [
        "kg当たり原価",
        "キロ当たり原価",
        "単位原価",
        "原単位",
        "kg単価",
        "製造単価"
      ],
      "not_for": "販売単価・売価は対象外。",
      "worse_when": "up",
      "allowed_group_by": [
        "factory",
        "product",
        "customer",
        "month"
      ],
      "allowed_compare": [
        "prev_year",
        "prev_month"
      ],
      "example_questions": [
        "製品別のkg当たり原価",
        "kg当たり原価の推移"
      ],
      "owner": "未定"
    }
  ],
  "dimensions": [
    {
      "dim": "factory",
      "label": "工場",
      "column": "工場",
      "synonyms": [
        "工場",
        "部門",
        "部署",
        "拠点",
        "工場別",
        "部門別"
      ]
    },
    {
      "dim": "product",
      "label": "製品",
      "column": "製品",
      "synonyms": [
        "製品",
        "品目",
        "部品",
        "アイテム",
        "製品別",
        "品目別"
      ]
    },
    {
      "dim": "customer",
      "label": "顧客",
      "column": "顧客",
      "synonyms": [
        "顧客",
        "得意先",
        "取引先",
        "客先",
        "お客さん",
        "顧客別"
      ]
    },
    {
      "dim": "month",
      "label": "月",
      "column": "年月",
      "synonyms": [
        "月別",
        "月ごと",
        "推移",
        "月次",
        "毎月"
      ]
    }
  ],
  "compares": [
    {
      "compare": "prev_year",
      "label": "前年同月",
      "synonyms": [
        "前年",
        "去年",
        "昨年",
        "前年同月",
        "前年比",
        "前年同期"
      ]
    },
    {
      "compare": "prev_month",
      "label": "前月",
      "synonyms": [
        "前月比",
        "先月と比べて",
        "前の月"
      ]
    }
  ],
  "conflicts": [
    {
      "term": "原価",
      "candidates": [
        "total_cost",
        "direct_material_cost",
        "indirect_cost",
        "cost_per_kg"
      ],
      "default": "total_cost",
      "rule": "「材料」があれば direct_material_cost、「間接」「加工」があれば indirect_cost、「kg」「単価」「原単位」があれば cost_per_kg。どれもなければ既定を使い、チップで切り替えを出す。"
    },
    {
      "term": "差異",
      "candidates": [
        "cost_budget_variance",
        "cost_budget_variance_rate",
        "compare:prev_year"
      ],
      "default": "cost_budget_variance",
      "rule": "「前年」「去年」があれば前年比較（指標は total_cost、compare: prev_year）。「率」「%」があれば率。どれもなければ予算差異額（月報・アラートと同じ定義）を既定にし、チップで切り替えを出す。"
    },
    {
      "term": "予算",
      "candidates": [
        "budget_cost",
        "cost_budget_variance"
      ],
      "default": "budget_cost",
      "rule": "「差」「オーバー」「超過」があれば cost_budget_variance。"
    }
  ],
  "out_of_scope": [
    {
      "terms": [
        "売上",
        "売り上げ",
        "利益",
        "粗利",
        "採算",
        "販売"
      ],
      "message": "売上・利益はまだ検索の対象外です（原価系の指標から開始しています）。"
    },
    {
      "terms": [
        "電力費",
        "労務費",
        "人件費",
        "減価償却",
        "賃借料",
        "家賃"
      ],
      "message": "費目別の内訳はまだ出せません。間接費（電力・労務・償却・賃借の合計）なら確認できます。"
    },
    {
      "terms": [
        "マシン",
        "号機",
        "設備",
        "作業員",
        "担当者"
      ],
      "message": "マシン別・作業員別の切り口はまだ対象外です。工場別・製品別・顧客別なら確認できます。"
    }
  ],
  "limits": {
    "max_group_by": 2,
    "max_rows": 200,
    "max_ranking_limit": 50,
    "max_months": 36,
    "maximum_bytes_billed": 104857600
  }
};

const NL_ALIASES = {
  "version": "2026-10-25",
  "note": "値の辞書（設計資料の dim_alias）。正式名称は master 表の名称。マスタの件数が少ない（工場2・製品50・顧客25）ため GAS 内で照合する。",
  "normalize": [
    "全角英数字・記号を半角にそろえる（NFKC）",
    "大文字・小文字をそろえる",
    "空白を除く",
    "「株式会社」「(株)」「㈱」を除く",
    "漢数字の一〜九を算用数字にそろえる（第一 → 第1）"
  ],
  "patterns": [
    {
      "dim": "product",
      "regex": "^(?:成形)?(?:部品)?p0*([1-9][0-9]?)$",
      "canonical_template": "成形部品P{2桁}",
      "examples": [
        "P1",
        "p01",
        "部品P01",
        "成形部品P1"
      ]
    },
    {
      "dim": "customer",
      "regex": "^顧客(?:企業)?0*([1-9][0-9]?)$",
      "canonical_template": "顧客企業{2桁}株式会社",
      "examples": [
        "顧客1",
        "顧客企業01",
        "顧客企業01株式会社"
      ]
    }
  ],
  "aliases": [
    {
      "dim": "factory",
      "canonical": "第一成形工場",
      "alias": "第1工場",
      "source": "manual",
      "updated_at": "2026-10-25"
    },
    {
      "dim": "factory",
      "canonical": "第一成形工場",
      "alias": "第1",
      "source": "manual",
      "updated_at": "2026-10-25"
    },
    {
      "dim": "factory",
      "canonical": "第一成形工場",
      "alias": "1工場",
      "source": "manual",
      "updated_at": "2026-10-25"
    },
    {
      "dim": "factory",
      "canonical": "第一成形工場",
      "alias": "第1成形",
      "source": "manual",
      "updated_at": "2026-10-25"
    },
    {
      "dim": "factory",
      "canonical": "第二成形工場",
      "alias": "第2工場",
      "source": "manual",
      "updated_at": "2026-10-25"
    },
    {
      "dim": "factory",
      "canonical": "第二成形工場",
      "alias": "第2",
      "source": "manual",
      "updated_at": "2026-10-25"
    },
    {
      "dim": "factory",
      "canonical": "第二成形工場",
      "alias": "2工場",
      "source": "manual",
      "updated_at": "2026-10-25"
    },
    {
      "dim": "factory",
      "canonical": "第二成形工場",
      "alias": "第2成形",
      "source": "manual",
      "updated_at": "2026-10-25"
    }
  ],
  "period_tokens": {
    "fiscal_year_start_month": 4,
    "fiscal_year_note": "4月始まり（2026-10-25 確定）。年度は開始年で呼ぶ（2026年度 = 2026-04〜2027-03）",
    "tokens": [
      {
        "token": "this_month",
        "phrases": [
          "今月",
          "当月"
        ],
        "expand": "今日の月。確定前のため結果に「速報」と表示する"
      },
      {
        "token": "last_month",
        "phrases": [
          "先月",
          "前月"
        ],
        "expand": "今日の前月"
      },
      {
        "token": "month(YYYY-MM)",
        "phrases": [
          "2026年9月",
          "26年9月"
        ],
        "expand": "その月"
      },
      {
        "token": "month(M)",
        "phrases": [
          "9月",
          "3月分"
        ],
        "expand": "年がない月。今日以前で直近のその月"
      },
      {
        "token": "last_n_months(N)",
        "phrases": [
          "直近3か月",
          "過去半年",
          "この1年"
        ],
        "expand": "先月までの N か月（当月を含めない）。半年 = 6、1年 = 12"
      },
      {
        "token": "range(YYYY-MM,YYYY-MM)",
        "phrases": [
          "4月から9月",
          "2025年10月〜2026年3月"
        ],
        "expand": "両端を含む月の範囲"
      },
      {
        "token": "current_fiscal_year",
        "phrases": [
          "今期",
          "今年度",
          "期初から"
        ],
        "expand": "今年度の開始月〜先月（確定済みの月まで）"
      },
      {
        "token": "previous_fiscal_year",
        "phrases": [
          "前期",
          "昨年度",
          "前年度"
        ],
        "expand": "今年度の 1つ前の年度の 4月〜翌3月。比較先の「前年度と比べて」は compare: prev_year"
      },
      {
        "token": "fiscal_year(YYYY)",
        "phrases": [
          "2025年度"
        ],
        "expand": "その年度の 4月〜翌3月"
      },
      {
        "token": "fiscal_half(H)",
        "phrases": [
          "上期",
          "下期",
          "上半期"
        ],
        "expand": "今年度の H1 = 4〜9月、H2 = 10〜翌3月"
      },
      {
        "token": "fiscal_half(YYYY,H)",
        "phrases": [
          "2025年度上期"
        ],
        "expand": "その年度の H1 / H2"
      }
    ],
    "not_periods": [
      {
        "phrases": [
          "前年",
          "去年と比べて",
          "前年同月"
        ],
        "meaning": "期間ではなく compare: prev_year"
      },
      {
        "phrases": [
          "前月比"
        ],
        "meaning": "期間ではなく compare: prev_month"
      }
    ]
  }
};

const NL_TESTSET = {
  "version": "2026-10-25",
  "today": "2026-10-25",
  "note": "期待値は GAS が辞書・カタログで確定した後の条件（filters の value は正式名称、text は Claude が返すべき利用者の言い方）。期間はトークンのまま比べ、日付への展開は別途テストする。",
  "scoring": {
    "elements": [
      "metric",
      "group_by",
      "period",
      "filters",
      "compare"
    ],
    "rules": [
      "5要素を別々に採点し、要素ごとの一致率を前回と比べる",
      "group_by と filters は順不同で比べる。period はトークンの書き方ではなく、今日の日付で展開した月の範囲で比べる",
      "status（ok / needs_choice / unsupported）も別に採点する。status が unsupported の問いは5要素を採点しない",
      "default_used は、既定で解決した用語がチップに明示されるかを確かめる項目",
      "公開の目安: metric 100% に近い、その他の要素と status は 90% 以上"
    ]
  },
  "cases": [
    {
      "id": "T001",
      "question": "先月の原価はいくら",
      "status": "ok",
      "expected": {
        "type": "aggregate",
        "metric": "total_cost",
        "period": "last_month",
        "filters": [],
        "group_by": [],
        "compare": null
      },
      "default_used": [
        "原価"
      ]
    },
    {
      "id": "T002",
      "question": "9月の総原価",
      "status": "ok",
      "expected": {
        "type": "aggregate",
        "metric": "total_cost",
        "period": "month(2026-09)",
        "filters": [],
        "group_by": [],
        "compare": null
      },
      "note": "年がない月は今日以前で直近のその月"
    },
    {
      "id": "T003",
      "question": "今期の材料費の合計",
      "status": "ok",
      "expected": {
        "type": "aggregate",
        "metric": "direct_material_cost",
        "period": "current_fiscal_year",
        "filters": [],
        "group_by": [],
        "compare": null
      }
    },
    {
      "id": "T004",
      "question": "2025年度の原価予算はいくらだった",
      "status": "ok",
      "expected": {
        "type": "aggregate",
        "metric": "budget_cost",
        "period": "fiscal_year(2025)",
        "filters": [],
        "group_by": [],
        "compare": null
      }
    },
    {
      "id": "T005",
      "question": "第一工場の先月の間接費",
      "status": "ok",
      "expected": {
        "type": "aggregate",
        "metric": "indirect_cost",
        "period": "last_month",
        "filters": [
          {
            "dim": "factory",
            "text": "第一工場",
            "value": "第一成形工場"
          }
        ],
        "group_by": [],
        "compare": null
      }
    },
    {
      "id": "T006",
      "question": "先月のkg当たり原価",
      "status": "ok",
      "expected": {
        "type": "aggregate",
        "metric": "cost_per_kg",
        "period": "last_month",
        "filters": [],
        "group_by": [],
        "compare": null
      }
    },
    {
      "id": "T007",
      "question": "先月の原価を工場別に",
      "status": "ok",
      "expected": {
        "type": "breakdown",
        "metric": "total_cost",
        "period": "last_month",
        "filters": [],
        "group_by": [
          "factory"
        ],
        "compare": null
      },
      "default_used": [
        "原価"
      ]
    },
    {
      "id": "T008",
      "question": "部門別の予算差異を見せて",
      "status": "ok",
      "expected": {
        "type": "breakdown",
        "metric": "cost_budget_variance",
        "period": "last_month",
        "filters": [],
        "group_by": [
          "factory"
        ],
        "compare": null
      },
      "note": "部門 = 工場。期間がないときは先月"
    },
    {
      "id": "T009",
      "question": "第二工場の先月の原価を製品別に",
      "status": "ok",
      "expected": {
        "type": "breakdown",
        "metric": "total_cost",
        "period": "last_month",
        "filters": [
          {
            "dim": "factory",
            "text": "第二工場",
            "value": "第二成形工場"
          }
        ],
        "group_by": [
          "product"
        ],
        "compare": null
      },
      "default_used": [
        "原価"
      ]
    },
    {
      "id": "T010",
      "question": "顧客別の材料費（今期）",
      "status": "ok",
      "expected": {
        "type": "breakdown",
        "metric": "direct_material_cost",
        "period": "current_fiscal_year",
        "filters": [],
        "group_by": [
          "customer"
        ],
        "compare": null
      }
    },
    {
      "id": "T011",
      "question": "上期の予算差異率を工場別に",
      "status": "ok",
      "expected": {
        "type": "breakdown",
        "metric": "cost_budget_variance_rate",
        "period": "fiscal_half(2026,H1)",
        "filters": [],
        "group_by": [
          "factory"
        ],
        "compare": null
      }
    },
    {
      "id": "T012",
      "question": "製品別・工場別に先月の間接費",
      "status": "ok",
      "expected": {
        "type": "breakdown",
        "metric": "indirect_cost",
        "period": "last_month",
        "filters": [],
        "group_by": [
          "product",
          "factory"
        ],
        "compare": null
      }
    },
    {
      "id": "T013",
      "question": "先月の原価を前年と比べて",
      "status": "ok",
      "expected": {
        "type": "compare",
        "metric": "total_cost",
        "period": "last_month",
        "filters": [],
        "group_by": [],
        "compare": "prev_year"
      },
      "default_used": [
        "原価"
      ]
    },
    {
      "id": "T014",
      "question": "先月の製造の原価を、製品別に前年と比べて",
      "status": "ok",
      "expected": {
        "type": "breakdown",
        "metric": "total_cost",
        "period": "last_month",
        "filters": [],
        "group_by": [
          "product"
        ],
        "compare": "prev_year"
      },
      "note": "資料の通し例。本システムに「製造」という部門はないため、「製造の原価」= 製造原価（total_cost の同義語）として絞り込みにしない"
    },
    {
      "id": "T015",
      "question": "材料費は前月比でどう",
      "status": "ok",
      "expected": {
        "type": "compare",
        "metric": "direct_material_cost",
        "period": "last_month",
        "filters": [],
        "group_by": [],
        "compare": "prev_month"
      }
    },
    {
      "id": "T016",
      "question": "今期の工場別原価を去年と比べて",
      "status": "ok",
      "expected": {
        "type": "breakdown",
        "metric": "total_cost",
        "period": "current_fiscal_year",
        "filters": [],
        "group_by": [
          "factory"
        ],
        "compare": "prev_year"
      },
      "default_used": [
        "原価"
      ]
    },
    {
      "id": "T017",
      "question": "顧客3の原価、前年同月比",
      "status": "ok",
      "expected": {
        "type": "compare",
        "metric": "total_cost",
        "period": "last_month",
        "filters": [
          {
            "dim": "customer",
            "text": "顧客3",
            "value": "顧客企業03株式会社"
          }
        ],
        "group_by": [],
        "compare": "prev_year"
      },
      "default_used": [
        "原価"
      ]
    },
    {
      "id": "T018",
      "question": "先月、予算オーバーが大きい上位10製品",
      "status": "ok",
      "expected": {
        "type": "ranking",
        "metric": "cost_budget_variance",
        "period": "last_month",
        "filters": [],
        "group_by": [
          "product"
        ],
        "compare": null,
        "order": {
          "by": "value",
          "dir": "desc"
        },
        "limit": 10
      },
      "note": "工場の絞り込みがないので全社順位。月報・アラートのワーストN（工場内順位）と違う旨を画面に出す"
    },
    {
      "id": "T019",
      "question": "予算差異のワースト5製品",
      "status": "ok",
      "expected": {
        "type": "ranking",
        "metric": "cost_budget_variance",
        "period": "last_month",
        "filters": [],
        "group_by": [
          "product"
        ],
        "compare": null,
        "order": {
          "by": "value",
          "dir": "desc"
        },
        "limit": 5
      }
    },
    {
      "id": "T020",
      "question": "前年より原価が増えた上位5製品",
      "status": "ok",
      "expected": {
        "type": "ranking",
        "metric": "total_cost",
        "period": "last_month",
        "filters": [],
        "group_by": [
          "product"
        ],
        "compare": "prev_year",
        "order": {
          "by": "diff",
          "dir": "desc"
        },
        "limit": 5
      },
      "default_used": [
        "原価"
      ]
    },
    {
      "id": "T021",
      "question": "今期、kg当たり原価が高い製品トップ3",
      "status": "ok",
      "expected": {
        "type": "ranking",
        "metric": "cost_per_kg",
        "period": "current_fiscal_year",
        "filters": [],
        "group_by": [
          "product"
        ],
        "compare": null,
        "order": {
          "by": "value",
          "dir": "desc"
        },
        "limit": 3
      }
    },
    {
      "id": "T022",
      "question": "先月、予算差異率が一番低い顧客は",
      "status": "ok",
      "expected": {
        "type": "ranking",
        "metric": "cost_budget_variance_rate",
        "period": "last_month",
        "filters": [],
        "group_by": [
          "customer"
        ],
        "compare": null,
        "order": {
          "by": "value",
          "dir": "asc"
        },
        "limit": 1
      }
    },
    {
      "id": "T023",
      "question": "直近12か月の原価推移",
      "status": "ok",
      "expected": {
        "type": "trend",
        "metric": "total_cost",
        "period": "last_n_months(12)",
        "filters": [],
        "group_by": [
          "month"
        ],
        "compare": null
      },
      "default_used": [
        "原価"
      ]
    },
    {
      "id": "T024",
      "question": "第二工場の材料費の推移（今期）",
      "status": "ok",
      "expected": {
        "type": "trend",
        "metric": "direct_material_cost",
        "period": "current_fiscal_year",
        "filters": [
          {
            "dim": "factory",
            "text": "第二工場",
            "value": "第二成形工場"
          }
        ],
        "group_by": [
          "month"
        ],
        "compare": null
      }
    },
    {
      "id": "T025",
      "question": "P5のkg当たり原価の月別推移、過去半年",
      "status": "ok",
      "expected": {
        "type": "trend",
        "metric": "cost_per_kg",
        "period": "last_n_months(6)",
        "filters": [
          {
            "dim": "product",
            "text": "P5",
            "value": "成形部品P05"
          }
        ],
        "group_by": [
          "month"
        ],
        "compare": null
      }
    },
    {
      "id": "T026",
      "question": "2025年4月から9月の予算差異を月ごとに",
      "status": "ok",
      "expected": {
        "type": "trend",
        "metric": "cost_budget_variance",
        "period": "range(2025-04,2025-09)",
        "filters": [],
        "group_by": [
          "month"
        ],
        "compare": null
      }
    },
    {
      "id": "T027",
      "question": "先月の差異を工場別に",
      "status": "ok",
      "expected": {
        "type": "breakdown",
        "metric": "cost_budget_variance",
        "period": "last_month",
        "filters": [],
        "group_by": [
          "factory"
        ],
        "compare": null
      },
      "default_used": [
        "差異"
      ]
    },
    {
      "id": "T028",
      "question": "原価、先月分",
      "status": "ok",
      "expected": {
        "type": "aggregate",
        "metric": "total_cost",
        "period": "last_month",
        "filters": [],
        "group_by": [],
        "compare": null
      },
      "default_used": [
        "原価"
      ]
    },
    {
      "id": "T029",
      "question": "今期の予算",
      "status": "ok",
      "expected": {
        "type": "aggregate",
        "metric": "budget_cost",
        "period": "current_fiscal_year",
        "filters": [],
        "group_by": [],
        "compare": null
      },
      "default_used": [
        "予算"
      ]
    },
    {
      "id": "T030",
      "question": "去年の同じ時期と比べて今月の原価はどう",
      "status": "ok",
      "expected": {
        "type": "compare",
        "metric": "total_cost",
        "period": "this_month",
        "filters": [],
        "group_by": [],
        "compare": "prev_year"
      },
      "default_used": [
        "原価"
      ],
      "note": "当月は速報表示"
    },
    {
      "id": "T031",
      "question": "第1工場と第2工場の間接費を比べて",
      "status": "ok",
      "expected": {
        "type": "breakdown",
        "metric": "indirect_cost",
        "period": "last_month",
        "filters": [
          {
            "dim": "factory",
            "text": "第1工場",
            "value": "第一成形工場"
          },
          {
            "dim": "factory",
            "text": "第2工場",
            "value": "第二成形工場"
          }
        ],
        "group_by": [
          "factory"
        ],
        "compare": null
      },
      "note": "同じ切り口の値どうしの比較は compare ではなく、その切り口の内訳＋その値での絞り込み"
    },
    {
      "id": "T032",
      "question": "顧客企業12株式会社の今期の予算差異率",
      "status": "ok",
      "expected": {
        "type": "aggregate",
        "metric": "cost_budget_variance_rate",
        "period": "current_fiscal_year",
        "filters": [
          {
            "dim": "customer",
            "text": "顧客企業12株式会社",
            "value": "顧客企業12株式会社"
          }
        ],
        "group_by": [],
        "compare": null
      }
    },
    {
      "id": "T033",
      "question": "先月の原価、予算と比べて",
      "status": "ok",
      "expected": {
        "type": "aggregate",
        "metric": "cost_budget_variance",
        "period": "last_month",
        "filters": [],
        "group_by": [],
        "compare": null
      },
      "note": "予算との比較は compare ではなく予算差異の指標"
    },
    {
      "id": "T034",
      "question": "今期の原価予算を工場別に、前年度と比べて",
      "status": "ok",
      "expected": {
        "type": "breakdown",
        "metric": "budget_cost",
        "period": "current_fiscal_year",
        "filters": [],
        "group_by": [
          "factory"
        ],
        "compare": "prev_year"
      }
    },
    {
      "id": "T035",
      "question": "第三工場の先月の原価",
      "status": "needs_choice",
      "expected": {
        "type": "aggregate",
        "metric": "total_cost",
        "period": "last_month",
        "filters": [
          {
            "dim": "factory",
            "text": "第三工場",
            "value": null
          }
        ],
        "group_by": [],
        "compare": null
      },
      "note": "第三工場はない。近い候補（第一成形工場・第二成形工場）を出し、自動では確定しない"
    },
    {
      "id": "T036",
      "question": "P60の原価",
      "status": "needs_choice",
      "expected": {
        "type": "aggregate",
        "metric": "total_cost",
        "period": "last_month",
        "filters": [
          {
            "dim": "product",
            "text": "P60",
            "value": null
          }
        ],
        "group_by": [],
        "compare": null
      },
      "note": "製品は P01〜P50。見つからないと伝え、近い名称を出す"
    },
    {
      "id": "T037",
      "question": "なぜ先月原価が増えたの",
      "status": "unsupported",
      "expected": {
        "type": "unsupported",
        "reason": "cause_analysis",
        "suggest": [
          "breakdown",
          "compare"
        ]
      }
    },
    {
      "id": "T038",
      "question": "来期の原価はいくらになりそう",
      "status": "unsupported",
      "expected": {
        "type": "unsupported",
        "reason": "forecast"
      },
      "note": "予算（budget_cost）との比較を案内する"
    },
    {
      "id": "T039",
      "question": "先月の売上を製品別に",
      "status": "unsupported",
      "expected": {
        "type": "unsupported",
        "reason": "out_of_scope"
      }
    },
    {
      "id": "T040",
      "question": "電力費の推移",
      "status": "unsupported",
      "expected": {
        "type": "unsupported",
        "reason": "out_of_scope"
      },
      "note": "費目別は出せない。間接費の推移を案内する"
    },
    {
      "id": "T041",
      "question": "マシン別の間接費",
      "status": "unsupported",
      "expected": {
        "type": "unsupported",
        "reason": "out_of_scope"
      }
    },
    {
      "id": "T042",
      "question": "作業員Aの生産量",
      "status": "unsupported",
      "expected": {
        "type": "unsupported",
        "reason": "out_of_scope"
      }
    },
    {
      "id": "T043",
      "question": "製品別の原価率（原価÷売上）",
      "status": "unsupported",
      "expected": {
        "type": "unsupported",
        "reason": "out_of_scope"
      }
    }
  ]
};
