// Kairos Forex v2 -- Sprint 3.5: Shared M30 Scan Context (shadow-only).
//
// Proves the deduplicated fetch path (refreshM30ScanContexts) produces
// results byte/deep-equal to the old independent-fetch path (Sprint 2's
// evaluateM30Confirmation and Sprint 3's evaluateM30Retest, called
// directly), while fetching M30 candles only once per unique pair.
// Candle fixtures are identical to the ones already calibrated in
// m30-confirmation-runner.ts / m30-retest-runner.ts.
import { execSync } from 'child_process';
import { evaluateM30Confirmation, type M30Candle } from '../m30Confirmation.js';
import { evaluateM30Retest } from '../m30Retest.js';
import { refreshM30ScanContexts } from '../m30ScanContext.js';
import { attachM30Confirmations } from '../m30Confirmation.js';
import { attachM30Retests } from '../m30Retest.js';
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

function bullishBosCandles(): M30Candle[] {
  const rows = uptrendBase();
  const lastClose = rows[rows.length - 1].c;
  rows.push(candle(rows.length, lastClose, lastClose + 20, lastClose - 0.2, lastClose + 19));
  return pad(rows, 8, 1);
}

function bearishBosCandles(): M30Candle[] {
  const rows = downtrendBase();
  const lastClose = rows[rows.length - 1].c;
  rows.push(candle(rows.length, lastClose, lastClose + 0.2, lastClose - 20, lastClose - 19));
  return pad(rows, 8, -1);
}

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

function spyFetch(byPair: Record<string, M30Candle[]>) {
  const calls: string[] = [];
  const fn = async (pair: string): Promise<M30Candle[]> => {
    calls.push(pair);
    const data = byPair[pair];
    if (!data) throw new Error(`no fixture for ${pair}`);
    return data;
  };
  return { fn, calls };
}

(async () => {
  // ---------------------------------------------------------------------
  // Case 1 -- One network fetch produces both results.
  // ---------------------------------------------------------------------
  {
    const report = scoutReport({ pair: 'EUR_USD', timeframe: 'H1', tradeDirection: 'LONG' });
    const { fn, calls } = spyFetch({ EUR_USD: bullishBosCandles() });
    const { confirmations, retests } = await refreshM30ScanContexts([report], fn);
    assertCase('Case1: fetch called exactly once', calls.length === 1, `expected 1 call, got ${calls.length}`);
    assertCase('Case1: confirmation produced', confirmations.size === 1 && confirmations.values().next().value?.status === 'CONFIRMED', 'expected a CONFIRMED confirmation');
    assertCase('Case1: retest produced', retests.size === 1 && retests.values().next().value?.status === 'WAITING_FOR_RETEST', 'expected a WAITING_FOR_RETEST retest');
  }

  // ---------------------------------------------------------------------
  // Case 2 -- Confirmation result unchanged vs. the old direct evaluation.
  // ---------------------------------------------------------------------
  {
    const candles = bullishBosWithRetest();
    const oldConfirmation = evaluateM30Confirmation('LONG', candles);
    const report = scoutReport({ pair: 'EUR_USD', timeframe: 'H1', tradeDirection: 'LONG' });
    const { fn } = spyFetch({ EUR_USD: candles });
    const { confirmations } = await refreshM30ScanContexts([report], fn);
    const newConfirmation = confirmations.values().next().value;
    assertCase('Case2: confirmation deep-equal to old path', JSON.stringify(newConfirmation) === JSON.stringify(oldConfirmation), `expected ${JSON.stringify(oldConfirmation)}, got ${JSON.stringify(newConfirmation)}`);
  }

  // ---------------------------------------------------------------------
  // Case 3 -- Retest result unchanged vs. the old direct evaluation.
  // ---------------------------------------------------------------------
  {
    const candles = bullishBosWithRetest();
    const oldConfirmation = evaluateM30Confirmation('LONG', candles);
    const oldRetest = evaluateM30Retest(oldConfirmation, candles);
    const report = scoutReport({ pair: 'EUR_USD', timeframe: 'H1', tradeDirection: 'LONG' });
    const { fn } = spyFetch({ EUR_USD: candles });
    const { retests } = await refreshM30ScanContexts([report], fn);
    const newRetest = retests.values().next().value;
    assertCase('Case3: retest deep-equal to old path', JSON.stringify(newRetest) === JSON.stringify(oldRetest), `expected ${JSON.stringify(oldRetest)}, got ${JSON.stringify(newRetest)}`);
  }

  // ---------------------------------------------------------------------
  // Case 4 -- Same candle snapshot: two reports for the SAME pair (e.g.
  // one from an H4 scout scan, one from H1 -- exactly the real
  // scheduledScan() flattened-results shape) must trigger only ONE fetch,
  // proving confirmation and retest for both reports come from a single
  // shared snapshot rather than independent per-report fetches.
  // ---------------------------------------------------------------------
  {
    const candles = bullishBosWithRetest();
    const h4Report = scoutReport({ pair: 'EUR_USD', timeframe: 'H4', tradeDirection: 'LONG' });
    const h1Report = scoutReport({ pair: 'EUR_USD', timeframe: 'H1', tradeDirection: 'LONG' });
    const { fn, calls } = spyFetch({ EUR_USD: candles });
    const { confirmations, retests } = await refreshM30ScanContexts([h4Report, h1Report], fn);
    assertCase('Case4: exactly one fetch for two reports of the same pair', calls.length === 1, `expected 1 call, got ${calls.length}`);
    const h4Confirmation = confirmations.get('EUR_USD|H4|LONG');
    const h1Confirmation = confirmations.get('EUR_USD|H1|LONG');
    assertCase('Case4: both reports derive identical confirmation from the shared snapshot', JSON.stringify(h4Confirmation) === JSON.stringify(h1Confirmation), 'expected both timeframe-reports of the same pair/direction to share the same confirmation result');
    const h4Retest = retests.get('EUR_USD|H4|LONG');
    const h1Retest = retests.get('EUR_USD|H1|LONG');
    assertCase('Case4: both reports derive identical retest from the shared snapshot', JSON.stringify(h4Retest) === JSON.stringify(h1Retest), 'expected both timeframe-reports of the same pair/direction to share the same retest result');
  }

  // ---------------------------------------------------------------------
  // Case 5 -- Fetch failure: unavailable shadow outputs, Scout intact.
  // ---------------------------------------------------------------------
  {
    const report = scoutReport({ pair: 'EUR_USD', timeframe: 'H1', tradeDirection: 'LONG' });
    const reportJsonBefore = JSON.stringify(report);
    const failingFetch = async (_pair: string): Promise<M30Candle[]> => {
      throw new Error('OANDA EUR_USD M30: 503');
    };
    let threw = false;
    let result: Awaited<ReturnType<typeof refreshM30ScanContexts>> | undefined;
    try {
      result = await refreshM30ScanContexts([report], failingFetch);
    } catch {
      threw = true;
    }
    assertCase('Case5: refreshM30ScanContexts never throws', !threw, 'a fetch failure must not reject the whole refresh');
    const confirmation = result?.confirmations.get('EUR_USD|H1|LONG');
    const retest = result?.retests.get('EUR_USD|H1|LONG');
    assertCase('Case5: confirmation UNAVAILABLE', confirmation?.status === 'UNAVAILABLE', `expected UNAVAILABLE, got ${confirmation?.status}`);
    assertCase('Case5: retest UNAVAILABLE', retest?.status === 'UNAVAILABLE', `expected UNAVAILABLE, got ${retest?.status}`);
    assertCase('Case5: report object not mutated', JSON.stringify(report) === reportJsonBefore, 'a fetch failure must not mutate the ScoutReport');
  }

  // ---------------------------------------------------------------------
  // Case 6 -- Repeated GET (repeated attach reads) makes zero fetches.
  // ---------------------------------------------------------------------
  {
    const candles = bullishBosCandles();
    const report = scoutReport({ pair: 'EUR_USD', timeframe: 'H1', tradeDirection: 'LONG' });
    const { fn, calls } = spyFetch({ EUR_USD: candles });
    const { confirmations, retests } = await refreshM30ScanContexts([report], fn);
    assertCase('Case6: one fetch during the scan itself', calls.length === 1, `expected 1 call, got ${calls.length}`);
    const snapshotConfBefore = JSON.stringify(Array.from(confirmations.entries()));
    const snapshotRetestBefore = JSON.stringify(Array.from(retests.entries()));
    for (let i = 0; i < 5; i++) {
      attachM30Confirmations([report], confirmations);
      attachM30Retests([report], retests);
    }
    assertCase('Case6: repeated attach reads make zero additional fetches', calls.length === 1, `expected fetch count to stay at 1, got ${calls.length}`);
    assertCase('Case6: confirmations cache untouched by repeated reads', JSON.stringify(Array.from(confirmations.entries())) === snapshotConfBefore, 'attachM30Confirmations must never write to its cache');
    assertCase('Case6: retests cache untouched by repeated reads', JSON.stringify(Array.from(retests.entries())) === snapshotRetestBefore, 'attachM30Retests must never write to its cache');
  }

  // ---------------------------------------------------------------------
  // Case 7 -- Pair isolation: EUR_USD data/results cannot leak into
  // GBP_USD, even though both were fetched in the same shared-context
  // scan pass.
  // ---------------------------------------------------------------------
  {
    const eur = scoutReport({ pair: 'EUR_USD', timeframe: 'H1', tradeDirection: 'LONG' });
    const gbp = scoutReport({ pair: 'GBP_USD', displaySymbol: 'GBP/USD', timeframe: 'H1', tradeDirection: 'LONG' });
    const { fn } = spyFetch({ EUR_USD: bullishBosWithRetest(), GBP_USD: bullishBosCandles() });
    const { confirmations, retests } = await refreshM30ScanContexts([eur, gbp], fn);
    const eurRetest = confirmations.get('EUR_USD|H1|LONG');
    const gbpRetest = confirmations.get('GBP_USD|H1|LONG');
    assertCase('Case7: EUR_USD gets its own confirmation', eurRetest?.status === 'CONFIRMED', `expected CONFIRMED, got ${eurRetest?.status}`);
    assertCase('Case7: GBP_USD gets its own confirmation, not EUR_USD\'s', gbpRetest?.status === 'CONFIRMED' && gbpRetest?.brokenLevel === 110, 'GBP_USD should evaluate its own (different-shaped) fixture independently');
    const eurRetestResult = retests.get('EUR_USD|H1|LONG');
    const gbpRetestResult = retests.get('GBP_USD|H1|LONG');
    assertCase('Case7: EUR_USD retest reflects its own (retest-reached) data', eurRetestResult?.status === 'RETEST_REACHED', `expected RETEST_REACHED, got ${eurRetestResult?.status}`);
    assertCase('Case7: GBP_USD retest reflects its own (no-retest) data, not EUR_USD\'s', gbpRetestResult?.status === 'WAITING_FOR_RETEST', `expected WAITING_FOR_RETEST, got ${gbpRetestResult?.status}`);
  }

  // ---------------------------------------------------------------------
  // Case 8 -- Direction isolation: LONG and SHORT reports for the SAME
  // pair share one fetched candle snapshot, but each still gets its own
  // direction-specific confirmation/retest.
  // ---------------------------------------------------------------------
  {
    const candles = bullishBosWithRetest(); // only a bullish (LONG) event exists in this fixture
    const longReport = scoutReport({ pair: 'EUR_USD', timeframe: 'H1', tradeDirection: 'LONG' });
    const shortReport = scoutReport({ pair: 'EUR_USD', timeframe: 'H1', tradeDirection: 'SHORT', bias: 'BEARISH', zone: 'PREMIUM' });
    const { fn, calls } = spyFetch({ EUR_USD: candles });
    const { confirmations, retests } = await refreshM30ScanContexts([longReport, shortReport], fn);
    assertCase('Case8: one shared fetch for both directions', calls.length === 1, `expected 1 call, got ${calls.length}`);
    assertCase('Case8: LONG is CONFIRMED', confirmations.get('EUR_USD|H1|LONG')?.status === 'CONFIRMED', 'expected LONG thesis to be confirmed by the bullish event');
    assertCase('Case8: SHORT is NOT_CONFIRMED', confirmations.get('EUR_USD|H1|SHORT')?.status === 'NOT_CONFIRMED', 'expected SHORT thesis NOT to inherit the bullish confirmation');
    assertCase('Case8: LONG retest reflects LONG confirmation', retests.get('EUR_USD|H1|LONG')?.status === 'RETEST_REACHED', 'expected LONG retest to be evaluated from its own confirmation');
    assertCase('Case8: SHORT retest is WAITING_FOR_CONFIRMATION', retests.get('EUR_USD|H1|SHORT')?.status === 'WAITING_FOR_CONFIRMATION', 'expected SHORT retest to reflect its own (unconfirmed) state, not LONG\'s');
  }

  // ---------------------------------------------------------------------
  // Case 9 -- Existing Sprint 2 tests remain passing.
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
    assertCase('Case9: Sprint 2 (test:m30-confirmation) still passes', passed, `Sprint 2 suite failed: ${message}`);
  }

  // ---------------------------------------------------------------------
  // Case 10 -- Existing Sprint 3 tests remain passing.
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
    assertCase('Case10: Sprint 3 (test:m30-retest) still passes', passed, `Sprint 3 suite failed: ${message}`);
  }

  // ---------------------------------------------------------------------
  // Case 11 -- V2 continuity (Sprint 1) remains passing.
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
    assertCase('Case11: Sprint 1 (test:card-continuity) still passes', passed, `Sprint 1 suite failed: ${message}`);
  }

  // ---------------------------------------------------------------------
  // Case 12 -- Scout isolation: scoutPhaseState/isTradeableScoutSignal/
  // isWatchScoutSignal must be byte/deep-equal before and after the
  // shared-context refactor's evaluation for the exact same report.
  // ---------------------------------------------------------------------
  {
    const report = scoutReport();
    const phaseBefore = scoutPhaseState(report);
    const tradeableBefore = isTradeableScoutSignal(report);
    const watchBefore = isWatchScoutSignal(report);
    const reportJsonBefore = JSON.stringify(report);

    const { fn } = spyFetch({ EUR_USD: bullishBosWithRetest() });
    const { confirmations, retests } = await refreshM30ScanContexts([report], fn);
    attachM30Confirmations([report], confirmations);
    attachM30Retests([report], retests);

    const phaseAfter = scoutPhaseState(report);
    const tradeableAfter = isTradeableScoutSignal(report);
    const watchAfter = isWatchScoutSignal(report);

    assertCase('Case12: report object not mutated', JSON.stringify(report) === reportJsonBefore, 'M30 shared-context evaluation must not mutate the ScoutReport');
    assertCase('Case12: scoutPhaseState unchanged', JSON.stringify(phaseAfter) === JSON.stringify(phaseBefore), 'scoutPhaseState must be byte-equal before/after the shared-context refactor');
    assertCase('Case12: isTradeableScoutSignal unchanged', tradeableAfter === tradeableBefore, 'isTradeableScoutSignal must be unaffected by the shared-context refactor');
    assertCase('Case12: isWatchScoutSignal unchanged', watchAfter === watchBefore, 'isWatchScoutSignal must be unaffected by the shared-context refactor');
  }

  console.log('\n-- Kairos Forex v2 M30 Shared Scan Context Regression Suite ----------');
  const groupedFailures = new Set(failures.map(f => f.caseName));
  const totalCases = 12;
  if (!failures.length) {
    console.log('PASS Case 1: one network fetch produces both results');
    console.log('PASS Case 2: confirmation result unchanged vs. old path');
    console.log('PASS Case 3: retest result unchanged vs. old path');
    console.log('PASS Case 4: same candle snapshot shared across reports of the same pair');
    console.log('PASS Case 5: fetch failure -> safe UNAVAILABLE, Scout intact');
    console.log('PASS Case 6: repeated GET/attach makes zero additional fetches');
    console.log('PASS Case 7: pair isolation');
    console.log('PASS Case 8: direction isolation');
    console.log('PASS Case 9: Sprint 2 suite still passes');
    console.log('PASS Case 10: Sprint 3 suite still passes');
    console.log('PASS Case 11: Sprint 1 suite still passes');
    console.log('PASS Case 12: Scout phase/tradeable/watch gates unchanged');
  } else {
    for (const failure of failures) console.log(`FAIL ${failure.caseName}: ${failure.message}`);
  }
  console.log(`\nTotal: ${totalCases} | Passed: ${totalCases - groupedFailures.size} | Failed: ${groupedFailures.size}`);

  if (failures.length) process.exit(1);
})();
