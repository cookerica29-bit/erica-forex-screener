// Kairos Forex v2 -- Sprint 2: M30 CHoCH/BOS Confirmation (shadow-only).
//
// Candle fixtures below are empirically calibrated against the REAL
// computeStructures/findSwings primitives (scanner.ts), the same way
// this repo's other synthetic-OHLCV fixtures are calibrated -- not
// hand-waved. See buildTrendCandles()'s own comment for exactly what
// each parameter controls.
import { evaluateM30Confirmation, fetchM30ConfirmationForReport, attachM30Confirmations, refreshM30Confirmations, type M30Candle } from '../m30Confirmation.js';
import { LifecycleDiagnosticsStore } from '../diagnostics.js';
import { buildForexV2LifecycleCard } from '../cardContract.js';
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

function isoAt(baseIdx: number): string {
  const base = new Date('2026-07-01T00:00:00.000Z').getTime();
  return new Date(base + baseIdx * 30 * 60 * 1000).toISOString();
}

function candle(i: number, o: number, h: number, l: number, close: number): M30Candle {
  return { t: isoAt(i), o, h, l, c: close, v: 1000 } as M30Candle;
}

function zigzag(points: Array<{ i: number; price: number; type: 'high' | 'low' }>): M30Candle[] {
  const rows: M30Candle[] = [];
  let cur = points[0].price + (points[0].type === 'high' ? -3 : 3);
  let idx = 0;
  for (const target of points) {
    while (idx < target.i) {
      const price = cur + (target.price - cur) * 0.4;
      const o = price;
      const cl = price + (target.type === 'high' ? 0.1 : -0.1);
      const h = Math.max(o, cl) + 0.05, l = Math.min(o, cl) - 0.05;
      rows.push(candle(idx, o, h, l, cl));
      cur = cl;
      idx++;
    }
    const o = cur;
    const h = target.type === 'high' ? target.price : target.price + 0.3;
    const l = target.type === 'low' ? target.price : target.price - 0.3;
    const cl = target.type === 'high' ? target.price - 0.08 : target.price + 0.08;
    rows.push(candle(idx, o, h, l, cl));
    cur = cl;
    idx++;
  }
  return rows;
}

// Monotonic drift only -- never reverses, so it can't create a NEW
// fractal pivot that would pollute findSwings' "last 3 highs/lows"
// trend read. `direction` must continue AWAY from the preceding pivot's
// extreme (up after ending on a low, down after ending on a high) for
// that pivot to remain a confirmed swing at all.
function pad(rows: M30Candle[], n: number, direction: 1 | -1): M30Candle[] {
  const out = rows.slice();
  for (let k = 0; k < n; k++) {
    const last = out[out.length - 1];
    const step = 0.02 * direction;
    const o = last.c;
    const cl = last.c + step;
    const h = Math.max(o, cl) + 0.01, l = Math.min(o, cl) - 0.01;
    out.push(candle(out.length, o, h, l, cl));
  }
  return out;
}

// A clean downtrend (3 lower highs + 3 lower lows, so getTrend reads
// SHORT) -- margin=4 matches M30_STRUCTURE_MARGIN in m30Confirmation.ts.
function downtrendBase(): M30Candle[] {
  let rows = zigzag([
    { i: 6, price: 115, type: 'high' },
    { i: 12, price: 95, type: 'low' },
    { i: 18, price: 110, type: 'high' },
    { i: 24, price: 90, type: 'low' },
    { i: 30, price: 105, type: 'high' },
    { i: 36, price: 85, type: 'low' },
  ]);
  return pad(rows, 50, 1); // rise after ending on a low, to confirm that pivot -- also pushes total length comfortably past MIN_M30_CANDLES
}

// A clean uptrend (3 higher highs + 3 higher lows, so getTrend reads LONG).
function uptrendBase(): M30Candle[] {
  let rows = zigzag([
    { i: 6, price: 85, type: 'low' },
    { i: 12, price: 100, type: 'high' },
    { i: 18, price: 90, type: 'low' },
    { i: 24, price: 105, type: 'high' },
    { i: 30, price: 95, type: 'low' },
    { i: 36, price: 110, type: 'high' },
  ]);
  return pad(rows, 50, -1); // fall after ending on a high, to confirm that pivot -- also pushes total length comfortably past MIN_M30_CANDLES
}

// downtrend + a large bullish break of the trend's own swing highs ->
// overallTrend is SHORT, so breaking a high bullishly is classified as
// a bullish CHoCH (structure.ts's own "reversal within a downtrend" rule).
function bullishChochCandles(): M30Candle[] {
  const rows = downtrendBase();
  const lastClose = rows[rows.length - 1].c;
  rows.push(candle(rows.length, lastClose, lastClose + 30, lastClose - 0.2, lastClose + 29));
  return pad(rows, 8, 1);
}

// uptrend + a large bullish break of the trend's own most recent swing
// high -> overallTrend is LONG, so this is trend-continuation: bullish BOS.
function bullishBosCandles(): M30Candle[] {
  const rows = uptrendBase();
  const lastClose = rows[rows.length - 1].c;
  rows.push(candle(rows.length, lastClose, lastClose + 20, lastClose - 0.2, lastClose + 19));
  return pad(rows, 8, 1);
}

// uptrend + a large bearish break of the trend's own swing lows ->
// overallTrend is LONG, so breaking a low bearishly is a bearish CHoCH.
function bearishChochCandles(): M30Candle[] {
  const rows = uptrendBase();
  const lastClose = rows[rows.length - 1].c;
  rows.push(candle(rows.length, lastClose, lastClose + 0.2, lastClose - 20, lastClose - 19));
  return pad(rows, 8, -1);
}

// downtrend + a large bearish break of the trend's own most recent swing
// low -> overallTrend is SHORT, so this is trend-continuation: bearish BOS.
function bearishBosCandles(): M30Candle[] {
  const rows = downtrendBase();
  const lastClose = rows[rows.length - 1].c;
  rows.push(candle(rows.length, lastClose, lastClose + 0.2, lastClose - 20, lastClose - 19));
  return pad(rows, 8, -1);
}

function scoutReport(overrides: Partial<ScoutReport> = {}): ScoutReport {
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
    evalEligible: true,
    evalReason: 'Watch only.',
    entryTimingState: 'Entry Triggered',
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
    entryStatus: 'Tradeable',
    distanceFromEntryAtr: 0.4,
    distanceFromEntryPercent: 0.02,
    zoneTouchState: 'REJECTING',
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
// Case 1 -- LONG + bullish CHoCH
// ---------------------------------------------------------------------
{
  const result = evaluateM30Confirmation('LONG', bullishChochCandles());
  assertCase('Case1: status CONFIRMED', result.status === 'CONFIRMED', `expected CONFIRMED, got ${result.status}`);
  assertCase('Case1: direction LONG', result.direction === 'LONG', `expected LONG, got ${result.direction}`);
  assertCase('Case1: eventType CHOCH', result.eventType === 'CHOCH', `expected CHOCH, got ${result.eventType}`);
  assertCase('Case1: eventDirection bullish', result.eventDirection === 'bullish', `expected bullish, got ${result.eventDirection}`);
  assertCase('Case1: confirmedAt present', typeof result.confirmedAt === 'string', 'expected a confirmedAt timestamp');
}

// ---------------------------------------------------------------------
// Case 2 -- LONG + bullish BOS
// ---------------------------------------------------------------------
{
  const result = evaluateM30Confirmation('LONG', bullishBosCandles());
  assertCase('Case2: status CONFIRMED', result.status === 'CONFIRMED', `expected CONFIRMED, got ${result.status}`);
  assertCase('Case2: eventType BOS', result.eventType === 'BOS', `expected BOS, got ${result.eventType}`);
  assertCase('Case2: eventDirection bullish', result.eventDirection === 'bullish', `expected bullish, got ${result.eventDirection}`);
}

// ---------------------------------------------------------------------
// Case 3 -- SHORT + bearish CHoCH
// ---------------------------------------------------------------------
{
  const result = evaluateM30Confirmation('SHORT', bearishChochCandles());
  assertCase('Case3: status CONFIRMED', result.status === 'CONFIRMED', `expected CONFIRMED, got ${result.status}`);
  assertCase('Case3: eventType CHOCH', result.eventType === 'CHOCH', `expected CHOCH, got ${result.eventType}`);
  assertCase('Case3: eventDirection bearish', result.eventDirection === 'bearish', `expected bearish, got ${result.eventDirection}`);
}

// ---------------------------------------------------------------------
// Case 4 -- SHORT + bearish BOS
// ---------------------------------------------------------------------
{
  const result = evaluateM30Confirmation('SHORT', bearishBosCandles());
  assertCase('Case4: status CONFIRMED', result.status === 'CONFIRMED', `expected CONFIRMED, got ${result.status}`);
  assertCase('Case4: eventType BOS', result.eventType === 'BOS', `expected BOS, got ${result.eventType}`);
  assertCase('Case4: eventDirection bearish', result.eventDirection === 'bearish', `expected bearish, got ${result.eventDirection}`);
}

// ---------------------------------------------------------------------
// Case 5 -- Opposite-direction structure: Scout LONG, M30 shows only
// bearish BOS (downtrend continuation, no bullish event anywhere in the
// series) -- must NOT be accepted regardless of event quality.
// ---------------------------------------------------------------------
{
  const result = evaluateM30Confirmation('LONG', bearishBosCandles());
  assertCase('Case5: status NOT_CONFIRMED', result.status === 'NOT_CONFIRMED', `expected NOT_CONFIRMED, got ${result.status}`);
  assertCase('Case5: no eventType leaks through', result.eventType === null, `expected null eventType, got ${result.eventType}`);
  // Sanity: prove the SAME candles genuinely do confirm the opposite
  // (SHORT) thesis, so this test is actually exercising direction
  // filtering rather than a fixture with no events at all.
  const shortResult = evaluateM30Confirmation('SHORT', bearishBosCandles());
  assertCase('Case5: same candles DO confirm the correct (SHORT) direction', shortResult.status === 'CONFIRMED', 'fixture must contain a real bearish event for the sanity check to be meaningful');
}

// ---------------------------------------------------------------------
// Case 6 -- No qualifying structure event: valid M30 candles, no
// thesis-direction confirmation at all (plain trend, no breakout).
// ---------------------------------------------------------------------
{
  const resultLong = evaluateM30Confirmation('LONG', downtrendBase());
  const resultShort = evaluateM30Confirmation('SHORT', uptrendBase());
  assertCase('Case6: LONG on unconfirmed data is NOT_CONFIRMED', resultLong.status === 'NOT_CONFIRMED', `expected NOT_CONFIRMED, got ${resultLong.status}`);
  assertCase('Case6: SHORT on unconfirmed data is NOT_CONFIRMED', resultShort.status === 'NOT_CONFIRMED', `expected NOT_CONFIRMED, got ${resultShort.status}`);
  // Sprint 3, Phase 0.1: prove the reason string's candle count is the
  // ACTUAL evaluated window length (min(input length, 140)), not a
  // stale/hardcoded number -- verified against two different input
  // lengths on purpose.
  const shorterInput = downtrendBase().slice(-83);
  const shorterResult = evaluateM30Confirmation('LONG', shorterInput);
  assertCase('Case6: reason reports the actual (87-candle) evaluated window, not a hardcoded number', resultLong.reason.includes(`${downtrendBase().length} M30 candles`), `expected the real length in the reason, got: ${resultLong.reason}`);
  assertCase('Case6: reason count tracks a DIFFERENT input length too (83, not still 87)', shorterResult.reason.includes('83 M30 candles'), `expected 83 in the reason, got: ${shorterResult.reason}`);
}

// ---------------------------------------------------------------------
// Case 7 -- Missing M30 data
// ---------------------------------------------------------------------
{
  const resultNull = evaluateM30Confirmation('LONG', null);
  const resultEmpty = evaluateM30Confirmation('LONG', []);
  const resultShort = evaluateM30Confirmation('LONG', bullishBosCandles().slice(0, 10));
  assertCase('Case7: null candles -> UNAVAILABLE', resultNull.status === 'UNAVAILABLE', `expected UNAVAILABLE, got ${resultNull.status}`);
  assertCase('Case7: empty candles -> UNAVAILABLE', resultEmpty.status === 'UNAVAILABLE', `expected UNAVAILABLE, got ${resultEmpty.status}`);
  assertCase('Case7: too-few candles -> UNAVAILABLE', resultShort.status === 'UNAVAILABLE', `expected UNAVAILABLE, got ${resultShort.status}`);
}

// ---------------------------------------------------------------------
// Case 8 -- M30 fetch/analysis failure stays isolated: the async
// orchestration function never throws, and returns UNAVAILABLE.
// ---------------------------------------------------------------------
(async () => {
  const failingFetch = async (_pair: string): Promise<M30Candle[]> => {
    throw new Error('OANDA EUR_USD M30: 503');
  };
  let threw = false;
  let result;
  try {
    result = await fetchM30ConfirmationForReport(scoutReport(), failingFetch);
  } catch {
    threw = true;
  }
  assertCase('Case8: fetch failure never throws', !threw, 'fetchM30ConfirmationForReport must not reject on a fetch failure');
  assertCase('Case8: fetch failure yields UNAVAILABLE', result?.status === 'UNAVAILABLE', `expected UNAVAILABLE, got ${result?.status}`);

  // ---------------------------------------------------------------------
  // Case 9 -- Pair isolation: EUR_USD structure cannot confirm GBP_USD.
  // ---------------------------------------------------------------------
  {
    const cache = new Map<string, ReturnType<typeof evaluateM30Confirmation>>();
    cache.set('EUR_USD|M30|LONG', evaluateM30Confirmation('LONG', bullishBosCandles()));
    const eur = scoutReport({ pair: 'EUR_USD', timeframe: 'M30', tradeDirection: 'LONG' });
    const gbp = scoutReport({ pair: 'GBP_USD', displaySymbol: 'GBP/USD', timeframe: 'M30', tradeDirection: 'LONG' });
    const [eurAttached, gbpAttached] = attachM30Confirmations([eur, gbp], cache);
    assertCase('Case9: EUR_USD gets its own CONFIRMED result', eurAttached.m30Confirmation.status === 'CONFIRMED', `expected CONFIRMED, got ${eurAttached.m30Confirmation.status}`);
    assertCase('Case9: GBP_USD does not inherit EUR_USD confirmation', gbpAttached.m30Confirmation.status !== 'CONFIRMED', 'GBP_USD must not inherit EUR_USD M30 confirmation');
  }

  // ---------------------------------------------------------------------
  // Case 10 -- Direction isolation: a prior LONG confirmation must not
  // automatically confirm a later SHORT thesis for the same pair.
  // ---------------------------------------------------------------------
  {
    const cache = new Map<string, ReturnType<typeof evaluateM30Confirmation>>();
    cache.set('EUR_USD|M30|LONG', evaluateM30Confirmation('LONG', bullishBosCandles()));
    const shortReport = scoutReport({ pair: 'EUR_USD', timeframe: 'M30', tradeDirection: 'SHORT', bias: 'BEARISH', zone: 'PREMIUM' });
    const [attached] = attachM30Confirmations([shortReport], cache);
    assertCase('Case10: SHORT thesis does not inherit the LONG confirmation', attached.m30Confirmation.status !== 'CONFIRMED', 'a prior LONG confirmation must not carry over to a SHORT thesis');
  }

  // ---------------------------------------------------------------------
  // Case 11 -- Repeated reads must not manufacture a new event or change
  // confirmation independently of scan data (attachM30Confirmations is a
  // pure cache read; it must never write to the cache it's given).
  // ---------------------------------------------------------------------
  {
    const cache = new Map<string, ReturnType<typeof evaluateM30Confirmation>>();
    cache.set('EUR_USD|M30|LONG', evaluateM30Confirmation('LONG', bullishChochCandles()));
    const snapshotBefore = JSON.stringify(Array.from(cache.entries()));
    const report = scoutReport({ pair: 'EUR_USD', timeframe: 'M30', tradeDirection: 'LONG' });
    const reads = Array.from({ length: 5 }, () => attachM30Confirmations([report], cache)[0]);
    const snapshotAfter = JSON.stringify(Array.from(cache.entries()));
    assertCase('Case11: cache is never mutated by repeated reads', snapshotBefore === snapshotAfter, 'attachM30Confirmations must never write to its cache');
    assertCase(
      'Case11: repeated reads return identical confirmation',
      reads.every(r => JSON.stringify(r.m30Confirmation) === JSON.stringify(reads[0].m30Confirmation)),
      'repeated reads of unchanged cache data must not manufacture a new/different M30 event',
    );
  }

  // ---------------------------------------------------------------------
  // Case 12 -- Scout phase isolation: scoutPhaseState/isTradeableScoutSignal/
  // isWatchScoutSignal must be byte/deep-equal before and after M30 shadow
  // evaluation for the exact same report.
  // ---------------------------------------------------------------------
  {
    const report = scoutReport();
    const phaseBefore = scoutPhaseState(report);
    const tradeableBefore = isTradeableScoutSignal(report);
    const watchBefore = isWatchScoutSignal(report);
    const reportJsonBefore = JSON.stringify(report);

    await fetchM30ConfirmationForReport(report, async () => bullishBosCandles());
    evaluateM30Confirmation('LONG', bullishChochCandles());
    const cache = await refreshM30Confirmations([report], async () => bullishBosCandles());
    attachM30Confirmations([report], cache);

    const phaseAfter = scoutPhaseState(report);
    const tradeableAfter = isTradeableScoutSignal(report);
    const watchAfter = isWatchScoutSignal(report);

    assertCase('Case12: report object not mutated', JSON.stringify(report) === reportJsonBefore, 'M30 shadow evaluation must not mutate the ScoutReport');
    assertCase('Case12: scoutPhaseState unchanged', JSON.stringify(phaseAfter) === JSON.stringify(phaseBefore), 'scoutPhaseState must be byte-equal before/after M30 evaluation');
    assertCase('Case12: isTradeableScoutSignal unchanged', tradeableAfter === tradeableBefore, 'isTradeableScoutSignal must be unaffected by M30 evaluation');
    assertCase('Case12: isWatchScoutSignal unchanged', watchAfter === watchBefore, 'isWatchScoutSignal must be unaffected by M30 evaluation');
  }

  // ---------------------------------------------------------------------
  // Case 13 -- Existing (Sprint 1) lifecycle continuity remains intact
  // when M30 confirmation is evaluated alongside it for the same report.
  // ---------------------------------------------------------------------
  {
    const store = new LifecycleDiagnosticsStore();
    const report = scoutReport({ dailyTrendDirection: 'Bullish', h4TrendDirection: 'Bullish', reversalConfirmed: true });
    const cardBefore = buildForexV2LifecycleCard(report, store);
    store.recordScan([report], 'sprint2 coexistence check');

    // M30 shadow evaluation happens alongside -- must not disturb Sprint 1's own store.
    await fetchM30ConfirmationForReport(report, async () => bullishBosCandles());

    const cardAfter = buildForexV2LifecycleCard(report, store);
    assertCase('Case13: Sprint 1 previous_state relay still works', cardAfter.engine_snapshot.previous_state === cardBefore.state, `expected ${cardBefore.state}, got ${cardAfter.engine_snapshot.previous_state}`);
  }

  console.log('\n-- Kairos Forex v2 M30 Confirmation Regression Suite ---------------');
  const groupedFailures = new Set(failures.map(f => f.caseName));
  const totalCases = 35;
  if (!failures.length) {
    console.log('PASS Case 1: LONG + bullish CHoCH -> CONFIRMED/CHOCH');
    console.log('PASS Case 2: LONG + bullish BOS -> CONFIRMED/BOS');
    console.log('PASS Case 3: SHORT + bearish CHoCH -> CONFIRMED/CHOCH');
    console.log('PASS Case 4: SHORT + bearish BOS -> CONFIRMED/BOS');
    console.log('PASS Case 5: opposite-direction structure -> NOT_CONFIRMED');
    console.log('PASS Case 6: no qualifying event -> NOT_CONFIRMED');
    console.log('PASS Case 7: missing M30 data -> UNAVAILABLE');
    console.log('PASS Case 8: fetch failure isolated -> UNAVAILABLE, never throws');
    console.log('PASS Case 9: pair isolation');
    console.log('PASS Case 10: direction isolation');
    console.log('PASS Case 11: repeated reads do not write or manufacture');
    console.log('PASS Case 12: Scout phase/tradeable/watch gates unchanged');
    console.log('PASS Case 13: Sprint 1 lifecycle continuity intact alongside M30');
  } else {
    for (const failure of failures) console.log(`FAIL ${failure.caseName}: ${failure.message}`);
  }
  console.log(`\nTotal: ${totalCases} | Passed: ${totalCases - groupedFailures.size} | Failed: ${groupedFailures.size}`);

  if (failures.length) process.exit(1);
})();
