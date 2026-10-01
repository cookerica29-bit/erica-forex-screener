import type { RequirementStatus } from './stateMachine.js';
import type { TimeframeStructure } from './structure.js';

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
      unmet_kind: 'PENDING' as const,
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
      unmet_kind: 'PENDING' as const,
    };
  }
  return {
    status: 'INCOMPLETE' as RequirementStatus,
    reason: `${label} conflicts with the setup direction.`,
    unmet_kind: 'CONFLICT' as const,
  };
}

export interface HierarchicalContextInput {
  daily: TimeframeStructure;
  h4: TimeframeStructure;
  m30: TimeframeStructure;
}

export interface HierarchicalContext {
  direction: Direction;
  dailyBias: 'Bullish' | 'Bearish' | 'Neutral';
  h4Bias: 'Bullish' | 'Bearish' | 'Neutral';
  m30Bias: 'Bullish' | 'Bearish' | 'Neutral';
  reason: string;
}

function biasToDirection(bias: 'Bullish' | 'Bearish' | 'Neutral'): Direction {
  if (bias === 'Bullish') return 'LONG';
  if (bias === 'Bearish') return 'SHORT';
  return 'NEUTRAL';
}

export function evaluateHierarchicalContext(input: HierarchicalContextInput): HierarchicalContext {
  const dailyBias = input.daily.bias;
  const h4Bias = input.h4.bias;
  const m30Bias = input.m30.bias;
  if (dailyBias !== 'Neutral' && h4Bias === dailyBias) {
    return {
      direction: biasToDirection(dailyBias),
      dailyBias,
      h4Bias,
      m30Bias,
      reason: `Daily and H4 market structure are ${dailyBias.toLowerCase()}.`,
    };
  }
  if (dailyBias !== 'Neutral' && h4Bias !== 'Neutral') {
    return {
      direction: biasToDirection(dailyBias),
      dailyBias,
      h4Bias,
      m30Bias,
      reason: `Daily is ${dailyBias.toLowerCase()} while H4 is ${h4Bias.toLowerCase()}, treating H4 as pullback/transition in shadow mode.`,
    };
  }
  return {
    direction: 'NEUTRAL',
    dailyBias,
    h4Bias,
    m30Bias,
    reason: 'Daily/H4 market structure is mixed or neutral.',
  };
}
