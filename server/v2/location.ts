import type { Candle } from './structure.js';

export interface DealingRange {
  high: number;
  low: number;
  equilibrium: number;
  source: string;
}

export interface LocationRead {
  zone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
  range: DealingRange;
  reason: string;
}

function round(value: number) {
  return Math.round(value * 1e5) / 1e5;
}

export function activeDealingRange(candles: Candle[], source = 'active range'): DealingRange {
  if (!candles.length) return { high: 0, low: 0, equilibrium: 0, source };
  const high = Math.max(...candles.map(c => c.h));
  const low = Math.min(...candles.map(c => c.l));
  return {
    high: round(high),
    low: round(low),
    equilibrium: round((high + low) / 2),
    source,
  };
}

export function evaluateLocation(price: number, range: DealingRange, equilibriumTolerance = 0.05): LocationRead {
  const span = Math.max(range.high - range.low, 0);
  const upperEq = range.equilibrium + span * equilibriumTolerance;
  const lowerEq = range.equilibrium - span * equilibriumTolerance;
  if (price > upperEq) {
    return {
      zone: 'PREMIUM',
      range,
      reason: `Price ${round(price)} is in premium above equilibrium ${range.equilibrium}.`,
    };
  }
  if (price < lowerEq) {
    return {
      zone: 'DISCOUNT',
      range,
      reason: `Price ${round(price)} is in discount below equilibrium ${range.equilibrium}.`,
    };
  }
  return {
    zone: 'EQUILIBRIUM',
    range,
    reason: `Price ${round(price)} is near equilibrium ${range.equilibrium}.`,
  };
}
