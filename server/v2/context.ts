import type { RequirementStatus } from './stateMachine.js';

export type Direction = 'LONG' | 'SHORT' | 'NEUTRAL';
export type BiasLabel = 'Bullish' | 'Bearish' | 'Neutral' | 'Mixed' | string | undefined | null;

export function directionToBias(direction: Direction) {
  if (direction === 'LONG') return 'Bullish';
  if (direction === 'SHORT') return 'Bearish';
  return 'Neutral';
}

export function biasMatchesDirection(direction: Direction, bias: BiasLabel) {
  const expected = directionToBias(direction);
  return expected !== 'Neutral' && bias === expected;
}

export function evaluateBiasRequirement(direction: Direction, bias: BiasLabel, label: string) {
  if (direction === 'NEUTRAL') {
    return {
      status: 'INCOMPLETE' as RequirementStatus,
      reason: `${label} cannot align because setup direction is neutral.`,
    };
  }
  if (biasMatchesDirection(direction, bias)) {
    return {
      status: 'COMPLETE' as RequirementStatus,
      reason: `${label} aligns ${directionToBias(direction).toLowerCase()} with the setup direction.`,
    };
  }
  if (bias === 'Neutral' || bias === 'Mixed' || !bias) {
    return {
      status: 'INCOMPLETE' as RequirementStatus,
      reason: `${label} is mixed or neutral.`,
    };
  }
  return {
    status: 'INCOMPLETE' as RequirementStatus,
    reason: `${label} conflicts with the setup direction.`,
  };
}
