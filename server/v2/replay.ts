import { evaluateLifecycle, type LifecycleInput } from './lifecycle.js';
import { calculateOutcome, type OutcomeSummary, type TradeLevels } from './outcomes.js';
import { type EngineName, type LifecycleSnapshot, type LifecycleState, type LifecycleTransition } from './stateMachine.js';
import type { Candle } from './structure.js';

export interface ReplayCase {
  id: string;
  symbol: string;
  timeframe: string;
  candles: Candle[];
  levels: TradeLevels;
  v1Result?: {
    state: LifecycleState;
    levels: TradeLevels;
  };
  inputForCandle: (args: {
    index: number;
    candle: Candle;
    history: Candle[];
    previousState: LifecycleState | null;
    levels: TradeLevels;
  }) => LifecycleInput;
}

export interface ReplayTransition extends LifecycleTransition {
  index: number;
  time: string;
  missing: string[];
  completed: string[];
}

export interface ReplayResult {
  id: string;
  symbol: string;
  timeframe: string;
  snapshots: LifecycleSnapshot[];
  transitions: ReplayTransition[];
  outcome: OutcomeSummary;
  v1Outcome: OutcomeSummary | null;
  completed: boolean;
  disagreementEngine: EngineName | null;
  disagreementReason: string | null;
}

function firstMissingEngine(snapshot: LifecycleSnapshot): EngineName | null {
  const missing = Object.values(snapshot.requirements).find(req => req.status === 'INCOMPLETE');
  return missing?.engine ?? null;
}

export function replayLifecycle(testCase: ReplayCase): ReplayResult {
  const snapshots: LifecycleSnapshot[] = [];
  const transitions: ReplayTransition[] = [];
  let previousState: LifecycleState | null = null;

  for (let i = 0; i < testCase.candles.length; i++) {
    const candle = testCase.candles[i];
    const history = testCase.candles.slice(0, i + 1);
    const input = testCase.inputForCandle({
      index: i,
      candle,
      history,
      previousState,
      levels: testCase.levels,
    });
    const snapshot = evaluateLifecycle({
      ...input,
      symbol: input.symbol || testCase.symbol,
      timeframe: input.timeframe || testCase.timeframe,
      previous_state: previousState,
    });
    snapshots.push(snapshot);
    if (snapshot.current_state !== previousState) {
      transitions.push({
        key: testCase.id,
        symbol: testCase.symbol,
        timeframe: testCase.timeframe,
        from: previousState,
        to: snapshot.current_state,
        reason: snapshot.reason,
        sequence: transitions.length + 1,
        index: i,
        time: candle.t,
        missing: snapshot.missing_requirements,
        completed: snapshot.completed_requirements,
      });
      previousState = snapshot.current_state;
    }
  }

  const outcome = calculateOutcome(testCase.candles, testCase.levels);
  const v1Outcome = testCase.v1Result ? calculateOutcome(testCase.candles, testCase.v1Result.levels) : null;
  const finalSnapshot = snapshots.at(-1) ?? null;
  const v1State = testCase.v1Result?.state ?? null;
  const disagreementReason = finalSnapshot && v1State && finalSnapshot.current_state !== v1State
    ? `${v1State} vs ${finalSnapshot.current_state}`
    : null;

  return {
    id: testCase.id,
    symbol: testCase.symbol,
    timeframe: testCase.timeframe,
    snapshots,
    transitions,
    outcome,
    v1Outcome,
    completed: ['TP3', 'TP2', 'TP1', 'STOP', 'MISSED'].includes(outcome.completionReason),
    disagreementEngine: finalSnapshot && disagreementReason ? firstMissingEngine(finalSnapshot) : null,
    disagreementReason,
  };
}

export function timelineOutput(result: ReplayResult) {
  return result.transitions.map(t => ({
    index: t.index,
    time: t.time,
    from: t.from,
    to: t.to,
    reason: t.reason,
    missing: t.missing,
    completed: t.completed,
  }));
}
