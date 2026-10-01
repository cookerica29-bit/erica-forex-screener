// Kairos Forex v2 -- Sprint 3: Post-M30-Confirmation Retest (shadow-only).
//
// Answers exactly one further question, observationally, once Sprint 2's
// m30Confirmation.ts has already answered "has M30 confirmed the thesis":
// "has price since RETURNED to the exact level that confirmation broke?"
// M30 CONFIRMED -> WAITING_FOR_RETEST -> RETEST_REACHED.
//
// No new structure algorithm: this module only re-runs Sprint 2's own
// evaluateM30Confirmation (pure) to recover the confirming event, then
// scans the SAME M30 candle series for the first candle, strictly AFTER
// the confirming candle, whose range touches the confirmed level. No
// ATR/pip/Fibonacci tolerance, no candle-close requirement, no rejection
// requirement -- an objective range test only, per this sprint's own
// instruction. This module has no write path back into Scout/V1/Sprint
// 1's lifecycle card: it only ever reads a ScoutReport's own fields and
// an independently-fetched M30 candle series.
import { scoutTradeDirection } from '../scoutPhase.js';
import { shadowKey } from './diagnostics.js';
import {
  evaluateM30Confirmation,
  unavailable as unavailableConfirmation,
  M30_STRUCTURE_WINDOW,
  type M30Candle,
  type M30Confirmation,
  type M30EventType,
} from './m30Confirmation.js';
import { fetchCandles } from '../scanner.js';
import type { ScoutReport } from '../scanner.js';
import type { Direction } from './context.js';

export type M30RetestStatus = 'WAITING_FOR_CONFIRMATION' | 'WAITING_FOR_RETEST' | 'RETEST_REACHED' | 'UNAVAILABLE';

export interface M30Retest {
  status: M30RetestStatus;
  direction: Direction;
  level: number | null;
  confirmationType: M30EventType;
  confirmedAt: string | null;
  retestAt: string | null;         // ISO timestamp of the first candle whose range touched `level`, strictly after confirmedAt
  barsAfterConfirmation: number | null; // M30 candles between the confirming candle and the retest candle
  reason: string;
}

const M30_FETCH_COUNT = 250;

function unavailable(direction: Direction, reason: string): M30Retest {
  return {
    status: 'UNAVAILABLE',
    direction,
    level: null,
    confirmationType: null,
    confirmedAt: null,
    retestAt: null,
    barsAfterConfirmation: null,
    reason,
  };
}

function waitingForConfirmation(direction: Direction, reason: string): M30Retest {
  return {
    status: 'WAITING_FOR_CONFIRMATION',
    direction,
    level: null,
    confirmationType: null,
    confirmedAt: null,
    retestAt: null,
    barsAfterConfirmation: null,
    reason,
  };
}

function candleEpochSeconds(candle: M30Candle): number {
  return Math.floor(new Date(candle.t).getTime() / 1000);
}

// Pure, synchronous, network-free. Takes an already-computed confirmation
// (Phase 4: computed fresh from the SAME candle series by the caller, so
// confirmation and retest can never drift into mismatched direction/level
// pairs) plus the candle series it was computed from, and determines
// whether price has since retested the confirmed level.
export function evaluateM30Retest(confirmation: M30Confirmation, m30Candles: M30Candle[] | null | undefined): M30Retest {
  const direction = confirmation.direction;

  if (confirmation.status === 'UNAVAILABLE') {
    return unavailable(direction, 'M30 confirmation is unavailable; retest cannot be evaluated.');
  }
  if (confirmation.status === 'NOT_CONFIRMED') {
    return waitingForConfirmation(direction, 'M30 has not yet confirmed the thesis; nothing to retest.');
  }

  // CONFIRMED, but missing the data a retest needs -- do not invent a
  // level or timestamp; report UNAVAILABLE instead (Case 10).
  if (confirmation.brokenLevel === null || confirmation.confirmedAt === null || confirmation.eventType === null) {
    return unavailable(direction, 'M30 confirmation is missing a broken level or timestamp; retest cannot be evaluated.');
  }
  if (!m30Candles || m30Candles.length === 0) {
    return unavailable(direction, 'M30 candles unavailable; retest cannot be evaluated.');
  }

  const level = confirmation.brokenLevel;
  const window = m30Candles.slice(-M30_STRUCTURE_WINDOW);
  const confirmedAtEpoch = Math.floor(new Date(confirmation.confirmedAt).getTime() / 1000);
  const confirmingIndex = window.findIndex(candle => candleEpochSeconds(candle) === confirmedAtEpoch);

  if (confirmingIndex === -1) {
    // The confirming candle has scrolled out of the currently-evaluated
    // window (or the window shape changed between calls) -- cannot
    // locate a "strictly after" boundary without it, so do not guess.
    return unavailable(direction, 'Could not locate the confirming M30 candle in the current window; retest cannot be evaluated.');
  }

  // Strictly AFTER the confirming candle -- the confirmation candle
  // itself can never count as its own retest (Case 6).
  for (let i = confirmingIndex + 1; i < window.length; i++) {
    const candle = window[i];
    if (candle.l <= level && level <= candle.h) {
      return {
        status: 'RETEST_REACHED',
        direction,
        level,
        confirmationType: confirmation.eventType,
        confirmedAt: confirmation.confirmedAt,
        retestAt: candle.t,
        barsAfterConfirmation: i - confirmingIndex,
        reason: `Price returned to the confirmed ${direction} level ${level} (${confirmation.eventType}) ${i - confirmingIndex} M30 candle(s) after confirmation.`,
      };
    }
  }

  return {
    status: 'WAITING_FOR_RETEST',
    direction,
    level,
    confirmationType: confirmation.eventType,
    confirmedAt: confirmation.confirmedAt,
    retestAt: null,
    barsAfterConfirmation: null,
    reason: `M30 confirmed the ${direction} thesis at ${level} (${confirmation.eventType}) but price has not yet returned to that level.`,
  };
}

// Async orchestration -- deliberately re-fetches M30 candles independently
// of Sprint 2's own fetchM30ConfirmationForReport (a second OANDA call per
// report) rather than sharing its cache, so this sprint requires zero
// changes to Sprint 2's already-tested fetch/cache path. Confirmation is
// then recomputed fresh, from this SAME candle series, purely in-memory --
// guaranteeing confirmation/retest consistency by construction (Phase 4)
// without introducing any shared mutable state between the two modules.
// Never throws: any fetch/analysis failure becomes UNAVAILABLE.
export async function fetchM30RetestForReport(
  report: ScoutReport,
  fetchM30Candles: (pair: string) => Promise<M30Candle[]> = (pair) => fetchCandles(pair, 'M30', M30_FETCH_COUNT),
): Promise<M30Retest> {
  const direction = scoutTradeDirection(report) as Direction;
  try {
    const candles = await fetchM30Candles(report.pair);
    const confirmation = evaluateM30Confirmation(direction, candles);
    return evaluateM30Retest(confirmation, candles);
  } catch (e: any) {
    const failure = unavailableConfirmation(direction, `M30 candle fetch failed for ${report.pair}: ${e?.message || 'unknown error'}.`);
    return evaluateM30Retest(failure, null);
  }
}

const UNKNOWN_M30_RETEST: M30Retest = unavailable('NEUTRAL', 'M30 shadow retest has not been evaluated for this report yet.');

// Read-model attach step -- pure, synchronous, additive, mirroring Sprint
// 2's own attachM30Confirmations exactly: reads a pre-populated cache by
// the same shadowKey identity, spreads a new sibling field on top, never
// mutates the input report.
export function attachM30Retests<T extends ScoutReport>(
  reports: T[],
  cache: Map<string, M30Retest>,
): Array<T & { m30Retest: M30Retest }> {
  return reports.map(report => ({
    ...report,
    m30Retest: cache.get(shadowKey(report)) ?? UNKNOWN_M30_RETEST,
  }));
}

// Refresh step -- called once per real scan (never on a plain read),
// mirroring Sprint 2's own refreshM30Confirmations exactly. Every
// per-report fetch already catches its own errors, so Promise.all here
// can never reject -- one pair's failure can't affect any other pair's
// shadow result, and can never throw back into the caller.
export async function refreshM30Retests(
  reports: ScoutReport[],
  fetchM30Candles?: (pair: string) => Promise<M30Candle[]>,
): Promise<Map<string, M30Retest>> {
  const entries = await Promise.all(
    reports.map(async report => [shadowKey(report), await fetchM30RetestForReport(report, fetchM30Candles)] as const),
  );
  return new Map(entries);
}
