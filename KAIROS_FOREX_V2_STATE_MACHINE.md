# Kairos Forex v2 State Machine

Sprint Zero design document. This defines the desired future lifecycle. It must not be implemented or wired into alerts until a later migration phase.

## Lifecycle Flow

```text
BUILDING
  -> ALMOST_READY
  -> LIQUIDITY_SWEPT
  -> STRUCTURE_CONFIRMED
  -> SETUP_CONFIRMED_WAITING_FOR_ENTRY
  -> ENTRY_REACHED
  -> POSITION_RUNNING
  -> TP1_REACHED
  -> TP2_REACHED
  -> TP3_REACHED
  -> COMPLETED
```

Invalidation can happen before entry. Stop can happen after entry.

```text
BUILDING / ALMOST_READY / LIQUIDITY_SWEPT / STRUCTURE_CONFIRMED / SETUP_CONFIRMED_WAITING_FOR_ENTRY
  -> INVALIDATED

POSITION_RUNNING / TP1_REACHED / TP2_REACHED
  -> STOPPED
  -> COMPLETED
```

## State Contract

| State | Purpose | Required Evidence | Allowed Prior States | Allowed Next States | Invalidation | Visible Label | Next Step | Alert | Journal |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `BUILDING` | Identify a developing setup without implying action. | Daily context exists; H4 has possible direction or setup area; M30 may be unresolved. | New setup. | `ALMOST_READY`, `INVALIDATED`. | Direction flips, planned area invalid, high-impact news makes read unusable, structure becomes choppy. | Building | Continue monitoring. The setup is still developing. | No alert. | No trade journal. Optional diagnostic snapshot only. |
| `ALMOST_READY` | Show setup is close but not confirmed. | Context, location, and plan are mostly aligned; at least one required item is missing. | `BUILDING`. | `LIQUIDITY_SWEPT`, `STRUCTURE_CONFIRMED`, `SETUP_CONFIRMED_WAITING_FOR_ENTRY`, `INVALIDATED`. | Missing requirement worsens, price runs away, zone invalidates, context conflicts. | Almost Ready | The setup is close, but confirmation is incomplete. | Future soft alert `ALMOST_READY`. | No trade journal; may log setup watch event in v2 measurements. |
| `LIQUIDITY_SWEPT` | Mark that relevant liquidity was taken. | Price trades through identified buy-side/sell-side liquidity and closes back inside or shows rejection. | `BUILDING`, `ALMOST_READY`. | `STRUCTURE_CONFIRMED`, `INVALIDATED`. | Sweep candle closes through level without rejection and continues as liquidity run; opposing structure invalidates plan. | Liquidity Swept | Liquidity has been taken. Wait for structure confirmation. | Future alert `ALMOST_READY` only if setup is otherwise close; no urgent alert. | Store sweep time/level in measured setup record. |
| `STRUCTURE_CONFIRMED` | Mark that post-sweep structure has shifted in setup direction. | H4 or M30 BOS/CHoCH/displacement confirms intended direction from planned area. | `ALMOST_READY`, `LIQUIDITY_SWEPT`. | `SETUP_CONFIRMED_WAITING_FOR_ENTRY`, `ENTRY_REACHED`, `INVALIDATED`. | Protected high/low breaks against setup; displacement fails; price closes beyond invalidation zone. | Structure Confirmed / Enter Now | Setup confirmed. Wait for price to reach the planned entry at [price]. | Future `SETUP_CONFIRMED` alert. | Store confirmation time. Do not create executed-trade journal unless user enters. |
| `SETUP_CONFIRMED_WAITING_FOR_ENTRY` | Separate setup confirmation from price execution readiness. | Full setup confirmation plus planned entry or entry zone not yet reached. | `STRUCTURE_CONFIRMED`. | `ENTRY_REACHED`, `INVALIDATED`. | Stale entry, missed entry, price reaches TP objective before entry, invalidation level breaks. | Enter Now | Setup confirmed. Wait for price to reach the planned entry at [price]. | Future `SETUP_CONFIRMED`; duplicate-safe. | Track planned entry and wait time. |
| `ENTRY_REACHED` | Tell trader price touched planned entry area. | Current price/candle touches planned entry or entry zone after setup confirmation. | `STRUCTURE_CONFIRMED`, `SETUP_CONFIRMED_WAITING_FOR_ENTRY`. | `POSITION_RUNNING`, `INVALIDATED`, `COMPLETED` if no trade taken and setup expires. | Touch occurs after stale-entry window, violent candle through stop zone, no risk-rule clearance. | Entry Reached | Price has reached the planned entry. Execute only if your risk rules allow. | Future `ENTRY_REACHED` alert. | Store entry touch time. Actual entry remains manual unless broker integration is later added. |
| `POSITION_RUNNING` | Track active trade management after manual execution. | Trader marks actual entry or v2 journal records execution. | `ENTRY_REACHED`. | `TP1_REACHED`, `TP2_REACHED`, `TP3_REACHED`, `STOPPED`, `COMPLETED`. | Stop hit, manual close, invalid manual update. | Position Running | Trade is active. Follow the management plan. | No setup alert; optional management reminders later. | Trade journal active with actual entry time/price. |
| `TP1_REACHED` | First target reached. | Market touches TP1 after active entry. | `POSITION_RUNNING`. | `TP2_REACHED`, `STOPPED`, `COMPLETED`. | Stop/management exit after TP1. | TP1 | TP1 reached. Consider taking partial profits and managing the remainder according to plan. | Future `TP1_REACHED`. | Store TP1 time, MFE/MAE snapshot. |
| `TP2_REACHED` | Second target reached. | Market touches TP2 after active entry. | `TP1_REACHED`, `POSITION_RUNNING` if TP1 skipped through. | `TP3_REACHED`, `STOPPED`, `COMPLETED`. | Stop/management exit after TP2. | TP2 | TP2 reached. Continue following the management plan. | Future `TP2_REACHED`. | Store TP2 time. |
| `TP3_REACHED` | Final planned target reached. | Market touches TP3 after active entry. | `TP2_REACHED`, `TP1_REACHED`, `POSITION_RUNNING` if price moves directly. | `COMPLETED`. | None; this is terminal-progress before completion. | TP3 | TP3 reached. Complete the trade review. | Future `TP3_REACHED`. | Store TP3 time and completion reason candidate. |
| `STOPPED` | Stop or invalid management exit occurred. | Market touches stop after active entry, or user records stop/failed result. | `POSITION_RUNNING`, `TP1_REACHED`, `TP2_REACHED`. | `COMPLETED`. | None. | Stopped | Stop reached. Complete the review and record what failed. | Future `STOP_REACHED`. | Store stop time, MAE, completion reason. |
| `INVALIDATED` | No entry should be taken. | Setup invalidation before execution. | Any pre-entry state. | `COMPLETED`, or new setup as separate ID. | None; terminal for original setup. | Invalidated | No entry. The original setup is no longer valid. | Future `SETUP_INVALIDATED`. | Store invalidation time/reason as setup outcome, not trade result. |
| `COMPLETED` | Close the lifecycle for measurement. | TP3, stop, invalidation, manual close, missed entry, stale entry, or expiry. | Any terminal or managed state. | None. | None. | Completed | Review complete. Use the outcome data to improve the process. | No new alert by default. | Finalize measured market outcome and manual review separately. |

## Missing Requirement Contract

`ALMOST_READY` must always expose one primary missing requirement, selected from objective evidence:

- Waiting for liquidity sweep.
- Waiting for structure confirmation.
- Waiting for displacement.
- Waiting for price to return to planned entry.
- Waiting for entry zone touch.
- Waiting for session/news risk to clear.
- Waiting for valid R:R.
- Waiting for planned entry to be recalculated.

The main card should show one missing requirement. A future Further Analysis view can show the full evidence list.

## Alert Eligibility

Future alert events map to states:

- `ALMOST_READY`: first transition into `ALMOST_READY` when setup is A-grade quality but missing final evidence.
- `SETUP_CONFIRMED`: first transition into `STRUCTURE_CONFIRMED` or `SETUP_CONFIRMED_WAITING_FOR_ENTRY`.
- `ENTRY_REACHED`: first touch of planned entry/entry zone after setup confirmation.
- `TP1_REACHED`, `TP2_REACHED`, `TP3_REACHED`: first target touches after active position.
- `STOP_REACHED`: first stop touch after active position.
- `SETUP_INVALIDATED`: first pre-entry invalidation after setup had reached `ALMOST_READY` or better.

Duplicate prevention should use a lifecycle setup ID, symbol, direction, timeframe role set, state/event, planned entry, stop, targets, and the evidence candle time.

## Journal Behavior

Setup states and trade states are different:

- Pre-entry states belong in a v2 setup measurement table.
- `POSITION_RUNNING` and later belong in trade journal rows only after actual user entry is known.
- Market-measured events must be stored separately from manual review fields.
- A setup can be invalidated or missed without creating a losing trade.

## State Machine Guardrails

- Do not promote directly from `BUILDING` to `ENTRY_REACHED`; confirmation must exist first.
- Do not use `Enter Now` to mean market execution at any price.
- Do not advance because a label says “bullish” or “bearish”; require the coded evidence for the transition.
- Do not let M30 alone override Daily/H4 context unless the H4 decision state permits an execution trigger.
- Do not carry a stale entry forward after the setup objective has already run or the invalidation level has broken.
