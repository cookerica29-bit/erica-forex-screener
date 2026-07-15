import type { Candle } from './structure.js';

export type TradeDirection = 'LONG' | 'SHORT';

export interface TradeLevels {
  direction: TradeDirection;
  entry: number;
  stop: number;
  tp1: number;
  tp2?: number | null;
  tp3?: number | null;
}

export interface OutcomeEvent {
  type: 'ENTRY' | 'TP1' | 'TP2' | 'TP3' | 'STOP';
  index: number;
  time: string;
  price: number;
}

export interface OutcomeSummary {
  entryTouched: boolean;
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  stopHit: boolean;
  entryIndex: number | null;
  tp1Index: number | null;
  tp2Index: number | null;
  tp3Index: number | null;
  stopIndex: number | null;
  completionIndex: number | null;
  completionReason: 'TP3' | 'TP2' | 'TP1' | 'STOP' | 'MISSED' | 'RUNNING';
  mfe: number;
  mae: number;
  mfeR: number;
  maeR: number;
  realizedR: number;
  timeToEntry: number | null;
  timeToTp1: number | null;
  timeToCompletion: number | null;
  events: OutcomeEvent[];
}

function touchesLong(candle: Candle, level: number) {
  return candle.l <= level && candle.h >= level;
}

function touchesShort(candle: Candle, level: number) {
  return candle.h >= level && candle.l <= level;
}

function touches(direction: TradeDirection, candle: Candle, level: number) {
  return direction === 'LONG' ? touchesLong(candle, level) : touchesShort(candle, level);
}

function favorable(direction: TradeDirection, candle: Candle, entry: number) {
  return direction === 'LONG' ? candle.h - entry : entry - candle.l;
}

function adverse(direction: TradeDirection, candle: Candle, entry: number) {
  return direction === 'LONG' ? entry - candle.l : candle.h - entry;
}

function risk(levels: TradeLevels) {
  return Math.max(Math.abs(levels.entry - levels.stop), 0.0000001);
}

function barsBetween(start: number | null, end: number | null) {
  if (start === null || end === null) return null;
  return Math.max(0, end - start);
}

export function calculateOutcome(candles: Candle[], levels: TradeLevels): OutcomeSummary {
  const events: OutcomeEvent[] = [];
  let entryIndex: number | null = null;
  let tp1Index: number | null = null;
  let tp2Index: number | null = null;
  let tp3Index: number | null = null;
  let stopIndex: number | null = null;
  let maxFavorable = 0;
  let maxAdverse = 0;
  const r = risk(levels);

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (entryIndex === null) {
      if (touches(levels.direction, candle, levels.entry)) {
        entryIndex = i;
        events.push({ type: 'ENTRY', index: i, time: candle.t, price: levels.entry });
      } else {
        continue;
      }
    }

    maxFavorable = Math.max(maxFavorable, favorable(levels.direction, candle, levels.entry));
    maxAdverse = Math.max(maxAdverse, adverse(levels.direction, candle, levels.entry));

    if (stopIndex === null && touches(levels.direction, candle, levels.stop)) {
      stopIndex = i;
      events.push({ type: 'STOP', index: i, time: candle.t, price: levels.stop });
      break;
    }
    if (tp1Index === null && touches(levels.direction, candle, levels.tp1)) {
      tp1Index = i;
      events.push({ type: 'TP1', index: i, time: candle.t, price: levels.tp1 });
    }
    if (levels.tp2 != null && tp2Index === null && touches(levels.direction, candle, levels.tp2)) {
      tp2Index = i;
      events.push({ type: 'TP2', index: i, time: candle.t, price: levels.tp2 });
    }
    if (levels.tp3 != null && tp3Index === null && touches(levels.direction, candle, levels.tp3)) {
      tp3Index = i;
      events.push({ type: 'TP3', index: i, time: candle.t, price: levels.tp3 });
      break;
    }
  }

  const completionIndex = tp3Index ?? stopIndex ?? tp2Index ?? tp1Index;
  const completionReason = tp3Index !== null
    ? 'TP3'
    : stopIndex !== null
    ? 'STOP'
    : tp2Index !== null
    ? 'TP2'
    : tp1Index !== null
    ? 'TP1'
    : entryIndex === null
    ? 'MISSED'
    : 'RUNNING';
  const realizedR = completionReason === 'STOP'
    ? -1
    : completionReason === 'TP3' && levels.tp3 != null
    ? Math.abs(levels.tp3 - levels.entry) / r
    : completionReason === 'TP2' && levels.tp2 != null
    ? Math.abs(levels.tp2 - levels.entry) / r
    : completionReason === 'TP1'
    ? Math.abs(levels.tp1 - levels.entry) / r
    : 0;

  return {
    entryTouched: entryIndex !== null,
    tp1Hit: tp1Index !== null,
    tp2Hit: tp2Index !== null,
    tp3Hit: tp3Index !== null,
    stopHit: stopIndex !== null,
    entryIndex,
    tp1Index,
    tp2Index,
    tp3Index,
    stopIndex,
    completionIndex,
    completionReason,
    mfe: Math.round(maxFavorable * 1e5) / 1e5,
    mae: Math.round(maxAdverse * 1e5) / 1e5,
    mfeR: Math.round((maxFavorable / r) * 100) / 100,
    maeR: Math.round((maxAdverse / r) * 100) / 100,
    realizedR: Math.round(realizedR * 100) / 100,
    timeToEntry: barsBetween(0, entryIndex),
    timeToTp1: barsBetween(entryIndex, tp1Index),
    timeToCompletion: barsBetween(entryIndex, completionIndex),
    events,
  };
}
