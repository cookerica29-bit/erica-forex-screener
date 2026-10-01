# Erica's Forex Scanner
Live OANDA forex screener for 9 pairs.

## Pairs
XAG/USD · XAU/USD · GBP/JPY · NZD/USD · AUD/USD · AUD/JPY · USD/JPY · GBP/USD · EUR/USD

## Setup
1. npm install
2. cp .env.example .env and add your OANDA_API_KEY
3. npm run dev

## Correction-finder HTF zones

Correction discovery is still defined only by an intact Daily swing thesis and a counter-directional 1H leg. Daily/4H zones add transparent location context; they do not create a correction, invalidate the Daily thesis, or turn 30M/5M evidence into an entry signal.

- Demand is the wick-to-body range of a confirmed Daily/4H swing-low candle; supply is the body-to-wick range of a confirmed swing-high candle.
- Swings use three completed candles on each side. A zone is hidden until it is at least four completed source-timeframe candles old, so the newest just-confirmed pivot is not promoted immediately.
- A completed close beyond the zone's distal wick invalidates it. Live price is used only for distance and `IN_ZONE` / `APPROACHING` / `AWAY` state.
- `APPROACHING` means the nearest zone edge is within 1.5 current 1H ATR. Bounds, ATR distance, pips, percent, source timeframe, age, and freshness are shown on the card.
- Freshness is the number of completed post-formation overlaps: `FRESH`, `TESTED_ONCE`, or `TESTED_TWICE`. A third overlap retires the zone as exhausted. Old zones are not discarded just for calendar age if completed candles have respected them.
- For a bullish Daily thesis only relevant demand at/below price is considered; for a bearish thesis only relevant supply at/above price is considered. Without a valid zone, the previous swing-level / Daily 200 SMA / premium-discount location logic remains the fallback.

## Deploy to Railway
Push to GitHub, connect to Railway, add OANDA_API_KEY env var.

## TradingView to Telegram paper alerts
TradingView can send webhook alerts to the scanner, and the scanner will:

1. validate your secret,
2. create a paper journal entry,
3. forward the alert to Telegram.

Railway variables needed:

```bash
DATABASE_URL=mysql://...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TRADINGVIEW_WEBHOOK_SECRET=make_this_a_long_random_phrase
```

TradingView webhook URL:

```text
https://YOUR-RAILWAY-APP.up.railway.app/api/tradingview-alert
```

TradingView alert message:

```json
{
  "secret": "same value as TRADINGVIEW_WEBHOOK_SECRET",
  "mode": "paper",
  "symbol": "{{ticker}}",
  "timeframe": "{{interval}}",
  "action": "buy",
  "entry": "{{close}}",
  "sl": 1.082,
  "tp": 1.091,
  "strategy": "Asia JPY setup",
  "session": "Asia"
}
```

Use `"action": "sell"` for short alerts. The endpoint requires `symbol`, `action`, `entry`, `sl`, and `tp` so every paper alert has measurable risk/reward.
