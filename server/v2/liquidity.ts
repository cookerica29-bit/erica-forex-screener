import type { RequirementStatus } from './stateMachine.js';

export interface LiquidityEvidence {
  swept: boolean;
  level?: 'buy_side' | 'sell_side' | 'swing' | 'unknown';
  reason?: string;
}

export function evaluateLiquidity(evidence: LiquidityEvidence) {
  if (evidence.swept) {
    return {
      status: 'COMPLETE' as RequirementStatus,
      reason: evidence.reason || 'Relevant liquidity has been swept.',
    };
  }
  return {
    status: 'INCOMPLETE' as RequirementStatus,
    reason: evidence.reason || 'Liquidity sweep is missing.',
  };
}
