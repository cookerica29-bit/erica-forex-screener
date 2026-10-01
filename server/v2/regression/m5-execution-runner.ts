// Kairos Forex v2 -- Sprint 4: M5 Execution Trigger (shadow-only).
//
// Candle fixtures are empirically calibrated against the REAL
// computeStructures/findSwings primitives (scanner.ts), same methodology
// as m30-confirmation-runner.ts / m30-retest-runner.ts, but at 5-minute
// spacing. Touch points are always chosen as a NATURAL candle within a
// longer monotonic extension (never a separately-inserted dip/spike
// candle), so they never become a spurious new swing pivot that would
// corrupt getTrend's classification of a later breakout.
import { execSync } from 'child_process';
import { computeStructures } from '../../scanner.js';
import { evaluateM5Execution, attachM5Executions, refreshM5Executions, type M5Candle } from '../m5Execution.js';
import type { M30Retest } from '../m30Retest.js';
import { scoutPhaseState, isTradeableScoutSignal, isWatchScoutSignal, scoutTradeDirection } from '../../scoutPhase.js';
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
  return new Date(base + baseIdx * 5 * 60 * 1000).toISOString(); // 5-minute spacing
}

function candle(i: number, o: number, h: number, l: number, close: number): M5Candle {
  return { t: isoAt(i), o, h, l, c: close, v: 1000 } as M5Candle;
}

function zigzag(points: Array<{ i: number; price: number; type: 'high' | 'low' }>): M5Candle[] {
  const rows: M5Candle[] = [];
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

function pad(rows: M5Candle[], n: number, direction: 1 | -1): M5Candle[] {
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

function downtrendBase(): M5Candle[] {
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

function uptrendBase(): M5Candle[] {
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

function retest(overrides: Partial<M30Retest> = {}): M30Retest {
  return {
    status: 'RETEST_REACHED',
    direction: 'LONG',
    level: 999,
    confirmationType: 'BOS',
    confirmedAt: isoAt(0),
    retestAt: isoAt(60),
    barsAfterConfirmation: 60,
    reason: 'test fixture',
    ...overrides,
  };
}

// downtrend (SHORT trend) + natural touch point + later bullish CHoCH breakout.
function longTriggerCandles() {
  const base = downtrendBase();
  const extended = pad(base, 6, 1);
  const touchIndex = extended.length - 3;
  const level = extended[touchIndex].c;
  let out = pad(extended, 3, 1);
  const lastClose = out[out.length - 1].c;
  out.push(candle(out.length, lastClose, lastClose + 20, lastClose - 0.2, lastClose + 19)); // bullish CHoCH (trend SHORT)
  out = pad(out, 5, 1);
  return { candles: out, level, touchIndex };
}

// uptrend (LONG trend) + natural touch point + later bearish CHoCH breakdown.
function shortTriggerCandles() {
  const base = uptrendBase();
  const extended = pad(base, 6, -1);
  const touchIndex = extended.length - 3;
  const level = extended[touchIndex].c;
  let out = pad(extended, 3, -1);
  const lastClose = out[out.length - 1].c;
  out.push(candle(out.length, lastClose, lastClose + 0.2, lastClose - 20, lastClose - 19)); // bearish CHoCH (trend LONG)
  out = pad(out, 5, -1);
  return { candles: out, level, touchIndex };
}

// uptrend (already LONG) + natural touch point + bullish break of its OWN
// last swing high -> BOS (trend continuation), never CHoCH.
function bosOnlyCandles() {
  const base = uptrendBase();
  const extended = pad(base, 6, -1);
  const touchIndex = extended.length - 3;
  const level = extended[touchIndex].c;
  let out = pad(extended, 3, -1);
  const lastClose = out[out.length - 1].c;
  out.push(candle(out.length, lastClose, lastClose + 20, lastClose - 0.2, lastClose + 19)); // bullish break of own last high -> BOS
  out = pad(out, 5, 1);
  return { candles: out, level, touchIndex };
}

// Same prefix as longTriggerCandles() up to and including the touch point,
// but never breaks out afterward -- no qualifying CHoCH ever appears.
function noTriggerCandles() {
  const base = downtrendBase();
  const extended = pad(base, 6, 1);
  const touchIndex = extended.length - 3;
  const level = extended[touchIndex].c;
  const out = pad(extended, 10, 1);
  return { candles: out, level, touchIndex };
}

// A bullish CHoCH fires EARLY (well before the retest touch), then price
// only drifts afterward with no further qualifying event.
function historicalChochThenNoTrigger() {
  const base = downtrendBase();
  const chochIdx = base.length;
  const lastClose = base[base.length - 1].c;
  const withChoch = base.slice();
  withChoch.push(candle(chochIdx, lastClose, lastClose + 20, lastClose - 0.2, lastClose + 19)); // early bullish CHoCH
  const extended = pad(withChoch, 10, 1);
  const touchIndex = extended.length - 3;
  const level = extended[touchIndex].c;
  const out = pad(extended, 8, 1);
  return { candles: out, level, touchIndex };
}

// The bullish CHoCH fires at the FIRST candle of the M30 retest window
// (windowStartIndex), but the actual level touch only occurs a few M5
// candles LATER within that same window (touchIndex) -- proves the
// "earlier CHoCH inside the same M30 retest bar" exclusion.
function sameBarEarlyChoch() {
  const base = downtrendBase();
  const windowStartIndex = base.length;
  const lastClose = base[base.length - 1].c;
  const bigMove = lastClose + 19;
  const withChoch = base.slice();
  withChoch.push(candle(windowStartIndex, lastClose, bigMove + 0.05, lastClose - 0.05, bigMove)); // realistic wick, not an oversized one
  let out = pad(withChoch, 3, 1);
  const touchIndex = out.length;
  const level = out[out.length - 1].h + 0.01; // reachable only by a candle after the breakout, not the breakout candle's own wick
  out.push(candle(touchIndex, out[out.length - 1].c, level + 0.02, out[out.length - 1].c - 0.01, level));
  out = pad(out, 8, 1);
  return { candles: out, level, windowStartIndex, touchIndex };
}

// The retest-touch candle IS the CHoCH breakout candle itself (same index).
function retestIsBreakoutCandles() {
  const base = downtrendBase();
  const breakoutIndex = base.length;
  const lastClose = base[base.length - 1].c;
  const out = base.slice();
  out.push(candle(breakoutIndex, lastClose, lastClose + 20, lastClose - 0.2, lastClose + 19));
  const level = lastClose + 10; // within the breakout candle's own [l,h] range
  const final = pad(out, 8, 1);
  return { candles: final, level, breakoutIndex };
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
    timeframe: 'H1',
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

function spyFetch(byPair: Record<string, M5Candle[]>) {
  const calls: string[] = [];
  const fn = async (pair: string): Promise<M5Candle[]> => {
    calls.push(pair);
    const data = byPair[pair];
    if (!data) throw new Error(`no fixture for ${pair}`);
    return data;
  };
  return { fn, calls };
}

function shadowKeyFor(pair: string, timeframe: string, direction: string): string {
  return [pair, timeframe, direction].join('|');
}

// ---------------------------------------------------------------------
// Case 1 -- M30 retest not reached -> WAITING_FOR_M30_RETEST, zero fetch.
// ---------------------------------------------------------------------
{
  const r = retest({ status: 'WAITING_FOR_RETEST', level: null, retestAt: null, confirmationType: null });
  const result = evaluateM5Execution('LONG', r, null);
  assertCase('Case1: status WAITING_FOR_M30_RETEST', result.status === 'WAITING_FOR_M30_RETEST', `expected WAITING_FOR_M30_RETEST, got ${result.status}`);
}

// ---------------------------------------------------------------------
// Case 2 -- LONG retest reached, no post-retest CHoCH -> WATCHING_M5.
// ---------------------------------------------------------------------
{
  const { candles, level, touchIndex } = noTriggerCandles();
  const r = retest({ direction: 'LONG', level, retestAt: isoAt(touchIndex) });
  const result = evaluateM5Execution('LONG', r, candles);
  assertCase('Case2: status WATCHING_M5', result.status === 'WATCHING_M5', `expected WATCHING_M5, got ${result.status}`);
  assertCase('Case2: m5RetestAt resolved', result.m5RetestAt === isoAt(touchIndex), `expected ${isoAt(touchIndex)}, got ${result.m5RetestAt}`);
}

// ---------------------------------------------------------------------
// Case 3 -- LONG + bullish post-retest CHoCH -> ENTRY_READY.
// ---------------------------------------------------------------------
{
  const { candles, level, touchIndex } = longTriggerCandles();
  const r = retest({ direction: 'LONG', level, retestAt: isoAt(touchIndex) });
  const result = evaluateM5Execution('LONG', r, candles);
  assertCase('Case3: status ENTRY_READY', result.status === 'ENTRY_READY', `expected ENTRY_READY, got ${result.status}`);
  assertCase('Case3: direction LONG', result.direction === 'LONG', `expected LONG, got ${result.direction}`);
  assertCase('Case3: triggerType CHOCH', result.triggerType === 'CHOCH', `expected CHOCH, got ${result.triggerType}`);
  assertCase('Case3: triggerDirection bullish', result.triggerDirection === 'bullish', `expected bullish, got ${result.triggerDirection}`);
  assertCase('Case3: triggeredAt strictly after m5RetestAt', new Date(result.triggeredAt!).getTime() > new Date(result.m5RetestAt!).getTime(), 'trigger must be strictly after the resolved M5 retest touch');
}

// ---------------------------------------------------------------------
// Case 4 -- SHORT + bearish post-retest CHoCH -> ENTRY_READY.
// ---------------------------------------------------------------------
{
  const { candles, level, touchIndex } = shortTriggerCandles();
  const r = retest({ direction: 'SHORT', level, retestAt: isoAt(touchIndex) });
  const result = evaluateM5Execution('SHORT', r, candles);
  assertCase('Case4: status ENTRY_READY', result.status === 'ENTRY_READY', `expected ENTRY_READY, got ${result.status}`);
  assertCase('Case4: direction SHORT', result.direction === 'SHORT', `expected SHORT, got ${result.direction}`);
  assertCase('Case4: triggerType CHOCH', result.triggerType === 'CHOCH', `expected CHOCH, got ${result.triggerType}`);
  assertCase('Case4: triggerDirection bearish', result.triggerDirection === 'bearish', `expected bearish, got ${result.triggerDirection}`);
}

// ---------------------------------------------------------------------
// Case 5 -- LONG thesis, only a bearish CHoCH exists -> must NOT trigger.
// ---------------------------------------------------------------------
{
  const { candles, level, touchIndex } = shortTriggerCandles();
  const r = retest({ direction: 'LONG', level, retestAt: isoAt(touchIndex) });
  const result = evaluateM5Execution('LONG', r, candles);
  assertCase('Case5: status WATCHING_M5 (wrong-direction CHoCH must not trigger)', result.status === 'WATCHING_M5', `expected WATCHING_M5, got ${result.status}`);
}

// ---------------------------------------------------------------------
// Case 6 -- SHORT thesis, only a bullish CHoCH exists -> must NOT trigger.
// ---------------------------------------------------------------------
{
  const { candles, level, touchIndex } = longTriggerCandles();
  const r = retest({ direction: 'SHORT', level, retestAt: isoAt(touchIndex) });
  const result = evaluateM5Execution('SHORT', r, candles);
  assertCase('Case6: status WATCHING_M5 (wrong-direction CHoCH must not trigger)', result.status === 'WATCHING_M5', `expected WATCHING_M5, got ${result.status}`);
}

// ---------------------------------------------------------------------
// Case 7 -- Thesis-direction BOS only (no CHoCH) -> WATCHING_M5.
// ---------------------------------------------------------------------
{
  const { candles, level, touchIndex } = bosOnlyCandles();
  const r = retest({ direction: 'LONG', level, retestAt: isoAt(touchIndex) });
  const result = evaluateM5Execution('LONG', r, candles);
  assertCase('Case7: status WATCHING_M5 (BOS alone must not trigger)', result.status === 'WATCHING_M5', `expected WATCHING_M5, got ${result.status}`);
  // Sanity: prove a real bullish BOS actually exists in this fixture, so
  // this test is exercising the BOS-exclusion rule, not an empty fixture.
  const structures = computeStructures(candles, 5);
  assertCase('Case7: fixture genuinely contains a bullish BOS', structures.bosEvents.some(e => e.type === 'bullish'), 'fixture must contain a real bullish BOS for this test to be meaningful');
}

// ---------------------------------------------------------------------
// Case 8 -- Historical CHoCH before the retest, none after -> does NOT
// trigger.
// ---------------------------------------------------------------------
{
  const { candles, level, touchIndex } = historicalChochThenNoTrigger();
  const r = retest({ direction: 'LONG', level, retestAt: isoAt(touchIndex) });
  const result = evaluateM5Execution('LONG', r, candles);
  assertCase('Case8: status WATCHING_M5 (historical pre-retest CHoCH must not trigger)', result.status === 'WATCHING_M5', `expected WATCHING_M5, got ${result.status}`);
  const structures = computeStructures(candles, 5);
  assertCase('Case8: fixture genuinely contains a bullish CHoCH before the retest', structures.chochEvents.some(e => e.type === 'bullish'), 'fixture must contain a real historical CHoCH for this test to be meaningful');
}

// ---------------------------------------------------------------------
// Case 9 -- CHoCH earlier inside the SAME M30 retest bar (window opens
// with the CHoCH; the actual touch is a later candle in that same
// window) -> does NOT trigger. Critical regression case.
// ---------------------------------------------------------------------
{
  const { candles, level, windowStartIndex, touchIndex } = sameBarEarlyChoch();
  const r = retest({ direction: 'LONG', level, retestAt: isoAt(windowStartIndex) });
  const result = evaluateM5Execution('LONG', r, candles);
  assertCase('Case9: status WATCHING_M5', result.status === 'WATCHING_M5', `expected WATCHING_M5, got ${result.status}`);
  assertCase('Case9: m5RetestAt resolved to the LATER touch candle, not the window-open CHoCH candle', result.m5RetestAt === isoAt(touchIndex) && result.m5RetestAt !== isoAt(windowStartIndex), `expected ${isoAt(touchIndex)}, got ${result.m5RetestAt}`);
  const structures = computeStructures(candles, 5);
  assertCase('Case9: fixture genuinely contains a bullish CHoCH at the window-open candle', structures.chochEvents.some(e => e.type === 'bullish' && e.time === Math.floor(new Date(isoAt(windowStartIndex)).getTime() / 1000)), 'fixture must contain a real CHoCH at windowStartIndex for this test to be meaningful');
}

// ---------------------------------------------------------------------
// Case 10 -- The retest-touch candle itself generates the CHoCH event ->
// does NOT trigger (it must not count as its own execution trigger).
// ---------------------------------------------------------------------
{
  const { candles, level, breakoutIndex } = retestIsBreakoutCandles();
  const r = retest({ direction: 'LONG', level, retestAt: isoAt(breakoutIndex) });
  const result = evaluateM5Execution('LONG', r, candles);
  assertCase('Case10: status WATCHING_M5', result.status === 'WATCHING_M5', `expected WATCHING_M5, got ${result.status}`);
  assertCase('Case10: m5RetestAt equals the breakout candle itself', result.m5RetestAt === isoAt(breakoutIndex), `expected ${isoAt(breakoutIndex)}, got ${result.m5RetestAt}`);
  const structures = computeStructures(candles, 5);
  assertCase('Case10: fixture genuinely contains a CHoCH at the retest-touch candle', structures.chochEvents.some(e => e.time === Math.floor(new Date(isoAt(breakoutIndex)).getTime() / 1000)), 'fixture must contain a real CHoCH at the retest-touch candle for this test to be meaningful');
}

// ---------------------------------------------------------------------
// Case 12 -- Missing M5 coverage for the retest (retestAt predates the
// earliest available M5 candle) -> UNAVAILABLE, even if an unrelated
// later CHoCH exists in the data.
// ---------------------------------------------------------------------
{
  const { candles } = longTriggerCandles(); // contains a real later bullish CHoCH
  const r = retest({ direction: 'LONG', level: 999999, retestAt: isoAt(-5) });
  const result = evaluateM5Execution('LONG', r, candles);
  assertCase('Case12: status UNAVAILABLE', result.status === 'UNAVAILABLE', `expected UNAVAILABLE, got ${result.status}`);
  assertCase('Case12: does not accept the newer unrelated CHoCH', result.triggerType === null, 'must not accept an unrelated CHoCH when coverage is insufficient');
}

(async () => {
  // ---------------------------------------------------------------------
  // Case 1b -- refreshM5Executions makes zero fetches while waiting for
  // M30 confirmation/retest.
  // ---------------------------------------------------------------------
  {
    const report = scoutReport({ pair: 'EUR_USD', timeframe: 'H1', tradeDirection: 'LONG' });
    const m30Retests = new Map<string, M30Retest>([[shadowKeyFor('EUR_USD', 'H1', 'LONG'), retest({ status: 'WAITING_FOR_RETEST', level: null, retestAt: null })]]);
    const { fn, calls } = spyFetch({});
    const results = await refreshM5Executions([report], m30Retests, fn);
    assertCase('Case1b: zero M5 fetches while waiting for M30 retest', calls.length === 0, `expected 0 calls, got ${calls.length}`);
    assertCase('Case1b: result is WAITING_FOR_M30_RETEST', results.get(shadowKeyFor('EUR_USD', 'H1', 'LONG'))?.status === 'WAITING_FOR_M30_RETEST', 'expected WAITING_FOR_M30_RETEST');
  }

  // ---------------------------------------------------------------------
  // Case 11 -- Retest then later CHoCH: WATCHING_M5 on one scan, then
  // ENTRY_READY on a subsequent scan once the data shows the trigger.
  // ---------------------------------------------------------------------
  {
    const report = scoutReport({ pair: 'EUR_USD', timeframe: 'H1', tradeDirection: 'LONG' });
    const { candles: firstScanCandles, level, touchIndex } = noTriggerCandles();
    const { candles: secondScanCandles } = longTriggerCandles(); // same prefix/touchIndex, later breakout added
    const m30Retests = new Map<string, M30Retest>([[shadowKeyFor('EUR_USD', 'H1', 'LONG'), retest({ direction: 'LONG', level, retestAt: isoAt(touchIndex) })]]);
    const firstResults = await refreshM5Executions([report], m30Retests, async () => firstScanCandles);
    const secondResults = await refreshM5Executions([report], m30Retests, async () => secondScanCandles);
    const key = shadowKeyFor('EUR_USD', 'H1', 'LONG');
    assertCase('Case11: first scan is WATCHING_M5', firstResults.get(key)?.status === 'WATCHING_M5', `expected WATCHING_M5, got ${firstResults.get(key)?.status}`);
    assertCase('Case11: second scan advances to ENTRY_READY', secondResults.get(key)?.status === 'ENTRY_READY', `expected ENTRY_READY, got ${secondResults.get(key)?.status}`);
  }

  // ---------------------------------------------------------------------
  // Case 13 -- M5 fetch failure -> UNAVAILABLE, Scout survives.
  // ---------------------------------------------------------------------
  {
    const report = scoutReport({ pair: 'EUR_USD', timeframe: 'H1', tradeDirection: 'LONG' });
    const reportJsonBefore = JSON.stringify(report);
    const { level, touchIndex } = noTriggerCandles();
    const m30Retests = new Map<string, M30Retest>([[shadowKeyFor('EUR_USD', 'H1', 'LONG'), retest({ direction: 'LONG', level, retestAt: isoAt(touchIndex) })]]);
    const failingFetch = async (_pair: string): Promise<M5Candle[]> => {
      throw new Error('OANDA EUR_USD M5: 503');
    };
    let threw = false;
    let results: Awaited<ReturnType<typeof refreshM5Executions>> | undefined;
    try {
      results = await refreshM5Executions([report], m30Retests, failingFetch);
    } catch {
      threw = true;
    }
    assertCase('Case13: refreshM5Executions never throws', !threw, 'a fetch failure must not reject the whole refresh');
    assertCase('Case13: status UNAVAILABLE', results?.get(shadowKeyFor('EUR_USD', 'H1', 'LONG'))?.status === 'UNAVAILABLE', `expected UNAVAILABLE, got ${results?.get(shadowKeyFor('EUR_USD', 'H1', 'LONG'))?.status}`);
    assertCase('Case13: report object not mutated', JSON.stringify(report) === reportJsonBefore, 'a fetch failure must not mutate the ScoutReport');
  }

  // ---------------------------------------------------------------------
  // Case 14 -- Repeated GET (repeated attach reads) makes zero network
  // calls, manufactures no new CHoCH/transition, and keeps timestamps
  // identical.
  // ---------------------------------------------------------------------
  {
    const report = scoutReport({ pair: 'EUR_USD', timeframe: 'H1', tradeDirection: 'LONG' });
    const { candles, level, touchIndex } = longTriggerCandles();
    const m30Retests = new Map<string, M30Retest>([[shadowKeyFor('EUR_USD', 'H1', 'LONG'), retest({ direction: 'LONG', level, retestAt: isoAt(touchIndex) })]]);
    const { fn, calls } = spyFetch({ EUR_USD: candles });
    const results = await refreshM5Executions([report], m30Retests, fn);
    assertCase('Case14: one fetch during the scan itself', calls.length === 1, `expected 1 call, got ${calls.length}`);
    const snapshotBefore = JSON.stringify(Array.from(results.entries()));
    for (let i = 0; i < 5; i++) attachM5Executions([report], results);
    assertCase('Case14: repeated attach reads make zero additional fetches', calls.length === 1, `expected fetch count to stay at 1, got ${calls.length}`);
    assertCase('Case14: cache untouched by repeated reads', JSON.stringify(Array.from(results.entries())) === snapshotBefore, 'attachM5Executions must never write to its cache');
    const reads = Array.from({ length: 5 }, () => attachM5Executions([report], results)[0].m5Execution);
    assertCase('Case14: repeated reads return identical result', reads.every(r => JSON.stringify(r) === JSON.stringify(reads[0])), 'repeated reads must not manufacture a new/different M5 execution result');
  }

  // ---------------------------------------------------------------------
  // Case 15 -- One pair, H4 + H1 activated reports -> one M5 fetch.
  // ---------------------------------------------------------------------
  {
    const { candles, level, touchIndex } = longTriggerCandles();
    const h4Report = scoutReport({ pair: 'EUR_USD', timeframe: 'H4', tradeDirection: 'LONG' });
    const h1Report = scoutReport({ pair: 'EUR_USD', timeframe: 'H1', tradeDirection: 'LONG' });
    const m30Retests = new Map<string, M30Retest>([
      [shadowKeyFor('EUR_USD', 'H4', 'LONG'), retest({ direction: 'LONG', level, retestAt: isoAt(touchIndex) })],
      [shadowKeyFor('EUR_USD', 'H1', 'LONG'), retest({ direction: 'LONG', level, retestAt: isoAt(touchIndex) })],
    ]);
    const { fn, calls } = spyFetch({ EUR_USD: candles });
    const results = await refreshM5Executions([h4Report, h1Report], m30Retests, fn);
    assertCase('Case15: exactly one fetch for two activated reports of the same pair', calls.length === 1, `expected 1 call, got ${calls.length}`);
    assertCase('Case15: both reports reach ENTRY_READY from the shared snapshot', results.get(shadowKeyFor('EUR_USD', 'H4', 'LONG'))?.status === 'ENTRY_READY' && results.get(shadowKeyFor('EUR_USD', 'H1', 'LONG'))?.status === 'ENTRY_READY', 'expected both timeframe-reports to reach ENTRY_READY from the same shared M5 snapshot');
  }

  // ---------------------------------------------------------------------
  // Case 16 -- Pair isolation: EURUSD M5 structure cannot trigger GBPUSD.
  // ---------------------------------------------------------------------
  {
    const { candles: eurCandles, level: eurLevel, touchIndex: eurTouch } = longTriggerCandles();
    const { candles: gbpCandles, level: gbpLevel, touchIndex: gbpTouch } = noTriggerCandles();
    const eurReport = scoutReport({ pair: 'EUR_USD', timeframe: 'H1', tradeDirection: 'LONG' });
    const gbpReport = scoutReport({ pair: 'GBP_USD', displaySymbol: 'GBP/USD', timeframe: 'H1', tradeDirection: 'LONG' });
    const m30Retests = new Map<string, M30Retest>([
      [shadowKeyFor('EUR_USD', 'H1', 'LONG'), retest({ direction: 'LONG', level: eurLevel, retestAt: isoAt(eurTouch) })],
      [shadowKeyFor('GBP_USD', 'H1', 'LONG'), retest({ direction: 'LONG', level: gbpLevel, retestAt: isoAt(gbpTouch) })],
    ]);
    const { fn } = spyFetch({ EUR_USD: eurCandles, GBP_USD: gbpCandles });
    const results = await refreshM5Executions([eurReport, gbpReport], m30Retests, fn);
    assertCase('Case16: EUR_USD reaches ENTRY_READY on its own data', results.get(shadowKeyFor('EUR_USD', 'H1', 'LONG'))?.status === 'ENTRY_READY', 'expected EUR_USD to reach ENTRY_READY');
    assertCase('Case16: GBP_USD does not inherit EUR_USD\'s trigger', results.get(shadowKeyFor('GBP_USD', 'H1', 'LONG'))?.status === 'WATCHING_M5', 'GBP_USD must not inherit EUR_USD\'s M5 CHoCH trigger');
  }

  // ---------------------------------------------------------------------
  // Case 17 -- Direction isolation: a LONG trigger cannot make a SHORT
  // setup ENTRY_READY, even for the same pair sharing one M5 fetch.
  // ---------------------------------------------------------------------
  {
    const { candles, level, touchIndex } = longTriggerCandles(); // only a bullish CHoCH exists
    const longReport = scoutReport({ pair: 'EUR_USD', timeframe: 'H1', tradeDirection: 'LONG' });
    const shortReport = scoutReport({ pair: 'EUR_USD', timeframe: 'H1', tradeDirection: 'SHORT', bias: 'BEARISH', zone: 'PREMIUM' });
    const m30Retests = new Map<string, M30Retest>([
      [shadowKeyFor('EUR_USD', 'H1', 'LONG'), retest({ direction: 'LONG', level, retestAt: isoAt(touchIndex) })],
      [shadowKeyFor('EUR_USD', 'H1', 'SHORT'), retest({ direction: 'SHORT', level, retestAt: isoAt(touchIndex) })],
    ]);
    const { fn, calls } = spyFetch({ EUR_USD: candles });
    const results = await refreshM5Executions([longReport, shortReport], m30Retests, fn);
    assertCase('Case17: one shared fetch for both directions', calls.length === 1, `expected 1 call, got ${calls.length}`);
    assertCase('Case17: LONG reaches ENTRY_READY', results.get(shadowKeyFor('EUR_USD', 'H1', 'LONG'))?.status === 'ENTRY_READY', 'expected LONG to reach ENTRY_READY');
    assertCase('Case17: SHORT does not inherit the LONG trigger', results.get(shadowKeyFor('EUR_USD', 'H1', 'SHORT'))?.status === 'WATCHING_M5', 'SHORT must not inherit the LONG thesis\'s bullish CHoCH trigger');
  }

  // ---------------------------------------------------------------------
  // Case 18 -- Existing M30 confirmation tests (Sprint 2) still pass.
  // ---------------------------------------------------------------------
  {
    let passed = true;
    let message = '';
    try {
      execSync('npm run test:m30-confirmation', { stdio: 'pipe' });
    } catch (e: any) {
      passed = false;
      message = e?.stdout?.toString?.() || e?.message || 'unknown failure';
    }
    assertCase('Case18: Sprint 2 (test:m30-confirmation) still passes', passed, `Sprint 2 suite failed: ${message}`);
  }

  // ---------------------------------------------------------------------
  // Case 19 -- Existing M30 retest tests (Sprint 3) still pass.
  // ---------------------------------------------------------------------
  {
    let passed = true;
    let message = '';
    try {
      execSync('npm run test:m30-retest', { stdio: 'pipe' });
    } catch (e: any) {
      passed = false;
      message = e?.stdout?.toString?.() || e?.message || 'unknown failure';
    }
    assertCase('Case19: Sprint 3 (test:m30-retest) still passes', passed, `Sprint 3 suite failed: ${message}`);
  }

  // ---------------------------------------------------------------------
  // Case 20 -- Shared M30 context tests (Sprint 3.5) still pass.
  // ---------------------------------------------------------------------
  {
    let passed = true;
    let message = '';
    try {
      execSync('npm run test:m30-scan-context', { stdio: 'pipe' });
    } catch (e: any) {
      passed = false;
      message = e?.stdout?.toString?.() || e?.message || 'unknown failure';
    }
    assertCase('Case20: Sprint 3.5 (test:m30-scan-context) still passes', passed, `Sprint 3.5 suite failed: ${message}`);
  }

  // ---------------------------------------------------------------------
  // Case 21 -- V2 continuity tests (Sprint 1) still pass.
  // ---------------------------------------------------------------------
  {
    let passed = true;
    let message = '';
    try {
      execSync('npm run test:card-continuity', { stdio: 'pipe' });
    } catch (e: any) {
      passed = false;
      message = e?.stdout?.toString?.() || e?.message || 'unknown failure';
    }
    assertCase('Case21: Sprint 1 (test:card-continuity) still passes', passed, `Sprint 1 suite failed: ${message}`);
  }

  // ---------------------------------------------------------------------
  // Case 22 -- Scout isolation: scoutPhaseState/isTradeableScoutSignal/
  // isWatchScoutSignal must be byte/deep-equal before and after M5 shadow
  // evaluation for the exact same report.
  // ---------------------------------------------------------------------
  {
    const report = scoutReport();
    const phaseBefore = scoutPhaseState(report);
    const tradeableBefore = isTradeableScoutSignal(report);
    const watchBefore = isWatchScoutSignal(report);
    const reportJsonBefore = JSON.stringify(report);

    const direction = scoutTradeDirection(report);
    const { candles, level, touchIndex } = longTriggerCandles();
    const m30Retests = new Map<string, M30Retest>([[shadowKeyFor(report.pair, report.timeframe, direction), retest({ direction: direction as any, level, retestAt: isoAt(touchIndex) })]]);
    const results = await refreshM5Executions([report], m30Retests, async () => candles);
    attachM5Executions([report], results);

    const phaseAfter = scoutPhaseState(report);
    const tradeableAfter = isTradeableScoutSignal(report);
    const watchAfter = isWatchScoutSignal(report);

    assertCase('Case22: report object not mutated', JSON.stringify(report) === reportJsonBefore, 'M5 shadow evaluation must not mutate the ScoutReport');
    assertCase('Case22: scoutPhaseState unchanged', JSON.stringify(phaseAfter) === JSON.stringify(phaseBefore), 'scoutPhaseState must be byte-equal before/after M5 shadow evaluation');
    assertCase('Case22: isTradeableScoutSignal unchanged', tradeableAfter === tradeableBefore, 'isTradeableScoutSignal must be unaffected by M5 shadow evaluation');
    assertCase('Case22: isWatchScoutSignal unchanged', watchAfter === watchBefore, 'isWatchScoutSignal must be unaffected by M5 shadow evaluation');
  }

  console.log('\n-- Kairos Forex v2 M5 Execution Trigger Regression Suite -------------');
  const groupedFailures = new Set(failures.map(f => f.caseName));
  const totalCases = 23; // Case 1 + Case 1b + Cases 2-22
  if (!failures.length) {
    console.log('PASS Case 1: M30 retest not reached -> WAITING_FOR_M30_RETEST');
    console.log('PASS Case 1b: zero M5 fetches while waiting for M30 retest');
    console.log('PASS Case 2: LONG retest reached, no post-retest CHoCH -> WATCHING_M5');
    console.log('PASS Case 3: LONG + bullish post-retest CHoCH -> ENTRY_READY');
    console.log('PASS Case 4: SHORT + bearish post-retest CHoCH -> ENTRY_READY');
    console.log('PASS Case 5: LONG + bearish CHoCH -> WATCHING_M5 (must not trigger)');
    console.log('PASS Case 6: SHORT + bullish CHoCH -> WATCHING_M5 (must not trigger)');
    console.log('PASS Case 7: thesis-direction BOS only -> WATCHING_M5');
    console.log('PASS Case 8: historical CHoCH before retest -> does not trigger');
    console.log('PASS Case 9: CHoCH earlier inside same M30 retest bar -> does not trigger');
    console.log('PASS Case 10: retest candle itself is the CHoCH -> does not trigger');
    console.log('PASS Case 11: retest then later CHoCH -> WATCHING_M5 -> ENTRY_READY');
    console.log('PASS Case 12: missing M5 coverage -> UNAVAILABLE');
    console.log('PASS Case 13: M5 fetch failure -> UNAVAILABLE, Scout survives');
    console.log('PASS Case 14: repeated GET makes zero network calls');
    console.log('PASS Case 15: one pair, H4+H1 activated reports -> one M5 fetch');
    console.log('PASS Case 16: pair isolation');
    console.log('PASS Case 17: direction isolation');
    console.log('PASS Case 18: Sprint 2 (M30 confirmation) suite still passes');
    console.log('PASS Case 19: Sprint 3 (M30 retest) suite still passes');
    console.log('PASS Case 20: Sprint 3.5 (shared M30 context) suite still passes');
    console.log('PASS Case 21: Sprint 1 (V2 continuity) suite still passes');
    console.log('PASS Case 22: Scout phase/tradeable/watch gates unchanged');
  } else {
    for (const failure of failures) console.log(`FAIL ${failure.caseName}: ${failure.message}`);
  }
  console.log(`\nTotal: ${totalCases} | Passed: ${totalCases - groupedFailures.size} | Failed: ${groupedFailures.size}`);

  if (failures.length) process.exit(1);
})();
