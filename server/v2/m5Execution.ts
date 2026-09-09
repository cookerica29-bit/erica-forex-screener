// Kairos Forex v2 -- Sprint 4: M5 Execution Trigger (shadow-only).
//
// Answers the final observational question in Erica's workflow: once M30
// has confirmed the thesis (Sprint 2) AND price has retested the broken
// level (Sprint 3), has a 5-minute CHoCH in the thesis direction since
// fired as the execution trigger? M30 RETEST_REACHED -> WATCHING_M5 ->
// ENTRY_READY. No new structure algorithm: reuses computeStructures
// (scanner.ts) exactly as Sprint 2/3 already do, just applied to M5
// candles instead of M30. This module has no write path back into
// Scout/V1/Sprint 1's lifecycle card/Sprint 2's confirmation/Sprint 3's
// retest: it only ever reads their outputs and an independently-fetched
// M5 candle series.
import { computeStructures, fetchCandles, type TrainerStructures } from '../scanner.js';
import { scoutTradeDirection } from '../scoutPhase.js';
import { shadowKey } from './diagnostics.js';
import type { M30Retest } from './m30Retest.js';
import type { ScoutReport } from '../scanner.js';
import type { Direction } from './context.js';

// Structurally identical to M30Candle/scanner.ts's own Candle -- named
// locally per this codebase's existing convention (see m30Confirmation.ts).
export type M5Candle = Awaited<ReturnType<typeof fetchCandles>>[number];

export type M5ExecutionStatus = 'WAITING_FOR_M30_RETEST' | 'WATCHING_M5' | 'ENTRY_READY' | 'UNAVAILABLE';
export type M5TriggerType = 'CHOCH' | null;

export interface M5Execution {
  status: M5ExecutionStatus;
  direction: Direction;
  brokenLevel: number | null;
  m30ConfirmedAt: string | null;
  m30RetestAt: string | null;
  m5RetestAt: string | null;       // ISO timestamp of the M5 candle that actually touched brokenLevel (5-minute precision)
  triggerType: M5TriggerType;      // always 'CHOCH' when ENTRY_READY -- a thesis-direction BOS alone never qualifies (Phase 6)
  triggerDirection: 'bullish' | 'bearish' | null;
  triggeredAt: string | null;      // ISO timestamp of the qualifying M5 CHoCH candle, if any
  barsAfterRetest: number | null;  // M5 candles between the retest-touch candle and the trigger candle
  reason: string;
}

// M5 fetch count matches runScalpScan's own existing M5 fetch precedent
// (server/scanner.ts) -- reused rather than invented.
const M5_FETCH_COUNT = 180;
// Matches scalpAnalyzeCandles's own minimum-data guard for M5.
const MIN_M5_CANDLES = 40;
// No repository precedent exists for a CHoCH/BOS margin on M5 specifically
// (computeStructures is only ever run on M15/M30 elsewhere in this
// codebase -- see Phase 1 findings). Per this sprint's own instruction to
// not silently tune structure sensitivity, this reuses computeStructures'
// own function-default margin (5) rather than inventing a new one.
const M5_STRUCTURE_MARGIN = 5;

function candleEpochSeconds(candle: M5Candle): number {
  return Math.floor(new Date(candle.t).getTime() / 1000);
}

function waitingForM30Retest(direction: Direction, reason: string): M5Execution {
  return {
    status: 'WAITING_FOR_M30_RETEST',
    direction,
    brokenLevel: null,
    m30ConfirmedAt: null,
    m30RetestAt: null,
    m5RetestAt: null,
    triggerType: null,
    triggerDirection: null,
    triggeredAt: null,
    barsAfterRetest: null,
    reason,
  };
}

// Exported so callers building a synthetic "M30 not activated yet" result
// (e.g. the scan-context refresh step, which skips the M5 fetch entirely
// for non-activated reports) can reuse this shape rather than duplicating it.
export function unavailable(direction: Direction, m30Retest: M30Retest, reason: string): M5Execution {
  return {
    status: 'UNAVAILABLE',
    direction,
    brokenLevel: m30Retest.level ?? null,
    m30ConfirmedAt: m30Retest.confirmedAt ?? null,
    m30RetestAt: m30Retest.retestAt ?? null,
    m5RetestAt: null,
    triggerType: null,
    triggerDirection: null,
    triggeredAt: null,
    barsAfterRetest: null,
    reason,
  };
}

function watchingM5(direction: Direction, m30Retest: M30Retest, m5RetestAt: string, reason: string): M5Execution {
  return {
    status: 'WATCHING_M5',
    direction,
    brokenLevel: m30Retest.level,
    m30ConfirmedAt: m30Retest.confirmedAt,
    m30RetestAt: m30Retest.retestAt,
    m5RetestAt,
    triggerType: null,
    triggerDirection: null,
    triggeredAt: null,
    barsAfterRetest: null,
    reason,
  };
}

// Pure, synchronous, network-free -- the entire execution-trigger rule
// lives here so it can be tested against hand-built candle series exactly
// like m30Confirmation.ts/m30Retest.ts's own pure evaluators.
//
// Critical sequencing (Phase 2/6): M5 gets no vote at all unless
// m30Retest.status === 'RETEST_REACHED'. The M30 retest is then resolved
// to 5-minute precision by scanning M5 candles, starting at the M30
// retest candle's own 30-minute interval, for the first candle whose
// range actually touches brokenLevel (m5RetestAt). Only a thesis-
// direction CHoCH strictly AFTER that exact M5 candle's index can trigger
// ENTRY_READY -- a BOS alone never qualifies, and the retest-touch candle
// itself can never count as its own trigger.
export function evaluateM5Execution(
  direction: Direction,
  m30Retest: M30Retest,
  m5Candles: M5Candle[] | null | undefined,
): M5Execution {
  if (direction === 'NEUTRAL') {
    return waitingForM30Retest(direction, 'Scout thesis has no directional bias to evaluate M5 execution against.');
  }
  if (m30Retest.status !== 'RETEST_REACHED') {
    return waitingForM30Retest(direction, 'M30 retest has not occurred yet; M5 execution analysis is not activated.');
  }
  if (m30Retest.level === null || m30Retest.retestAt === null) {
    return unavailable(direction, m30Retest, 'M30 retest is missing a broken level or retest timestamp; M5 execution cannot be evaluated.');
  }
  if (!m5Candles || m5Candles.length < MIN_M5_CANDLES) {
    return unavailable(direction, m30Retest, `M5 candles unavailable or insufficient (need >= ${MIN_M5_CANDLES}, have ${m5Candles?.length ?? 0}).`);
  }

  const level = m30Retest.level;
  const m30RetestEpoch = Math.floor(new Date(m30Retest.retestAt).getTime() / 1000);

  // Coverage check (Phase "M5 History Coverage"): if the earliest
  // available M5 candle is already AFTER the M30 retest interval began,
  // the M5 history does not reach back far enough to safely resolve the
  // retest -- do not guess, report UNAVAILABLE.
  const earliestM5Epoch = candleEpochSeconds(m5Candles[0]);
  if (earliestM5Epoch > m30RetestEpoch) {
    return unavailable(direction, m30Retest, 'M5 candle history does not reach back far enough to cover the M30 retest interval.');
  }

  // Resolve the exact M5 retest touch: the first M5 candle, starting at
  // the M30 retest candle's own 30-minute interval, whose range touches
  // the exact broken level. Candles before the M30 retest interval are
  // skipped entirely (a pre-existing touch earlier in history must not
  // be mistaken for the retest).
  let retestIndex = -1;
  for (let i = 0; i < m5Candles.length; i++) {
    const epoch = candleEpochSeconds(m5Candles[i]);
    if (epoch < m30RetestEpoch) continue;
    if (m5Candles[i].l <= level && level <= m5Candles[i].h) {
      retestIndex = i;
      break;
    }
  }

  if (retestIndex === -1) {
    return unavailable(direction, m30Retest, 'Could not locate an M5 candle touching the confirmed level within the M30 retest interval.');
  }

  const m5RetestAt = m5Candles[retestIndex].t;

  let structures: TrainerStructures;
  try {
    structures = computeStructures(m5Candles, M5_STRUCTURE_MARGIN);
  } catch (e: any) {
    return unavailable(direction, m30Retest, `M5 structure analysis failed: ${e?.message || 'unknown error'}.`);
  }

  // Execution trigger is specifically a thesis-direction CHoCH -- a BOS
  // alone never qualifies (Phase 6's own explicit BOS-exclusion rule).
  const wantedEventDirection: 'bullish' | 'bearish' = direction === 'LONG' ? 'bullish' : 'bearish';
  const qualifying = structures.chochEvents
    .filter(event => event.type === wantedEventDirection)
    .map(event => ({ event, index: m5Candles.findIndex(c => candleEpochSeconds(c) === event.time) }))
    // Strictly after the retest-touch candle's own index -- excludes any
    // historical pre-retest CHoCH, any CHoCH earlier within the same M30
    // retest bar, and the retest-touch candle's own event.
    .filter(({ index }) => index !== -1 && index > retestIndex)
    .sort((a, b) => a.event.time - b.event.time);

  const trigger = qualifying[0] ?? null;

  if (!trigger) {
    return watchingM5(direction, m30Retest, m5RetestAt, `No ${wantedEventDirection} M5 CHoCH found strictly after the M5 retest touch yet.`);
  }

  const triggeredAt = m5Candles[trigger.index].t;
  const barsAfterRetest = trigger.index - retestIndex;

  return {
    status: 'ENTRY_READY',
    direction,
    brokenLevel: level,
    m30ConfirmedAt: m30Retest.confirmedAt,
    m30RetestAt: m30Retest.retestAt,
    m5RetestAt,
    triggerType: 'CHOCH',
    triggerDirection: trigger.event.type,
    triggeredAt,
    barsAfterRetest,
    reason: `M5 ${trigger.event.type} CHoCH at ${triggeredAt} confirms the ${direction} execution trigger ${barsAfterRetest} M5 candle(s) after the resolved retest touch.`,
  };
}

const UNKNOWN_M5_EXECUTION: M5Execution = waitingForM30Retest('NEUTRAL', 'M5 shadow execution has not been evaluated for this report yet.');

// Read-model attach step -- pure, synchronous, additive, mirroring
// m30Confirmation.ts/m30Retest.ts's own attach functions exactly.
export function attachM5Executions<T extends ScoutReport>(
  reports: T[],
  cache: Map<string, M5Execution>,
): Array<T & { m5Execution: M5Execution }> {
  return reports.map(report => ({
    ...report,
    m5Execution: cache.get(shadowKey(report)) ?? UNKNOWN_M5_EXECUTION,
  }));
}

// Async orchestration -- activates M5 fetching ONLY for reports whose M30
// retest has actually reached RETEST_REACHED (Phase 3), and fetches M5
// candles once per unique pair among those activated reports (Phase 4),
// mirroring m30ScanContext.ts's own dedup pattern. Reports that are not
// activated get an evaluateM5Execution call with null candles, which
// resolves to WAITING_FOR_M30_RETEST without ever touching the network --
// so the "zero M5 fetch while waiting" requirement falls out of
// evaluateM5Execution's own guard rather than a second, duplicated check.
export async function refreshM5Executions(
  reports: ScoutReport[],
  m30Retests: Map<string, M30Retest>,
  fetchM5Candles: (pair: string) => Promise<M5Candle[]> = (pair) => fetchCandles(pair, 'M5', M5_FETCH_COUNT),
): Promise<Map<string, M5Execution>> {
  const activatedPairs = Array.from(new Set(
    reports
      .filter(report => m30Retests.get(shadowKey(report))?.status === 'RETEST_REACHED')
      .map(report => report.pair),
  ));

  const candlesByPair = new Map<string, M5Candle[] | null>();
  await Promise.all(
    activatedPairs.map(async pair => {
      try {
        candlesByPair.set(pair, await fetchM5Candles(pair));
      } catch {
        candlesByPair.set(pair, null);
      }
    }),
  );

  const results = new Map<string, M5Execution>();
  for (const report of reports) {
    const direction = scoutTradeDirection(report) as Direction;
    const key = shadowKey(report);
    const retest = m30Retests.get(key);
    if (!retest || retest.status !== 'RETEST_REACHED') {
      // Not activated -- no fetch for this pair was requested on this
      // report's behalf. Evaluate with null candles; the pure evaluator's
      // own retest-status guard produces WAITING_FOR_M30_RETEST safely.
      results.set(key, evaluateM5Execution(direction, retest ?? { status: 'WAITING_FOR_CONFIRMATION', direction, level: null, confirmationType: null, confirmedAt: null, retestAt: null, barsAfterConfirmation: null, reason: 'No M30 retest evaluated for this report yet.' } as M30Retest, null));
      continue;
    }
    try {
      const candles = candlesByPair.get(report.pair) ?? null;
      results.set(key, evaluateM5Execution(direction, retest, candles));
    } catch (e: any) {
      results.set(key, unavailable(direction, retest, `M5 execution evaluation failed for ${report.pair}: ${e?.message || 'unknown error'}.`));
    }
  }
  return results;
}
