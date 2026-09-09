// Kairos Forex v2 -- Sprint 2: M30 CHoCH/BOS Confirmation (shadow-only).
//
// Answers exactly one question, observationally: "Has M30 structurally
// confirmed the existing Scout thesis?" -- via CHoCH/BOS in the thesis
// direction, reusing the already-proven `computeStructures` primitive
// (scanner.ts) rather than a second structure algorithm. This module has
// no write path back into Scout/V1: it only ever reads a ScoutReport's
// own fields (never mutates them) and an independently-fetched M30
// candle series. See server/index.ts for how the async fetch is kept
// isolated from the production Scout scan.
import { computeStructures, fetchCandles, type TrainerStructures } from '../scanner.js';
import { scoutTradeDirection } from '../scoutPhase.js';
import { shadowKey } from './diagnostics.js';
import type { ScoutReport } from '../scanner.js';
import type { Direction } from './context.js';

// A plain OHLCV candle, structurally identical to scanner.ts's own
// (unexported) Candle type -- named locally rather than exporting a new
// type from scanner.ts, since every other v2/* module already avoids
// touching scanner.ts's own type surface.
export type M30Candle = Awaited<ReturnType<typeof fetchCandles>>[number];

export type M30ConfirmationStatus = 'CONFIRMED' | 'NOT_CONFIRMED' | 'UNAVAILABLE';
export type M30EventType = 'CHOCH' | 'BOS' | null;

export interface M30Confirmation {
  status: M30ConfirmationStatus;
  direction: Direction;
  eventType: M30EventType;
  eventDirection: 'bullish' | 'bearish' | null;
  confirmedAt: string | null; // ISO timestamp of the confirming M30 candle's close, if any
  ageBars: number | null;     // M30 candles between the confirming event and the latest evaluated candle
  reason: string;
}

// Window/margin match the ALREADY-existing M30 computeStructures call in
// scanner.ts's analyzeIndependentCandidate (the one other place in this
// codebase that already runs structure analysis on M30) -- reused rather
// than invented, per this sprint's own "avoid arbitrary strategy
// invention" instruction. Recency is bounded by this same window: the
// "most recent qualifying event within the last 140 M30 candles" is the
// whole recency rule -- no additional arbitrary cutoff is layered on top.
// `ageBars` is still surfaced on every CONFIRMED result so a human can
// calibrate a tighter cutoff later without this module hiding one now.
const M30_STRUCTURE_WINDOW = 140;
const M30_STRUCTURE_MARGIN = 4;
// Matches analyzeIndependentCandidate's own minimum-data guard for M30.
const MIN_M30_CANDLES = 80;
const M30_FETCH_COUNT = 250;

function directionToEventDirection(direction: Direction): 'bullish' | 'bearish' | null {
  if (direction === 'LONG') return 'bullish';
  if (direction === 'SHORT') return 'bearish';
  return null;
}

function candleEpochSeconds(candle: M30Candle): number {
  return Math.floor(new Date(candle.t).getTime() / 1000);
}

function unavailable(direction: Direction, reason: string): M30Confirmation {
  return { status: 'UNAVAILABLE', direction, eventType: null, eventDirection: null, confirmedAt: null, ageBars: null, reason };
}

function notConfirmed(direction: Direction, reason: string): M30Confirmation {
  return { status: 'NOT_CONFIRMED', direction, eventType: null, eventDirection: null, confirmedAt: null, ageBars: null, reason };
}

// Pure, synchronous, network-free -- the entire confirmation rule lives
// here so it can be tested against hand-built candle series exactly like
// the rest of this codebase's structure/lifecycle logic.
export function evaluateM30Confirmation(direction: Direction, m30Candles: M30Candle[] | null | undefined): M30Confirmation {
  if (direction === 'NEUTRAL') {
    return notConfirmed(direction, 'Scout thesis has no directional bias to confirm against M30 structure.');
  }
  if (!m30Candles || m30Candles.length < MIN_M30_CANDLES) {
    return unavailable(direction, `M30 candles unavailable or insufficient (need >= ${MIN_M30_CANDLES}, have ${m30Candles?.length ?? 0}).`);
  }

  const window = m30Candles.slice(-M30_STRUCTURE_WINDOW);
  let structures: TrainerStructures;
  try {
    structures = computeStructures(window, M30_STRUCTURE_MARGIN);
  } catch (e: any) {
    return unavailable(direction, `M30 structure analysis failed: ${e?.message || 'unknown error'}.`);
  }

  const wanted = directionToEventDirection(direction);
  const matchingBos = structures.bosEvents.filter(event => event.type === wanted);
  const matchingChoch = structures.chochEvents.filter(event => event.type === wanted);
  const latestBos = matchingBos.at(-1) ?? null;
  const latestChoch = matchingChoch.at(-1) ?? null;

  const candidates: Array<{ event: TrainerStructures['bosEvents'][number]; eventType: 'BOS' | 'CHOCH' }> = [];
  if (latestBos) candidates.push({ event: latestBos, eventType: 'BOS' });
  if (latestChoch) candidates.push({ event: latestChoch, eventType: 'CHOCH' });

  if (!candidates.length) {
    return notConfirmed(direction, `No ${wanted} CHoCH/BOS found in the last ${window.length} M30 candles.`);
  }

  // CHoCH and BOS are mutually exclusive per broken swing (computeStructures
  // never places the same break in both arrays) -- take whichever
  // qualifying event is most recent.
  candidates.sort((a, b) => a.event.time - b.event.time);
  const latest = candidates[candidates.length - 1];

  const eventIndex = window.findIndex(candle => candleEpochSeconds(candle) === latest.event.time);
  const ageBars = eventIndex === -1 ? null : window.length - 1 - eventIndex;
  const confirmedAt = eventIndex === -1 ? null : window[eventIndex].t;

  return {
    status: 'CONFIRMED',
    direction,
    eventType: latest.eventType,
    eventDirection: latest.event.type,
    confirmedAt,
    ageBars,
    reason: `M30 ${latest.event.type} ${latest.eventType} at ${latest.event.brokenLevel} confirms the ${direction} thesis.`,
  };
}

// Async orchestration -- isolated per report. `fetchM30Candles` is
// injectable (defaults to the real OANDA fetch) purely so tests never
// need network access, matching this codebase's existing test
// conventions. Never throws: any fetch/analysis failure becomes
// UNAVAILABLE, never an exception the caller has to handle.
export async function fetchM30ConfirmationForReport(
  report: ScoutReport,
  fetchM30Candles: (pair: string) => Promise<M30Candle[]> = (pair) => fetchCandles(pair, 'M30', M30_FETCH_COUNT),
): Promise<M30Confirmation> {
  const direction = scoutTradeDirection(report) as Direction;
  try {
    const candles = await fetchM30Candles(report.pair);
    return evaluateM30Confirmation(direction, candles);
  } catch (e: any) {
    return unavailable(direction, `M30 candle fetch failed for ${report.pair}: ${e?.message || 'unknown error'}.`);
  }
}

const UNKNOWN_M30_CONFIRMATION: M30Confirmation = unavailable('NEUTRAL', 'M30 shadow confirmation has not been evaluated for this report yet.');

// Read-model attach step (Phase 5) -- pure, synchronous, additive, and
// deliberately separate from Sprint 1's attachForexV2LifecycleCards
// (server/v2/cardContract.ts, untouched by this sprint). Reads a
// pre-populated cache by the SAME shadowKey identity Sprint 1 already
// established (pair + timeframe + direction) -- no second key scheme.
// Mirrors index.ts's own existing enrichScoutReports() pattern (reads a
// module-level cache, spreads a new field on top, never mutates the
// input report).
export function attachM30Confirmations<T extends ScoutReport>(
  reports: T[],
  cache: Map<string, M30Confirmation>,
): Array<T & { m30Confirmation: M30Confirmation }> {
  return reports.map(report => ({
    ...report,
    m30Confirmation: cache.get(shadowKey(report)) ?? UNKNOWN_M30_CONFIRMATION,
  }));
}

// Refresh step -- called once per real scan (never on a plain read),
// exactly like latestScoutResults itself is only ever refreshed by a
// scan. Every per-report fetch already catches its own errors
// (fetchM30ConfirmationForReport never rejects), so Promise.all here can
// never reject either -- one pair's OANDA failure can't affect any
// other pair's shadow result, and can never throw back into the caller
// (scheduledScan / POST /api/scout), which is what keeps this from ever
// being able to affect Scout's own production behavior.
export async function refreshM30Confirmations(
  reports: ScoutReport[],
  fetchM30Candles?: (pair: string) => Promise<M30Candle[]>,
): Promise<Map<string, M30Confirmation>> {
  const entries = await Promise.all(
    reports.map(async report => [shadowKey(report), await fetchM30ConfirmationForReport(report, fetchM30Candles)] as const),
  );
  return new Map(entries);
}
