// Required env vars: OANDA_API_KEY, OANDA_ACCOUNT_TYPE
// Optional alerts/execution: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TRADINGVIEW_WEBHOOK_SECRET, BOT_URL, WEBHOOK_SECRET
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { getJournalEntries, createJournalEntry, updateJournalEntry, deleteJournalEntry, clearAllJournalEntries, getPatternStats } from './db.js';
import { debugScan, Setup, JournalStats } from './scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());

const server = createServer(app);

app.use(express.json());
app.use(express.text({ type: 'text/plain' }));

let latestSetups: Setup[] = [];
let latestRejected: Array<{ pair: string; reason: string; detail: any; granularity: string }> = [];
let cachedJournalStats: JournalStats = {};
let lastScanTime: string | null = null;
let pendingApprovals: (Setup & { id: string })[] = [];

async function sendTelegram(text: string, parseMode?: 'Markdown') {
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;
  if (!telegramToken || !telegramChatId) {
    console.warn('[Telegram] Alerts disabled: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    return { ok: false, skipped: true, error: 'Telegram not configured' };
  }

  const response = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: telegramChatId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
    }),
  });
  const data = await response.json() as any;
  if (!data.ok) console.error('[Telegram] API error:', JSON.stringify(data));
  return data;
}

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const num = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(num) ? num : undefined;
}

function normalizeDirection(value: unknown): 'LONG' | 'SHORT' | undefined {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'BUY' || normalized === 'LONG') return 'LONG';
  if (normalized === 'SELL' || normalized === 'SHORT') return 'SHORT';
  return undefined;
}

function normalizeSymbol(value: unknown) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return { symbol: '', displaySymbol: '' };
  const compact = raw.replace(/^OANDA:/, '').replace(/[^A-Z]/g, '');
  if (compact.length === 6) {
    return { symbol: `${compact.slice(0, 3)}_${compact.slice(3)}`, displaySymbol: `${compact.slice(0, 3)}/${compact.slice(3)}` };
  }
  return { symbol: compact, displaySymbol: raw.replace('_', '/') };
}

function parseTradingViewBody(body: any): any {
  if (typeof body !== 'string') return body || {};
  try {
    return JSON.parse(body);
  } catch {
    return { message: body };
  }
}

function calculateRr(direction: 'LONG' | 'SHORT', entry: number, stopLoss: number, tp: number) {
  const risk = direction === 'LONG' ? entry - stopLoss : stopLoss - entry;
  const reward = direction === 'LONG' ? tp - entry : entry - tp;
  if (risk <= 0 || reward <= 0) return undefined;
  return Number((reward / risk).toFixed(1));
}

function queueSetups(setups: Setup[]) {
  const premium = setups.filter(s => s.quality === 'PREMIUM' || s.quality === 'STRONG');
  for (const setup of premium) {
    const exists = pendingApprovals.some(
      p => p.pair === setup.pair && p.timeframe === setup.timeframe &&
           Math.abs(p.entry - setup.entry) < (setup.pair.includes('JPY') ? 0.1 : 0.001)
    );
    if (!exists) {
      pendingApprovals.push({ ...setup, id: `${setup.pair}-${Date.now()}` });
      const dir = setup.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
      const emoji = setup.quality === 'PREMIUM' ? '🔥' : '⚡';
      const label = setup.quality === 'PREMIUM' ? 'PREMIUM' : 'STRONG';
      const newsPrefix = setup.newsRisk ? '⚠️ NEWS RISK\n' : '';
      const text = `${newsPrefix}${emoji} *${label} SETUP — ${setup.pair.replace('_','/')}*\n${dir} | R:R: ${setup.rrRatio} | ${setup.session} session\nEntry: ${setup.entry} | SL: ${setup.sl.toFixed(5)} | TP: ${setup.tp1.toFixed(5)}\nPattern: ${setup.pattern} | TF: ${setup.timeframe}\n→ https://erica-forex-screener-production.up.railway.app`;
      sendTelegram(text, 'Markdown').then((data: any) => {
        if (data.ok) console.log(`[Telegram] Alert sent for ${setup.pair} ${setup.quality}`);
      }).catch((e: any) => console.error('[Telegram] fetch failed:', e.message));
    }
  }
  if (pendingApprovals.length > 20) {
    pendingApprovals = pendingApprovals.slice(-20);
  }
}

async function scheduledScan(forceTf?: string) {
  const tfsToRun = forceTf ? [forceTf] : ['H4', 'M30'];
  const tfs = tfsToRun.join(' + ');
  console.log(`[Scanner] Running scan at ${new Date().toISOString()} (${tfs})`);
  try {
    // Refresh journal stats for historical edge/weakness scoring
    try { cachedJournalStats = await getPatternStats(); } catch { /* non-fatal */ }

    const debugResults = await Promise.all(tfsToRun.map(tf => debugScan(tf, 1.5, cachedJournalStats)));
    const h4Debug  = debugResults[0] ?? [];
    const m30Debug = debugResults[1] ?? [];

    const ord: Record<string,number> = { PREMIUM: 0, STRONG: 1, DEVELOPING: 2 };
    latestSetups = [
      ...h4Debug.filter(r => r.result === 'SETUP' && r.setup).map(r => r.setup!),
      ...m30Debug.filter(r => r.result === 'SETUP' && r.setup).map(r => r.setup!),
    ].sort((a, b) => ord[a.quality] - ord[b.quality] || b.rrRatio - a.rrRatio);

    // Near-misses: rejected pairs that had a trend direction detected
    latestRejected = [
      ...h4Debug.filter(r => r.result === 'REJECTED' && r.detail?.trend).map(r => ({ pair: r.pair, reason: r.reason ?? '', detail: r.detail, granularity: 'H4' })),
      ...m30Debug.filter(r => r.result === 'REJECTED' && r.detail?.trend).map(r => ({ pair: r.pair, reason: r.reason ?? '', detail: r.detail, granularity: 'M30' })),
    ];

    lastScanTime = new Date().toISOString();
    console.log(`[Scanner] Found ${latestSetups.length} setups (${tfs}), ${latestSetups.filter(s=>s.quality==='PREMIUM').length} premium, ${latestRejected.length} near-misses`);
    queueSetups(latestSetups);
  } catch(e: any) {
    console.error('[Scanner] Scan failed:', e.message);
  }
}

// Run immediately on startup then every 15 minutes
scheduledScan();
setInterval(scheduledScan, 15 * 60 * 1000);

// ─── SCANNER API ──────────────────────────────────────────────────────────────
app.get('/api/setups', (_req, res) => {
  res.json({ setups: latestSetups, lastScanTime, count: latestSetups.length });
});

app.post('/api/scan', async (req, res) => {
  const tf = (req.query.tf as string) || undefined;
  await scheduledScan(tf);
  res.json({ setups: latestSetups, lastScanTime, count: latestSetups.length });
});

app.get('/api/debug', async (req, res) => {
  const granularity = (req.query.tf as string) || 'H1';
  const minRR = parseFloat((req.query.minRR as string) || '1.5');
  const pairFilter = (req.query.pair as string) || null;
  try {
    const results = await debugScan(granularity, minRR, cachedJournalStats);
    const filtered = pairFilter ? results.filter(r => r.pair === pairFilter) : results;
    res.json(filtered);
  } catch(e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/near-misses', (_req, res) => {
  res.json(latestRejected);
});

const OANDA_API_KEY = process.env.OANDA_API_KEY || '';
const OANDA_ACCOUNT_TYPE = process.env.OANDA_ACCOUNT_TYPE || 'practice';
const OANDA_BASE = OANDA_ACCOUNT_TYPE === 'live'
  ? 'https://api-fxtrade.oanda.com'
  : 'https://api-fxpractice.oanda.com';

// ─── OANDA CANDLES ────────────────────────────────────────────────────────────
app.get('/api/candles', async (req, res) => {
  const { instrument, granularity, count = '200' } = req.query as Record<string, string>;
  if (!instrument || !granularity) return res.status(400).json({ error: 'Missing params' });
  if (!OANDA_API_KEY) return res.status(500).json({ error: 'OANDA_API_KEY not configured' });
  try {
    const url = `${OANDA_BASE}/v3/instruments/${instrument}/candles?granularity=${granularity}&count=${count}&price=M`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${OANDA_API_KEY}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) return res.status(response.status).json({ error: `OANDA error: ${response.status}` });
    const data = await response.json() as any;
    const candles = data.candles.filter((c: any) => c.complete).map((c: any) => ({
      t: c.time, o: parseFloat(c.mid.o), h: parseFloat(c.mid.h),
      l: parseFloat(c.mid.l), c: parseFloat(c.mid.c), v: c.volume,
    }));
    return res.json(candles);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch OANDA data' });
  }
});

// ─── JOURNAL API ──────────────────────────────────────────────────────────────
app.get('/api/journal', async (_req, res) => {
  try {
    const entries = await getJournalEntries();
    return res.json(entries);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch journal' });
  }
});

app.post('/api/journal', async (req, res) => {
  try {
    const b = req.body;
    // Normalize field names — scanner uses pair/sl/rrRatio; client form uses symbol/stopLoss/rr1
    const normalized = {
      symbol:        b.symbol      || b.pair,
      displaySymbol: b.displaySymbol || (b.pair ? b.pair.replace('_', '/') : undefined),
      direction:     b.direction,
      quality:       b.quality,
      pattern:       b.pattern,
      timeframe:     b.timeframe,
      entry:         b.entry,
      stopLoss:      b.stopLoss    || b.sl,
      tp1:           b.tp1,
      tp2:           b.tp2,
      tp3:           b.tp3,
      rr1:           b.rr1         || b.rrRatio,
      rr2:           b.rr2,
      rr3:           b.rr3,
      confluences:   b.confluences || b.confluence,
      session:       b.session,
      newsRisk:      b.newsRisk ?? b.news_risk ?? false,
    };
    const id = await createJournalEntry(normalized);
    return res.json({ success: true, id });
  } catch (err) {
    console.error('[Journal] POST error:', err);
    return res.status(500).json({ error: 'Failed to create journal entry' });
  }
});

app.patch('/api/journal/:id', async (req, res) => {
  try {
    const b = req.body;
    await updateJournalEntry(parseInt(req.params.id), {
      outcome: b.outcome,
      pnl: b.pnl,
      notes: b.notes,
      tradeType: b.trade_type ?? b.tradeType,
    });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update journal entry' });
  }
});

app.delete('/api/journal/:id', async (req, res) => {
  try {
    await deleteJournalEntry(parseInt(req.params.id));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete journal entry' });
  }
});

app.delete('/api/journal', async (_req, res) => {
  try {
    await clearAllJournalEntries();
    cachedJournalStats = {};
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to clear journal' });
  }
});

// ─── TRADINGVIEW PAPER ALERT RELAY ────────────────────────────────────────────
app.post('/api/tradingview-alert', async (req, res) => {
  try {
    const configuredSecret = process.env.TRADINGVIEW_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;
    if (!configuredSecret) {
      return res.status(500).json({ error: 'TradingView alerts disabled: missing TRADINGVIEW_WEBHOOK_SECRET' });
    }

    const body = parseTradingViewBody(req.body);
    if (body.secret !== configuredSecret) {
      return res.status(401).json({ error: 'Invalid TradingView alert secret' });
    }

    const { symbol, displaySymbol } = normalizeSymbol(body.symbol || body.ticker || body.pair);
    const direction = normalizeDirection(body.action || body.direction || body.side);
    const entry = toNumber(body.entry || body.price || body.close);
    const stopLoss = toNumber(body.sl || body.stop || body.stopLoss || body.stop_loss);
    const tp1 = toNumber(body.tp || body.tp1 || body.takeProfit || body.take_profit);
    const timeframe = String(body.timeframe || body.interval || 'TradingView').trim();
    const strategy = String(body.strategy || body.pattern || 'TradingView Alert').trim();
    const session = String(body.session || 'TradingView').trim();

    if (!symbol || !direction || entry === undefined || stopLoss === undefined || tp1 === undefined) {
      return res.status(400).json({
        error: 'TradingView alert must include symbol, action/direction, entry, sl, and tp',
        received: {
          symbol: Boolean(symbol),
          direction: Boolean(direction),
          entry: entry !== undefined,
          sl: stopLoss !== undefined,
          tp: tp1 !== undefined,
        },
      });
    }

    const rr1 = calculateRr(direction, entry, stopLoss, tp1);
    if (rr1 === undefined) {
      return res.status(400).json({ error: 'Invalid risk/reward: check entry, sl, tp, and direction' });
    }

    const id = await createJournalEntry({
      symbol,
      displaySymbol,
      direction,
      quality: 'DEVELOPING',
      pattern: strategy,
      timeframe,
      entry,
      stopLoss,
      tp1,
      rr1,
      confluences: ['TradingView alert', body.mode === 'paper' ? 'Paper trade' : 'Alert relay'],
      session,
      newsRisk: Boolean(body.newsRisk || body.news_risk),
      notes: `TradingView paper alert${body.message ? `: ${String(body.message).slice(0, 300)}` : ''}`,
      tradeType: 'paper',
    });

    const directionIcon = direction === 'LONG' ? 'LONG' : 'SHORT';
    const text = [
      `TradingView paper alert: ${displaySymbol}`,
      `${directionIcon} | ${timeframe} | ${strategy}`,
      `Entry: ${entry}`,
      `SL: ${stopLoss}`,
      `TP: ${tp1}`,
      `R:R: ${rr1}`,
      `Journal ID: ${id}`,
    ].join('\n');

    const telegram = await sendTelegram(text);
    return res.json({ success: true, journalId: id, telegram: telegram.ok ? 'sent' : 'skipped', mode: 'paper' });
  } catch (e: any) {
    console.error('[TradingView] Alert failed:', e.message);
    return res.status(500).json({ error: 'Failed to process TradingView alert' });
  }
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', oanda: OANDA_API_KEY ? 'configured' : 'missing', accountType: OANDA_ACCOUNT_TYPE });
});

// ─── APPROVALS API ────────────────────────────────────────────────────────────
app.get('/api/approvals', (_req, res) => {
  res.json(pendingApprovals);
});

app.delete('/api/approvals/:id', (req, res) => {
  pendingApprovals = pendingApprovals.filter(p => p.id !== req.params.id);
  res.json({ success: true });
});

app.post('/api/approvals/:id/execute', async (req, res) => {
  const setup = pendingApprovals.find(p => p.id === req.params.id);
  if (!setup) return res.status(404).json({ error: 'Setup not found' });

  const botUrl = process.env.BOT_URL;
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!botUrl || !webhookSecret) {
    return res.status(500).json({ error: 'Bot execution disabled: missing BOT_URL or WEBHOOK_SECRET' });
  }

  try {
    const payload = {
      secret: webhookSecret,
      action: setup.direction === 'LONG' ? 'buy' : 'sell',
      symbol: (setup.pair || (setup as any).symbol || '').replace('_', ''),
      entry: setup.entry,
      sl: setup.sl || (setup as any).stopLoss || (setup as any).stop_loss || 0,
      tp: setup.tp1 || (setup as any).tp || 0,
      comment: `${setup.quality}-${setup.pattern}`,
    };

    const response = await fetch(`${botUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    pendingApprovals = pendingApprovals.filter(p => p.id !== setup.id);
    return res.json({ success: true, result });
  } catch(e: any) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/approvals/manual', (req, res) => {
  const setup = req.body;
  if (!setup || (!setup.pair && !setup.symbol) || !setup.direction) {
    return res.status(400).json({ error: 'Invalid setup data' });
  }
  // Normalize - ensure pair field exists
  if (!setup.pair && setup.symbol) setup.pair = setup.symbol;

  const exists = pendingApprovals.some(
    p => p.pair === setup.pair && p.timeframe === setup.timeframe &&
    Math.abs(p.entry - setup.entry) < (setup.pair.includes('JPY') ? 0.1 : 0.001)
  );
  if (!exists) {
    pendingApprovals.push({ ...setup, id: `${setup.pair}-manual-${Date.now()}` });
  }
  return res.json({ success: true, queued: !exists });
});

// ─── TEST ENDPOINTS ───────────────────────────────────────────────────────────
app.get('/api/test-telegram', async (_req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return res.json({ error: 'Telegram not configured' });
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: '🔔 Telegram test from scanner', parse_mode: 'Markdown' }),
  });
  const data = await r.json();
  return res.json(data);
});

// ─── STATIC ───────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = parseInt(process.env.PORT || '8080', 10);
console.log(`PORT env var is: ${process.env.PORT}`);
server.listen(PORT, () => {
  console.log(`✅ Forex Scanner running on http://localhost:${PORT}`);
  console.log(`   OANDA: ${OANDA_API_KEY ? '✓ configured' : '✗ missing key'} (${OANDA_ACCOUNT_TYPE})`);
  console.log(`[Config] TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? 'set' : 'MISSING'}`);
});
