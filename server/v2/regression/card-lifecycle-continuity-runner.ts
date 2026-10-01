// Kairos Forex v2 -- Sprint 1: Stateful V2 Shadow Lifecycle Card.
//
// Proves buildForexV2LifecycleCard/attachForexV2LifecycleCards now READ
// previous lifecycle state from the SAME LifecycleDiagnosticsStore
// recordLifecycleShadowScan() already writes to (server/v2/diagnostics.ts),
// keyed by the same shadowKey() identity (pair + timeframe + direction) --
// no second, competing state store. The card path never writes to the
// store itself; each test here uses its OWN fresh LifecycleDiagnosticsStore
// instance (matching shadow-comparison-runner.ts's own convention) so
// these cases share no state with each other or with any other test file.
import { LifecycleDiagnosticsStore } from '../diagnostics.js';
import { buildForexV2LifecycleCard, attachForexV2LifecycleCards } from '../cardContract.js';
import { scoutPhaseState, isTradeableScoutSignal, isWatchScoutSignal } from '../../scoutPhase.js';
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
    evalReason: 'Watch only.',
    entryTimingState: 'Area Reached',
    entryTimingReason: 'Area reached.',
    trendDirection: 'Bullish',
    trendScore: 8,
    trendReason: 'Daily and H4 bullish.',
    dailyTrendDirection: 'Neutral',
    dailySwingStructure: 'Mixed',
    dailyBosDirection: 'Neutral',
    dailyChochDirection: 'Neutral',
    h4TrendDirection: 'Neutral',
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

// ---------------------------------------------------------------------
// Case 1 -- Same setup advances normally across successive scans, and
// each later card's previous_state matches the earlier card's own
// current_state (real lifecycle progression, correctly relayed).
// ---------------------------------------------------------------------
{
  const store = new LifecycleDiagnosticsStore();

  // Scan 1: context not yet aligned -> BUILDING/ALMOST_READY-equivalent.
  const scan1Report = report({
    dailyTrendDirection: 'Neutral',
    h4TrendDirection: 'Neutral',
  });
  const card1 = buildForexV2LifecycleCard(scan1Report, store);
  // recordScan is the only writer -- simulate the real scan event that
  // would have run alongside this card build in production.
  store.recordScan([scan1Report], 'case1 scan1');

  // Scan 2: daily+H4 now aligned and structure confirmed -> STRUCTURE_CONFIRMED.
  const scan2Report = report({
    dailyTrendDirection: 'Bullish',
    h4TrendDirection: 'Bullish',
    zoneTouchState: 'REJECTING',
    reversalConfirmed: true,
    reversalReason: 'M30 structure shifted bullish.',
  });
  const card2 = buildForexV2LifecycleCard(scan2Report, store);
  store.recordScan([scan2Report], 'case1 scan2');

  // Scan 3: entry reached -> ENTRY_REACHED.
  const scan3Report = report({
    dailyTrendDirection: 'Bullish',
    h4TrendDirection: 'Bullish',
    zoneTouchState: 'REJECTING',
    reversalConfirmed: true,
    reversalReason: 'M30 structure shifted bullish.',
    entryTimingState: 'Entry Triggered',
    entryStatus: 'Tradeable',
  });
  const card3 = buildForexV2LifecycleCard(scan3Report, store);

  assertCase('Case1: scan1 has no previous state', card1.engine_snapshot.previous_state === null, `expected null, got ${card1.engine_snapshot.previous_state}`);
  assertCase('Case1: scan2 receives scan1 state as previous', card2.engine_snapshot.previous_state === card1.state, `expected ${card1.state}, got ${card2.engine_snapshot.previous_state}`);
  assertCase('Case1: scan2 advances state', card2.state !== card1.state, `expected scan2 to advance past ${card1.state}`);
  assertCase('Case1: scan3 receives scan2 state as previous', card3.engine_snapshot.previous_state === card2.state, `expected ${card2.state}, got ${card3.engine_snapshot.previous_state}`);
  assertCase('Case1: scan3 reaches ENTRY_REACHED', card3.state === 'ENTRY_REACHED', `expected ENTRY_REACHED, got ${card3.state}`);
}

// ---------------------------------------------------------------------
// Case 2 -- Same setup does not reset unnecessarily: rebuilding a card
// for the SAME already-recorded setup, with unchanged report data, must
// not regress or "restart" the lifecycle.
// ---------------------------------------------------------------------
{
  const store = new LifecycleDiagnosticsStore();
  const advancedReport = report({
    dailyTrendDirection: 'Bullish',
    h4TrendDirection: 'Bullish',
    reversalConfirmed: true,
  });
  const firstCard = buildForexV2LifecycleCard(advancedReport, store);
  store.recordScan([advancedReport], 'case2 scan1');

  // A second card generation for the identical setup/report -- as if
  // /api/scout were simply refreshed with no new scan in between.
  const secondCard = buildForexV2LifecycleCard(advancedReport, store);

  assertCase('Case2: second card does not restart to BUILDING', secondCard.state !== 'BUILDING', 'unchanged setup must not reset to BUILDING');
  assertCase('Case2: second card state matches first card state', secondCard.state === firstCard.state, `expected ${firstCard.state}, got ${secondCard.state}`);
  assertCase('Case2: second card previous_state reflects the recorded state, not null', secondCard.engine_snapshot.previous_state === firstCard.state, `expected ${firstCard.state}, got ${secondCard.engine_snapshot.previous_state}`);
}

// ---------------------------------------------------------------------
// Case 3 -- Opposite direction does not inherit state: EUR_USD LONG's
// advanced lifecycle must not leak into a later EUR_USD SHORT setup.
// ---------------------------------------------------------------------
{
  const store = new LifecycleDiagnosticsStore();
  const longReport = report({
    tradeDirection: 'LONG',
    dailyTrendDirection: 'Bullish',
    h4TrendDirection: 'Bullish',
    zoneTouchState: 'REJECTING',
    reversalConfirmed: true,
    entryTimingState: 'Entry Triggered',
    entryStatus: 'Tradeable',
  });
  const longCard = buildForexV2LifecycleCard(longReport, store);
  store.recordScan([longReport], 'case3 long scan');

  const shortReport = report({
    tradeDirection: 'SHORT',
    bias: 'BEARISH',
    zone: 'PREMIUM',
    dailyTrendDirection: 'Bearish',
    h4TrendDirection: 'Bearish',
  });
  const shortCard = buildForexV2LifecycleCard(shortReport, store);

  assertCase('Case3: LONG setup actually reached ENTRY_REACHED (test is meaningful)', longCard.state === 'ENTRY_REACHED', `expected LONG fixture to reach ENTRY_REACHED, got ${longCard.state}`);
  assertCase('Case3: opposite direction has no previous state', shortCard.engine_snapshot.previous_state === null, `expected null, got ${shortCard.engine_snapshot.previous_state}`);
  assertCase('Case3: opposite direction does not inherit ENTRY_REACHED', shortCard.state !== 'ENTRY_REACHED', 'SHORT setup must not inherit the LONG lifecycle');
}

// ---------------------------------------------------------------------
// Case 4 -- Different pair does not inherit state: GBP_USD must never
// inherit EUR_USD's lifecycle, even with identical timeframe/direction.
// ---------------------------------------------------------------------
{
  const store = new LifecycleDiagnosticsStore();
  const eurReport = report({
    pair: 'EUR_USD',
    dailyTrendDirection: 'Bullish',
    h4TrendDirection: 'Bullish',
    zoneTouchState: 'REJECTING',
    reversalConfirmed: true,
    entryTimingState: 'Entry Triggered',
    entryStatus: 'Tradeable',
  });
  const eurCard = buildForexV2LifecycleCard(eurReport, store);
  store.recordScan([eurReport], 'case4 eur scan');

  const gbpReport = report({
    pair: 'GBP_USD',
    displaySymbol: 'GBP/USD',
    dailyTrendDirection: 'Neutral',
    h4TrendDirection: 'Neutral',
  });
  const gbpCard = buildForexV2LifecycleCard(gbpReport, store);

  assertCase('Case4: EUR_USD fixture actually reached ENTRY_REACHED (test is meaningful)', eurCard.state === 'ENTRY_REACHED', `expected EUR_USD fixture to reach ENTRY_REACHED, got ${eurCard.state}`);
  assertCase('Case4: different pair has no previous state', gbpCard.engine_snapshot.previous_state === null, `expected null, got ${gbpCard.engine_snapshot.previous_state}`);
  assertCase('Case4: different pair does not inherit ENTRY_REACHED', gbpCard.state !== 'ENTRY_REACHED', 'GBP_USD must not inherit EUR_USD lifecycle');
}

// ---------------------------------------------------------------------
// Case 5 -- Repeated API reads (attachForexV2LifecycleCards, simulating
// GET /api/scout) never write to the store and never manufacture a
// transition purely from being called again.
// ---------------------------------------------------------------------
{
  const store = new LifecycleDiagnosticsStore();
  const advancedReport = report({
    dailyTrendDirection: 'Bullish',
    h4TrendDirection: 'Bullish',
    reversalConfirmed: true,
  });
  store.recordScan([advancedReport], 'case5 scan1');
  const stateAfterScan = store.getPreviousState('EUR_USD|M30|LONG');

  const reads = Array.from({ length: 5 }, () => attachForexV2LifecycleCards([advancedReport], store)[0]);

  assertCase('Case5: store state unchanged after repeated reads', store.getPreviousState('EUR_USD|M30|LONG') === stateAfterScan, 'repeated GET-equivalent reads must never write to the shared store');
  assertCase(
    'Case5: repeated reads return identical state, not manufactured advancement',
    reads.every(r => r.v2LifecycleCard.state === reads[0].v2LifecycleCard.state),
    'repeated reads of unchanged input must not advance lifecycle state',
  );
  assertCase(
    'Case5: repeated reads report the same previous_state each time',
    reads.every(r => r.v2LifecycleCard.engine_snapshot.previous_state === reads[0].v2LifecycleCard.engine_snapshot.previous_state),
    'repeated reads must not drift previous_state',
  );
}

// ---------------------------------------------------------------------
// Case 6 -- Existing card contract remains compatible: calling with the
// default (shared singleton) store -- i.e. no store argument, exactly
// how every pre-Sprint-1 caller (including card-contract-runner.ts)
// already calls this function -- still returns the same card shape.
// ---------------------------------------------------------------------
{
  const card = buildForexV2LifecycleCard(report());
  assertCase('Case6: default-store call still returns a full card shape', typeof card.state === 'string' && Array.isArray(card.completed) && Array.isArray(card.missing) && Boolean(card.execution_plan) && Array.isArray(card.lifecycle), 'card shape changed for the zero-argument call signature');
  assertCase('Case6: default-store call has an engine_snapshot with previous_state field', Object.prototype.hasOwnProperty.call(card.engine_snapshot, 'previous_state'), 'engine_snapshot must still expose previous_state');
}

// ---------------------------------------------------------------------
// Phase 4 isolation guard -- V2 continuity must have no write path back
// into V1/Scout. Proves: (a) the original ScoutReport object attached
// to a card is untouched (only a NEW v2LifecycleCard field is added, via
// the same spread pattern that already existed before this sprint), and
// (b) Scout's own phase classification / Telegram tradeability gate
// (server/scoutPhase.ts, untouched by this sprint) produce IDENTICAL
// results before and after a V2 card is built for the same report.
// ---------------------------------------------------------------------
{
  const store = new LifecycleDiagnosticsStore();
  const original = report({
    dailyTrendDirection: 'Bullish',
    h4TrendDirection: 'Bullish',
    reversalConfirmed: true,
    entryTimingState: 'Entry Triggered',
    entryStatus: 'Tradeable',
    evalEligible: true,
  });
  const originalJson = JSON.stringify(original);
  const phaseBefore = scoutPhaseState(original);
  const tradeableBefore = isTradeableScoutSignal(original);
  const watchBefore = isWatchScoutSignal(original);

  const [attached] = attachForexV2LifecycleCards([original], store);
  store.recordScan([original], 'isolation guard scan');
  buildForexV2LifecycleCard(original, store);

  const phaseAfter = scoutPhaseState(original);
  const tradeableAfter = isTradeableScoutSignal(original);
  const watchAfter = isWatchScoutSignal(original);

  assertCase('Isolation: original report object is not mutated', JSON.stringify(original) === originalJson, 'the source ScoutReport must not be mutated by card building');
  assertCase('Isolation: attached copy adds only v2LifecycleCard', Object.keys(attached).filter(k => !(k in original)).join(',') === 'v2LifecycleCard', 'attachForexV2LifecycleCards must only add the v2LifecycleCard field');
  assertCase('Isolation: Scout phase classification unchanged', JSON.stringify(phaseAfter) === JSON.stringify(phaseBefore), 'scoutPhaseState must be unaffected by V2 card/store activity');
  assertCase('Isolation: Telegram tradeable gate unchanged', tradeableAfter === tradeableBefore, 'isTradeableScoutSignal must be unaffected by V2 card/store activity');
  assertCase('Isolation: Telegram watch gate unchanged', watchAfter === watchBefore, 'isWatchScoutSignal must be unaffected by V2 card/store activity');
}

console.log('\n-- Kairos Forex v2 Card Lifecycle Continuity Regression Suite -----');
const groupedFailures = new Set(failures.map(f => f.caseName));
const totalCases = 22;
if (!failures.length) {
  console.log('PASS Case 1: same setup advances normally across scans');
  console.log('PASS Case 2: same setup does not reset unnecessarily');
  console.log('PASS Case 3: opposite direction does not inherit state');
  console.log('PASS Case 4: different pair does not inherit state');
  console.log('PASS Case 5: repeated reads do not write or manufacture transitions');
  console.log('PASS Case 6: existing card contract remains compatible');
  console.log('PASS Isolation guard: V2 continuity has no write path into Scout/V1');
} else {
  for (const failure of failures) console.log(`FAIL ${failure.caseName}: ${failure.message}`);
}
console.log(`\nTotal: ${totalCases} | Passed: ${totalCases - groupedFailures.size} | Failed: ${groupedFailures.size}`);

if (failures.length) process.exit(1);
