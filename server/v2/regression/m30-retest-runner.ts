// Kairos Forex v2 -- Sprint 3: Post-M30-Confirmation Retest (shadow-only).
//
// Candle fixtures below are empirically calibrated against the REAL
// computeStructures/findSwings primitives (scanner.ts) via evaluateM30Confirmation
// and evaluateM30Retest themselves -- same methodology as Sprint 2's own
// m30-confirmation-runner.ts fixtures.
import { execSync } from 'child_process';
import { evaluateM30Confirmation, type M30Candle, type M30Confirmation } from '../m30Confirmation.js';
import { evaluateM30Retest, fetchM30RetestForReport, attachM30Retests, refreshM30Retests } from '../m30Retest.js';
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

// Monotonic drift only -- see m30-confirmation-runner.ts's own comment on
// why this must never reverse and must continue AWAY from the preceding
// pivot's extreme.
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

// Identical base fixtures to Sprint 2's own (last swing high 110 / last
// swing low 85) -- reused rather than re-derived, so brokenLevel is known
// ahead of time (110 for the uptrend's own last high, 85 for the
// downtrend's own last low).
function uptrendBase(): M30Candle[] {
  let rows = zigzag([
    { i: 6, price: 85, type: 'low' },
    { i: 12, price: 100, type: 'high' },
    { i: 18, price: 90, type: 'low' },
    { i: 24, price: 105, type: 'high' },
    { i: 30, price: 95, type: 'low' },
    { i: 36, price: 110, type: 'high' },
  ]);
  return pad(rows, 50, -1);
}

function downtrendBase(): M30Candle[] {
  let rows = zigzag([
    { i: 6, price: 115, type: 'high' },
    { i: 12, price: 95, type: 'low' },
    { i: 18, price: 110, type: 'high' },
    { i: 24, price: 90, type: 'low' },
    { i: 30, price: 105, type: 'high' },
    { i: 36, price: 85, type: 'low' },
  ]);
  return pad(rows, 50, 1);
}

// uptrend + bullish BOS break of its own last swing high (110) -> never
// comes back down -- used for the WAITING_FOR_RETEST cases.
function bullishBosCandles(): M30Candle[] {
  const rows = uptrendBase();
  const lastClose = rows[rows.length - 1].c;
  rows.push(candle(rows.length, lastClose, lastClose + 20, lastClose - 0.2, lastClose + 19));
  return pad(rows, 8, 1);
}

// downtrend + bearish BOS break of its own last swing low (85) -> never
// comes back up -- used for the WAITING_FOR_RETEST cases.
function bearishBosCandles(): M30Candle[] {
  const rows = downtrendBase();
  const lastClose = rows[rows.length - 1].c;
  rows.push(candle(rows.length, lastClose, lastClose + 0.2, lastClose - 20, lastClose - 19));
  return pad(rows, 8, -1);
}

// Same bullish BOS break as bullishBosCandles(), but followed (after a
// brief continuation away from the level) by a pullback candle whose
// range touches the exact broken level (110), then a short continuation
// -- calibrated against the real evaluateM30Confirmation/evaluateM30Retest
// to confirm CONFIRMED -> RETEST_REACHED with barsAfterConfirmation=4.
function bullishBosWithRetest(): M30Candle[] {
  const rows = uptrendBase();
  const lastClose = rows[rows.length - 1].c;
  rows.push(candle(rows.length, lastClose, lastClose + 20, lastClose - 0.2, lastClose + 19));
  let out = pad(rows, 3, 1);
  const afterDrift = out[out.length - 1].c;
  const level = 110;
  out.push(candle(out.length, afterDrift, afterDrift + 0.1, level - 0.5, level - 0.1));
  out = pad(out, 5, 1);
  return out;
}

// Bearish mirror of bullishBosWithRetest() -- level 85.
function bearishBosWithRetest(): M30Candle[] {
  const rows = downtrendBase();
  const lastClose = rows[rows.length - 1].c;
  rows.push(candle(rows.length, lastClose, lastClose + 0.2, lastClose - 20, lastClose - 19));
  let out = pad(rows, 3, -1);
  const afterDrift = out[out.length - 1].c;
  const level = 85;
  out.push(candle(out.length, afterDrift, level + 0.5, afterDrift - 0.1, level + 0.1));
  out = pad(out, 5, -1);
  return out;
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
// Case 1 -- LONG confirmed, price never returns -> WAITING_FOR_RETEST
// ---------------------------------------------------------------------
{
  const candles = bullishBosCandles();
  const confirmation = evaluateM30Confirmation('LONG', candles);
  const result = evaluateM30Retest(confirmation, candles);
  assertCase('Case1: status WAITING_FOR_RETEST', result.status === 'WAITING_FOR_RETEST', `expected WAITING_FOR_RETEST, got ${result.status}`);
  assertCase('Case1: level carried through', result.level === 110, `expected 110, got ${result.level}`);
  assertCase('Case1: retestAt null', result.retestAt === null, `expected null, got ${result.retestAt}`);
}

// ---------------------------------------------------------------------
// Case 2 -- LONG confirmed, price returns to the level -> RETEST_REACHED
// ---------------------------------------------------------------------
{
  const candles = bullishBosWithRetest();
  const confirmation = evaluateM30Confirmation('LONG', candles);
  const result = evaluateM30Retest(confirmation, candles);
  assertCase('Case2: status RETEST_REACHED', result.status === 'RETEST_REACHED', `expected RETEST_REACHED, got ${result.status}`);
  assertCase('Case2: level 110', result.level === 110, `expected 110, got ${result.level}`);
  assertCase('Case2: retestAt present', typeof result.retestAt === 'string', 'expected a retestAt timestamp');
  assertCase('Case2: barsAfterConfirmation positive', (result.barsAfterConfirmation ?? -1) > 0, `expected > 0, got ${result.barsAfterConfirmation}`);
  assertCase('Case2: confirmedAt < retestAt', new Date(result.confirmedAt!).getTime() < new Date(result.retestAt!).getTime(), 'confirmation timestamp must precede retest timestamp');
}

// ---------------------------------------------------------------------
// Case 3 -- SHORT confirmed, price never returns -> WAITING_FOR_RETEST
// ---------------------------------------------------------------------
{
  const candles = bearishBosCandles();
  const confirmation = evaluateM30Confirmation('SHORT', candles);
  const result = evaluateM30Retest(confirmation, candles);
  assertCase('Case3: status WAITING_FOR_RETEST', result.status === 'WAITING_FOR_RETEST', `expected WAITING_FOR_RETEST, got ${result.status}`);
  assertCase('Case3: level 85', result.level === 85, `expected 85, got ${result.level}`);
}

// ---------------------------------------------------------------------
// Case 4 -- SHORT confirmed, price returns to the level -> RETEST_REACHED
// ---------------------------------------------------------------------
{
  const candles = bearishBosWithRetest();
  const confirmation = evaluateM30Confirmation('SHORT', candles);
  const result = evaluateM30Retest(confirmation, candles);
  assertCase('Case4: status RETEST_REACHED', result.status === 'RETEST_REACHED', `expected RETEST_REACHED, got ${result.status}`);
  assertCase('Case4: level 85', result.level === 85, `expected 85, got ${result.level}`);
  assertCase('Case4: confirmedAt < retestAt', new Date(result.confirmedAt!).getTime() < new Date(result.retestAt!).getTime(), 'confirmation timestamp must precede retest timestamp');
}

// ---------------------------------------------------------------------
// Case 5 -- A pre-confirmation touch of the level (the original swing-high
// pivot at candle index 36, price exactly 110, well before the breakout)
// must NOT be picked up as the retest.
// ---------------------------------------------------------------------
{
  const candles = bullishBosWithRetest();
  const confirmation = evaluateM30Confirmation('LONG', candles);
  const result = evaluateM30Retest(confirmation, candles);
  const pivotTimestamp = isoAt(36); // the original swing-high pivot that was later broken -- also touches level 110
  assertCase('Case5: retest is not the pre-confirmation pivot touch', result.retestAt !== pivotTimestamp, 'the pre-existing pivot touch must not be reported as the retest');
  assertCase('Case5: retestAt strictly after confirmedAt', new Date(result.retestAt!).getTime() > new Date(result.confirmedAt!).getTime(), 'retest must occur strictly after confirmation, not at an earlier pre-confirmation touch');
}

// ---------------------------------------------------------------------
// Case 6 -- The confirming (breakout) candle's own range also spans the
// level it broke, but it cannot count as its own retest.
// ---------------------------------------------------------------------
{
  const candles = bullishBosWithRetest();
  const confirmation = evaluateM30Confirmation('LONG', candles);
  const result = evaluateM30Retest(confirmation, candles);
  assertCase('Case6: retestAt is not the confirming candle itself', result.retestAt !== confirmation.confirmedAt, 'the confirming candle must not count as its own retest');
  assertCase('Case6: barsAfterConfirmation > 0', (result.barsAfterConfirmation ?? 0) > 0, 'the retest must be strictly after the confirming candle');
}

// ---------------------------------------------------------------------
// Case 7 -- Opposite-direction confirmation (thesis LONG, M30 only shows
// bearish continuation) -> confirmation NOT_CONFIRMED -> retest
// WAITING_FOR_CONFIRMATION.
// ---------------------------------------------------------------------
{
  const candles = bearishBosCandles();
  const confirmation = evaluateM30Confirmation('LONG', candles);
  assertCase('Case7: confirmation is NOT_CONFIRMED (sanity)', confirmation.status === 'NOT_CONFIRMED', `expected NOT_CONFIRMED, got ${confirmation.status}`);
  const result = evaluateM30Retest(confirmation, candles);
  assertCase('Case7: status WAITING_FOR_CONFIRMATION', result.status === 'WAITING_FOR_CONFIRMATION', `expected WAITING_FOR_CONFIRMATION, got ${result.status}`);
  assertCase('Case7: no level invented', result.level === null, `expected null, got ${result.level}`);
}

// ---------------------------------------------------------------------
// Case 8 -- No confirmation at all (plain trend, no breakout anywhere)
// -> WAITING_FOR_CONFIRMATION.
// ---------------------------------------------------------------------
{
  const candles = downtrendBase();
  const confirmation = evaluateM30Confirmation('LONG', candles);
  assertCase('Case8: confirmation is NOT_CONFIRMED (sanity)', confirmation.status === 'NOT_CONFIRMED', `expected NOT_CONFIRMED, got ${confirmation.status}`);
  const result = evaluateM30Retest(confirmation, candles);
  assertCase('Case8: status WAITING_FOR_CONFIRMATION', result.status === 'WAITING_FOR_CONFIRMATION', `expected WAITING_FOR_CONFIRMATION, got ${result.status}`);
}

// ---------------------------------------------------------------------
// Case 9 -- Confirmation itself UNAVAILABLE (insufficient M30 data) ->
// retest UNAVAILABLE.
// ---------------------------------------------------------------------
{
  const confirmation = evaluateM30Confirmation('LONG', bullishBosCandles().slice(0, 10));
  assertCase('Case9: confirmation is UNAVAILABLE (sanity)', confirmation.status === 'UNAVAILABLE', `expected UNAVAILABLE, got ${confirmation.status}`);
  const result = evaluateM30Retest(confirmation, bullishBosCandles().slice(0, 10));
  assertCase('Case9: status UNAVAILABLE', result.status === 'UNAVAILABLE', `expected UNAVAILABLE, got ${result.status}`);
}

// ---------------------------------------------------------------------
// Case 10 -- CONFIRMED but missing a broken level/timestamp/eventType ->
// UNAVAILABLE, never an invented level.
// ---------------------------------------------------------------------
{
  const brokenConfirmation: M30Confirmation = {
    status: 'CONFIRMED',
    direction: 'LONG',
    eventType: null as any,
    eventDirection: 'bullish',
    confirmedAt: null,
    ageBars: 1,
    brokenLevel: null,
    reason: 'malformed confirmation for test purposes',
  };
  const result = evaluateM30Retest(brokenConfirmation, bullishBosCandles());
  assertCase('Case10: status UNAVAILABLE', result.status === 'UNAVAILABLE', `expected UNAVAILABLE, got ${result.status}`);
  assertCase('Case10: no level invented', result.level === null, `expected null, got ${result.level}`);
}

// ---------------------------------------------------------------------
// Case 11 -- Pair isolation: EUR_USD retest cannot leak to GBP_USD.
// ---------------------------------------------------------------------
{
  const candles = bullishBosWithRetest();
  const confirmation = evaluateM30Confirmation('LONG', candles);
  const cache = new Map<string, ReturnType<typeof evaluateM30Retest>>();
  cache.set('EUR_USD|M30|LONG', evaluateM30Retest(confirmation, candles));
  const eur = scoutReport({ pair: 'EUR_USD', timeframe: 'M30', tradeDirection: 'LONG' });
  const gbp = scoutReport({ pair: 'GBP_USD', displaySymbol: 'GBP/USD', timeframe: 'M30', tradeDirection: 'LONG' });
  const [eurAttached, gbpAttached] = attachM30Retests([eur, gbp], cache);
  assertCase('Case11: EUR_USD gets its own RETEST_REACHED result', eurAttached.m30Retest.status === 'RETEST_REACHED', `expected RETEST_REACHED, got ${eurAttached.m30Retest.status}`);
  assertCase('Case11: GBP_USD does not inherit EUR_USD retest', gbpAttached.m30Retest.status !== 'RETEST_REACHED', 'GBP_USD must not inherit EUR_USD M30 retest');
}

// ---------------------------------------------------------------------
// Case 12 -- Direction isolation: a prior LONG retest must not
// automatically apply to a later SHORT thesis for the same pair.
// ---------------------------------------------------------------------
{
  const candles = bullishBosWithRetest();
  const confirmation = evaluateM30Confirmation('LONG', candles);
  const cache = new Map<string, ReturnType<typeof evaluateM30Retest>>();
  cache.set('EUR_USD|M30|LONG', evaluateM30Retest(confirmation, candles));
  const shortReport = scoutReport({ pair: 'EUR_USD', timeframe: 'M30', tradeDirection: 'SHORT', bias: 'BEARISH', zone: 'PREMIUM' });
  const [attached] = attachM30Retests([shortReport], cache);
  assertCase('Case12: SHORT thesis does not inherit the LONG retest', attached.m30Retest.status !== 'RETEST_REACHED', 'a prior LONG retest must not carry over to a SHORT thesis');
}

// ---------------------------------------------------------------------
// Case 13 -- Repeated reads must not manufacture a new retest or write to
// the cache (attachM30Retests is a pure cache read).
// ---------------------------------------------------------------------
{
  const candles = bullishBosCandles();
  const confirmation = evaluateM30Confirmation('LONG', candles);
  const cache = new Map<string, ReturnType<typeof evaluateM30Retest>>();
  cache.set('EUR_USD|M30|LONG', evaluateM30Retest(confirmation, candles));
  const snapshotBefore = JSON.stringify(Array.from(cache.entries()));
  const report = scoutReport({ pair: 'EUR_USD', timeframe: 'M30', tradeDirection: 'LONG' });
  const reads = Array.from({ length: 5 }, () => attachM30Retests([report], cache)[0]);
  const snapshotAfter = JSON.stringify(Array.from(cache.entries()));
  assertCase('Case13: cache is never mutated by repeated reads', snapshotBefore === snapshotAfter, 'attachM30Retests must never write to its cache');
  assertCase(
    'Case13: repeated reads return identical retest',
    reads.every(r => JSON.stringify(r.m30Retest) === JSON.stringify(reads[0].m30Retest)),
    'repeated reads of unchanged cache data must not manufacture a new/different M30 retest',
  );
}

(async () => {
  // ---------------------------------------------------------------------
  // Case 14 -- A new scan (a fresh refreshM30Retests call, not a plain
  // read) correctly advances WAITING_FOR_RETEST -> RETEST_REACHED once
  // price genuinely returns to the level.
  // ---------------------------------------------------------------------
  {
    const report = scoutReport({ pair: 'EUR_USD', timeframe: 'M30', tradeDirection: 'LONG' });
    const firstScanCandles = bullishBosCandles(); // no retest yet
    const secondScanCandles = bullishBosWithRetest(); // same breakout, later data shows the retest
    const cacheAfterFirstScan = await refreshM30Retests([report], async () => firstScanCandles);
    const cacheAfterSecondScan = await refreshM30Retests([report], async () => secondScanCandles);
    const key = 'EUR_USD|M30|LONG';
    assertCase('Case14: first scan is WAITING_FOR_RETEST', cacheAfterFirstScan.get(key)?.status === 'WAITING_FOR_RETEST', `expected WAITING_FOR_RETEST, got ${cacheAfterFirstScan.get(key)?.status}`);
    assertCase('Case14: second scan advances to RETEST_REACHED', cacheAfterSecondScan.get(key)?.status === 'RETEST_REACHED', `expected RETEST_REACHED, got ${cacheAfterSecondScan.get(key)?.status}`);
  }

  // ---------------------------------------------------------------------
  // Case 15 -- Sprint 2's own test suite still passes unchanged.
  // ---------------------------------------------------------------------
  {
    let sprint2Passed = true;
    let sprint2Message = '';
    try {
      execSync('npm run test:m30-confirmation', { stdio: 'pipe' });
    } catch (e: any) {
      sprint2Passed = false;
      sprint2Message = e?.stdout?.toString?.() || e?.message || 'unknown failure';
    }
    assertCase('Case15: Sprint 2 (test:m30-confirmation) still passes', sprint2Passed, `Sprint 2 suite failed: ${sprint2Message}`);
  }

  // ---------------------------------------------------------------------
  // Case 16 -- Sprint 1's own test suite still passes unchanged.
  // ---------------------------------------------------------------------
  {
    let sprint1Passed = true;
    let sprint1Message = '';
    try {
      execSync('npm run test:card-continuity', { stdio: 'pipe' });
    } catch (e: any) {
      sprint1Passed = false;
      sprint1Message = e?.stdout?.toString?.() || e?.message || 'unknown failure';
    }
    assertCase('Case16: Sprint 1 (test:card-continuity) still passes', sprint1Passed, `Sprint 1 suite failed: ${sprint1Message}`);
  }

  // ---------------------------------------------------------------------
  // Case 17 -- Scout phase isolation: scoutPhaseState/isTradeableScoutSignal/
  // isWatchScoutSignal must be byte/deep-equal before and after M30 retest
  // shadow evaluation for the exact same report, and the report itself
  // must never be mutated.
  // ---------------------------------------------------------------------
  {
    const report = scoutReport();
    const phaseBefore = scoutPhaseState(report);
    const tradeableBefore = isTradeableScoutSignal(report);
    const watchBefore = isWatchScoutSignal(report);
    const reportJsonBefore = JSON.stringify(report);

    await fetchM30RetestForReport(report, async () => bullishBosWithRetest());
    const cache = await refreshM30Retests([report], async () => bullishBosWithRetest());
    attachM30Retests([report], cache);

    const phaseAfter = scoutPhaseState(report);
    const tradeableAfter = isTradeableScoutSignal(report);
    const watchAfter = isWatchScoutSignal(report);

    assertCase('Case17: report object not mutated', JSON.stringify(report) === reportJsonBefore, 'M30 retest evaluation must not mutate the ScoutReport');
    assertCase('Case17: scoutPhaseState unchanged', JSON.stringify(phaseAfter) === JSON.stringify(phaseBefore), 'scoutPhaseState must be byte-equal before/after M30 retest evaluation');
    assertCase('Case17: isTradeableScoutSignal unchanged', tradeableAfter === tradeableBefore, 'isTradeableScoutSignal must be unaffected by M30 retest evaluation');
    assertCase('Case17: isWatchScoutSignal unchanged', watchAfter === watchBefore, 'isWatchScoutSignal must be unaffected by M30 retest evaluation');
  }

  console.log('\n-- Kairos Forex v2 M30 Retest Regression Suite -----------------------');
  const groupedFailures = new Set(failures.map(f => f.caseName));
  const totalCases = 17;
  if (!failures.length) {
    console.log('PASS Case 1: LONG confirmed, no retest -> WAITING_FOR_RETEST');
    console.log('PASS Case 2: LONG confirmed, retest reached -> RETEST_REACHED');
    console.log('PASS Case 3: SHORT confirmed, no retest -> WAITING_FOR_RETEST');
    console.log('PASS Case 4: SHORT confirmed, retest reached -> RETEST_REACHED');
    console.log('PASS Case 5: pre-confirmation touch does not count');
    console.log('PASS Case 6: confirmation candle itself does not count');
    console.log('PASS Case 7: opposite-direction confirmation -> WAITING_FOR_CONFIRMATION');
    console.log('PASS Case 8: no confirmation -> WAITING_FOR_CONFIRMATION');
    console.log('PASS Case 9: confirmation UNAVAILABLE -> retest UNAVAILABLE');
    console.log('PASS Case 10: missing broken level -> UNAVAILABLE, no invented level');
    console.log('PASS Case 11: pair isolation');
    console.log('PASS Case 12: direction isolation');
    console.log('PASS Case 13: repeated reads do not write or manufacture');
    console.log('PASS Case 14: new scan data advances WAITING_FOR_RETEST -> RETEST_REACHED');
    console.log('PASS Case 15: Sprint 2 suite still passes');
    console.log('PASS Case 16: Sprint 1 suite still passes');
    console.log('PASS Case 17: Scout phase/tradeable/watch gates unchanged');
  } else {
    for (const failure of failures) console.log(`FAIL ${failure.caseName}: ${failure.message}`);
  }
  console.log(`\nTotal: ${totalCases} | Passed: ${totalCases - groupedFailures.size} | Failed: ${groupedFailures.size}`);

  if (failures.length) process.exit(1);
})();
