# Kairos Forex v2 Blueprint

Sprint Zero design document. This describes the target workflow and evidence model for a future parallel v2 scanner. It intentionally does not change production scanner logic.

## Product Goal

Kairos Forex v2 should guide Erica through a repeatable trading process:

```text
Market Scan
-> Building
-> Almost Ready
-> Liquidity Swept
-> Structure Confirmed
-> Enter Now
-> Wait for Planned Entry
-> Entry Reached
-> Execute Trade
-> Position Running
-> TP1
-> TP2
-> TP3 / Completed
```

The scanner should reinforce patience. It should show where the setup is, what is missing, what to do next, and where the planned entry is.

## Non-Goals for This Sprint

- No production scanner changes.
- No alert changes.
- No journal behavior changes.
- No changed entries, stops, targets, grades, or card counts.
- No v1 replacement.
- No v1 deletion.
- No partial v2 deployment.
- No stock-scanner logic mixed into forex strategy calculations.
- No new APIs.

## Current Code Mapping to v2 Roles

### Daily - Context

Future role:

- Higher-timeframe directional structure.
- Major dealing range.
- Premium/discount.
- Major liquidity objectives.
- Major supply/demand context.

Current mapping:

- `analyzeDirectionalFrame(dailyCandles, 'Daily')` scores swing structure, latest BOS/CHoCH, and EMA20/EMA50.
- `buildTrendSetupPhase()` exposes `dailyTrendDirection`, `dailySwingStructure`, `dailyBosDirection`, and `dailyChochDirection`.
- Premium/discount is not Daily-specific; Scout uses the current scan timeframe's last 50 candles.
- Major liquidity objectives are not formally modeled.
- Major supply/demand exists only through `computeStructures()` when called on a given candle set; the main Scout zone does not explicitly use Daily zones.

Gap:

- Daily is currently one vote in a broader trend model, not a dedicated context authority.

### H4 - Decision

Future role:

- Active market structure.
- Pullback versus reversal.
- Liquidity sweep.
- Displacement.
- Fresh order block or supply/demand zone.
- Setup direction.
- Planned trade area.

Current mapping:

- Scheduled legacy scan runs H4 and M30.
- Scheduled Scout scan runs H4 and H1.
- `h4TrendDirection` is included in Scout context.
- `computeStructures()` can create supply/demand zones from H4 if called with H4 candles, but Scout's active entry zone is derived from the current scan timeframe.
- Pullback/reversal are scored on the current scan timeframe, not always H4.

Gap:

- H4 is not consistently the primary decision timeframe. It sometimes provides context and sometimes is itself the scanned setup frame.

### M30 - Execution

Future role:

- Price reached planned area.
- Reaction started.
- Minor structure shift.
- Entry trigger.
- Planned entry reached.

Current mapping:

- Manual Scout can scan M30; diagnostics can include M30.
- Scheduled Scout does not include M30.
- Independent watchlist uses M30 as the candidate frame.
- Scalp mode uses M15/M5 and is a separate strategy path.
- `entryTimingState` approximates execution readiness with `Area Reached`, `Reaction Started`, and `Entry Triggered`.

Gap:

- M30 is not consistently tied to H4 planned areas. It can behave like another independent signal generator.

## Future Setup Requirements

These are candidate definitions for later shadow-mode implementation. They are not v1 behavior.

### Directional Context

Daily market structure:

- Bullish when the protected low holds and price creates a valid BOS above the prior swing high, or maintains HH/HL sequence inside the active dealing range.
- Bearish when the protected high holds and price creates a valid BOS below the prior swing low, or maintains LH/LL sequence.
- Neutral when structure is internal, overlapping, or conflicting.

H4 market structure:

- Bullish decision context when H4 is aligned with Daily or executing a clearly defined Daily pullback into discount/demand.
- Bearish decision context when H4 is aligned with Daily or executing a clearly defined Daily pullback into premium/supply.

Trend continuation versus pullback:

- Continuation: Daily and H4 structure agree and H4 pullback holds above/below the protected structure point.
- Pullback: H4 moves against Daily direction without breaking the Daily protected level.

True reversal versus temporary correction:

- Reversal candidate requires liquidity sweep, displacement, and CHoCH/BOS that breaks the protected level of the prior move.
- Temporary correction is a counter-move that has not displaced through protected structure.

### Liquidity

Buy-side liquidity:

- Resting liquidity above swing highs, equal highs, prior session highs, previous day high, or obvious range highs.

Sell-side liquidity:

- Resting liquidity below swing lows, equal lows, prior session lows, previous day low, or obvious range lows.

Equal highs/lows:

- Two or more swing points whose prices are within a tolerance such as 0.1-0.25 ATR or pair-specific pip threshold.

Swing liquidity:

- Liquidity resting beyond a confirmed swing high/low with enough candles on both sides to be meaningful.

Liquidity sweep:

- Bullish setup: candle low trades below sell-side liquidity, then closes back above the swept level or back inside the range with rejection evidence.
- Bearish setup: candle high trades above buy-side liquidity, then closes back below the swept level or back inside the range with rejection evidence.

Liquidity run without rejection:

- Price trades through liquidity and closes beyond it with continuation body, no meaningful wick rejection, and no return inside the prior range. This should not advance to `LIQUIDITY_SWEPT`.

### Structure

BOS:

- Break of structure in the current trend direction by candle close beyond a confirmed swing high/low.

CHoCH:

- First meaningful close through the protected structure point against the prior trend after a liquidity event or displacement.

Minor structure shift:

- M30 or lower-timeframe close through a minor protected high/low that confirms reaction from the planned H4 area.

Displacement:

- A directional candle or candle sequence with body size meaningfully greater than recent average/ATR, closing away from the swept area with limited opposing wick.

Protected high:

- The swing high whose break would invalidate a bearish setup or confirm a bullish reversal.

Protected low:

- The swing low whose break would invalidate a bullish setup or confirm a bearish reversal.

### Location

Premium:

- Price is above the equilibrium of the active Daily/H4 dealing range.

Discount:

- Price is below the equilibrium of the active Daily/H4 dealing range.

Equilibrium:

- Middle area around the dealing range midpoint. Candidate tolerance should be explicit, for example 45%-55% of range.

Fresh supply:

- Last up candle/range before bearish displacement that has not been meaningfully mitigated.

Fresh demand:

- Last down candle/range before bullish displacement that has not been meaningfully mitigated.

Fresh order block:

- Unmitigated source candle/range of displacement that led to BOS/CHoCH and remains inside valid context.

Mitigated zone:

- Price has returned into the zone at least once. It can still be usable if reaction/displacement remains valid, but it should be lower freshness.

Invalid zone:

- Candle close through the far side of the zone, or protected structure broken against the setup.

### Execution

Planned entry:

- A specific price derived from the planned H4/M30 trade area before execution.

Entry zone:

- A bounded area around the planned entry, typically the order block/supply/demand zone or refined M30 area.

Reaction started:

- Price touches the entry zone and begins rejecting with wick/body evidence in the setup direction.

Entry trigger:

- M30 minor structure shift or displacement from the entry zone after setup confirmation.

Entry reached:

- Price trades at or through the planned entry/entry zone after setup confirmation.

Stale entry:

- Planned entry is touched too late, after the target objective has run, after invalidation, or after a configured time/session expiration.

Missed entry:

- Setup confirms and moves to target area without touching planned entry, or touches while unavailable and no valid retest occurs.

Do not chase:

- If price has left the planned entry area and reward-to-risk or invalidation no longer matches the plan, the card must keep the planned entry visible and mark the setup as missed/stale instead of moving entry to current price.

## Card Information Architecture

Main-card principle:

The card answers:

- Where is this setup?
- What is missing?
- What should I do next?
- Where is my planned entry?

Draft layout:

```text
Pair / Timeframe
Status
Direction

Trade Readiness
Context
Liquidity
Structure
Location
Execute

Next Step

Execution Plan
Current Price
Planned Entry
Stop
TP1
TP2
TP3
R:R

Missing Requirement
```

Main card should stay compact. Explanations belong in a future Forex Further Analysis view.

## Wording Contract

Use exact wording unless later product review changes it.

Building:

- Next Step: Continue monitoring. The setup is still developing.

Almost Ready:

- Next Step: The setup is close, but confirmation is incomplete.
- Missing: `[actual missing requirement]`

Liquidity Swept:

- Next Step: Liquidity has been taken. Wait for structure confirmation.

Structure Confirmed / Enter Now:

- Next Step: Setup confirmed. Wait for price to reach the planned entry at `[price]`.

Entry Reached:

- Next Step: Price has reached the planned entry. Execute only if your risk rules allow.

Position Running:

- Next Step: Trade is active. Follow the management plan.

TP1:

- Next Step: TP1 reached. Consider taking partial profits and managing the remainder according to plan.

Invalidated:

- Next Step: No entry. The original setup is no longer valid.

Avoid:

- Mixed buy/sell-arrow language as primary communication.
- “Enter Now” as a synonym for market order at the current price.
- Changing planned entry to current price after confirmation.

## Alert Lifecycle

Future alerts:

| Event | Trigger | Payload | Duplicate Key | Dashboard Open? | Server-Side Required? |
| --- | --- | --- | --- | --- | --- |
| `ALMOST_READY` | First transition into `ALMOST_READY` for high-quality setup | Setup ID, pair, direction, state, timeframe roles, missing requirement, planned entry/SL/TPs, evidence candle time | setup ID + event + evidence candle + planned entry | No | Yes |
| `SETUP_CONFIRMED` | First transition into `STRUCTURE_CONFIRMED` or waiting-for-entry state | Setup ID, pair, direction, confirmation evidence, planned entry, stop, targets, next step | setup ID + event + confirmation candle + planned entry | No | Yes |
| `ENTRY_REACHED` | First touch of planned entry/zone after confirmation | Setup ID, pair, planned entry, current price, risk reminder | setup ID + event + entry touch candle + entry | No | Yes |
| `TP1_REACHED` | First touch of TP1 after active position | Setup/trade ID, TP1, time, MFE/MAE snapshot | trade ID + TP1 + candle | No | Yes |
| `TP2_REACHED` | First touch of TP2 after active position | Setup/trade ID, TP2, time | trade ID + TP2 + candle | No | Yes |
| `TP3_REACHED` | First touch of TP3 after active position | Setup/trade ID, TP3, completion candidate | trade ID + TP3 + candle | No | Yes |
| `STOP_REACHED` | First touch of stop after active position | Setup/trade ID, stop, time, completion reason | trade ID + stop + candle | No | Yes |
| `SETUP_INVALIDATED` | Pre-entry invalidation after meaningful setup state | Setup ID, invalidation reason, invalidation level/time | setup ID + invalidation reason + candle | No | Yes |

The intended future behavior is server-side Telegram delivery even when the browser is closed.

## Session Behavior

Erica's routine:

- Setups may be entered during Asia or London.
- Trades may remain open through New York.
- Erica no longer stays awake all night.
- New York is often used for stock-options activity and forex management.

Future v2 treatment:

- Asia setup discovery: allow Building/Almost Ready discovery and planned-area preparation. Avoid forcing entries solely because Asia liquidity tapped a level.
- London confirmation and entry: preferred confirmation/execution window, but still require evidence.
- New York continuation/management: allow management states, TP alerts, stop alerts, and continuation tracking.
- Late New York entries: do not hard-block by session alone; mark session caution when liquidity/volatility quality is poor or rollover/weekend risk approaches.
- Overnight holding: preserve position-running state and management plan across sessions.
- Session transitions: state should carry forward unless invalidated, stale, or materially changed.
- High-impact news: flag risk and optionally pause new entry alerts around event windows; do not erase already-running management states.

The goal is to support workflow, not eliminate valid trades merely because a candle formed outside a preferred session.

## Outcome Tracking Requirements

Future measured setup/trade data:

- Signal time.
- Confirmation time.
- Planned entry.
- Entry touch time.
- Actual entry time.
- Stop.
- TP1, TP2, TP3.
- Time to entry.
- Time to TP1, TP2, TP3.
- MFE.
- MAE.
- Direction correct.
- Entry quality.
- Setup grade.
- Session entered.
- Session target reached.
- Completion reason.

Keep measured market outcomes separate from manually reviewed results. A missed or invalidated setup is not a losing trade unless Erica actually entered.

## Reusable Components

Safely reusable from current forex scanner:

- OANDA candle fetching and normalization.
- Pair normalization aliases.
- Market-hours utility, with future refinement.
- High-impact news risk lookup.
- Basic swing detection, with validation and possible stricter definitions.
- ATR/EMA/RSI helper calculations.
- Alert duplicate-key pattern and stale-candle suppression concept.
- Journal persistence infrastructure.
- TradingView/Pine zone/confirmation ingestion as an optional evidence source.
- Regression test harness pattern.

Reusable from stock workflow:

- Clear workflow/card language.
- Productivity/dashboard organization.
- “What happened / what needs attention / what should be worked first” framing.
- Further Analysis separation from main-card summary.

Reusable from Expected Move/setup diagnostics:

- Shadow-mode comparison.
- Diagnostics summaries.
- Evidence disagreement recording.
- Idempotent event keys.
- Outcome timing measurements.

Do not reuse directly:

- Stock scanner calculations or market-specific assumptions.
- Stock option session behavior.
- Equity expected-move math for forex directional logic.
- Scalp mode thresholds as H4/M30 swing-trade evidence.
- Current v1 label names as canonical v2 states without mapping.
