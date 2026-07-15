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

function lifecycleProgress(state: string) {
  const orderedStates = [
    ['market_scan', 'Market Scan', 'BUILDING'],
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

export function buildForexV2LifecycleCard(report: ScoutReport): ForexV2LifecycleCard {
  const snapshot = evaluateLifecycle(lifecycleInputFromScoutReport(report));
  return {
    state: snapshot.current_state,
    next_step: snapshot.next_step,
    transition_reason: snapshot.reason,
    completed: snapshot.completed_requirements,
    missing: snapshot.missing_requirements,
    execution_plan: {
      current_price: formatLevel(report.price, report.pair),
      planned_entry: formatLevel(report.entry, report.pair),
      stop: formatLevel(report.sl, report.pair),
      tp1: formatLevel(report.tp1, report.pair),
      tp2: formatLevel(report.tp2, report.pair),
      tp3: 'N/A',
    },
    lifecycle: lifecycleProgress(snapshot.current_state),
    engine_snapshot: snapshot,
  };
}

export function attachForexV2LifecycleCards<T extends ScoutReport>(reports: T[]) {
  return reports.map(report => ({
    ...report,
    v2LifecycleCard: buildForexV2LifecycleCard(report),
  }));
}
