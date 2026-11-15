// ============================================================
// 原価 自然言語検索（GAS Webアプリ）
//
// 質問 → Claude が条件JSONに変換 → 辞書・カタログで確定 → 候補（条件チップ）を提示
// → 利用者が確認・選択 → SQLを組み立てて BigQuery（explore.v_cost）で実行、の2段階。
// 設計は nl_search/README.md。カタログ・辞書は nl_search/catalog/*.json が正で、
// カタログ_自動生成.gs はそこから npm run nl:build で作る。
//
// 事前準備: スクリプトプロパティ ANTHROPIC_API_KEY に Claude の API キーを保存する。
//           モデルを変えるときだけ CLAUDE_MODEL を保存する（未設定なら下の既定値）。
// 修正の反映: リポジトリ直下で npm run gas:push:nl（手順は GAS/README.md）。
// ============================================================

const NL_CONFIG = {
  PROJECT_ID: 'cost-mgmt-prod-507701',
  LOCATION: 'asia-northeast1',
  LOG_TABLE: { datasetId: 'explore', tableId: 'nl_search_log' },

  CLAUDE_URL: 'https://api.anthropic.com/v1/messages',
  CLAUDE_MODEL_DEFAULT: 'claude-opus-5-5',
  CLAUDE_EFFORT: 'low',
  CLAUDE_MAX_TOKENS: 4000,
  CLAUDE_RETRY_MAX: 1,

  QUESTION_MAX_CHARS: 300,
  MASTER_CACHE_KEY: 'nl_masters_v1',
  MASTER_CACHE_SECONDS: 21600
};
