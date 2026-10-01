import { aggregateDecisionStats, completedSetupComparisons, developerDecisionReport } from '../decisionReports.js';
import { calculateOutcome } from '../outcomes.js';
import { replayLifecycle, timelineOutput, type ReplayCase } from '../replay.js';
import type { LifecycleState } from '../stateMachine.js';
import type { Candle } from '../structure.js';

interface Failure {
  caseName: string;
  message: string;
}

const failures: Failure[] = [];

function assertCase(caseName: string, condition: boolean, message: string) {
  if (!condition) failures.push({ caseName, message });
}

function c(i: number, o: number, h: number, l: number, close: number): Candle {
  return { t: `2026-07-14T${String(i).padStart(2, '0')}:00:00.000Z`, o, h, l, c: close };
}

function scriptedCase(id: string, states: LifecycleState[], candles: Candle[], overrides: Partial<ReplayCase> = {}): ReplayCase {
  const levels = overrides.levels || {
    direction: 'LONG' as const,
    entry: 100,
    stop: 95,
    tp1: 110,
    tp2: 115,
    tp3: 120,
  };
  return {
    id,
    symbol: 'EUR_USD',
    timeframe: 'M30',
    candles,
    levels,
    v1Result: overrides.v1Result,
    inputForCandle: ({ index, previousState }) => {
      const state = states[Math.min(index, states.length - 1)];
      const contextReady = ['ALMOST_READY', 'LIQUIDITY_SWEPT', 'STRUCTURE_CONFIRMED', 'SETUP_CONFIRMED_WAITING_FOR_ENTRY', 'ENTRY_REACHED', 'TP1_REACHED', 'TP2_REACHED', 'TP3_REACHED', 'COMPLETED'].includes(state);
      const liquidityReady = ['LIQUIDITY_SWEPT', 'STRUCTURE_CONFIRMED', 'SETUP_CONFIRMED_WAITING_FOR_ENTRY', 'ENTRY_REACHED', 'TP1_REACHED', 'TP2_REACHED', 'TP3_REACHED', 'COMPLETED'].includes(state);
      const structureReady = ['STRUCTURE_CONFIRMED', 'SETUP_CONFIRMED_WAITING_FOR_ENTRY', 'ENTRY_REACHED', 'TP1_REACHED', 'TP2_REACHED', 'TP3_REACHED', 'COMPLETED'].includes(state);
      const planReady = ['SETUP_CONFIRMED_WAITING_FOR_ENTRY', 'ENTRY_REACHED', 'TP1_REACHED', 'TP2_REACHED', 'TP3_REACHED', 'COMPLETED'].includes(state);
      return {
        symbol: 'EUR_USD',
        timeframe: 'M30',
        direction: levels.direction,
        previous_state: previousState,
        daily_bias: contextReady ? 'Bullish' : 'Neutral',
        h4_bias: contextReady ? 'Bullish' : 'Neutral',
        location_valid: contextReady,
        liquidity_swept: liquidityReady,
        liquidity_reason: liquidityReady ? 'Sell-side liquidity swept.' : 'Liquidity sweep missing.',
        structure_confirmed: structureReady,
        structure_reason: structureReady ? 'Bullish CHoCH confirmed.' : 'Structure confirmation missing.',
        planned_entry_ready: planReady,
        planned_entry: levels.entry,
        entry_reached: ['ENTRY_REACHED', 'TP1_REACHED', 'TP2_REACHED', 'TP3_REACHED', 'COMPLETED'].includes(state),
        tp1_reached: state === 'TP1_REACHED',
        tp2_reached: state === 'TP2_REACHED',
        tp3_reached: state === 'TP3_REACHED',
        completed: state === 'COMPLETED',
      };
    },
    ...overrides,
  };
}

const winningCandles = [
  c(0, 104, 106, 103, 105),
  c(1, 105, 107, 101, 103),
  c(2, 103, 105, 99, 101),
  c(3, 101, 106, 100, 104),
  c(4, 104, 111, 103, 110),
  c(5, 110, 116, 108, 114),
  c(6, 114, 121, 113, 120),
];

const stoppedCandles = [
  c(0, 104, 106, 102, 105),
  c(1, 105, 106, 100, 101),
  c(2, 101, 104, 99, 102),
  c(3, 102, 103, 100, 101),
  c(4, 101, 104, 98, 99),
  c(5, 99, 100, 94, 95),
];

const missedCandles = [
  c(0, 104, 106, 103, 105),
  c(1, 105, 108, 104, 107),
  c(2, 107, 111, 106, 110),
];

const replay = replayLifecycle(scriptedCase(
  'winner',
  ['BUILDING', 'ALMOST_READY', 'LIQUIDITY_SWEPT', 'STRUCTURE_CONFIRMED', 'SETUP_CONFIRMED_WAITING_FOR_ENTRY', 'ENTRY_REACHED', 'COMPLETED'],
  winningCandles,
  {
    v1Result: {
      state: 'ENTRY_REACHED',
      levels: { direction: 'LONG', entry: 103, stop: 98, tp1: 108, tp2: 113, tp3: 118 },
    },
  }
));

const timeline = timelineOutput(replay);
assertCase('Replay records lifecycle transitions', timeline.length === 7, `expected 7 transitions, got ${timeline.length}`);
assertCase('Replay timeline includes liquidity before structure', timeline[2].to === 'LIQUIDITY_SWEPT' && timeline[3].to === 'STRUCTURE_CONFIRMED', 'expected liquidity transition before structure');
assertCase('Replay outcome TP3 completion', replay.outcome.tp1Hit && replay.outcome.tp2Hit && replay.outcome.tp3Hit && replay.outcome.completionReason === 'TP3', `unexpected outcome ${JSON.stringify(replay.outcome)}`);
assertCase('Replay time to entry', replay.outcome.timeToEntry === 2, `expected timeToEntry 2, got ${replay.outcome.timeToEntry}`);
assertCase('Replay time to TP1', replay.outcome.timeToTp1 === 2, `expected timeToTp1 2, got ${replay.outcome.timeToTp1}`);
assertCase('Replay MFE/MAE R', replay.outcome.mfeR === 4.2 && replay.outcome.maeR === 0.2, `expected MFE 4.2R and MAE 0.2R, got ${replay.outcome.mfeR}/${replay.outcome.maeR}`);

const stopped = replayLifecycle(scriptedCase(
  'stopped',
  ['ALMOST_READY', 'LIQUIDITY_SWEPT', 'STRUCTURE_CONFIRMED', 'SETUP_CONFIRMED_WAITING_FOR_ENTRY', 'ENTRY_REACHED', 'COMPLETED'],
  stoppedCandles
));
assertCase('Outcome stop hit', stopped.outcome.stopHit && stopped.outcome.completionReason === 'STOP' && stopped.outcome.realizedR === -1, `unexpected stopped outcome ${JSON.stringify(stopped.outcome)}`);

const missed = replayLifecycle(scriptedCase(
  'missed',
  ['ALMOST_READY', 'LIQUIDITY_SWEPT', 'STRUCTURE_CONFIRMED'],
  missedCandles
));
assertCase('Outcome missed setup', missed.outcome.completionReason === 'MISSED' && !missed.outcome.entryTouched, `unexpected missed outcome ${JSON.stringify(missed.outcome)}`);

const directOutcome = calculateOutcome(winningCandles, { direction: 'LONG', entry: 100, stop: 95, tp1: 110, tp2: 115, tp3: 120 });
assertCase('Direct outcome events are ordered', directOutcome.events.map(e => e.type).join(',') === 'ENTRY,TP1,TP2,TP3', `unexpected event order ${JSON.stringify(directOutcome.events)}`);

const results = [replay, stopped, missed];
const comparisons = completedSetupComparisons(results);
const aggregate = aggregateDecisionStats(results);
const report = developerDecisionReport(results);

assertCase('Completed setup comparisons include all completed outcomes', comparisons.length === 3, `expected 3 comparisons, got ${comparisons.length}`);
assertCase('Aggregate V2 TP1 success rate', aggregate.v2Tp1SuccessRate === 33.33, `expected 33.33, got ${aggregate.v2Tp1SuccessRate}`);
assertCase('Aggregate invalidated setup rate is zero', aggregate.invalidatedSetupRate === 0, `expected 0, got ${aggregate.invalidatedSetupRate}`);
assertCase('Aggregate missed setup rate', aggregate.missedSetupRate === 33.33, `expected 33.33, got ${aggregate.missedSetupRate}`);
assertCase('Developer report is deterministic', report.generatedAt === '1970-01-01T00:00:00.000Z' && report.timelines.length === 3, 'expected deterministic developer report');

console.log('\n-- Kairos Forex v2 Decision Validation Regression Suite ------------');
const groupedFailures = new Set(failures.map(f => f.caseName));
if (!failures.length) {
  console.log(`PASS replay transitions: ${timeline.map(t => t.to).join(' -> ')}`);
  console.log(`PASS winner outcome: ${replay.outcome.completionReason}, MFE=${replay.outcome.mfeR}R, MAE=${replay.outcome.maeR}R`);
  console.log(`PASS aggregate: V2 TP1=${aggregate.v2Tp1SuccessRate}%, missed=${aggregate.missedSetupRate}%`);
} else {
  for (const failure of failures) console.log(`FAIL ${failure.caseName}: ${failure.message}`);
}
console.log(`\nTotal: 14 | Passed: ${14 - groupedFailures.size} | Failed: ${groupedFailures.size}`);

if (failures.length) process.exit(1);
