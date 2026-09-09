// Kairos Forex v2 -- Sprint 3.5: Shared M30 Scan Context (shadow-only).
//
// Pure architecture/efficiency cleanup: Sprint 2 (m30Confirmation.ts) and
// Sprint 3 (m30Retest.ts) were each written in isolation and each fetch
// their own independent M30 candle series per report. This module removes
// that duplication by fetching M30 candles ONCE PER UNIQUE PAIR per scan,
// and evaluating both evaluateM30Confirmation and evaluateM30Retest from
// that SAME candle snapshot -- reusing those two pure functions exactly
// as Sprint 2/3 left them, unmodified. No new strategy logic: this module
// only decides what to fetch and when, never how to interpret candles.
//
// Scout can legitimately contain more than one report for the same pair
// in one scan (scheduledScan's scout block runs H4 and H1 and flattens
// the results), so dedup is keyed by pair, not by report/shadowKey --
// every report for a given pair shares the exact same fetched candle
// array reference for that scan.
import { scoutTradeDirection } from '../scoutPhase.js';
import { shadowKey } from './diagnostics.js';
import {
  evaluateM30Confirmation,
  unavailable as unavailableConfirmation,
  type M30Candle,
  type M30Confirmation,
} from './m30Confirmation.js';
import { evaluateM30Retest, type M30Retest } from './m30Retest.js';
import { fetchCandles } from '../scanner.js';
import type { ScoutReport } from '../scanner.js';
import type { Direction } from './context.js';

// Matches M30_FETCH_COUNT in both m30Confirmation.ts and m30Retest.ts --
// kept as a separate local constant rather than importing theirs, since
// neither module exports it and this is the only place that still needs
// to know it (the default real-fetch function).
const M30_FETCH_COUNT = 250;

export interface M30ScanContextResult {
  confirmations: Map<string, M30Confirmation>;
  retests: Map<string, M30Retest>;
}

// Async orchestration -- fetches M30 candles once per unique pair among
// the given reports (never once per report), then evaluates confirmation
// and retest for every report from that pair's single shared candle
// snapshot. `fetchM30Candles` is injectable (defaults to the real OANDA
// fetch), matching this codebase's existing test conventions.
export async function refreshM30ScanContexts(
  reports: ScoutReport[],
  fetchM30Candles: (pair: string) => Promise<M30Candle[]> = (pair) => fetchCandles(pair, 'M30', M30_FETCH_COUNT),
): Promise<M30ScanContextResult> {
  const uniquePairs = Array.from(new Set(reports.map(report => report.pair)));

  // One fetch per unique pair, isolated per pair -- one pair's OANDA
  // failure can never affect any other pair's candle snapshot.
  const candlesByPair = new Map<string, M30Candle[] | null>();
  await Promise.all(
    uniquePairs.map(async pair => {
      try {
        candlesByPair.set(pair, await fetchM30Candles(pair));
      } catch {
        candlesByPair.set(pair, null);
      }
    }),
  );

  const confirmations = new Map<string, M30Confirmation>();
  const retests = new Map<string, M30Retest>();

  for (const report of reports) {
    const direction = scoutTradeDirection(report) as Direction;
    const key = shadowKey(report);
    const candles = candlesByPair.get(report.pair) ?? null;

    // Confirmation and retest are evaluated -- and can fail -- separately,
    // so an unexpected retest-evaluation error can never take down an
    // already-valid confirmation for the same report (Phase 4).
    let confirmation: M30Confirmation;
    try {
      confirmation = candles === null
        ? unavailableConfirmation(direction, `M30 candle fetch failed for ${report.pair}.`)
        : evaluateM30Confirmation(direction, candles);
    } catch (e: any) {
      confirmation = unavailableConfirmation(direction, `M30 confirmation evaluation failed for ${report.pair}: ${e?.message || 'unknown error'}.`);
    }
    confirmations.set(key, confirmation);

    let retest: M30Retest;
    try {
      retest = evaluateM30Retest(confirmation, candles);
    } catch (e: any) {
      retest = evaluateM30Retest(
        unavailableConfirmation(direction, `M30 retest evaluation failed for ${report.pair}: ${e?.message || 'unknown error'}.`),
        null,
      );
    }
    retests.set(key, retest);
  }

  return { confirmations, retests };
}
