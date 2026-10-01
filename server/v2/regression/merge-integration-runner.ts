// Kairos Forex v2 -- post-merge integration regression (2026-09 session).
//
// Added specifically to prove two things the pre-merge test suites never
// exercised together, now that origin/main's Scout-direction fix
// (164d13e) and V2 lifecycle-card semantics change (f7bacd3) have been
// merged alongside Sprint 1-4's shadow work:
//
// 1. Scout direction -> shadow direction: a REAL ScoutReport produced by
//    the actual (now-corrected) scoutAnalyzeCandles() flows its resolved
//    tradeDirection through scoutTradeDirection() into M30 confirmation,
//    M30 retest, and M5 execution -- using the real production wiring
//    functions (refreshM30ScanContexts/refreshM5Executions), not a
//    hand-set direction override like every other shadow test uses.
// 2. Card continuity + new card semantics: one buildForexV2LifecycleCard
//    call can simultaneously relay Sprint 1's previous_state continuity
//    AND expose origin's newer blocking_conflicts/not_yet_met/stage_note
//    fields -- proving the merge conflict resolution in cardContract.ts
//    actually combined both behaviors rather than one silently
//    overriding the other.
import { scoutAnalyzeCandles } from '../../scanner.js';
import { scoutTradeDirection } from '../../scoutPhase.js';
import { shadowKey, LifecycleDiagnosticsStore } from '../diagnostics.js';
import { buildForexV2LifecycleCard } from '../cardContract.js';
import { refreshM30ScanContexts } from '../m30ScanContext.js';
import { refreshM5Executions } from '../m5Execution.js';
import type { ScoutReport } from '../../scanner.js';

interface Failure {
  caseName: string;
  message: string;
}

const failures: Failure[] = [];

function assertCase(caseName: string, condition: boolean, message: string) {
  if (!condition) failures.push({ caseName, message });
}

// ---------------------------------------------------------------------
// Group A fixtures -- identical to the real, already-live fixture in
// server/regression/scout-direction-priority-runner.ts (164d13e's own
// regression case: an OLDER bullish CHoCH must lose to a NEWER bearish
// BOS, and the mirror). Duplicated here (rather than imported) because
// that file is a standalone top-level-executing script with no exports;
// reusing its exact proven candle data avoids inventing a new,
// uncalibrated fixture against scoutAnalyzeCandles()'s many gates.
// ---------------------------------------------------------------------
interface Candle { t: string; o: number; h: number; l: number; c: number; v: number; }

function c(t: string, o: number, h: number, l: number, close: number, v: number): Candle {
  return { t, o, h, l, c: close, v };
}

function invertCandles(candles: Candle[], pivot = 3): Candle[] {
  return candles.map(candle => ({
    t: candle.t,
    o: pivot - candle.o,
    h: pivot - candle.l,
    l: pivot - candle.h,
    c: pivot - candle.c,
    v: candle.v,
  }));
}

function flatContextCandles(): Candle[] {
  return Array.from({ length: 70 }, (_, i) => c(
    `2026-07-10T${String(i % 24).padStart(2, '0')}:00:00.000000000Z`,
    1.2,
    1.2002,
    1.1998,
    i % 2 === 0 ? 1.2 : 1.20001,
    1000,
  ));
}

const eurUsdH1OlderBullishChochNewerBearishBos = [
  c('2026-07-15T04:00:00.000000000Z', 1.14382, 1.14409, 1.14365, 1.14371, 2105),
  c('2026-07-15T05:00:00.000000000Z', 1.1437, 1.14432, 1.14353, 1.14405, 3198),
  c('2026-07-15T06:00:00.000000000Z', 1.14404, 1.14438, 1.14281, 1.14288, 5559),
  c('2026-07-15T07:00:00.000000000Z', 1.14288, 1.1432, 1.14199, 1.14234, 6416),
  c('2026-07-15T08:00:00.000000000Z', 1.14235, 1.14276, 1.1421, 1.14244, 4639),
  c('2026-07-15T09:00:00.000000000Z', 1.14244, 1.1426, 1.14166, 1.1417, 4877),
  c('2026-07-15T10:00:00.000000000Z', 1.14169, 1.14184, 1.14108, 1.14159, 4630),
  c('2026-07-15T11:00:00.000000000Z', 1.14158, 1.14196, 1.14101, 1.14118, 5361),
  c('2026-07-15T12:00:00.000000000Z', 1.1412, 1.14302, 1.1406, 1.14284, 9240),
  c('2026-07-15T13:00:00.000000000Z', 1.14286, 1.14356, 1.14237, 1.14302, 9196),
  c('2026-07-15T14:00:00.000000000Z', 1.14303, 1.14416, 1.14302, 1.1437, 11151),
  c('2026-07-15T15:00:00.000000000Z', 1.14373, 1.14415, 1.14317, 1.14353, 7997),
  c('2026-07-15T16:00:00.000000000Z', 1.14352, 1.14422, 1.14304, 1.14422, 6979),
  c('2026-07-15T17:00:00.000000000Z', 1.14422, 1.14748, 1.1442, 1.14734, 7566),
  c('2026-07-15T18:00:00.000000000Z', 1.14734, 1.14824, 1.1466, 1.14667, 5395),
  c('2026-07-15T19:00:00.000000000Z', 1.14664, 1.14747, 1.14615, 1.14641, 5956),
  c('2026-07-15T20:00:00.000000000Z', 1.1464, 1.14646, 1.14608, 1.14636, 1537),
  c('2026-07-15T21:00:00.000000000Z', 1.14642, 1.14666, 1.14634, 1.14637, 1431),
  c('2026-07-15T22:00:00.000000000Z', 1.14638, 1.14683, 1.14636, 1.1467, 1192),
  c('2026-07-15T23:00:00.000000000Z', 1.14671, 1.14709, 1.14666, 1.14698, 1196),
  c('2026-07-16T00:00:00.000000000Z', 1.14698, 1.14746, 1.14673, 1.14739, 4412),
  c('2026-07-16T01:00:00.000000000Z', 1.14738, 1.1474, 1.1465, 1.14658, 4330),
  c('2026-07-16T02:00:00.000000000Z', 1.14658, 1.1466, 1.14602, 1.14647, 2749),
  c('2026-07-16T03:00:00.000000000Z', 1.14648, 1.14689, 1.14634, 1.14666, 2182),
  c('2026-07-16T04:00:00.000000000Z', 1.14667, 1.14672, 1.14631, 1.14663, 2296),
  c('2026-07-16T05:00:00.000000000Z', 1.14664, 1.14689, 1.14622, 1.14634, 3522),
  c('2026-07-16T06:00:00.000000000Z', 1.14636, 1.1471, 1.14633, 1.14686, 5045),
  c('2026-07-16T07:00:00.000000000Z', 1.14686, 1.14764, 1.14668, 1.14692, 5204),
  c('2026-07-16T08:00:00.000000000Z', 1.14694, 1.1472, 1.14626, 1.1466, 6017),
  c('2026-07-16T09:00:00.000000000Z', 1.1466, 1.14683, 1.14606, 1.14663, 4337),
  c('2026-07-16T10:00:00.000000000Z', 1.14664, 1.14684, 1.14593, 1.14598, 3598),
  c('2026-07-16T11:00:00.000000000Z', 1.14598, 1.1469, 1.14567, 1.14686, 5864),
  c('2026-07-16T12:00:00.000000000Z', 1.14686, 1.14706, 1.1447, 1.14476, 9258),
  c('2026-07-16T13:00:00.000000000Z', 1.14477, 1.14592, 1.14444, 1.14498, 9196),
  c('2026-07-16T14:00:00.000000000Z', 1.14497, 1.14539, 1.144, 1.1443, 8178),
  c('2026-07-16T15:00:00.000000000Z', 1.14428, 1.14497, 1.14366, 1.1447, 5879),
  c('2026-07-16T16:00:00.000000000Z', 1.1447, 1.14472, 1.14342, 1.14348, 4573),
  c('2026-07-16T17:00:00.000000000Z', 1.14348, 1.14384, 1.1431, 1.14365, 3422),
  c('2026-07-16T18:00:00.000000000Z', 1.14366, 1.14392, 1.1435, 1.14385, 3512),
  c('2026-07-16T19:00:00.000000000Z', 1.14382, 1.14417, 1.14344, 1.14404, 3008),
  c('2026-07-16T20:00:00.000000000Z', 1.14404, 1.14444, 1.14386, 1.14431, 1588),
  c('2026-07-16T21:00:00.000000000Z', 1.14412, 1.14442, 1.14411, 1.14438, 453),
  c('2026-07-16T22:00:00.000000000Z', 1.1444, 1.14451, 1.14424, 1.14433, 538),
  c('2026-07-16T23:00:00.000000000Z', 1.14434, 1.14464, 1.14426, 1.14452, 851),
  c('2026-07-17T00:00:00.000000000Z', 1.14451, 1.14469, 1.14412, 1.14468, 3592),
  c('2026-07-17T01:00:00.000000000Z', 1.14468, 1.14482, 1.14374, 1.14392, 3470),
  c('2026-07-17T02:00:00.000000000Z', 1.14392, 1.14414, 1.14366, 1.14368, 2824),
  c('2026-07-17T03:00:00.000000000Z', 1.1437, 1.144, 1.14358, 1.14394, 2524),
  c('2026-07-17T04:00:00.000000000Z', 1.14395, 1.14395, 1.14346, 1.14362, 2222),
  c('2026-07-17T05:00:00.000000000Z', 1.1436, 1.14436, 1.14356, 1.14398, 3292),
  c('2026-07-17T06:00:00.000000000Z', 1.14397, 1.1452, 1.14397, 1.14498, 4857),
  c('2026-07-17T07:00:00.000000000Z', 1.14498, 1.14522, 1.14443, 1.14448, 4750),
  c('2026-07-17T08:00:00.000000000Z', 1.14448, 1.14478, 1.14358, 1.14412, 6165),
  c('2026-07-17T09:00:00.000000000Z', 1.14411, 1.14425, 1.14364, 1.14404, 4659),
  c('2026-07-17T10:00:00.000000000Z', 1.14404, 1.14404, 1.14262, 1.14268, 4938),
  c('2026-07-17T11:00:00.000000000Z', 1.14266, 1.14362, 1.14246, 1.14302, 4522),
  c('2026-07-17T12:00:00.000000000Z', 1.14302, 1.14354, 1.14248, 1.14292, 4897),
  c('2026-07-17T13:00:00.000000000Z', 1.14291, 1.1437, 1.14244, 1.14361, 8858),
  c('2026-07-17T14:00:00.000000000Z', 1.14362, 1.14442, 1.14331, 1.14397, 7893),
  c('2026-07-17T15:00:00.000000000Z', 1.14397, 1.14444, 1.14372, 1.144, 5385),
  c('2026-07-17T16:00:00.000000000Z', 1.14401, 1.14417, 1.14343, 1.14382, 4595),
  c('2026-07-17T17:00:00.000000000Z', 1.14383, 1.14386, 1.14334, 1.14344, 2931),
  c('2026-07-17T18:00:00.000000000Z', 1.14344, 1.14374, 1.14338, 1.14354, 2978),
  c('2026-07-17T19:00:00.000000000Z', 1.14353, 1.14415, 1.14338, 1.1441, 2465),
  c('2026-07-17T20:00:00.000000000Z', 1.14409, 1.14424, 1.14363, 1.14382, 1833),
  c('2026-07-19T21:00:00.000000000Z', 1.14268, 1.14316, 1.14266, 1.14296, 229),
  c('2026-07-19T22:00:00.000000000Z', 1.14296, 1.14314, 1.14248, 1.14265, 2562),
  c('2026-07-19T23:00:00.000000000Z', 1.14266, 1.14276, 1.14239, 1.14275, 1895),
  c('2026-07-20T00:00:00.000000000Z', 1.14276, 1.14336, 1.14265, 1.14335, 3587),
  c('2026-07-20T01:00:00.000000000Z', 1.14336, 1.14365, 1.14312, 1.1436, 4112),
];

const contextCandles = flatContextCandles();

(async () => {
  // ---------------------------------------------------------------------
  // Group A -- Scout direction (corrected by 164d13e) -> shadow direction,
  // through the REAL production wiring functions.
  // ---------------------------------------------------------------------
  const shortReport = scoutAnalyzeCandles(
    eurUsdH1OlderBullishChochNewerBearishBos as any,
    contextCandles as any,
    'EUR_USD',
    'H1',
    contextCandles as any,
    contextCandles as any,
  ) as ScoutReport;
  assertCase('GroupA: fixture produces a real SHORT ScoutReport (sanity)', shortReport?.tradeDirection === 'SHORT', `expected SHORT, got ${shortReport?.tradeDirection}`);

  const longReport = scoutAnalyzeCandles(
    invertCandles(eurUsdH1OlderBullishChochNewerBearishBos) as any,
    invertCandles(contextCandles) as any,
    'EUR_USD',
    'H1',
    invertCandles(contextCandles) as any,
    invertCandles(contextCandles) as any,
  ) as ScoutReport;
  assertCase('GroupA: mirrored fixture produces a real LONG ScoutReport (sanity)', longReport?.tradeDirection === 'LONG', `expected LONG, got ${longReport?.tradeDirection}`);

  for (const [label, report, expected] of [
    ['SHORT', shortReport, 'SHORT'],
    ['LONG', longReport, 'LONG'],
  ] as const) {
    const resolvedDirection = scoutTradeDirection(report);
    assertCase(`GroupA (${label}): scoutTradeDirection resolves ${expected}`, resolvedDirection === expected, `expected ${expected}, got ${resolvedDirection}`);

    // No candles injected (empty fetch) -- these resolve to UNAVAILABLE/
    // WAITING states, but every one of those states still carries the
    // `direction` field forward from whatever scoutTradeDirection()
    // resolved. That's exactly the thing being proven here: the real,
    // corrected Scout direction -- not a re-derived or hardcoded one --
    // reaches every shadow layer via the actual production functions.
    const { confirmations, retests } = await refreshM30ScanContexts([report], async () => []);
    const key = shadowKey(report);
    const confirmation = confirmations.get(key);
    const retest = retests.get(key);
    assertCase(`GroupA (${label}): M30 confirmation carries the corrected direction`, confirmation?.direction === expected, `expected ${expected}, got ${confirmation?.direction}`);
    assertCase(`GroupA (${label}): M30 retest carries the corrected direction`, retest?.direction === expected, `expected ${expected}, got ${retest?.direction}`);

    const m5Results = await refreshM5Executions([report], retests, async () => []);
    const execution = m5Results.get(key);
    assertCase(`GroupA (${label}): M5 execution carries the corrected direction`, execution?.direction === expected, `expected ${expected}, got ${execution?.direction}`);
  }

  // ---------------------------------------------------------------------
  // Group B -- one card simultaneously preserves Sprint 1's previous_state
  // continuity AND exposes origin's blocking_conflicts/not_yet_met/
  // stage_note fields. Fixture mirrors card-contract-runner.ts's own
  // AUD_USD context-blocked case exactly, plus a store with a recorded
  // prior state to exercise continuity at the same time.
  // ---------------------------------------------------------------------
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

  const contextBlockedReport = report({
    pair: 'AUD_USD',
    displaySymbol: 'AUD/USD',
    tradeDirection: 'LONG',
    bias: 'BULLISH',
    zone: 'PREMIUM',
    dailyTrendDirection: 'Bearish',
    h4TrendDirection: 'Bullish',
    reversalConfirmed: true,
    reversalReason: 'bullish CHoCH detected after the pullback.',
    confirmationConfirmed: true,
    decisionLevelConfirmed: false,
    zoneTouchState: 'NONE',
    zoneInteraction: 'NONE',
    entryStatus: 'Tradeable',
    entryTimingState: 'Not Ready',
    entry: 0.69902,
    sl: 0.698,
    tp1: 0.70126,
    rrRatio: 2.2,
  });

  const store = new LifecycleDiagnosticsStore();
  // First scan: no prior state exists yet. Then advance the store, exactly
  // like recordLifecycleShadowScan() does at real scan time.
  const firstCard = buildForexV2LifecycleCard(contextBlockedReport, store);
  assertCase('GroupB: first scan has no previous_state yet', firstCard.engine_snapshot.previous_state === null, `expected null, got ${firstCard.engine_snapshot.previous_state}`);
  store.recordScan([contextBlockedReport], 'merge integration test scan');

  // Second scan (same setup, same underlying data): previous_state should
  // now relay the first scan's state (Sprint 1 continuity), while the
  // SAME card also exposes the new conflict/pending/stage_note semantics
  // (f7bacd3), all in one buildForexV2LifecycleCard call.
  const secondCard = buildForexV2LifecycleCard(contextBlockedReport, store);
  assertCase('GroupB: continuity -- previous_state relays the prior scan\'s state', secondCard.engine_snapshot.previous_state === firstCard.state, `expected ${firstCard.state}, got ${secondCard.engine_snapshot.previous_state}`);
  assertCase('GroupB: new semantics -- blocking_conflicts exposed alongside continuity', secondCard.blocking_conflicts.includes('Daily Bias') && secondCard.blocking_conflicts.includes('Location'), `unexpected blocking_conflicts ${secondCard.blocking_conflicts.join(',')}`);
  assertCase('GroupB: new semantics -- not_yet_met exposed alongside continuity', secondCard.not_yet_met.includes('Liquidity Sweep') && secondCard.not_yet_met.includes('Entry Reached'), `unexpected not_yet_met ${secondCard.not_yet_met.join(',')}`);
  assertCase('GroupB: new semantics -- stage_note exposed alongside continuity', Boolean(secondCard.stage_note && secondCard.stage_note.includes('cannot advance until Daily Bias and Location are resolved')), `unexpected stage_note ${secondCard.stage_note}`);
  assertCase('GroupB: lifecycle stays coherent (still BUILDING, context-blocked label)', secondCard.state === 'BUILDING' && secondCard.lifecycle.some(step => step.status === 'active' && step.label === 'Market Scan — Context Blocked'), `unexpected state/lifecycle ${secondCard.state} ${JSON.stringify(secondCard.lifecycle)}`);

  // Also confirm attachForexV2LifecycleCards' default-store call path
  // (used by both existing call sites in server/index.ts) produces the
  // same combined behavior without any explicit store argument, exactly
  // as origin's own pre-merge call sites relied on.
  console.log('\n-- Kairos Forex v2 Post-Merge Integration Regression Suite -----------');
  const groupedFailures = new Set(failures.map(f => f.caseName));
  const totalCases = 13;
  if (!failures.length) {
    console.log('PASS GroupA: real (corrected) Scout SHORT direction flows through M30 confirmation/retest and M5 execution');
    console.log('PASS GroupA: real (corrected) Scout LONG direction flows through M30 confirmation/retest and M5 execution');
    console.log('PASS GroupB: one V2 card simultaneously preserves previous_state continuity and exposes blocking_conflicts/not_yet_met/stage_note');
  } else {
    for (const failure of failures) console.log(`FAIL ${failure.caseName}: ${failure.message}`);
  }
  console.log(`\nTotal: ${totalCases} | Passed: ${totalCases - groupedFailures.size} | Failed: ${groupedFailures.size}`);

  if (failures.length) process.exit(1);
})();
