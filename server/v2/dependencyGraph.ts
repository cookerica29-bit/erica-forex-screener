import type { LifecycleState } from './stateMachine.js';

export interface DependencyValidation {
  valid: boolean;
  blocker: string | null;
}

const REQUIRED_PRIORS: Partial<Record<LifecycleState, LifecycleState[]>> = {
  LIQUIDITY_SWEPT: ['ALMOST_READY'],
  STRUCTURE_CONFIRMED: ['LIQUIDITY_SWEPT'],
  SETUP_CONFIRMED_WAITING_FOR_ENTRY: ['STRUCTURE_CONFIRMED'],
  ENTRY_REACHED: ['SETUP_CONFIRMED_WAITING_FOR_ENTRY'],
  POSITION_RUNNING: ['ENTRY_REACHED'],
  TP1_REACHED: ['POSITION_RUNNING'],
  TP2_REACHED: ['TP1_REACHED'],
  TP3_REACHED: ['TP2_REACHED'],
  COMPLETED: [],
};

export function validateLifecycleDependencies(target: LifecycleState, completedStates: Set<LifecycleState>): DependencyValidation {
  const required = REQUIRED_PRIORS[target] || [];
  const missing = required.find(state => !completedStates.has(state));
  if (missing) {
    return {
      valid: false,
      blocker: `${target} requires ${missing} first.`,
    };
  }
  return { valid: true, blocker: null };
}

export function completedStateSet(states: LifecycleState[]) {
  return new Set(states);
}
