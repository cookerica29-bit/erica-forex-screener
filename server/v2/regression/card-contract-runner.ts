import fs from 'fs';
import { buildForexV2LifecycleCard } from '../cardContract.js';
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
    price: 1.1661,
    bias: 'BULLISH',
    scoutDirection: 'LONG',
    tradeDirection: 'LONG',
    htfBias: 'BULLISH',
    zone: 'DISCOUNT',
    nearestResistance: 1.1725,
    nearestSupport: 1.1638,
    recentBOS: null,
    recentChoCH: null,
    atr: 0.002,
    rsi: 52,
    ema20: 1.165,
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
    reversalConfirmed: true,
    reversalReason: 'Bullish structure confirmed.',
    setupGrade: 'A',
    setupGradeReason: 'Trend and location align.',
    evalEligible: false,
    evalReason: 'Watch only.',
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
    entryStatus: 'Waiting',
    distanceFromEntryAtr: 0.4,
    distanceFromEntryPercent: 0.02,
    zoneTouchState: 'REJECTING',
    activeZoneType: 'DEMAND',
    activeZoneHigh: 1.166,
    activeZoneLow: 1.164,
    currentCandleHigh: 1.167,
    currentCandleLow: 1.164,
    zoneInteraction: 'FRESH_TEST',
    decisionLevel: 1.1675,
    decisionLevelConfirmed: true,
    decisionLevelReason: 'Decision level confirmed.',
    entrySource: 'Nearest demand / pullback zone',
    slSource: 'Below nearest support with ATR buffer',
    tp1Source: 'Next valid swing high at or above 2R',
    tp2Source: 'Next swing high beyond TP1',
    planQuality: 'Clean',
    planQualityReason: 'Plan has complete levels.',
    entry: 1.1652,
    sl: 1.1638,
    tp1: 1.169,
    tp2: 1.1725,
    rrRatio: 2.71,
    ...overrides,
  } as ScoutReport;
}

const card = buildForexV2LifecycleCard(report());
assertCase('Card exposes engine state', card.state === 'SETUP_CONFIRMED_WAITING_FOR_ENTRY', `unexpected state ${card.state}`);
assertCase('Card exposes next step from engine', /planned entry/.test(card.next_step), `unexpected next step ${card.next_step}`);
assertCase('Card exposes transition reason', card.transition_reason.length > 0, 'missing transition reason');
assertCase('Card exposes completed requirements', card.completed.includes('Liquidity Sweep') && card.completed.includes('Structure Confirmation'), `unexpected completed ${card.completed.join(',')}`);
assertCase('Card exposes missing requirements', card.missing.includes('Entry Reached'), `unexpected missing ${card.missing.join(',')}`);
assertCase('Execution plan matches engine input', card.execution_plan.planned_entry === '1.16520' && card.execution_plan.stop === '1.16380' && card.execution_plan.tp1 === '1.16900', `unexpected execution plan ${JSON.stringify(card.execution_plan)}`);
assertCase('Lifecycle progress highlights current state', card.lifecycle.some(step => step.status === 'active' && step.label === 'Entry Planned'), `unexpected lifecycle ${JSON.stringify(card.lifecycle)}`);

const html = fs.readFileSync('public/index.html', 'utf8');
const rendererStart = html.indexOf('function renderForexV2LifecycleCard');
const rendererEnd = html.indexOf('function renderScoutCard', rendererStart);
const renderer = html.slice(rendererStart, rendererEnd);
assertCase('Frontend v2 renderer exists', rendererStart > -1 && rendererEnd > rendererStart, 'v2 renderer function not found');
assertCase('Frontend reads Decision Engine card payload', renderer.includes('r.v2LifecycleCard'), 'renderer should consume v2LifecycleCard');
assertCase('Frontend v2 renderer avoids trading calculations', !/(BOS|CHoCH|premium|discount|liquidity|entryTimingState|decisionLevelConfirmed|recentBOS|recentChoCH)/i.test(renderer), 'v2 renderer should not duplicate trading logic terms');
assertCase('Feature flag preserves v1 default', html.includes("localStorage.getItem(FOREX_CARD_V2_FLAG) === 'true'") && html.includes('if (!forexCardV2Enabled()) return renderScoutCard(r);'), 'feature flag should default to v1 renderer');
assertCase('Comparison mode renders both cards', html.includes('V1 Card') && html.includes('V2 Lifecycle Card') && html.includes('renderScoutCard(r)'), 'comparison mode should render both cards');

console.log('\n-- Kairos Forex v2 Card Contract Regression Suite ------------------');
const groupedFailures = new Set(failures.map(f => f.caseName));
if (!failures.length) {
  console.log(`PASS v2 card state=${card.state}`);
  console.log(`PASS execution plan entry=${card.execution_plan.planned_entry}, stop=${card.execution_plan.stop}, tp1=${card.execution_plan.tp1}`);
  console.log('PASS frontend renderer consumes v2LifecycleCard without trading logic terms');
} else {
  for (const failure of failures) console.log(`FAIL ${failure.caseName}: ${failure.message}`);
}
console.log(`\nTotal: 12 | Passed: ${12 - groupedFailures.size} | Failed: ${groupedFailures.size}`);

if (failures.length) process.exit(1);
