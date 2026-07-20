import type { ScoutReport } from '../scanner.js';
import { evaluateLifecycle, lifecycleInputFromScoutReport } from './lifecycle.js';
import type { LifecycleSnapshot } from './stateMachine.js';

export interface ForexV2ExecutionPlan {
  current_price: string;
  planned_entry: string;
  stop: string;
  tp1: string;
  tp2: string;
  tp3: string;
}

export interface ForexV2LifecycleCard {
  state: string;
  next_step: string;
  transition_reason: string;
  completed: string[];
  missing: string[];
  blocking_conflicts: string[];
  not_yet_met: string[];
  stage_note: string | null;
  execution_plan: ForexV2ExecutionPlan;
  lifecycle: Array<{
    key: string;
    label: string;
    status: 'complete' | 'active' | 'pending';
  }>;
  engine_snapshot: LifecycleSnapshot;
}

function formatLevel(value: number | null | undefined, pair: string) {
  if (value == null || !Number.isFinite(Number(value))) return 'N/A';
  const dp = pair.includes('JPY') || pair.includes('XAU') || pair.includes('XAG') ? 3 : 5;
  return Number(value).toFixed(dp);
}

function lifecycleStepStatus(state: string, stepState: string, completedStates: string[]) {
  if (state === stepState) return 'active' as const;
  if (completedStates.includes(stepState)) return 'complete' as const;
  return 'pending' as const;
}

function lifecycleProgress(snapshot: LifecycleSnapshot) {
  const state = snapshot.current_state;
  const contextBlocked = state === 'BUILDING' && snapshot.blocking_conflicts.length > 0;
  const orderedStates = [
    ['market_scan', contextBlocked ? 'Market Scan — Context Blocked' : 'Market Scan — Building', 'BUILDING'],
    ['context_found', 'Context Found', 'ALMOST_READY'],
    ['liquidity_taken', 'Liquidity Taken', 'LIQUIDITY_SWEPT'],
    ['structure_confirmed', 'Structure Confirmed', 'STRUCTURE_CONFIRMED'],
    ['entry_planned', 'Entry Planned', 'SETUP_CONFIRMED_WAITING_FOR_ENTRY'],
    ['entry_reached', 'Entry Reached', 'ENTRY_REACHED'],
    ['trade_active', 'Trade Active', 'POSITION_RUNNING'],
    ['management', 'Management', 'TP1_REACHED'],
    ['completed', 'Completed', 'COMPLETED'],
  ] as const;
  const currentIndex = Math.max(0, orderedStates.findIndex(([, , s]) => s === state));
  const completedStates = orderedStates.slice(0, currentIndex).map(([, , s]) => s);
  return orderedStates.map(([key, label, stepState]) => ({
    key,
    label,
    status: lifecycleStepStatus(state, stepState, completedStates),
  }));
}

const CONTEXT_REQUIREMENTS = new Set(['Daily Bias', 'H4 Bias', 'Location']);

function stageNote(snapshot: LifecycleSnapshot) {
  const laterEvidencePresent =
    snapshot.current_state === 'BUILDING' &&
    snapshot.completed_requirements.some(label => !CONTEXT_REQUIREMENTS.has(label));
  if (!laterEvidencePresent) return null;
  const blockers = snapshot.blocking_conflicts.length
    ? snapshot.blocking_conflicts.join(' and ')
    : snapshot.not_yet_met[0] || 'earlier requirements';
  const suffix = snapshot.blocking_conflicts.length > 1
    ? 'are resolved'
    : snapshot.blocking_conflicts.length === 1
    ? 'is resolved'
    : 'is met';
  return `Some later-stage requirements are already met, but the setup cannot advance until ${blockers} ${suffix}.`;
}

export function buildForexV2LifecycleCard(report: ScoutReport): ForexV2LifecycleCard {
  const snapshot = evaluateLifecycle(lifecycleInputFromScoutReport(report));
  return {
    state: snapshot.current_state,
    next_step: snapshot.next_step,
    transition_reason: snapshot.reason,
    completed: snapshot.completed_requirements,
    missing: snapshot.missing_requirements,
    blocking_conflicts: snapshot.blocking_conflicts,
    not_yet_met: snapshot.not_yet_met,
    stage_note: stageNote(snapshot),
    execution_plan: {
      current_price: formatLevel(report.price, report.pair),
      planned_entry: formatLevel(report.entry, report.pair),
      stop: formatLevel(report.sl, report.pair),
      tp1: formatLevel(report.tp1, report.pair),
      tp2: formatLevel(report.tp2, report.pair),
      tp3: 'N/A',
    },
    lifecycle: lifecycleProgress(snapshot),
    engine_snapshot: snapshot,
  };
}

export function attachForexV2LifecycleCards<T extends ScoutReport>(reports: T[]) {
  return reports.map(report => ({
    ...report,
    v2LifecycleCard: buildForexV2LifecycleCard(report),
  }));
}
