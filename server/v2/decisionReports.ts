import type { EngineName } from './stateMachine.js';
import type { ReplayResult } from './replay.js';

export interface DecisionAggregateStats {
  completedSetups: number;
  v1Tp1SuccessRate: number | null;
  v2Tp1SuccessRate: number | null;
  averageDrawdownR: number | null;
  averageRMultiple: number | null;
  averageTradeDurationBars: number | null;
  invalidatedSetupRate: number;
  missedSetupRate: number;
  disagreements: number;
  topDisagreementEngine: EngineName | null;
}

export interface CompletedSetupComparison {
  id: string;
  symbol: string;
  timeframe: string;
  v1Tp1Hit: boolean | null;
  v2Tp1Hit: boolean;
  v1Completion: string | null;
  v2Completion: string;
  v2RealizedR: number;
  v2MfeR: number;
  v2MaeR: number;
  timeToEntry: number | null;
  timeToTp1: number | null;
  timeToCompletion: number | null;
  disagreementReason: string | null;
  disagreementEngine: EngineName | null;
}

function rate(values: boolean[]) {
  if (!values.length) return null;
  return Math.round((values.filter(Boolean).length / values.length) * 10000) / 100;
}

function average(values: number[]) {
  const clean = values.filter(v => Number.isFinite(v));
  if (!clean.length) return null;
  return Math.round((clean.reduce((sum, v) => sum + v, 0) / clean.length) * 100) / 100;
}

function topEngine(values: Array<EngineName | null>) {
  const counts = new Map<EngineName, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

export function completedSetupComparisons(results: ReplayResult[]): CompletedSetupComparison[] {
  return results
    .filter(result => result.completed)
    .map(result => ({
      id: result.id,
      symbol: result.symbol,
      timeframe: result.timeframe,
      v1Tp1Hit: result.v1Outcome ? result.v1Outcome.tp1Hit : null,
      v2Tp1Hit: result.outcome.tp1Hit,
      v1Completion: result.v1Outcome?.completionReason ?? null,
      v2Completion: result.outcome.completionReason,
      v2RealizedR: result.outcome.realizedR,
      v2MfeR: result.outcome.mfeR,
      v2MaeR: result.outcome.maeR,
      timeToEntry: result.outcome.timeToEntry,
      timeToTp1: result.outcome.timeToTp1,
      timeToCompletion: result.outcome.timeToCompletion,
      disagreementReason: result.disagreementReason,
      disagreementEngine: result.disagreementEngine,
    }));
}

export function aggregateDecisionStats(results: ReplayResult[]): DecisionAggregateStats {
  const completed = completedSetupComparisons(results);
  const invalidated = results.filter(result => result.snapshots.some(snapshot => snapshot.current_state === 'INVALIDATED')).length;
  const missed = results.filter(result => result.outcome.completionReason === 'MISSED').length;
  const v1Tp1Values = completed
    .map(row => row.v1Tp1Hit)
    .filter((value): value is boolean => typeof value === 'boolean');

  return {
    completedSetups: completed.length,
    v1Tp1SuccessRate: rate(v1Tp1Values),
    v2Tp1SuccessRate: rate(completed.map(row => row.v2Tp1Hit)),
    averageDrawdownR: average(completed.map(row => row.v2MaeR)),
    averageRMultiple: average(completed.map(row => row.v2RealizedR)),
    averageTradeDurationBars: average(completed.map(row => row.timeToCompletion ?? 0)),
    invalidatedSetupRate: results.length ? Math.round((invalidated / results.length) * 10000) / 100 : 0,
    missedSetupRate: results.length ? Math.round((missed / results.length) * 10000) / 100 : 0,
    disagreements: completed.filter(row => row.disagreementReason).length,
    topDisagreementEngine: topEngine(completed.map(row => row.disagreementEngine)),
  };
}

export function developerDecisionReport(results: ReplayResult[]) {
  return {
    generatedAt: new Date(0).toISOString(),
    comparisons: completedSetupComparisons(results),
    aggregate: aggregateDecisionStats(results),
    timelines: results.map(result => ({
      id: result.id,
      symbol: result.symbol,
      timeframe: result.timeframe,
      transitions: result.transitions,
      outcome: result.outcome,
    })),
  };
}
