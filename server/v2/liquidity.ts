import type { RequirementStatus } from './stateMachine.js';
import type { Candle, SwingPoint } from './structure.js';

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

export interface LiquidityPool {
  type: 'BUY_SIDE' | 'SELL_SIDE';
  level: number;
  source: 'SWING' | 'EQUAL_HIGHS' | 'EQUAL_LOWS';
  indexes: number[];
}

export interface LiquiditySweep {
  type: 'BUY_SIDE_SWEEP' | 'SELL_SIDE_SWEEP';
  level: number;
  candleIndex: number;
  rejected: boolean;
  reason: string;
}

function round(value: number) {
  return Math.round(value * 1e5) / 1e5;
}

export function detectEqualHighsLows(swings: SwingPoint[], tolerance: number): LiquidityPool[] {
  const pools: LiquidityPool[] = [];
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');
  for (let i = 1; i < highs.length; i++) {
    const a = highs[i - 1];
    const b = highs[i];
    if (Math.abs(a.price - b.price) <= tolerance) {
      pools.push({ type: 'BUY_SIDE', level: round((a.price + b.price) / 2), source: 'EQUAL_HIGHS', indexes: [a.index, b.index] });
    }
  }
  for (let i = 1; i < lows.length; i++) {
    const a = lows[i - 1];
    const b = lows[i];
    if (Math.abs(a.price - b.price) <= tolerance) {
      pools.push({ type: 'SELL_SIDE', level: round((a.price + b.price) / 2), source: 'EQUAL_LOWS', indexes: [a.index, b.index] });
    }
  }
  return pools;
}

export function buildLiquidityPools(swings: SwingPoint[], tolerance: number): LiquidityPool[] {
  const swingPools = swings.map(s => ({
    type: s.type === 'high' ? 'BUY_SIDE' as const : 'SELL_SIDE' as const,
    level: round(s.price),
    source: 'SWING' as const,
    indexes: [s.index],
  }));
  return [...swingPools, ...detectEqualHighsLows(swings, tolerance)];
}

export function detectLiquiditySweeps(candles: Candle[], pools: LiquidityPool[]): LiquiditySweep[] {
  const sweeps: LiquiditySweep[] = [];
  for (const pool of pools) {
    const start = Math.max(...pool.indexes) + 1;
    for (let i = start; i < candles.length; i++) {
      const candle = candles[i];
      if (pool.type === 'BUY_SIDE' && candle.h > pool.level && candle.c < pool.level) {
        sweeps.push({
          type: 'BUY_SIDE_SWEEP',
          level: pool.level,
          candleIndex: i,
          rejected: true,
          reason: `Buy-side liquidity at ${pool.level} was swept and price closed back below it.`,
        });
        break;
      }
      if (pool.type === 'SELL_SIDE' && candle.l < pool.level && candle.c > pool.level) {
        sweeps.push({
          type: 'SELL_SIDE_SWEEP',
          level: pool.level,
          candleIndex: i,
          rejected: true,
          reason: `Sell-side liquidity at ${pool.level} was swept and price closed back above it.`,
        });
        break;
      }
    }
  }
  return sweeps;
}
