import type { ScoutReport } from './scanner.js';

export type ScoutPhaseLabel = 'Enter Now' | 'Almost Ready' | 'Waiting' | 'Skip';

const MIN_SCOUT_ALERT_RR = 2.0;

export function scoutTradeDirection(report: ScoutReport) {
  if (report.tradeDirection === 'LONG' || report.tradeDirection === 'SHORT') return report.tradeDirection;
  if (report.bias === 'BULLISH') return 'LONG';
  if (report.bias === 'BEARISH') return 'SHORT';
  return 'NEUTRAL';
}

export function isLocationAlignedForTrade(report: ScoutReport) {
  const direction = scoutTradeDirection(report);
  return (direction === 'LONG' && report.zone === 'DISCOUNT') ||
    (direction === 'SHORT' && report.zone === 'PREMIUM');
}

export function isSetupFlowAlignedForTrade(report: ScoutReport) {
  const direction = scoutTradeDirection(report);
  return (direction === 'LONG' && report.setupTimeframeDirection === 'Bullish') ||
    (direction === 'SHORT' && report.setupTimeframeDirection === 'Bearish');
}

export function scoutPhaseState(report: ScoutReport): { label: ScoutPhaseLabel; progress: number } {
  const direction = scoutTradeDirection(report);
  const grade = report.setupGrade || 'C';
  const timing = report.entryTimingState || 'Not Ready';
  const entryStatus = report.entryStatus || 'Waiting';
  const locationAligned = isLocationAlignedForTrade(report);
  const nearEntry = entryStatus === 'Tradeable' || entryStatus === 'Near Entry';
  const hasLevels = report.entry !== null && report.sl !== null && report.tp1 !== null;
  const hasRr = report.rrRatio !== null && report.rrRatio >= MIN_SCOUT_ALERT_RR;
  const flowAligned = isSetupFlowAlignedForTrade(report);
  const hasMajorConflict = grade === 'C' ||
    direction === 'NEUTRAL' ||
    !hasLevels ||
    !hasRr ||
    ((direction === 'LONG' && report.zone === 'PREMIUM') || (direction === 'SHORT' && report.zone === 'DISCOUNT'));

  if (timing === 'Entry Triggered' && report.evalEligible === true) {
    return { label: 'Enter Now', progress: 100 };
  }

  if ((grade === 'A' || grade === 'B') && nearEntry && locationAligned && hasLevels && hasRr) {
    const waitingOnFinalStep = timing === 'Area Reached' || timing === 'Reaction Started' ||
      !report.reversalConfirmed || !report.decisionLevelConfirmed || !flowAligned;
    if (waitingOnFinalStep) return { label: 'Almost Ready', progress: 85 };
  }

  if (hasMajorConflict) return { label: 'Skip', progress: 0 };
  return { label: 'Waiting', progress: 55 };
}

export function decisionLevelUsableForScoutMilestone(report: ScoutReport) {
  const level = Number(report.decisionLevel);
  if (!Number.isFinite(level)) return false;
  const tp1 = Number(report.tp1);
  if (Number.isFinite(tp1)) {
    const tolerance = Math.max(Math.abs(level) * 0.00001, 0.00001);
    if (Math.abs(level - tp1) <= tolerance) return false;
  }
  const price = Number(report.price);
  if (!Number.isFinite(price)) return false;
  const atr = Number(report.atr);
  const distance = Math.abs(level - price);
  if (Number.isFinite(atr) && atr > 0 && distance > atr * 0.75) return false;
  const entry = Number(report.entry);
  if (Number.isFinite(entry)) {
    const entryDistance = Math.abs(entry - price);
    if (entryDistance > 0 && distance > Math.max(entryDistance * 1.25, Number.isFinite(atr) ? atr * 0.25 : 0)) return false;
  }
  return true;
}

export function scoutConfirmationAction(report: ScoutReport) {
  return scoutTradeDirection(report) === 'LONG' ? 'Wait for bullish confirmation' : 'Wait for bearish confirmation';
}

export function scoutNextStep(report: ScoutReport, phase = scoutPhaseState(report)) {
  if (phase.label === 'Skip') return 'Do not trade this setup';
  if (phase.label === 'Enter Now') return 'Review active entry plan';

  const direction = scoutTradeDirection(report);
  const nearEntry = report.entryStatus === 'Tradeable' || report.entryStatus === 'Near Entry';
  const flowAligned = isSetupFlowAlignedForTrade(report);

  if (!flowAligned) return scoutConfirmationAction(report);
  if (!report.reversalConfirmed) return scoutConfirmationAction(report);
  if (!nearEntry) return 'Wait for price to reach entry';
  if (!report.decisionLevelConfirmed && decisionLevelUsableForScoutMilestone(report)) {
    const closeBelow = String(report.decisionLevelReason || '').match(/price has not closed below nearest support ([0-9.]+) yet/i);
    if (closeBelow) return `Wait for close below ${closeBelow[1]}`;
    const closeAbove = String(report.decisionLevelReason || '').match(/price has not closed above nearest resistance ([0-9.]+) yet/i);
    if (closeAbove) return `Wait for close above ${closeAbove[1]}`;
    return direction === 'LONG' ? 'Wait for close above decision level' : 'Wait for close below decision level';
  }
  return scoutConfirmationAction(report);
}

export function scoutNextMilestone(nextStep: string) {
  if (/^Wait for close below /i.test(nextStep)) return nextStep.replace(/^Wait for /i, '');
  if (/^Wait for close above /i.test(nextStep)) return nextStep.replace(/^Wait for /i, '');
  if (/bullish confirmation/i.test(nextStep)) return 'Bullish confirmation';
  if (/bearish confirmation/i.test(nextStep)) return 'Bearish confirmation';
  if (/price to reach entry/i.test(nextStep)) return 'Reach entry area';
  if (/Do not trade/i.test(nextStep)) return 'Do not trade';
  if (/active entry plan/i.test(nextStep)) return 'Entry trigger active';
  return nextStep.replace(/^Wait for\s+/i, '');
}

export function scoutShortReason(report: ScoutReport, phase = scoutPhaseState(report)) {
  if (phase.label === 'Enter Now') {
    return report.confirmationReason || report.entryTimingReason || 'Entry trigger and confirmation are active.';
  }
  if (phase.label === 'Almost Ready') {
    return 'Review setup. Wait for confirmation before entry.';
  }
  if (phase.label === 'Skip') {
    return report.setupGradeReason || report.evalReason || 'Low quality or major conflict.';
  }
  return report.entryTimingReason || report.evalReason || 'Setup is still developing.';
}

export function isTradeableScoutSignal(report: ScoutReport) {
  return !isIndexSymbol(report.pair) &&
    scoutPhaseState(report).label === 'Enter Now' &&
    report.evalEligible === true &&
    report.rrRatio !== null &&
    report.rrRatio >= MIN_SCOUT_ALERT_RR &&
    Boolean(report.trendDirection) &&
    Boolean(report.setupTimeframeDirection) &&
    Boolean(report.marketPhase) &&
    Boolean(report.confirmationStatus) &&
    report.entry !== null &&
    report.sl !== null &&
    report.tp1 !== null;
}

export function isWatchScoutSignal(report: ScoutReport) {
  return !isIndexSymbol(report.pair) &&
    scoutPhaseState(report).label === 'Almost Ready' &&
    report.evalEligible !== true &&
    (report.setupGrade === 'A' || report.setupGrade === 'B') &&
    report.rrRatio !== null &&
    report.rrRatio >= MIN_SCOUT_ALERT_RR &&
    hasClearDailyOrH4Trend(report) &&
    isLocationAlignedForTrade(report) &&
    isSetupFlowAlignedForTrade(report) &&
    (report.entryTimingState === 'Reaction Started' || report.entryTimingState === 'Area Reached') &&
    (report.entryStatus === 'Tradeable' || report.entryStatus === 'Near Entry' || report.entryStatus === 'Waiting') &&
    report.entry !== null &&
    report.sl !== null &&
    report.tp1 !== null;
}

export function tradeableSignalAlertKey(report: ScoutReport, kind = 'entry') {
  const phase = scoutPhaseState(report).label;
  return [
    kind,
    report.pair,
    report.timeframe,
    scoutTradeDirection(report),
    phase,
    report.candleTime,
    report.entry,
    report.sl,
    report.tp1,
  ].join('|');
}

export function tradeableSignalDataKey(report: ScoutReport, kind = 'entry') {
  return [kind, report.pair, report.timeframe, scoutTradeDirection(report), scoutPhaseState(report).label].join('|');
}

export function scoutAlertRoute(report: ScoutReport): 'urgent' | 'soft' | 'none' {
  if (isTradeableScoutSignal(report)) return 'urgent';
  if (isWatchScoutSignal(report)) return 'soft';
  return 'none';
}

export function scoutTelegramHeadline(report: ScoutReport) {
  const route = scoutAlertRoute(report);
  if (route === 'urgent') return `🚨 ENTER NOW — ${report.displaySymbol}`;
  if (route === 'soft') return `Almost Ready — Review setup — ${report.displaySymbol}`;
  return '';
}

function isIndexSymbol(symbol: string) {
  return ['US30_USD', 'NAS100_USD'].includes(symbol);
}

function hasClearDailyOrH4Trend(report: ScoutReport) {
  return ['Bullish', 'Bearish'].includes(report.dailyTrendDirection || '') ||
    ['Bullish', 'Bearish'].includes(report.h4TrendDirection || '');
}
