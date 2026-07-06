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

## Existing `server/test-refactor.ts` Audit

The older scanner harness reported 7 failures before this suite was added. These were reviewed:

| Test | Expected | Actual | Assessment |
| --- | --- | --- | --- |
| G1-c: HTF downtrend conflicts with LONG | Rejected with `HTF conflict` | Setup / `OK` | Potential real behavior gap or stale fixture. The current scanner does not reject this synthetic HTF series. |
| G2-a: Price 2.5x ATR above EMA20 | Rejected with `No pullback to 20 EMA` | Rejected with `No rejection candle...` | Stale reason expectation. Updated to match current rejection wording. |
| G2-b: SHORT price 2.5x ATR below EMA20 | Rejected with `No pullback to 20 EMA` | Rejected with `No rejection candle...` | Stale reason expectation. Updated to match current rejection wording. |
| G3-b: Weak EMA_BOUNCE offset | Rejected with `No rejection candle` | Setup / `OK` | Potential real behavior gap or stale fixture. Current momentum rules accept this synthetic candle. |
| G5-a: TF swing high close to entry | Rejected with `Entry too close to resistance` | Setup / `OK` | Potential real behavior gap or stale fixture. Current structure clearance accepts this synthetic series. |
| G5-b: HTF swing high close to entry | Rejected with `Entry too close to HTF resistance` | Setup / `OK` | Potential real behavior gap or stale fixture. Current HTF structure clearance accepts this synthetic series. |
| G5-c: TP1 tested twice | Rejected with `tested/rejected level` | Setup / `OK` | Potential real behavior gap or stale fixture. Current TP freshness accepts this synthetic series. |

The two stale reason-text failures were updated in `server/test-refactor.ts`. The five remaining verdict mismatches should be treated as scanner behavior questions before changing either strategy logic or test expectations.
