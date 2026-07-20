export const LIFECYCLE_STATES = [
  'BUILDING',
  'ALMOST_READY',
  'LIQUIDITY_SWEPT',
  'STRUCTURE_CONFIRMED',
  'SETUP_CONFIRMED_WAITING_FOR_ENTRY',
  'ENTRY_REACHED',
  'POSITION_RUNNING',
  'TP1_REACHED',
  'TP2_REACHED',
  'TP3_REACHED',
  'STOPPED',
  'INVALIDATED',
  'COMPLETED',
] as const;

export type LifecycleState = typeof LIFECYCLE_STATES[number];

export type RequirementStatus = 'COMPLETE' | 'INCOMPLETE' | 'NOT_APPLICABLE';
export type RequirementUnmetKind = 'CONFLICT' | 'PENDING';
export type EngineName = 'Context' | 'Liquidity' | 'Structure' | 'Location' | 'Execution';

export const REQUIREMENT_KEYS = [
  'daily_bias',
  'h4_bias',
  'liquidity',
  'structure',
  'location',
  'planned_entry',
  'entry_reached',
] as const;

export type RequirementKey = typeof REQUIREMENT_KEYS[number];

export interface LifecycleRequirement {
  key: RequirementKey;
  label: string;
  engine: EngineName;
  status: RequirementStatus;
  reason: string;
  unmet_kind?: RequirementUnmetKind;
}

export interface LifecycleSnapshot {
  symbol: string;
  timeframe: string;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  current_state: LifecycleState;
  previous_state: LifecycleState | null;
  reason: string;
  missing_requirements: string[];
  blocking_conflicts: string[];
  not_yet_met: string[];
  completed_requirements: string[];
  next_step: string;
  requirements: Record<RequirementKey, LifecycleRequirement>;
}

export interface LifecycleTransition {
  key: string;
  symbol: string;
  timeframe: string;
  from: LifecycleState | null;
  to: LifecycleState;
  reason: string;
  sequence: number;
}

export const STATE_ORDER: Record<LifecycleState, number> = {
  BUILDING: 0,
  ALMOST_READY: 1,
  LIQUIDITY_SWEPT: 2,
  STRUCTURE_CONFIRMED: 3,
  SETUP_CONFIRMED_WAITING_FOR_ENTRY: 4,
  ENTRY_REACHED: 5,
  POSITION_RUNNING: 6,
  TP1_REACHED: 7,
  TP2_REACHED: 8,
  TP3_REACHED: 9,
  STOPPED: 10,
  INVALIDATED: 10,
  COMPLETED: 11,
};

const ALLOWED_NEXT: Record<LifecycleState, LifecycleState[]> = {
  BUILDING: ['ALMOST_READY', 'INVALIDATED'],
  ALMOST_READY: ['LIQUIDITY_SWEPT', 'STRUCTURE_CONFIRMED', 'SETUP_CONFIRMED_WAITING_FOR_ENTRY', 'INVALIDATED'],
  LIQUIDITY_SWEPT: ['STRUCTURE_CONFIRMED', 'INVALIDATED'],
  STRUCTURE_CONFIRMED: ['SETUP_CONFIRMED_WAITING_FOR_ENTRY', 'ENTRY_REACHED', 'INVALIDATED'],
  SETUP_CONFIRMED_WAITING_FOR_ENTRY: ['ENTRY_REACHED', 'INVALIDATED'],
  ENTRY_REACHED: ['POSITION_RUNNING', 'INVALIDATED', 'COMPLETED'],
  POSITION_RUNNING: ['TP1_REACHED', 'TP2_REACHED', 'TP3_REACHED', 'STOPPED', 'COMPLETED'],
  TP1_REACHED: ['TP2_REACHED', 'STOPPED', 'COMPLETED'],
  TP2_REACHED: ['TP3_REACHED', 'STOPPED', 'COMPLETED'],
  TP3_REACHED: ['COMPLETED'],
  STOPPED: ['COMPLETED'],
  INVALIDATED: ['COMPLETED'],
  COMPLETED: [],
};

export function isValidLifecycleTransition(from: LifecycleState | null, to: LifecycleState) {
  if (from === null) return true;
  if (from === to) return true;
  return ALLOWED_NEXT[from].includes(to);
}

export function lifecycleNextStep(state: LifecycleState, plannedEntry?: number | null) {
  if (state === 'BUILDING') return 'Continue monitoring. The setup is still developing.';
  if (state === 'ALMOST_READY') return 'The setup is close, but confirmation is incomplete.';
  if (state === 'LIQUIDITY_SWEPT') return 'Liquidity has been taken. Wait for structure confirmation.';
  if (state === 'STRUCTURE_CONFIRMED') {
    return plannedEntry == null
      ? 'Setup confirmed. Define the planned entry before execution.'
      : `Setup confirmed. Wait for price to reach the planned entry at ${plannedEntry}.`;
  }
  if (state === 'SETUP_CONFIRMED_WAITING_FOR_ENTRY') {
    return plannedEntry == null
      ? 'Setup confirmed. Wait for price to reach the planned entry.'
      : `Setup confirmed. Wait for price to reach the planned entry at ${plannedEntry}.`;
  }
  if (state === 'ENTRY_REACHED') return 'Price has reached the planned entry. Execute only if your risk rules allow.';
  if (state === 'POSITION_RUNNING') return 'Trade is active. Follow the management plan.';
  if (state === 'TP1_REACHED') return 'TP1 reached. Consider taking partial profits and managing the remainder according to plan.';
  if (state === 'TP2_REACHED') return 'TP2 reached. Continue following the management plan.';
  if (state === 'TP3_REACHED') return 'TP3 reached. Complete the trade review.';
  if (state === 'STOPPED') return 'Stop reached. Complete the review and record what failed.';
  if (state === 'INVALIDATED') return 'No entry. The original setup is no longer valid.';
  return 'Review complete. Use the outcome data to improve the process.';
}

export function requirement(
  key: RequirementKey,
  label: string,
  engine: EngineName,
  status: RequirementStatus,
  reason: string,
  unmetKind?: RequirementUnmetKind
): LifecycleRequirement {
  return { key, label, engine, status, reason, unmet_kind: status === 'INCOMPLETE' ? unmetKind : undefined };
}
