# Kairos Forex v2 Migration Plan

Sprint Zero planning document. v1 remains the production baseline until v2 has enough evidence to replace it.

## Baseline Preservation

Current v1 production behavior must remain frozen while v2 is designed and validated:

- Keep `server/scanner.ts` v1 functions intact.
- Keep `server/scoutPhase.ts` current alert routes intact.
- Keep `server/index.ts` alert, journal, scan schedule, and API behavior intact.
- Keep `public/index.html` card rendering intact until a feature-flagged v2 UI exists.
- Keep existing regression tests passing.
- Do not change provider settings, OANDA requests, Telegram payloads, journal schema, or scan counts as part of migration planning.

## Current Logic Risks to Control

- Status vocabulary is spread across scanner, phase helper, server diagnostics, and frontend.
- H4 is not consistently the decision timeframe.
- M30 is not consistently the execution timeframe.
- `Enter Now` mixes setup readiness with entry execution readiness.
- Premium/discount is based on a recent current-timeframe range rather than a formal Daily/H4 dealing range.
- Supply/demand zones are simplified BOS-derived zones and do not robustly track mitigation/freshness.
- Scout has TP1/TP2 only while the desired workflow has TP1/TP2/TP3/completed.
- Alert idempotency is in memory only.
- Journal data mixes manually reviewed outcomes with scanner snapshots and does not measure full lifecycle timing.

## Phase 1 - Parallel v2 Data Model

Goal: compute v2 fields in shadow mode without changing UI decisions, alerts, journals, or v1 outputs.

Scope:

- Add v2 types for timeframe roles, lifecycle state, evidence, planned entry, invalidation, and outcome timestamps.
- Compute Daily context, H4 decision evidence, and M30 execution evidence in a new isolated module.
- Store v2 output in memory or diagnostics only.
- Do not display v2 as production cards.
- Do not send v2 alerts.
- Do not journal v2 setups as trades.

Validation:

- v1 card counts unchanged.
- v1 alert diagnostics unchanged.
- Build and regression tests pass.

## Phase 2 - Diagnostics Comparison

Goal: compare v1 and v2 without using v2 for trading decisions.

Compare:

- v1 direction versus v2 setup direction.
- v1 premium/discount versus v2 dealing-range location.
- v1 structure/reversal versus v2 liquidity/structure state.
- v1 entry versus v2 planned entry.
- v1 stop/TPs versus v2 risk plan.
- v1 grade versus v2 readiness/lifecycle.

Record:

- Agreement/disagreement reason.
- Which timeframe caused disagreement.
- Whether v1 said Entry Ready while v2 said wait.
- Whether v2 found a planned entry while v1 used current/near-current price.
- Whether the setup later reached planned entry, TP1, stop, or invalidation.

Constraints:

- No trading decisions from v2 yet.
- No public alert wording changes.
- No journal schema migration unless behind a non-production measurement table.

## Phase 3 - v2 Cards Behind Feature Flag

Goal: let Erica compare v1 and v2 visually while v1 remains production.

Feature flag behavior:

- Default remains v1.
- Optional v2 panel shows v2 lifecycle state, missing requirement, next step, planned entry, stop, TP1/TP2/TP3.
- v2 cards are marked shadow/paper only.
- v1 alert and journal buttons remain unchanged.

UI rules:

- Main v2 card stays compact.
- Detailed evidence goes into Forex Further Analysis.
- The card must always show the planned entry, even if current price moved away.
- Never replace planned entry with current market price after confirmation.

Exit criteria:

- Erica can distinguish Building, Almost Ready, Liquidity Swept, Structure Confirmed, Waiting for Entry, and Entry Reached.
- No production behavior changed when the flag is off.

## Phase 4 - Paper Validation

Goal: validate v2 quality before active release.

Paper process:

- Journal v2 setups as measured setup records, not live trade claims.
- Track signal time, confirmation time, planned entry, entry touch time, stop/TP touches, MFE, MAE, completion reason.
- Compare direction correctness and entry quality.
- Review session behavior across Asia, London, and New York.
- Measure missed/stale entries separately from losses.

No eval-account dependency:

- v2 must prove workflow quality before being used for funded/eval decisions.
- Alerts remain disabled or clearly paper/shadow during this phase.

Exit criteria:

- Enough sampled setups to show whether v2 improves patience and entry quality.
- Known false positives/false negatives documented.
- Clear rollback and fallback to v1.

## Phase 5 - Controlled Release

Goal: gradually enable v2 as the active workflow only after evidence supports it.

Steps:

- Enable v2 alerts for `ALMOST_READY` and `SETUP_CONFIRMED` first.
- Enable `ENTRY_REACHED` only after planned-entry touch detection is reliable.
- Enable target/stop management alerts only after actual-position tracking is reliable.
- Keep v1 available in a fallback panel.
- Retire v1 only after measured evidence supports v2 and Erica confirms daily usability.

Release safeguards:

- Event idempotency must be server-side and durable enough for restarts.
- Alert payloads must use the wording contract.
- Journal writes must separate setup measurement from actual trade execution.
- High-impact news and session caution must be visible without hard-blocking valid setups.

## Reuse Plan

Reuse now:

- Candle fetcher and normalized candle shape.
- Pair normalization.
- Basic indicators.
- Existing diagnostics pattern.
- Existing alert duplicate-key idea.
- Existing journal table for actual manual trade entries only.

Reuse with caution:

- Swing detection and BOS/CHoCH helpers after validation against v2 definitions.
- Supply/demand zone derivation after adding freshness/mitigation/invalidation.
- Session labels after separating discovery, confirmation, entry, and management roles.

Do not reuse:

- Stock scanner strategy logic.
- Stock expected-move calculations as forex signal evidence.
- Scalp strategy thresholds for swing-trade lifecycle states.
- Current frontend labels as canonical state names.

## Verification Checklist for Each Phase

- v1 setup counts unchanged unless explicitly approved.
- v1 alerts unchanged unless phase says otherwise.
- v1 journal behavior unchanged unless phase says otherwise.
- Build passes.
- Regression suite passes or failures are documented with reason.
- Feature flag off means production UI and behavior match v1.
- New diagnostics explain disagreements without forcing decisions.

## Rollback Plan

- Keep v1 code paths and UI available.
- Keep v2 modules isolated until controlled release.
- Disable v2 feature flag to remove all v2 display and alert behavior.
- Do not migrate existing journal rows destructively.
- If v2 alert quality is poor, revert alerts to diagnostics-only while retaining measurement data.
