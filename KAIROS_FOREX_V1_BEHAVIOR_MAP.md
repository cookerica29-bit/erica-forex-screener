# Kairos Forex v1 Behavior Map

Sprint Zero audit document. This freezes the current forex scanner behavior as a reference baseline. It is descriptive only and must not be treated as a request to change production logic.

## Files Inspected

- `server/scanner.ts` - OANDA candle fetching, legacy setup analysis, Scout analysis, Trend scan, Scalp scan, independent watchlist scan.
- `server/scoutPhase.ts` - Scout phase labels, next-step wording, alert route selection, duplicate keys.
- `server/index.ts` - scan schedule, APIs, Telegram delivery, diagnostics, TradingView confirmation layer, journal routes.
- `server/db.ts` - journal persistence, settings persistence, journal stats.
- `server/newsFilter.ts` - ForexFactory high-impact news risk lookup.
- `drizzle/schema.ts` - journal table schema.
- `server/regression/forex-regression-runner.ts` - regression coverage for Scout phase/alert routing and selected legacy rejection rules.
- `public/index.html` - frontend Scout rendering, developing setup panel, journaling form, filters, status translation.

## Current Runtime Architecture

Kairos v1 is a single Node/Express server with a static HTML frontend.

Data sources:

- OANDA v20 candles from `https://api-fxpractice.oanda.com` or `https://api-fxtrade.oanda.com`, selected by `OANDA_ACCOUNT_TYPE`.
- ForexFactory calendar JSON from `https://nfs.faireconomy.media/ff_calendar_thisweek.json` for high-impact news risk.
- MySQL for journal/settings when configured; local settings file fallback for development.
- TradingView/Pine webhooks for supply/demand zone sync and rejection confirmations.

Primary APIs:

- `/api/setups` and `/api/scan` expose legacy `latestSetups`.
- `/api/scout` exposes Scout reports and triggers manual Scout scans.
- `/api/scout/diagnostics` exposes read-only Scout alert diagnostics.
- `/api/trending` exposes D/H4/H1 trend scan.
- `/api/scalp` exposes M15/M5 scalp scan.
- `/api/independent-watchlist-scan` scans user-provided symbols only.
- `/api/journal` handles manual and TradingView paper journal rows.
- `/api/tradingview-confirmation` stores Pine zone/rejection confirmation and may send a Telegram confirmation.
- `/api/tradingview-alert` journals TradingView paper alerts without Telegram.

## Schedule

At startup, `init()` restores priority pairs, then calls:

- `scheduledScan()`
- `scheduledTrendScan()`

Both repeat every 15 minutes.

`scheduledScan()` currently:

- Runs legacy `debugScan()` on `H4` and `M30` unless a manual timeframe is forced.
- Builds `latestSetups` from legacy accepted setups.
- Queues premium/strong legacy setups for approval without Telegram.
- Runs Scout scans on `H4` and `H1` unless a manual timeframe is forced.
- Calls `notifyTradeableScoutSignals()` for Scout Telegram alerts.

Manual frontend Scan calls `POST /api/scout?tf={selectedScanTf}`. The UI selector includes `M30`, `H1`, and `H4`, but scheduled Scout scans use `H4` and `H1`.

## Supported Markets

`PAIRS` in `server/scanner.ts`:

- Majors: `EUR_USD`, `GBP_USD`, `USD_JPY`, `USD_CAD`, `USD_CHF`, `AUD_USD`, `NZD_USD`
- JPY crosses: `EUR_JPY`, `GBP_JPY`, `AUD_JPY`, `NZD_JPY`, `CAD_JPY`
- Crosses: `EUR_GBP`, `EUR_AUD`
- Metals: `XAU_USD`, `XAG_USD`
- Indices: `US30_USD`, `NAS100_USD`

News risk maps currencies for forex/metals only. Indices are scanned in several paths but excluded from Scout Telegram candidates.

## Supported Timeframes

Current logic uses these timeframes:

- Legacy scheduled setup scan: `H4`, `M30`.
- Scout scheduled scan: `H4`, `H1`.
- Scout manual scan: `M30`, `H1`, or `H4` depending on frontend selection.
- Scout diagnostics manual run defaults to `H4`, `H1`, `M30`.
- Trend scan: `D`, `H4`, `H1`.
- Scalp scan: `M15`, `M5`, `M30`, `H1`.
- Independent watchlist: `M30`, `H1`, `H4`.

`HTF_MAP`:

- `M15 -> H4`
- `M30 -> H4`
- `H1 -> D`
- `H4 -> W`
- `D -> W`

## Legacy Setup Logic

`analyzeCandles()` is still production code for `latestSetups` and approval queueing. The frontend mostly operates in Scout mode, but legacy setup generation remains active.

Legacy gates:

- Requires at least 210 candles.
- Rejects low ATR using pair-specific minimum ATR.
- Rejects post-news chop/spike behavior using recent candle ranges versus baseline ATR.
- Computes EMA20, EMA50, EMA200, RSI14.
- Direction requires price above EMA50/EMA200 for `LONG` or below both for `SHORT`.
- HTF conflict rejects if HTF swing trend opposes detected local direction.
- Requires recent pullback to EMA20 within 1 ATR.
- Requires momentum/rejection evidence from engulfing, pin bar, strong close, or EMA bounce.
- Rejects RSI outside current thresholds: long allowed roughly 35-72, short allowed roughly 30-65.

Legacy levels:

- Entry is current close.
- Stop is beyond recent swing low/high plus 0.3 ATR buffer.
- TP1/TP2/TP3 prefer qualifying opposing swings, with fallback R multiples.
- PDH/PDL can trim TP1.
- TP1 must clear freshness and structure filters.

Legacy grading:

- Score starts at 60 and is adjusted by volume, liquidity sweep around EMA20, PDH/PDL, clutter, session, and journal stats.
- `PREMIUM` at score >= 95.
- `STRONG` at score >= 75.
- Otherwise `DEVELOPING`.
- HTF conflict or counter-slope can cap quality.

Legacy journal influence:

- `getPatternStats()` reads journal outcomes and passes historical pattern stats into `debugScan()`.
- This only affects legacy scoring; Scout grading does not directly use those stats.

## Scout Logic

Scout scans produce a report for each pair that has enough candles. It does not gate out low-interest reports before returning to the UI.

Bias and trend:

- Local bias starts from swing structure on the last 50 candles with margin 3.
- HTF bias uses `HTF_MAP` candles with margin 3.
- Recent CHoCH can override local bias.
- `buildTrendSetupPhase()` separately analyzes Daily, H4, and current scan timeframe.
- `alignedScoutBias()` only returns a directional Scout bias when Daily structure, current setup frame, and combined trend direction agree.

Structure:

- `findSwings()` finds local highs/lows using left/right margin.
- `getTrend()` returns `LONG`, `SHORT`, or `null` based on recent swing sequences.
- `computeStructures()` marks bullish BOS when a later close breaks a swing high and bearish BOS when a later close breaks a swing low.
- BOS versus CHoCH is decided by the overall swing trend at the time of analysis: a break against the overall trend is labeled CHoCH; with trend is labeled BOS.
- Supply/demand zones are derived from the last opposing candle before BOS within an eight-candle lookback.

Premium/discount:

- Scout computes the high/low of the last 50 candles.
- `PREMIUM` means price is above midpoint plus 5% of range.
- `DISCOUNT` means price is below midpoint minus 5% of range.
- Otherwise `FAIR VALUE`.

Entry:

- `nearestActiveZoneEntry()` chooses the nearest demand/supply midpoint, nearest support/resistance, or EMA20 fallback.
- Candidate must be within or near roughly 1.25 ATR when possible.
- The entry is a planned level, not always current market price.

Stop:

- Long stop is below nearest support or ATR fallback, at least 1 ATR beyond entry plus 0.3 ATR buffer.
- Short stop is above nearest resistance or ATR fallback, at least 1 ATR beyond entry plus 0.3 ATR buffer.

Targets:

- Scout TP1 must be at least 2R.
- Long TP1 is nearest swing high at/above 2R or a 2R fallback.
- Short TP1 is nearest swing low at/below 2R or a 2R fallback.
- TP2 is next swing beyond TP1 or extended R fallback.
- Scout currently has no TP3 in `ScoutReport`; legacy setup has TP3.

Entry distance:

- `Tradeable` if price is within 0.25 ATR of planned entry.
- `Near Entry` if within 0.5 ATR.
- `Waiting` if within 1 ATR.
- `Too Far` otherwise.

Grade:

- `A`: trade direction is non-neutral, location aligns with direction, Daily trend does not conflict, setup/current flow aligns, and confirmation has started.
- `B`: trend/location alignment exists but setup is still developing, or Daily is mixed with location and reversal/setup evidence.
- `C`: neutral, countertrend conflict, location conflict, or incomplete evidence.

Eval eligibility:

`evalEligible` requires:

- A or B grade.
- Entry status is `Tradeable`.
- Daily trend aligns or is neutral.
- Current timeframe flow aligns.
- Location aligns.
- Reversal confirmed.
- Confirmation started.
- Decision level confirmed.
- Distance <= 0.25 ATR.
- Entry, SL, TP1 present.
- R:R >= 2.0.

Trend Watch:

- Separate label when not eval eligible.
- Requires clear Daily or H4 direction, setup flow alignment, trackable entry status, complete levels, and R:R >= 2.0.

## Current Statuses and Meanings

### Raw Scout Phase

Defined in `server/scoutPhase.ts`.

| Label | Conditions | Blocks advancement | Alert | Journaled |
| --- | --- | --- | --- | --- |
| `Enter Now` | `entryTimingState` is `Entry Triggered` and `evalEligible` is true | Missing eval gates, missing levels, R:R < 2.0, entry not Tradeable, decision level not confirmed | Urgent Scout Telegram candidate | Not automatic; user may manually journal |
| `Almost Ready` | A/B grade, near entry, aligned location, complete levels, R:R >= 2.0, but waiting on final step | Missing reversal, decision level, flow alignment, or final timing | Soft Scout Telegram candidate | Not automatic |
| `Waiting` | No major conflict, but not near/final enough | Price, confirmation, or decision level | No Scout Telegram | Not automatic |
| `Skip` | C grade, neutral direction, missing levels/R:R, or major location conflict | Major conflict or incomplete plan | No Scout Telegram | Not automatic |

Contradiction: `Enter Now` is used as an alert headline, but `scoutNextStep()` says “Review active entry plan.” Current code does not distinguish setup confirmation from planned-entry execution clearly.

### Raw Entry Status

| Status | Conditions | Entry implication |
| --- | --- | --- |
| `Tradeable` | Price <= 0.25 ATR from planned entry | Entry is close enough for current eval gate |
| `Near Entry` | Price <= 0.5 ATR | Watch closely; not eval eligible |
| `Waiting` | Price <= 1 ATR | Plan exists but price is not near enough |
| `Too Far` | Price > 1 ATR | Not actionable by distance |

### Entry Timing State

| Status | Conditions | Meaning |
| --- | --- | --- |
| `Not Ready` | Missing levels, neutral direction, C grade, location conflict, or too far | No entry |
| `Area Reached` | Location and levels are acceptable, but flow/reaction/confirmation is not enough | Watch zone |
| `Reaction Started` | Price is near and reversal/confirmation/pullback evidence has started | Wait for decision-level confirmation or trigger |
| `Entry Triggered` | `Tradeable`, reversal confirmed, confirmation started, decision level confirmed | Current v1 “entry ready” condition |

### Setup Development Labels

These come from pullback/confirmation scoring:

- `Pullback Active`
- `Pullback Complete`
- `Early Confirmation`
- `Strong Confirmation`
- `Trend Resumption Confirmed`
- Frontend simplified label `Confirmation Started` when reversal or confirmation score >= 3.

Ambiguity: the frontend can say `Confirmation Started` while the raw setup status is `Early Confirmation`, `Strong Confirmation`, or `Trend Resumption Confirmed`. These are related but not identical.

### Frontend Action Labels

The UI translates raw Scout data into action labels:

| UI Value | Short Label | Conditions |
| --- | --- | --- |
| `Entry Proven` | `Entry Ready` | `Entry Triggered` plus decision level confirmed |
| `Decision Pending` | `Needs Break` | `Reaction Started` without decision-level confirmation |
| `At Watch Area` | `Watching Zone` | `Area Reached`, or `Reaction Started` with decision confirmed but no trigger |
| `Trend Watch` | `Trend Watch` | `trendWatchEligible` true |
| `Counter Trend Recovery` | `Counter Trend Recovery` | Special frontend countertrend recovery heuristic |
| `Lower Priority` | `Skip / Low` | Low R:R, flow mismatch, or C grade |
| `Market Read` | `Observe` | Default monitor-only state |

Ambiguity: `Entry Proven`, `Entry Ready`, `Enter Now`, `Tradeable`, and `Entry Triggered` describe overlapping but different checks.

### Developing Setup Panel Labels

The panel displays:

- `ENTER NOW`
- `ALMOST READY`
- `WAIT`
- `SKIP`

It states “Visibility only. Alerts still require the existing Entry Triggered rules.”

Ambiguity: this panel is closer to the desired v2 workflow language, but it is not the canonical scanner lifecycle.

## Alert Logic

Scout Telegram:

- Alert candidates come from `isTradeableScoutSignal()` and `isWatchScoutSignal()`.
- Index symbols are excluded.
- Forex market must be open by New York week check: closed Saturday, opens Sunday 17:00 NY, closes Friday 17:00 NY.
- A report must have `candleTime`.
- Duplicate prevention uses:
  - Data key: kind, pair, timeframe, direction, phase.
  - Alert key: kind, pair, timeframe, direction, phase, candle time, entry, SL, TP1.
- Same data key and candle time is stale-candle suppressed.
- Same alert key inside cooldown is cooldown suppressed.
- Diagnostics record rejected/suppressed/sent states in memory only.

Scout alert routes:

- Urgent: `ENTER NOW` headline.
- Soft: `Almost Ready — Review setup` headline.
- None: no headline.

TradingView/Pine confirmation:

- `/api/tradingview-confirmation` stores zones and rejection confirmations.
- Requires webhook secret, symbol, timeframe, zone type, and direction.
- Zone-only updates store a Pine zone without confirmation.
- Rejection confirmations only send Telegram if a current A/B Scout setup matches symbol/timeframe/direction.
- Pine confirmation alerts also require market open and use a separate cooldown key.

TradingView paper alerts:

- `/api/tradingview-alert` validates direction, entry, SL, TP, calculates R:R, and journals a paper row.
- Telegram is disabled for this route.

## Journal Eligibility and Behavior

There is no automatic Scout journal on Scout alert.

Manual Scout journal:

- Frontend `Log Trade` opens a form with direction, entry, SL, TP1, and notes.
- Save calls `POST /api/journal`.
- Saved quality is `DEVELOPING`.
- Pattern is `${displayPhaseForReport(report)} Scout`.
- Notes include a snapshot of trend, current flow, market type, frontend status, internal grade, raw entry status, timing, proof, structure, Pine state, and location.

TradingView paper alert:

- Automatically creates a journal entry when payload is valid.
- Quality is `DEVELOPING`; trade type is `paper`.

Outcome tracking:

- Current journal stores entry, stop, TP1/TP2/TP3, result/outcome, direction correctness, entry quality, review notes, reversal confirmation, setup grade, news risk, session, and notes.
- It does not store signal time, confirmation time, entry touch time, MFE, MAE, or lifecycle state.

## Market-Hours, Sessions, News, and Stale Candles

Session label:

- UTC 22:00-08:00: `Tokyo` for JPY pairs, otherwise `Off-hours`.
- UTC 08:00-13:00: `London`.
- UTC 13:00-17:00: `London+NY overlap`.
- Otherwise `NY`.

Market open check:

- New York clock.
- Saturday closed.
- Sunday opens 17:00.
- Friday closes 17:00.
- Weekdays open.

News:

- High-impact ForexFactory events within 4 hours ahead or 1 hour behind flag `newsRisk`.
- The flag is displayed and journaled but does not uniformly block Scout reports.

Stale candle:

- Scout Telegram suppresses same kind/pair/timeframe/direction/phase when the candle timestamp has already been processed.
- Diagnostics expose stale-candle status.

## Duplicated or Spread Logic

- Direction/status wording is spread across `server/scoutPhase.ts`, `server/index.ts`, and `public/index.html`.
- `displayScoutSetupStatus()` and `displaySetupStatusForReport()` duplicate pullback/confirmation label logic.
- `scoutStateDisplay()` server-side and `scoutStateForReport()` frontend both translate timing into action states.
- `isIndexSymbol()` and trend/location helpers exist in multiple files.
- Supply/demand and structure primitives are reused in Scout, Trend, Scalp, and Independent Watchlist with different thresholds.
- Journal field normalization exists server-side while frontend builds a separate notes snapshot.
- Alert diagnostics are server-side, but frontend status labels can imply readiness without showing all alert blockers.

## Frozen v1 Risks

- Multiple labels imply entry readiness at different confidence levels.
- `Enter Now` can mean confirmed setup, while entry may still be interpreted as planned-entry review.
- Scout scheduled timeframes are `H4/H1`, while target v2 wants Daily/H4/M30 roles.
- Premium/discount is a simple recent 50-candle midpoint, not a formal dealing range.
- BOS/CHoCH is based on a simplified swing model and global trend classification.
- Supply/demand zones come from BOS-only last opposing candles and do not track freshness/mitigation robustly.
- TP3 is absent from Scout reports even though legacy setups and the desired v2 workflow include TP3/completion.
- Alert duplicate state is in-memory only.
- Journal outcome fields are manually reviewed and not separated from measured market outcomes.
