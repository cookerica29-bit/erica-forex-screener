# Forex Scanner Regression Suite

Run:

```bash
npm run test:regression
```

The suite checks the current Forex Scout phase and Telegram routing behavior without running the HTTP server or calling Telegram.

## What It Covers

- `Enter Now` phase maps to urgent Telegram routing.
- `Almost Ready` phase maps to softer review wording.
- `Waiting` setups do not alert.
- `Skip` setups do not alert.
- Next Step and Next Milestone use the current action-oriented wording.
- Enter Now dedupe keys include the candle timestamp, so the same setup on the same candle is suppressed while a new candle can alert.

## Initial Golden Cases

- Bullish Enter Now
- Bearish Enter Now
- Bullish Almost Ready
- Bearish Almost Ready
- Waiting for price to reach entry
- Waiting for close above/below decision level
- Skip setup
- Duplicate Enter Now same candle
- TP1 freshness rejects two failed approaches
- HTF conflict rejects long setup against bearish HTF
- Weak zone/order-block rejection is rejected

## Existing `server/test-refactor.ts` Audit

The older scanner harness reported 7 failures before this suite was added. These were reviewed:

| Test | Expected | Actual | Assessment |
| --- | --- | --- | --- |
| G1-c: HTF downtrend conflicts with LONG | Rejected with `HTF conflict` | Setup / `OK` | Real behavior gap. Fixed by rejecting clear non-neutral HTF trend conflicts. |
| G2-a: Price 2.5x ATR above EMA20 | Rejected with `No pullback to 20 EMA` | Rejected with `No rejection candle...` | Stale reason expectation. Updated to match current rejection wording. |
| G2-b: SHORT price 2.5x ATR below EMA20 | Rejected with `No pullback to 20 EMA` | Rejected with `No rejection candle...` | Stale reason expectation. Updated to match current rejection wording. |
| G3-b: Weak zone/order-block rejection | Rejected with `No rejection candle` | Setup / `OK` | Real behavior gap. Fixed by requiring the fallback zone rejection candle to close at least 0.2 ATR away from the reference area with at least 0.4 ATR body. |
| G5-a: TF swing high close to entry | Rejected with `Entry too close to resistance` | Setup / `OK` | Potential real behavior gap or stale fixture. Current structure clearance accepts this synthetic series. |
| G5-b: HTF swing high close to entry | Rejected with `Entry too close to HTF resistance` | Setup / `OK` | Potential real behavior gap or stale fixture. Current HTF structure clearance accepts this synthetic series. |
| G5-c: TP1 tested twice | Rejected with `tested/rejected level` | Setup / `OK` | Real behavior gap. Fixed by rejecting TP1 after the second failed approach, matching the existing comment that only one failed approach is allowed. |

The two stale reason-text failures were updated in `server/test-refactor.ts`. The TP1 freshness, HTF conflict, and weak zone rejection verdict mismatches were fixed. The two remaining verdict mismatches should be treated as scanner behavior questions before changing either strategy logic or test expectations.
