# Erica's Forex Scanner
Live OANDA forex screener for 9 pairs.

## Pairs
XAG/USD · XAU/USD · GBP/JPY · NZD/USD · AUD/USD · AUD/JPY · USD/JPY · GBP/USD · EUR/USD

## Setup
1. npm install
2. cp .env.example .env and add your OANDA_API_KEY
3. npm run dev

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
