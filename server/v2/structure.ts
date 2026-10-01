import type { RequirementStatus } from './stateMachine.js';

export interface Candle {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

export interface SwingPoint {
  index: number;
  price: number;
  type: 'high' | 'low';
}

export interface StructureEvent {
  type: 'BOS' | 'CHoCH';
  direction: 'Bullish' | 'Bearish';
  level: number;
  swingIndex: number;
  breakIndex: number;
  timeframe: string;
}

export interface TimeframeStructure {
  timeframe: string;
  bias: 'Bullish' | 'Bearish' | 'Neutral';
  swings: SwingPoint[];
  events: StructureEvent[];
  protectedHigh: number | null;
  protectedLow: number | null;
  reason: string;
}

export interface StructureEvidence {
  confirmed: boolean;
  reason?: string;
}

export function evaluateStructure(evidence: StructureEvidence) {
  if (evidence.confirmed) {
    return {
      status: 'COMPLETE' as RequirementStatus,
      reason: evidence.reason || 'Structure confirmation is present.',
    };
  }
  return {
    status: 'INCOMPLETE' as RequirementStatus,
    reason: evidence.reason || 'Structure confirmation is missing.',
    unmet_kind: 'PENDING' as const,
  };
}

function round(value: number) {
  return Math.round(value * 1e5) / 1e5;
}

export function findInstitutionalSwings(candles: Candle[], depth = 2): SwingPoint[] {
  const swings: SwingPoint[] = [];
  for (let i = depth; i < candles.length - depth; i++) {
    const left = candles.slice(i - depth, i);
    const right = candles.slice(i + 1, i + 1 + depth);
    const candle = candles[i];
    if (left.every(c => candle.h > c.h) && right.every(c => candle.h >= c.h)) {
      swings.push({ index: i, price: round(candle.h), type: 'high' });
    }
    if (left.every(c => candle.l < c.l) && right.every(c => candle.l <= c.l)) {
      swings.push({ index: i, price: round(candle.l), type: 'low' });
    }
  }
  return swings.sort((a, b) => a.index - b.index);
}

function initialBias(swings: SwingPoint[]): 'Bullish' | 'Bearish' | 'Neutral' {
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');
  if (highs.length < 2 || lows.length < 2) return 'Neutral';
  const higherHigh = highs.at(-1)!.price > highs.at(-2)!.price;
  const higherLow = lows.at(-1)!.price > lows.at(-2)!.price;
  const lowerHigh = highs.at(-1)!.price < highs.at(-2)!.price;
  const lowerLow = lows.at(-1)!.price < lows.at(-2)!.price;
  if (higherHigh && higherLow) return 'Bullish';
  if (lowerHigh && lowerLow) return 'Bearish';
  return 'Neutral';
}

export function detectStructureEvents(candles: Candle[], timeframe: string, depth = 2): StructureEvent[] {
  const swings = findInstitutionalSwings(candles, depth);
  let bias = initialBias(swings);
  const events: StructureEvent[] = [];
  const broken = new Set<string>();

  for (const swing of swings) {
    for (let i = swing.index + 1; i < candles.length; i++) {
      const breaksHigh = swing.type === 'high' && candles[i].c > swing.price;
      const breaksLow = swing.type === 'low' && candles[i].c < swing.price;
      if (!breaksHigh && !breaksLow) continue;
      const direction = breaksHigh ? 'Bullish' : 'Bearish';
      const key = `${swing.index}:${direction}`;
      if (broken.has(key)) break;
      const type = bias !== 'Neutral' && bias !== direction ? 'CHoCH' : 'BOS';
      events.push({
        type,
        direction,
        level: swing.price,
        swingIndex: swing.index,
        breakIndex: i,
        timeframe,
      });
      broken.add(key);
      bias = direction;
      break;
    }
  }
  return events.sort((a, b) => a.breakIndex - b.breakIndex || a.swingIndex - b.swingIndex);
}

export function analyzeTimeframeStructure(candles: Candle[], timeframe: string, depth = 2): TimeframeStructure {
  const swings = findInstitutionalSwings(candles, depth);
  const events = detectStructureEvents(candles, timeframe, depth);
  const lastEvent = events.at(-1);
  const bias = lastEvent?.direction || initialBias(swings);
  const lastHigh = swings.filter(s => s.type === 'high').at(-1)?.price ?? null;
  const lastLow = swings.filter(s => s.type === 'low').at(-1)?.price ?? null;
  return {
    timeframe,
    bias,
    swings,
    events,
    protectedHigh: bias === 'Bearish' ? lastHigh : null,
    protectedLow: bias === 'Bullish' ? lastLow : null,
    reason: lastEvent
      ? `${timeframe} ${lastEvent.direction} ${lastEvent.type} closed through ${lastEvent.level}.`
      : `${timeframe} structure is ${bias.toLowerCase()}.`,
  };
}

export interface HierarchicalStructureInput {
  daily: Candle[];
  h4: Candle[];
  m30: Candle[];
}

export function analyzeHierarchicalStructure(input: HierarchicalStructureInput) {
  const daily = analyzeTimeframeStructure(input.daily, 'Daily', 1);
  const h4 = analyzeTimeframeStructure(input.h4, 'H4', 1);
  const m30 = analyzeTimeframeStructure(input.m30, 'M30', 1);
  return {
    daily,
    h4,
    m30,
    aligned: daily.bias !== 'Neutral' && daily.bias === h4.bias,
    executionAligned: h4.bias !== 'Neutral' && h4.bias === m30.bias,
  };
}
