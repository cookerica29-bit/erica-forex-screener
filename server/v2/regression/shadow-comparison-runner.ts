import { LifecycleDiagnosticsStore } from '../diagnostics.js';
import type { ScoutReport } from '../../scanner.js';

interface Failure {
  caseName: string;
  message: string;
}

const failures: Failure[] = [];

function assertCase(caseName: string, condition: boolean, message: string) {
  if (!condition) failures.push({ caseName, message });
}

function report(overrides: Partial<ScoutReport> = {}): ScoutReport {
  return {
    pair: 'EUR_USD',
    displaySymbol: 'EUR/USD',
    price: 1.1,
    bias: 'BULLISH',
    scoutDirection: 'LONG',
    tradeDirection: 'LONG',
    htfBias: 'BULLISH',
    zone: 'DISCOUNT',
    nearestResistance: 1.12,
    nearestSupport: 1.09,
    recentBOS: null,
    recentChoCH: null,
    atr: 0.002,
    rsi: 52,
    ema20: 1.099,
    session: 'London',
    interestLevel: 'HIGH',
    timeframe: 'M30',
    scannedAt: '2026-07-14T12:00:00.000Z',
    candleTime: '2026-07-14T12:00:00.000Z',
    momentumScore: 4,
    momentumLabel: 'Bullish',
    momentumAlignedWithBias: true,
    momentumConflict: false,
    pullbackScore: 8,
    pullbackStatus: 'Reversal forming',
    pullbackCompleted: false,
    pullbackReason: 'Pullback is stabilizing.',
    confirmationScore: 8,
    confirmationStatus: 'Strong confirmation',
    confirmationConfirmed: false,
    confirmationReason: 'Confirmation is building.',
    reversalConfirmed: false,
    reversalReason: 'Waiting for structure shift.',
    setupGrade: 'A',
    setupGradeReason: 'Trend and location align.',
    evalEligible: false,
    evalReason: 'Watch only: liquidity missing.',
    trendWatchEligible: false,
    trendWatchReason: 'No separate trend watch.',
    entryTimingState: 'Area Reached',
    entryTimingReason: 'Area reached.',
    trendDirection: 'Bullish',
    trendScore: 8,
    trendReason: 'Daily and H4 bullish.',
    dailyTrendDirection: 'Bullish',
    dailySwingStructure: 'HH/HL',
    dailyBosDirection: 'Bullish',
    dailyChochDirection: 'Neutral',
    h4TrendDirection: 'Bullish',
    setupTimeframeDirection: 'Bullish',
    setupTimeframeScore: 8,
    setupTimeframeReason: 'M30 bullish.',
    marketPhase: 'Bullish Continuation',
    marketPhaseReason: 'Trend and setup align.',
    trendSetupAligned: true,
    isPullbackAgainstTrend: false,
    entryStatus: 'Near Entry',
    distanceFromEntryAtr: 0.4,
    distanceFromEntryPercent: 0.02,
    zoneTouchState: 'APPROACHING',
    activeZoneType: 'DEMAND',
    activeZoneHigh: 1.101,
    activeZoneLow: 1.099,
    currentCandleHigh: 1.102,
    currentCandleLow: 1.098,
    zoneInteraction: 'NONE',
    decisionLevel: 1.103,
    decisionLevelConfirmed: false,
    decisionLevelReason: 'Waiting for close above decision level.',
    entrySource: 'Nearest demand / pullback zone',
    slSource: 'Below nearest support with ATR buffer',
    tp1Source: 'Next valid swing high at or above 2R',
    tp2Source: 'Next swing high beyond TP1',
    planQuality: 'Clean',
    planQualityReason: 'Plan has complete levels.',
    entry: 1.1,
    sl: 1.094,
    tp1: 1.112,
    tp2: 1.118,
    rrRatio: 2,
    ...overrides,
  } as ScoutReport;
}

const store = new LifecycleDiagnosticsStore();
const first = store.recordScan([
  report({
    entryTimingState: 'Entry Triggered',
    entryStatus: 'Tradeable',
    evalEligible: true,
    reversalConfirmed: true,
    decisionLevelConfirmed: true,
    zoneTouchState: 'APPROACHING',
    zoneInteraction: 'NONE',
  }),
  report({
    pair: 'GBP_USD',
    displaySymbol: 'GBP/USD',
    entryTimingState: 'Entry Triggered',
    entryStatus: 'Tradeable',
    evalEligible: true,
    reversalConfirmed: true,
    decisionLevelConfirmed: true,
    zoneTouchState: 'REJECTING',
    zoneInteraction: 'FRESH_TEST',
  }),
], 'shadow test');

assertCase('Shadow summary counts scans', first.summary.scans === 1, `expected 1 scan, got ${first.summary.scans}`);
assertCase('Shadow summary counts comparisons', first.summary.comparisons === 2, `expected 2 comparisons, got ${first.summary.comparisons}`);
assertCase('Shadow stores disagreements', first.summary.different_states >= 1, 'expected at least one disagreement');
assertCase('Shadow tracks missing requirements', first.summary.most_common_missing_requirement !== null, 'expected missing requirement summary');
assertCase('Shadow records transitions', first.summary.transitions === 2, `expected 2 transitions, got ${first.summary.transitions}`);

const repeat = store.recordScan([
  report({
    entryTimingState: 'Entry Triggered',
    entryStatus: 'Tradeable',
    evalEligible: true,
    reversalConfirmed: true,
    decisionLevelConfirmed: true,
    zoneTouchState: 'APPROACHING',
    zoneInteraction: 'NONE',
  }),
  report({
    pair: 'GBP_USD',
    displaySymbol: 'GBP/USD',
    entryTimingState: 'Entry Triggered',
    entryStatus: 'Tradeable',
    evalEligible: true,
    reversalConfirmed: true,
    decisionLevelConfirmed: true,
    zoneTouchState: 'REJECTING',
    zoneInteraction: 'FRESH_TEST',
  }),
], 'shadow repeat');

assertCase('Shadow does not duplicate unchanged transitions', repeat.summary.transitions === 2, `expected transitions to stay 2, got ${repeat.summary.transitions}`);

const transition = store.recordScan([
  report({
    zoneTouchState: 'REJECTING',
    zoneInteraction: 'FRESH_TEST',
  }),
], 'shadow transition');

assertCase('Shadow logs changed lifecycle transition', transition.summary.transitions === 3, `expected 3 transitions, got ${transition.summary.transitions}`);
assertCase('Shadow transition reason exists', Boolean(transition.transitions.at(-1)?.reason), 'latest transition should include reason');

console.log('\n-- Kairos Forex v2 Shadow Comparison Regression Suite --------------');
const groupedFailures = new Set(failures.map(f => f.caseName));
if (!failures.length) {
  console.log(`PASS shadow comparison summary: scans=${transition.summary.scans}, comparisons=${transition.summary.comparisons}, disagreements=${transition.summary.different_states}`);
  console.log(`PASS latest transition: ${transition.transitions.at(-1)?.symbol} ${transition.transitions.at(-1)?.from} -> ${transition.transitions.at(-1)?.to}`);
} else {
  for (const failure of failures) console.log(`FAIL ${failure.caseName}: ${failure.message}`);
}
console.log(`\nTotal: 8 | Passed: ${8 - groupedFailures.size} | Failed: ${groupedFailures.size}`);

if (failures.length) process.exit(1);
