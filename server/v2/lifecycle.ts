import type { ScoutReport } from '../scanner.js';
import { biasMatchesDirection, evaluateBiasRequirement, type Direction } from './context.js';
import { evaluatePlannedEntry, evaluateEntryReached } from './execution.js';
import { evaluateLiquidity } from './liquidity.js';
import { evaluateStructure } from './structure.js';
import {
  lifecycleNextStep,
  requirement,
  type LifecycleRequirement,
  type LifecycleSnapshot,
  type LifecycleState,
  type RequirementKey,
} from './stateMachine.js';

export interface LifecycleInput {
  symbol: string;
  timeframe: string;
  direction: Direction;
  previous_state?: LifecycleState | null;
  daily_bias?: string | null;
  h4_bias?: string | null;
  liquidity_swept?: boolean;
  liquidity_reason?: string;
  structure_confirmed?: boolean;
  structure_reason?: string;
  location_valid?: boolean;
  location_reason?: string;
  planned_entry_ready?: boolean;
  planned_entry?: number | null;
  entry_reached?: boolean;
  position_running?: boolean;
  tp1_reached?: boolean;
  tp2_reached?: boolean;
  tp3_reached?: boolean;
  stopped?: boolean;
  invalidated?: boolean;
  completed?: boolean;
  completion_reason?: string;
}

function locationRequirement(input: LifecycleInput) {
  if (input.location_valid) {
    return requirement('location', 'Location', 'Location', 'COMPLETE', input.location_reason || 'Location aligns with the setup direction.');
  }
  return requirement('location', 'Location', 'Location', 'INCOMPLETE', input.location_reason || 'Location is not aligned with the setup direction.');
}

function buildRequirements(input: LifecycleInput): Record<RequirementKey, LifecycleRequirement> {
  const daily = evaluateBiasRequirement(input.direction, input.daily_bias, 'Daily Bias');
  const h4 = evaluateBiasRequirement(input.direction, input.h4_bias, 'H4 Bias');
  const liquidity = evaluateLiquidity({
    swept: Boolean(input.liquidity_swept),
    reason: input.liquidity_reason,
  });
  const structure = evaluateStructure({
    confirmed: Boolean(input.structure_confirmed),
    reason: input.structure_reason,
  });
  const execution = {
    plannedEntryReady: Boolean(input.planned_entry_ready),
    entryReached: Boolean(input.entry_reached),
    plannedEntry: input.planned_entry,
  };

  return {
    daily_bias: requirement('daily_bias', 'Daily Bias', 'Context', daily.status, daily.reason),
    h4_bias: requirement('h4_bias', 'H4 Bias', 'Context', h4.status, h4.reason),
    liquidity: requirement('liquidity', 'Liquidity Sweep', 'Liquidity', liquidity.status, liquidity.reason),
    structure: requirement('structure', 'Structure Confirmation', 'Structure', structure.status, structure.reason),
    location: locationRequirement(input),
    planned_entry: requirement(
      'planned_entry',
      'Planned Entry',
      'Execution',
      evaluatePlannedEntry(execution).status,
      evaluatePlannedEntry(execution).reason
    ),
    entry_reached: requirement(
      'entry_reached',
      'Entry Reached',
      'Execution',
      evaluateEntryReached(execution).status,
      evaluateEntryReached(execution).reason
    ),
  };
}

function complete(requirements: Record<RequirementKey, LifecycleRequirement>, key: RequirementKey) {
  return requirements[key].status === 'COMPLETE';
}

function firstMissingReason(requirements: Record<RequirementKey, LifecycleRequirement>) {
  return Object.values(requirements).find(r => r.status === 'INCOMPLETE')?.reason || 'All tracked requirements are complete.';
}

function stateReason(state: LifecycleState, input: LifecycleInput, requirements: Record<RequirementKey, LifecycleRequirement>) {
  if (state === 'COMPLETED') return input.completion_reason || 'Lifecycle is completed.';
  if (state === 'INVALIDATED') return input.completion_reason || 'Setup invalidation was detected before entry.';
  if (state === 'STOPPED') return input.completion_reason || 'Stop was reached after entry.';
  if (state === 'TP3_REACHED') return 'TP3 has been reached.';
  if (state === 'TP2_REACHED') return 'TP2 has been reached.';
  if (state === 'TP1_REACHED') return 'TP1 has been reached.';
  if (state === 'POSITION_RUNNING') return 'Position is marked running.';
  if (state === 'ENTRY_REACHED') return requirements.entry_reached.reason;
  if (state === 'SETUP_CONFIRMED_WAITING_FOR_ENTRY') return 'Setup is confirmed and waiting for planned entry.';
  if (state === 'STRUCTURE_CONFIRMED') return requirements.structure.reason;
  if (state === 'LIQUIDITY_SWEPT') return requirements.liquidity.reason;
  if (state === 'ALMOST_READY') return firstMissingReason(requirements);
  return firstMissingReason(requirements);
}

function deriveState(input: LifecycleInput, requirements: Record<RequirementKey, LifecycleRequirement>): LifecycleState {
  if (input.completed) return 'COMPLETED';
  if (input.invalidated) return 'INVALIDATED';
  if (input.stopped) return 'STOPPED';
  if (input.tp3_reached) return 'TP3_REACHED';
  if (input.tp2_reached) return 'TP2_REACHED';
  if (input.tp1_reached) return 'TP1_REACHED';
  if (input.position_running) return 'POSITION_RUNNING';

  const contextReady = complete(requirements, 'daily_bias') && complete(requirements, 'h4_bias') && complete(requirements, 'location');
  const liquidityReady = contextReady && complete(requirements, 'liquidity');
  const structureReady = liquidityReady && complete(requirements, 'structure');
  const planReady = structureReady && complete(requirements, 'planned_entry');
  if (planReady && complete(requirements, 'entry_reached')) return 'ENTRY_REACHED';
  if (planReady) return 'SETUP_CONFIRMED_WAITING_FOR_ENTRY';
  if (structureReady) return 'STRUCTURE_CONFIRMED';
  if (liquidityReady) return 'LIQUIDITY_SWEPT';
  if (contextReady) {
    return 'ALMOST_READY';
  }
  return 'BUILDING';
}

export function evaluateLifecycle(input: LifecycleInput): LifecycleSnapshot {
  const requirements = buildRequirements(input);
  const currentState = deriveState(input, requirements);
  const completed = Object.values(requirements)
    .filter(r => r.status === 'COMPLETE')
    .map(r => r.label);
  const missing = Object.values(requirements)
    .filter(r => r.status === 'INCOMPLETE')
    .map(r => r.label);

  return {
    symbol: input.symbol,
    timeframe: input.timeframe,
    direction: input.direction,
    current_state: currentState,
    previous_state: input.previous_state ?? null,
    reason: stateReason(currentState, input, requirements),
    missing_requirements: missing,
    completed_requirements: completed,
    next_step: lifecycleNextStep(currentState, input.planned_entry),
    requirements,
  };
}

function scoutDirection(report: ScoutReport): Direction {
  if (report.tradeDirection === 'LONG' || report.tradeDirection === 'SHORT') return report.tradeDirection;
  if (report.bias === 'BULLISH') return 'LONG';
  if (report.bias === 'BEARISH') return 'SHORT';
  return 'NEUTRAL';
}

function scoutLocationValid(report: ScoutReport, direction: Direction) {
  return (direction === 'LONG' && report.zone === 'DISCOUNT') ||
    (direction === 'SHORT' && report.zone === 'PREMIUM');
}

function scoutLiquiditySwept(report: ScoutReport) {
  return report.zoneTouchState === 'REJECTING' ||
    report.zoneInteraction === 'DEMAND_RECLAIM' ||
    report.zoneInteraction === 'SUPPLY_RECLAIM';
}

export function lifecycleInputFromScoutReport(report: ScoutReport, previousState?: LifecycleState | null): LifecycleInput {
  const direction = scoutDirection(report);
  const hasLevels = report.entry !== null && report.sl !== null && report.tp1 !== null;
  const rrReady = report.rrRatio !== null && report.rrRatio >= 2;
  const locationValid = scoutLocationValid(report, direction);
  const dailyAligned = biasMatchesDirection(direction, report.dailyTrendDirection);
  const h4Aligned = biasMatchesDirection(direction, report.h4TrendDirection);
  const liquiditySwept = scoutLiquiditySwept(report);
  const structureConfirmed = Boolean(report.reversalConfirmed || report.decisionLevelConfirmed || report.confirmationConfirmed);
  const entryReached = report.entryStatus === 'Tradeable' &&
    (report.entryTimingState === 'Entry Triggered' || report.entryTimingState === 'Reaction Started');

  return {
    symbol: report.pair,
    timeframe: report.timeframe,
    direction,
    previous_state: previousState ?? null,
    daily_bias: report.dailyTrendDirection,
    h4_bias: report.h4TrendDirection,
    liquidity_swept: liquiditySwept,
    liquidity_reason: liquiditySwept
      ? 'Scout zone reaction/reclaim implies liquidity has been taken in shadow mode.'
      : 'Liquidity sweep missing.',
    structure_confirmed: structureConfirmed,
    structure_reason: structureConfirmed
      ? report.reversalReason || report.decisionLevelReason || 'Scout structure confirmation is present.'
      : report.reversalReason || 'Structure confirmation is missing.',
    location_valid: locationValid,
    location_reason: locationValid
      ? `${report.zone} location aligns with ${direction}.`
      : `${report.zone || 'Unknown'} location does not align with ${direction}.`,
    planned_entry_ready: hasLevels && rrReady,
    planned_entry: report.entry,
    entry_reached: entryReached,
  };
}
