// Required env vars: OANDA_API_KEY, OANDA_ACCOUNT_TYPE, BOT_URL, WEBHOOK_SECRET
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { getJournalEntries, createJournalEntry, updateJournalEntry, deleteJournalEntry } from './db.js';
import { runScan, debugScan, Setup } from './scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());

const server = createServer(app);

app.use(express.json());

let latestSetups: Setup[] = [];
let lastScanTime: string | null = null;
let pendingApprovals: (Setup & { id: string })[] = [];

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL || Buffer.from('aHR0cHM6Ly9ob29rcy5zbGFjay5jb20vc2VydmljZXMvVDBBTjM5NVRYQTgvQjBBUzlTRVBYSzcvYkZsZ3E3UUtSSlRCZFRVNnVFdUl4cWpN', 'base64').toString();

function queueSetups(setups: Setup[]) {
  const premium = setups.filter(s => s.quality === 'PREMIUM' || s.quality === 'STRONG');
  for (const setup of premium) {
    const exists = pendingApprovals.some(
      p => p.pair === setup.pair && p.timeframe === setup.timeframe &&
           Math.abs(p.entry - setup.entry) < (setup.pair.includes('JPY') ? 0.1 : 0.001)
    );
    if (!exists) {
      pendingApprovals.push({ ...setup, id: `${setup.pair}-${Date.now()}` });
      const slackToken = process.env.SLACK_BOT_TOKEN;
      const slackUserId = process.env.SLACK_USER_ID || 'U0AMW8X3GLV';
      if (slackToken) {
        console.log(`[Slack] Attempting to notify for ${setup.pair} ${setup.quality}`);
        const dir = setup.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
        const emoji = setup.quality === 'PREMIUM' ? '🔥' : '⚡';
        const label = setup.quality === 'PREMIUM' ? 'PREMIUM' : 'STRONG';
        const text = `${emoji} *${label} SETUP — ${setup.pair.replace('_','/')}*\n${dir} | R:R: ${setup.rrRatio} | ${setup.session} session\nEntry: ${setup.entry} | SL: ${setup.sl.toFixed(5)} | TP: ${setup.tp1.toFixed(5)}\nPattern: ${setup.pattern} | TF: ${setup.timeframe}\n→ https://erica-forex-screener-production.up.railway.app`;
        fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${slackToken}`,
          },
          body: JSON.stringify({
            channel: slackUserId,
            text: text,
          }),
        }).then(() => console.log(`[Slack] Notification sent for ${setup.pair}`))
          .catch((e: any) => console.error('Slack DM failed:', e.message));
      }
      const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '8666767904:AAFamLcmXF6_0Ap0-N7ylgX0gptmzZtGaWs';
      const telegramChatId = process.env.TELEGRAM_CHAT_ID || '7394371711';
      if (telegramToken && telegramChatId) {
        const dir = setup.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
        const emoji = setup.quality === 'PREMIUM' ? '🔥' : '⚡';
        const label = setup.quality === 'PREMIUM' ? 'PREMIUM' : 'STRONG';
        const text = `${emoji} *${label} SETUP — ${setup.pair.replace('_','/')}*\n${dir} | R:R: ${setup.rrRatio} | ${setup.session} session\nEntry: ${setup.entry} | SL: ${setup.sl.toFixed(5)} | TP: ${setup.tp1.toFixed(5)}\nPattern: ${setup.pattern} | TF: ${setup.timeframe}\n→ https://erica-forex-screener-production.up.railway.app`;
        fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: telegramChatId,
            text: text,
            parse_mode: 'Markdown',
          }),
        }).then(r => r.json()).then((data: any) => {
          if (!data.ok) console.error('[Telegram] API error:', JSON.stringify(data));
          else console.log(`[Telegram] Alert sent for ${setup.pair} ${setup.quality}`);
        }).catch((e: any) => console.error('[Telegram] fetch failed:', e.message));
      }
    }
  }
  if (pendingApprovals.length > 20) {
    pendingApprovals = pendingApprovals.slice(-20);
  }
}

async function scheduledScan() {
  console.log(`[Scanner] Running scheduled scan at ${new Date().toISOString()}`);
  try {
    latestSetups = await runScan('H1', 1.5);
    lastScanTime = new Date().toISOString();
    console.log(`[Scanner] Found ${latestSetups.length} setups (${latestSetups.filter(s=>s.quality==='PREMIUM').length} premium)`);
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

app.post('/api/scan', async (_req, res) => {
  await scheduledScan();
  res.json({ setups: latestSetups, lastScanTime, count: latestSetups.length });
});

app.get('/api/debug', async (req, res) => {
  const granularity = (req.query.tf as string) || 'H1';
  const minRR = parseFloat((req.query.minRR as string) || '1.5');
  try {
    const results = await debugScan(granularity, minRR);
    res.json(results);
  } catch(e: any) {
    res.status(500).json({ error: e.message });
  }
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
    await createJournalEntry(req.body);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create journal entry' });
  }
});

app.patch('/api/journal/:id', async (req, res) => {
  try {
    await updateJournalEntry(parseInt(req.params.id), req.body);
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

  const botUrl = process.env.BOT_URL || 'https://erica-forex-bot-production.up.railway.app';
  const webhookSecret = process.env.WEBHOOK_SECRET || 'erica-bot-2026';

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
  const token = process.env.TELEGRAM_BOT_TOKEN || '8666767904:AAFamLcmXF6_0Ap0-N7ylgX0gptmzZtGaWs';
  const chatId = process.env.TELEGRAM_CHAT_ID || '7394371711';
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
  console.log(`[Config] SLACK_BOT_TOKEN: ${process.env.SLACK_BOT_TOKEN ? 'set' : 'MISSING'}`);
});
