// ============================================================
// コントロールパネル（06）から呼ぶ関数
//
// 06 は反映のとき、このフォルダの .gs をまとめて AlertApp という名前の中に同梱する
// （scripts/build_panel.js）。06 から呼べるのは、ここにある panel で始まる関数だけ。
// 毎月5日の自動通知（トリガー）は、これまでどおりこの「原価アラート」側で動く。
//
// 注意: 06 から Chat に送るときは、06 のスクリプトプロパティ CHAT_WEBHOOK_URL を読む
// （同梱したコードは 06 のプロジェクトとして動くため）。
// ============================================================

/** 閾値と、判定する月の初期値（前月） */
function panelAlertInfo() {
  const c = ALERT_CONFIG;
  return {
    rankLimit: c.RANK_LIMIT,
    minVariancePct: c.MIN_VARIANCE_PCT,
    minVarianceMan: c.MIN_VARIANCE_MAN,
    triggerDay: c.TRIGGER_DAY,
    triggerHour: c.TRIGGER_HOUR,
    defaultMonth: previousMonthStart_(new Date()).slice(0, 7),
    webhookConfigured: !!PropertiesService.getScriptProperties().getProperty('CHAT_WEBHOOK_URL')
  };
}

/**
 * yearMonth（'YYYY-MM'）の閾値超過を判定する。send が true のときだけ Chat に送る。
 * 戻り値は runForMonth_ と同じ（status: NO_DATA / NONE / ALERT）。
 */
function panelAlertCheck(yearMonth, send) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(yearMonth))) {
    throw new Error('年月は 2026-08 の形で指定してください: ' + yearMonth);
  }
  return runForMonth_(yearMonth + '-01', send === true);
}
