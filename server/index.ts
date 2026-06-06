// Required env vars: OANDA_API_KEY, OANDA_ACCOUNT_TYPE
// Optional alerts/execution: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TRADINGVIEW_WEBHOOK_SECRET, BOT_URL, WEBHOOK_SECRET
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { getJournalEntries, createJournalEntry, updateJournalEntry, deleteJournalEntry, clearAllJournalEntries, getPatternStats, getSetting, setSetting, deleteSetting, getSettingsStorageInfo } from './db.js';
import { debugScan, Setup, JournalStats, fetchCandles, computeStructures, PAIRS as FULL_PAIRS, runScoutScan, ScoutReport, runTrendScan, TrendReport, TrendScanResult } from './scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());

const server = createServer(app);

app.use(express.json());
app.use(express.text({ type: 'text/plain' }));

let latestSetups: Setup[] = [];
let latestScoutResults: ScoutReport[] = [];
let latestTrendResults: TrendScanResult | null = null;
let lastTrendScanTime: string | null = null;
let trendScanInFlight: Promise<TrendScanResult> | null = null;
let trendingMembershipInitialized = false;
let previousTrendingPairs = new Set<string>();
let latestRejected: Array<{ pair: string; reason: string; detail: any; granularity: string }> = [];
let cachedJournalStats: JournalStats = {};
let lastScanTime: string | null = null;
let pendingApprovals: (Setup & { id: string })[] = [];
const journalCandidateAlerts = new Map<string, number>();
const JOURNAL_CANDIDATE_ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const AUTO_JOURNAL_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const journalCandidateCandleTimes = new Map<string, string>();

// Priority pairs — pushed by Claude after each forex scan via POST /api/priority-pairs
// When set, the scanner and frontend only scan these pairs instead of the full 16-pair list.
interface PriorityPairsData {
  pairs: string[];       // OANDA format: EUR_USD, XAU_USD, etc.
  setAt: string;         // ISO timestamp
  meta?: Record<string, any>; // optional grade/direction info from the scan
}
let priorityPairsData: PriorityPairsData | null = null;
const PRIORITY_PAIRS_SETTING_KEY = 'priority_pairs';

// Convert bare symbol (EURUSD, XAU_USD, FX:EURUSD) to OANDA underscore format
function toOandaFormat(symbol: string): string {
  const s = symbol.replace(/^[^:]+:/, '').toUpperCase(); // strip exchange prefix
  if (s.includes('_')) return s;                          // already OANDA format
  if (s.length === 6) return `${s.slice(0, 3)}_${s.slice(3)}`; // EURUSD → EUR_USD
  return s;
}

function parsePriorityPairs(value: string | null): PriorityPairsData | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PriorityPairsData>;
    if (!Array.isArray(parsed.pairs) || parsed.pairs.length === 0 || !parsed.setAt) return null;
    return {
      pairs: parsed.pairs.map(toOandaFormat).filter(p => p.length >= 5),
      setAt: parsed.setAt,
      meta: parsed.meta,
    };
  } catch (e) {
    console.warn('[Priority] Stored priority pairs are invalid:', e);
    return null;
  }
}

function normalizePriorityPairsInput(pairs: unknown[], meta: unknown) {
  const normalized: string[] = [];
  const structuredMeta: Record<string, any> = meta && typeof meta === 'object' && !Array.isArray(meta)
    ? { ...(meta as Record<string, any>) }
    : {};
  const byPair: Record<string, any> = {};

  for (const item of pairs) {
    const rawPair = typeof item === 'string'
      ? item
      : item && typeof item === 'object'
        ? (item as any).pair || (item as any).symbol || (item as any).ticker
        : '';
    const pair = toOandaFormat(String(rawPair || '').trim());
    if (pair.length < 5) continue;
    if (!normalized.includes(pair)) normalized.push(pair);
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const { pair: _pair, symbol: _symbol, ticker: _ticker, ...fields } = item as Record<string, any>;
      byPair[pair] = { ...(byPair[pair] || {}), ...normalizePriorityMetadataFields(fields), pair };
    }
  }

  for (const [key, value] of Object.entries(structuredMeta)) {
    const pair = toOandaFormat(String(key));
    if (normalized.includes(pair) && value && typeof value === 'object' && !Array.isArray(value)) {
      byPair[pair] = { ...(byPair[pair] || {}), ...normalizePriorityMetadataFields(value as Record<string, any>), pair };
    }
  }

  if (Object.keys(byPair).length) {
    structuredMeta.byPair = { ...(structuredMeta.byPair || {}), ...byPair };
  }

  return { normalized, structuredMeta };
}

function normalizePriorityMetadataFields(fields: Record<string, any>) {
  const normalized = { ...fields };
  if (normalized.stop_loss === undefined && normalized.stopLoss !== undefined) normalized.stop_loss = normalized.stopLoss;
  if (normalized.target_1 === undefined && normalized.target1 !== undefined) normalized.target_1 = normalized.target1;
  if (normalized.target_2 === undefined && normalized.target2 !== undefined) normalized.target_2 = normalized.target2;
  if (normalized.rr_estimate === undefined && normalized.rrEstimate !== undefined) normalized.rr_estimate = normalized.rrEstimate;
  return normalized;
}

async function loadPriorityPairsFromStorage(source = 'LOAD') {
  const storage = await getSettingsStorageInfo();
  const stored = await getSetting(PRIORITY_PAIRS_SETTING_KEY);
  const parsed = parsePriorityPairs(stored);
  priorityPairsData = parsed?.pairs.length ? parsed : null;
  console.log(`[Priority] ${source} storage=${storage.backend} durable=${storage.durable} active=${priorityPairsData !== null}${storage.path ? ` path=${storage.path}` : ''}`);
  return priorityPairsData;
}

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

function isBiasLocationAligned(report: ScoutReport) {
  return (
    report.bias === 'BULLISH' &&
    report.htfBias === 'BULLISH' &&
    report.zone === 'DISCOUNT'
  ) || (
    report.bias === 'BEARISH' &&
    report.htfBias === 'BEARISH' &&
    report.zone === 'PREMIUM'
  );
}

function journalCandidateAlertKey(report: ScoutReport) {
  return [report.pair, report.timeframe, report.bias, report.htfBias, report.zone].join('|');
}

function journalCandidateDataKey(report: ScoutReport) {
  return [report.pair, report.timeframe].join('|');
}

function getNewYorkMarketParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  return {
    weekday: get('weekday'),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

function isForexMarketOpen(now = new Date()) {
  const { weekday, hour, minute } = getNewYorkMarketParts(now);
  const minutes = hour * 60 + minute;
  if (weekday === 'Sat') return false;
  if (weekday === 'Sun') return minutes >= 17 * 60;
  if (weekday === 'Fri') return minutes < 17 * 60;
  return true;
}

function getFreshJournalCandidateReports(reports: ScoutReport[], source: string) {
  const aligned = reports.filter(isBiasLocationAligned);
  if (!aligned.length) return [];

  if (!isForexMarketOpen()) {
    console.log(`[Journal] ${source}: market closed; skipped ${aligned.length} journal candidate${aligned.length === 1 ? '' : 's'}`);
    return [];
  }

  const fresh: ScoutReport[] = [];
  for (const report of aligned) {
    const candleTime = report.candleTime;
    if (!candleTime) {
      console.warn(`[Journal] ${source}: skipped ${report.pair} ${report.timeframe}; missing candle timestamp`);
      continue;
    }

    const key = journalCandidateDataKey(report);
    const previousCandleTime = journalCandidateCandleTimes.get(key);
    journalCandidateCandleTimes.set(key, candleTime);

    if (!previousCandleTime) {
      console.log(`[Journal] ${source}: baseline candle recorded for ${report.pair} ${report.timeframe} @ ${candleTime}`);
      continue;
    }

    if (previousCandleTime === candleTime) {
      console.log(`[Journal] ${source}: stale candle skipped for ${report.pair} ${report.timeframe} @ ${candleTime}`);
      continue;
    }

    fresh.push(report);
  }

  return fresh;
}

function formatScoutLevel(value: number | null) {
  if (value === null) return 'N/A';
  return value >= 100 ? value.toFixed(3) : value.toFixed(5);
}

function isOpenJournalIdea(entry: any) {
  const result = String(entry.result || 'PENDING').toUpperCase();
  const outcome = String(entry.outcome || 'PENDING').toUpperCase();
  return result === 'PENDING' || result === 'RUNNING' || outcome === 'PENDING';
}

function isMateriallySameJournalIdea(entry: any, report: ScoutReport, direction: 'LONG' | 'SHORT', now: number) {
  if (entry.symbol !== report.pair || entry.direction !== direction || entry.timeframe !== report.timeframe) {
    return false;
  }

  if (isOpenJournalIdea(entry)) {
    return true;
  }

  const pushedAt = new Date(entry.pushedAt || 0).getTime();
  const entryTolerance = report.pair.includes('JPY') ? 0.1 : 0.001;
  return Number.isFinite(pushedAt) &&
    now - pushedAt < AUTO_JOURNAL_COOLDOWN_MS &&
    Math.abs(Number(entry.entry) - report.entry!) < entryTolerance;
}

async function autoJournalBiasLocationAlignedCandidates(reports: ScoutReport[]) {
  const aligned = reports.filter(isBiasLocationAligned);
  if (!aligned.length) return;

  let existing: any[];
  try {
    existing = await getJournalEntries();
  } catch (e: any) {
    console.error('[Journal] Auto-journal lookup failed:', e.message);
    return;
  }
  const now = Date.now();
  for (const report of aligned) {
    if (report.entry === null || report.sl === null || report.tp1 === null) {
      console.warn(`[Journal] Auto-journal skipped for ${report.pair}: missing entry, SL, or TP`);
      continue;
    }

    const direction = report.bias === 'BULLISH' ? 'LONG' : 'SHORT';
    const duplicate = existing.some((entry: any) => isMateriallySameJournalIdea(entry, report, direction, now));
    if (duplicate) {
      console.log(`[Journal] Auto-journal existing idea reused for ${report.pair} ${report.timeframe} ${direction}`);
      continue;
    }

    try {
      const id = await createJournalEntry({
        symbol: report.pair,
        displaySymbol: report.displaySymbol,
        direction,
        quality: 'DEVELOPING',
        pattern: 'Bias + Location Aligned',
        timeframe: report.timeframe,
        entry: report.entry,
        stopLoss: report.sl,
        tp1: report.tp1,
        tp2: report.tp2 ?? undefined,
        rr1: report.rrRatio ?? undefined,
        session: report.session,
        notes: `Auto-journal candidate: ${report.bias} bias + ${report.htfBias} HTF bias + ${report.zone} location`,
        result: 'PENDING',
        directionCorrect: 'PENDING',
        entryQuality: 'PENDING',
        reviewNotes: '',
      });
      existing.unshift({
        id,
        symbol: report.pair,
        direction,
        timeframe: report.timeframe,
        entry: String(report.entry),
        outcome: 'PENDING',
        result: 'PENDING',
        pushedAt: new Date().toISOString(),
      });
      console.log(`[Journal] Auto-journaled bias + location candidate ${report.pair} ${report.timeframe}`);
    } catch (e: any) {
      console.error(`[Journal] Auto-journal insert failed for ${report.pair}:`, e.message);
    }
  }
}

async function notifyBiasLocationAlignedCandidates(reports: ScoutReport[]) {
  const now = Date.now();
  for (const [key, alertedAt] of journalCandidateAlerts) {
    if (now - alertedAt >= JOURNAL_CANDIDATE_ALERT_COOLDOWN_MS) journalCandidateAlerts.delete(key);
  }

  for (const report of reports.filter(isBiasLocationAligned)) {
    const key = journalCandidateAlertKey(report);
    const alertedAt = journalCandidateAlerts.get(key);
    if (alertedAt && now - alertedAt < JOURNAL_CANDIDATE_ALERT_COOLDOWN_MS) {
      console.log(`[Telegram] Journal candidate suppressed by cooldown for ${report.pair} ${report.timeframe}`);
      continue;
    }

    const direction = report.bias === 'BULLISH' ? 'LONG' : 'SHORT';
    const text = `🧪 *JOURNAL CANDIDATE — Bias + Location Aligned*\nPair: ${report.displaySymbol}\nDirection: ${direction}\nHTF Bias: ${report.htfBias}\nLocation: ${report.zone}\nEntry: ${formatScoutLevel(report.entry)}\nSL: ${formatScoutLevel(report.sl)}\nTP: ${formatScoutLevel(report.tp1)}\nR:R: ${report.rrRatio ?? 'N/A'}\nTimeframe: ${report.timeframe}\nReason: Bias + Location aligned for review\n→ https://erica-forex-screener-production.up.railway.app`;
    try {
      const data = await sendTelegram(text, 'Markdown');
      if (data.ok) {
        journalCandidateAlerts.set(key, now);
        console.log(`[Telegram] Journal candidate alert sent for ${report.pair} ${report.timeframe}`);
      }
    } catch (e: any) {
      console.error(`[Telegram] Journal candidate alert failed for ${report.pair}:`, e.message);
    }
  }
}

function getSurfacedTrends(results: TrendScanResult) {
  const surfaced = new Map<string, { report: TrendReport; section: string }>();
  const add = (reports: TrendReport[], section: string) => {
    for (const report of reports) {
      if (!surfaced.has(report.pair)) surfaced.set(report.pair, { report, section });
    }
  };
  add(results.strongBullish, 'Strong Bullish Trends');
  add(results.strongBearish, 'Strong Bearish Trends');
  add(results.pullbackOpportunities, 'Pullback Opportunities');
  return surfaced;
}

async function notifyNewTrendingPairs(results: TrendScanResult) {
  const surfaced = getSurfacedTrends(results);
  const currentPairs = new Set(surfaced.keys());
  const analyzedPairs = new Set(results.all.map(report => report.pair));
  if (!trendingMembershipInitialized) {
    if (!analyzedPairs.size) {
      console.warn('[Trending] Baseline deferred: no markets were analyzed successfully');
      return;
    }
    previousTrendingPairs = currentPairs;
    trendingMembershipInitialized = true;
    console.log(`[Trending] Baseline initialized with ${currentPairs.size} surfaced market${currentPairs.size === 1 ? '' : 's'}`);
    return;
  }

  const added = [...surfaced.values()].filter(({ report }) => !previousTrendingPairs.has(report.pair));
  // Preserve membership for assets that failed market-data analysis this cycle.
  // A transient provider failure must not turn recovered markets into false "new" alerts.
  previousTrendingPairs = new Set([
    ...currentPairs,
    ...[...previousTrendingPairs].filter(pair => !analyzedPairs.has(pair)),
  ]);
  for (const { report, section } of added) {
    const direction = report.direction === 'BULLISH' ? '🟢 BULLISH' : report.direction === 'BEARISH' ? '🔴 BEARISH' : '⚪ NEUTRAL';
    const text = `🔥 *NEW TRENDING MARKET — ${report.displaySymbol}*\n${direction} | ${section}\nTrend score: ${report.trendScore.toFixed(1)}/10 | Cleanliness: ${report.cleanlinessScore.toFixed(1)}/10\nState: ${report.marketState} | ${report.htfAlignment}\nSession: ${report.session}\n→ https://erica-forex-screener-production.up.railway.app`;
    sendTelegram(text, 'Markdown').then((data: any) => {
      if (data.ok) console.log(`[Trending] Telegram alert sent for new market ${report.pair}`);
    }).catch((e: any) => console.error(`[Trending] Telegram alert failed for ${report.pair}:`, e.message));
  }
  if (added.length) console.log(`[Trending] ${added.length} newly surfaced market${added.length === 1 ? '' : 's'} detected`);
}

async function refreshTrendingMarkets() {
  if (trendScanInFlight) return trendScanInFlight;
  trendScanInFlight = (async () => {
    console.log(`[Trending] Running scan at ${new Date().toISOString()}`);
    const results = await runTrendScan();
    latestTrendResults = results;
    lastTrendScanTime = new Date().toISOString();
    await notifyNewTrendingPairs(results);
    return results;
  })();
  try {
    return await trendScanInFlight;
  } finally {
    trendScanInFlight = null;
  }
}

async function scheduledTrendScan() {
  try {
    await refreshTrendingMarkets();
  } catch (e: any) {
    console.error('[Trending] Scan failed:', e.message);
  }
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
    await loadPriorityPairsFromStorage('SCAN_LOAD');
    // Refresh journal stats for historical edge/weakness scoring
    try { cachedJournalStats = await getPatternStats(); } catch { /* non-fatal */ }

    const pairsOverride = priorityPairsData?.pairs;
    if (pairsOverride?.length) {
      console.log(`[Scanner] Priority mode — scanning ${pairsOverride.length} pairs: ${pairsOverride.join(', ')}`);
    }
    const debugResults = await Promise.all(tfsToRun.map(tf => debugScan(tf, 1.5, cachedJournalStats, pairsOverride)));
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

    // Scout scan — produces a report for every pair (no gate filtering).
    // Keep this independent from priority setup queueing so LOW-interest
    // and non-priority pairs still render in scout mode.
    try {
      latestScoutResults = await runScoutScan(forceTf || 'H4');
      console.log(`[Scout] ${latestScoutResults.length} pairs scanned, ${latestScoutResults.filter(r => r.interestLevel === 'HIGH').length} HIGH interest`);
      const freshJournalCandidates = getFreshJournalCandidateReports(latestScoutResults, 'scheduled scout scan');
      await autoJournalBiasLocationAlignedCandidates(freshJournalCandidates);
      await notifyBiasLocationAlignedCandidates(freshJournalCandidates);
    } catch (e: any) {
      console.warn('[Scout] Scan failed:', e.message);
    }
  } catch(e: any) {
    console.error('[Scanner] Scan failed:', e.message);
  }
}

// Load persisted priority pairs from storage, then run first scan
async function init() {
  try {
    const restored = await loadPriorityPairsFromStorage('STARTUP_LOAD');
    if (restored) {
      console.log(`[Priority] Restored from storage: ${priorityPairsData.pairs.join(', ')}`);
    }
  } catch (e) {
    console.warn('[Priority] Could not load from storage on startup:', e);
  }
  scheduledScan();
  scheduledTrendScan();
  setInterval(scheduledScan, 15 * 60 * 1000);
  setInterval(scheduledTrendScan, 15 * 60 * 1000);
}
init();

// ─── SCANNER API ──────────────────────────────────────────────────────────────
app.get('/api/setups', (_req, res) => {
  res.json({ setups: latestSetups, lastScanTime, count: latestSetups.length });
});

app.post('/api/scan', async (req, res) => {
  const tf = (req.query.tf as string) || undefined;
  await scheduledScan(tf);
  res.json({ setups: latestSetups, lastScanTime, count: latestSetups.length });
});

// ── Scout API ──────────────────────────────────────────────────────────────────
app.get('/api/scout', (_req, res) => {
  res.json({ reports: latestScoutResults, lastScanTime, count: latestScoutResults.length });
});

app.post('/api/scout', async (req, res) => {
  const tf = (req.query.tf as string) || 'H4';
  try {
    await loadPriorityPairsFromStorage('SCOUT_LOAD');
    if (priorityPairsData?.pairs?.length) {
      console.log(`[Scout] Priority mode active for setup queue, ignored for scout card coverage (${priorityPairsData.pairs.length} priority pairs)`);
    }
    latestScoutResults = await runScoutScan(tf);
    const freshJournalCandidates = getFreshJournalCandidateReports(latestScoutResults, 'manual scout scan');
    await autoJournalBiasLocationAlignedCandidates(freshJournalCandidates);
    await notifyBiasLocationAlignedCandidates(freshJournalCandidates);
    lastScanTime = new Date().toISOString();
    res.json({ reports: latestScoutResults, lastScanTime, count: latestScoutResults.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Trending API ──────────────────────────────────────────────────────────────
app.get('/api/trending', (_req, res) => {
  res.json({
    ...(latestTrendResults ?? { strongBullish: [], strongBearish: [], pullbackOpportunities: [], all: [] }),
    lastScanTime: lastTrendScanTime,
  });
});

app.post('/api/trending', async (_req, res) => {
  try {
    const results = await refreshTrendingMarkets();
    res.json({ ...results, lastScanTime: lastTrendScanTime });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
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

// ─── PRIORITY PAIRS API ───────────────────────────────────────────────────────
// Claude posts here after each forex scan to set the active pair list.
// GET  /api/priority-pairs  → { active: bool, pairs: string[], setAt, fullList }
// POST /api/priority-pairs  → { pairs: ["EURUSD","XAUUSD",...], meta?: {...} }
// DELETE /api/priority-pairs → clears priority mode, reverts to full 16-pair list

app.get('/api/priority-pairs', async (_req, res) => {
  let storage = await getSettingsStorageInfo();
  let stale = false;
  try {
    await loadPriorityPairsFromStorage('GET');
    storage = await getSettingsStorageInfo();
  } catch (e: any) {
    stale = priorityPairsData !== null;
    storage = await getSettingsStorageInfo();
    console.warn(`[Priority] GET storage read failed storage=${storage.backend} active=${priorityPairsData !== null}: ${e.message}`);
    if (!stale) {
      return res.status(503).json({
        error: 'Priority pair storage is unavailable',
        active: null,
        pairs: FULL_PAIRS,
        setAt: null,
        meta: null,
        fullList: FULL_PAIRS,
        storage,
      });
    }
  }
  res.json({
    active: priorityPairsData !== null,
    pairs: priorityPairsData?.pairs ?? FULL_PAIRS,
    setAt: priorityPairsData?.setAt ?? null,
    meta: priorityPairsData?.meta ?? null,
    fullList: FULL_PAIRS,
    storage,
    stale,
  });
});

app.post('/api/priority-pairs', async (req, res) => {
  const { pairs, meta } = req.body as { pairs?: unknown; meta?: unknown };
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return res.status(400).json({ error: 'Body must include non-empty pairs array' });
  }
  const { normalized, structuredMeta } = normalizePriorityPairsInput(pairs, meta);
  if (normalized.length === 0) {
    return res.status(400).json({ error: 'No valid pair symbols after normalization' });
  }
  const record: PriorityPairsData = { pairs: normalized, setAt: new Date().toISOString(), meta: structuredMeta };
  const persisted = await setSetting(PRIORITY_PAIRS_SETTING_KEY, JSON.stringify(record));
  if (!persisted) {
    const latestStorage = await getSettingsStorageInfo();
    console.warn(`[Priority] POST failed storage=${latestStorage.backend} durable=${latestStorage.durable} detail=${latestStorage.detail}${latestStorage.path ? ` path=${latestStorage.path}` : ''}`);
    return res.status(500).json({
      error: 'Priority pairs could not be persisted',
      storage: latestStorage,
      fix: 'Configure DATABASE_URL/MYSQL_URL or attach a Railway volume so RAILWAY_VOLUME_MOUNT_PATH is present.',
    });
  }
  priorityPairsData = record;
  const persistedStorage = await getSettingsStorageInfo();
  console.log(`[Priority] POST storage=${persistedStorage.backend} durable=${persistedStorage.durable} count=${normalized.length}${persistedStorage.path ? ` path=${persistedStorage.path}` : ''}: ${normalized.join(', ')}`);
  res.json({ success: true, active: true, pairs: normalized, count: normalized.length, setAt: record.setAt, meta: record.meta, storage: persistedStorage });
});

app.delete('/api/priority-pairs', async (_req, res) => {
  const persisted = await deleteSetting(PRIORITY_PAIRS_SETTING_KEY);
  if (!persisted) {
    const latestStorage = await getSettingsStorageInfo();
    console.warn(`[Priority] DELETE failed storage=${latestStorage.backend} durable=${latestStorage.durable} detail=${latestStorage.detail}${latestStorage.path ? ` path=${latestStorage.path}` : ''}`);
    return res.status(500).json({ error: 'Priority pairs could not be cleared from persistent storage', storage: latestStorage });
  }
  priorityPairsData = null;
  const persistedStorage = await getSettingsStorageInfo();
  console.log(`[Priority] DELETE storage=${persistedStorage.backend} durable=${persistedStorage.durable}${persistedStorage.path ? ` path=${persistedStorage.path}` : ''} — reverting to full 16-pair list`);
  res.json({ success: true, message: 'Priority pairs cleared, reverted to full list', storage: persistedStorage });
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
      notes:         b.notes,
      result:        b.result,
      directionCorrect: b.direction_correct ?? b.directionCorrect,
      entryQuality:  b.entry_quality ?? b.entryQuality,
      reviewNotes:   b.review_notes ?? b.reviewNotes,
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
      result: b.result,
      directionCorrect: b.direction_correct ?? b.directionCorrect,
      entryQuality: b.entry_quality ?? b.entryQuality,
      reviewNotes: b.review_notes ?? b.reviewNotes,
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

// ─── TRAINER ──────────────────────────────────────────────────────────────────
const TRAINER_PAIRS = ['EUR_USD','GBP_USD','USD_JPY','EUR_JPY','GBP_JPY','AUD_USD','NZD_USD','USD_CAD'];
const TRAINER_CONFIG: Record<string, { gran: string; count: number }> = {
  beginner:     { gran: 'H1', count: 70  },
  intermediate: { gran: 'H4', count: 80  },
  advanced:     { gran: 'H4', count: 100 },
};

app.get('/api/trainer/chart', async (req, res) => {
  const level = (req.query.level as string) || 'intermediate';
  const cfg   = TRAINER_CONFIG[level] || TRAINER_CONFIG.intermediate;
  const pair  = TRAINER_PAIRS[Math.floor(Math.random() * TRAINER_PAIRS.length)];
  try {
    const raw    = await fetchCandles(pair, cfg.gran, cfg.count);
    const structures = computeStructures(raw);
    const candles = raw.map(c => ({
      time:  Math.floor(new Date(c.t).getTime() / 1000),
      open:  c.o, high: c.h, low: c.l, close: c.c,
    }));
    res.json({ pair: pair.replace('_', '/'), timeframe: cfg.gran, candles, structures });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
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
