import { checkNewsRisk } from './newsFilter.js';

const OANDA_API_KEY = process.env.OANDA_API_KEY || '';
const OANDA_ACCOUNT_TYPE = process.env.OANDA_ACCOUNT_TYPE || 'practice';
const OANDA_BASE = OANDA_ACCOUNT_TYPE === 'live'
  ? 'https://api-fxtrade.oanda.com'
  : 'https://api-fxpractice.oanda.com';

export const PAIRS = [
  // Majors
  'EUR_USD','GBP_USD','USD_JPY','USD_CAD','USD_CHF',
  // Commodity currencies
  'AUD_USD','NZD_USD',
  // JPY crosses
  'EUR_JPY','GBP_JPY','AUD_JPY','NZD_JPY','CAD_JPY',
  // Other crosses
  'EUR_GBP','EUR_AUD',
  // Metals
  'XAU_USD','XAG_USD',
  // Indices
  'US30_USD','NAS100_USD',
];

export const TRENDING_ASSETS = [
  ...PAIRS,
];

const HTF_MAP: Record<string,string> = { M15:'H4', M30:'H4', H1:'D', H4:'W', D:'W' };

interface Candle { t:string; o:number; h:number; l:number; c:number; v:number; }
interface Swing  { index:number; price:number; type:'high'|'low'; }

type TrendDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
type MarketState = 'TRENDING' | 'PULLBACK' | 'EXPANDING' | 'EXHAUSTED' | 'CHOPPY';
type DirectionLabel = 'Bullish' | 'Bearish' | 'Neutral';
type TrendLabel = 'Bullish' | 'Bearish' | 'Bullish HTF Pullback' | 'Bearish HTF Pullback' | 'Mixed / Transition';
type StructureLabel = 'HH/HL' | 'LH/LL' | 'Mixed';
type EntryStatus = 'Waiting' | 'Near Entry' | 'Tradeable' | 'Too Far';
type SetupGrade = 'A' | 'B' | 'C';
type EntryTimingState = 'Not Ready' | 'Area Reached' | 'Reaction Started' | 'Entry Triggered';
type MomentumLabel = 'Strong Bullish' | 'Bullish' | 'Neutral / Mixed' | 'Bearish' | 'Strong Bearish';
type PullbackStatus =
  | 'Aggressive pullback / Not ready'
  | 'Pullback still active'
  | 'Stabilizing'
  | 'Reversal forming'
  | 'Pullback completed';
type ConfirmationStatus =
  | 'No confirmation'
  | 'Early confirmation'
  | 'Building confirmation'
  | 'Strong confirmation'
  | 'Confirmed trend resumption';

export interface SetupChecklist {
  trend: boolean;           // Gate 1: EMA stack (price > EMA50 > EMA200) + EMA20 slope + HTF alignment
  pullbackQuality: boolean; // Gate 2: pullback to EMA20 within 0.5×ATR + not sandwiched
  momentum: boolean;        // Gate 3: ENGULFING / PIN_BAR / STRONG_CLOSE / EMA_BOUNCE
  rsi: boolean;             // Gate 4: RSI in zone (40–68 LONG, 35–60 SHORT)
  viability: boolean;       // Gate 5: structure clearance + impulse leg + TP1 freshness + min R:R
  session: string;          // Info field: active session at signal time (not a filter)
  // Bonus/scoring signals — not gates
  volumeSurge: boolean;
  liquiditySweep: boolean;
  pdhlConfluence: boolean;
  historicalEdge: boolean;
}

export interface Setup {
  pair: string;
  direction: 'LONG'|'SHORT';
  quality: 'PREMIUM'|'STRONG'|'DEVELOPING';
  rrRatio: number;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  pattern: string;
  confluence: string[];
  scannedAt: string;
  timeframe: string;
  session: string;
  newsRisk?: boolean;
  approved?: boolean;
  approvedAt?: string;
  checklist?: SetupChecklist;
  momentumScore: number;
  momentumLabel: MomentumLabel;
  momentumAlignedWithBias: boolean;
  momentumConflict: boolean;
  pullbackScore: number;
  pullbackStatus: PullbackStatus;
  pullbackCompleted: boolean;
  pullbackReason: string;
  confirmationScore: number;
  confirmationStatus: ConfirmationStatus;
  confirmationConfirmed: boolean;
  confirmationReason: string;
  reversalConfirmed: boolean;
  reversalReason: string;
  setupGrade: SetupGrade;
  setupGradeReason: string;
  evalEligible: boolean;
  evalReason: string;
  entryTimingState: EntryTimingState;
  entryTimingReason: string;
  trendDirection: TrendLabel;
  trendScore: number;
  trendReason: string;
  dailyTrendDirection: DirectionLabel;
  dailySwingStructure: StructureLabel;
  dailyBosDirection: DirectionLabel;
  dailyChochDirection: DirectionLabel;
  h4TrendDirection: DirectionLabel;
  setupTimeframeDirection: DirectionLabel;
  setupTimeframeScore: number;
  setupTimeframeReason: string;
  marketPhase: string;
  marketPhaseReason: string;
  trendSetupAligned: boolean;
  isPullbackAgainstTrend: boolean;
  entryStatus: EntryStatus;
  distanceFromEntryAtr: number | null;
  distanceFromEntryPercent: number | null;
}

export type JournalStats = Record<string, { wins: number; losses: number }>;

export interface DebugResult {
  pair: string;
  result: 'SETUP' | 'REJECTED' | 'ERROR';
  reason?: string;
  setup?: Setup;
  detail?: {
    trend?: string | null;
    htfTrend?: string | null;
    momentum?: string | null;
    atr?: number;
    baselineATR?: number;
    recentATR?: number;
    price?: number;
    ema20?: number;
    ema50?: number;
    ema200?: number;
    emaSlope?: number;
    rsi?: number;
  };
}

export async function fetchCandles(instrument: string, granularity: string, count=250): Promise<Candle[]> {
  const url = `${OANDA_BASE}/v3/instruments/${instrument}/candles?granularity=${granularity}&count=${count}&price=M`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${OANDA_API_KEY}` }
  });
  if (!res.ok) throw new Error(`OANDA ${instrument} ${granularity}: ${res.status}`);
  const data = await res.json() as any;
  return data.candles
    .filter((c:any) => c.complete)
    .map((c:any) => ({
      t: c.time,
      o: parseFloat(c.mid.o),
      h: parseFloat(c.mid.h),
      l: parseFloat(c.mid.l),
      c: parseFloat(c.mid.c),
      v: c.volume,
    }));
}

function calcATR(candles: Candle[], period=14): number {
  if (candles.length < 2) return 0.001;
  const trs = candles.slice(-period).map((c,i,arr) =>
    i===0 ? c.h-c.l : Math.max(c.h-c.l, Math.abs(c.h-arr[i-1].c), Math.abs(c.l-arr[i-1].c))
  );
  return trs.reduce((a,b)=>a+b,0) / trs.length;
}

// Returns array same length as candles; indices before period-1 are undefined
function calcEMA(candles: Candle[], period: number): number[] {
  const k = 2 / (period + 1);
  const emas: number[] = new Array(candles.length);
  // Seed with SMA of first `period` candles
  let sum = 0;
  for (let i = 0; i < period; i++) sum += candles[i].c;
  emas[period - 1] = sum / period;
  for (let i = period; i < candles.length; i++) {
    emas[i] = candles[i].c * k + emas[i - 1] * (1 - k);
  }
  return emas;
}

// Wilder RSI; indices before period are NaN
function calcRSI(candles: Candle[], period = 14): number[] {
  const rsi: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].c - candles[i - 1].c;
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].c - candles[i - 1].c;
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

export function findSwings(candles: Candle[], margin=5): Swing[] {
  const swings: Swing[] = [];
  for (let i=margin; i<candles.length-margin; i++) {
    const c = candles[i];
    const lh = candles.slice(i-margin,i);
    const rh = candles.slice(i+1,i+1+margin);
    if (lh.every(x=>x.h<=c.h) && rh.every(x=>x.h<=c.h))
      swings.push({ index:i, price:c.h, type:'high' });
    else if (lh.every(x=>x.l>=c.l) && rh.every(x=>x.l>=c.l))
      swings.push({ index:i, price:c.l, type:'low' });
  }
  return swings;
}

function getTrend(swings: Swing[]): 'LONG'|'SHORT'|null {
  const highs = swings.filter(s=>s.type==='high');
  const lows  = swings.filter(s=>s.type==='low');
  if (highs.length<3 || lows.length<3) return null;
  const hh  = highs[highs.length-1].price > highs[highs.length-2].price;
  const hh2 = highs[highs.length-2].price > highs[highs.length-3].price;
  const hl  = lows[lows.length-1].price   > lows[lows.length-2].price;
  const hl2 = lows[lows.length-2].price   > lows[lows.length-3].price;
  const lh  = highs[highs.length-1].price < highs[highs.length-2].price;
  const lh2 = highs[highs.length-2].price < highs[highs.length-3].price;
  const ll  = lows[lows.length-1].price   < lows[lows.length-2].price;
  const ll2 = lows[lows.length-2].price   < lows[lows.length-3].price;
  if ((hh || hh2) && (hl || hl2) && (hh || hl)) return 'LONG';
  if ((lh || lh2) && (ll || ll2) && (lh || ll)) return 'SHORT';
  return null;
}

function detectMomentum(c: Candle, p: Candle, dir: string, atr: number, structureLevel: number): {type:string;strength:number}|null {
  const body=Math.abs(c.c-c.o), range=c.h-c.l, bodyRatio=range>0?body/range:0;
  const uw=c.h-Math.max(c.c,c.o), lw=Math.min(c.c,c.o)-c.l;
  const pBody=Math.abs(p.c-p.o), pHigh=Math.max(p.c,p.o), pLow=Math.min(p.c,p.o);
  if (body < 0.2 * atr) return null;
  if (dir==='LONG'&&c.c>c.o&&Math.min(c.o,c.c)<=pLow&&Math.max(c.o,c.c)>=pHigh&&body>pBody*0.9)
    return {type:'ENGULFING',strength:80};
  if (dir==='SHORT'&&c.c<c.o&&Math.max(c.o,c.c)>=pHigh&&Math.min(c.o,c.c)<=pLow&&body>pBody*0.9)
    return {type:'ENGULFING',strength:80};
  if (dir==='LONG'&&lw>body*2&&lw>uw*1.5&&bodyRatio<0.4) {
    if (Math.abs(c.l - structureLevel) <= 0.5 * atr)
      return {type:'PIN_BAR',strength:70};
  }
  if (dir==='SHORT'&&uw>body*2&&uw>lw*1.5&&bodyRatio<0.4) {
    if (Math.abs(c.h - structureLevel) <= 0.5 * atr)
      return {type:'PIN_BAR',strength:70};
  }
  if (dir==='LONG'&&c.c>c.o&&bodyRatio>0.65&&c.c>p.h)
    return {type:'STRONG_CLOSE',strength:65};
  if (dir==='SHORT'&&c.c<c.o&&bodyRatio>0.65&&c.c<p.l)
    return {type:'STRONG_CLOSE',strength:65};
  return null;
}

function getPDHL(candles: Candle[]): { pdh: number; pdl: number } | null {
  const byDate = new Map<string, Candle[]>();
  for (const c of candles) {
    const date = c.t.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(c);
  }
  const dates = [...byDate.keys()].sort();
  if (dates.length < 2) return null;
  const prev = byDate.get(dates[dates.length - 2])!;
  return {
    pdh: Math.max(...prev.map(c => c.h)),
    pdl: Math.min(...prev.map(c => c.l)),
  };
}

// Session labels: London / NY / London+NY overlap / Tokyo (JPY pairs) / Off-hours
// UTC hour boundaries match the previous Asia/London/New York scoring weights exactly:
//   h>=22||h<8 → Tokyo/Off-hours  (was 'Asia', score -15)
//   h>=8&&h<13 → London           (was 'London', score +10)
//   h>=13&&h<17 → London+NY overlap (was 'New York', score +10)
//   h>=17&&h<22 → NY              (was 'New York', score +10)
function getSessionLabel(pair: string): string {
  const h = new Date().getUTCHours();
  if (h >= 22 || h < 8)  return pair.includes('JPY') ? 'Tokyo' : 'Off-hours';
  if (h >= 8  && h < 13) return 'London';
  if (h >= 13 && h < 17) return 'London+NY overlap';
  return 'NY';
}

export function analyzeCandles(
  candles: Candle[], htf: Candle[], pair: string,
  granularity='H1', minRR=1.5, _debug=false,
  journalStats: JournalStats = {}
): { setup: Setup|null; reason: string; detail: DebugResult['detail'] } {
  const detail: DebugResult['detail'] = {};

  // Need 210+ for a stable 200 EMA with warmup
  if (candles.length < 210) return { setup: null, reason: 'Not enough candles (<210)', detail };

  const atr = calcATR(candles.slice(-50));
  detail.atr = atr;
  const pdhl = getPDHL(candles);

  // ATR minimum — reject dead/illiquid markets
  const ATR_MIN: Record<string,number> = {
    // Metals
    XAU_USD: 0.8,   XAG_USD: 0.015,
    // JPY pairs
    USD_JPY: 0.03,  EUR_JPY: 0.04,  GBP_JPY: 0.05,
    AUD_JPY: 0.03,  NZD_JPY: 0.03,  CAD_JPY: 0.03,
    // USD majors
    GBP_USD: 0.0004, EUR_USD: 0.0003, AUD_USD: 0.0002,
    NZD_USD: 0.0002, USD_CAD: 0.0003, USD_CHF: 0.0003,
    // Crosses
    EUR_GBP: 0.0002, EUR_AUD: 0.0003,
  };
  const atrMin = ATR_MIN[pair] ?? 0.0003;
  if (atr < atrMin) return { setup: null, reason: `ATR too low (${atr.toFixed(5)} < min ${atrMin}) — market inactive`, detail };

  // Post-news chop filter
  const recent80 = candles.slice(-80);
  const baselineATR = calcATR(recent80.slice(-60, -20));
  const recentATR   = calcATR(recent80.slice(-10));
  detail.baselineATR = baselineATR;
  detail.recentATR   = recentATR;
  const spikeInWindow = recent80.slice(-20).some(c => (c.h - c.l) > 3 * baselineATR);
  if (spikeInWindow) return { setup: null, reason: 'Post-news spike in last 20 candles — chop window', detail };
  if (recentATR > 1.8 * baselineATR) return { setup: null, reason: `Elevated volatility regime — recent ATR ${recentATR.toFixed(5)} > 1.8× baseline ${baselineATR.toFixed(5)}`, detail };

  // Calculate indicators on full candle set
  const ema20arr  = calcEMA(candles, 20);
  const ema50arr  = calcEMA(candles, 50);
  const ema200arr = calcEMA(candles, 200);
  const rsiArr    = calcRSI(candles, 14);

  const lastIdx = candles.length - 1;
  const last    = candles[lastIdx];
  const price   = last.c;
  detail.price  = price;

  const ema20  = ema20arr[lastIdx];
  const ema50  = ema50arr[lastIdx];
  const ema200 = ema200arr[lastIdx];
  const rsi    = rsiArr[lastIdx];

  detail.ema20  = ema20;
  detail.ema50  = ema50;
  detail.ema200 = ema200;
  detail.rsi    = rsi;

  if (!ema20 || !ema50 || !ema200 || isNaN(rsi)) {
    return { setup: null, reason: 'Insufficient data for EMA/RSI calculation', detail };
  }

  // ── GATE 1: TREND ──────────────────────────────────────────────────────────
  // 1a. EMA direction: price must be above EMA50 + EMA200 (LONG) or below both (SHORT)
  let direction: 'LONG'|'SHORT'|null = null;
  if (price > ema50 && price > ema200)      direction = 'LONG';
  else if (price < ema50 && price < ema200) direction = 'SHORT';

  if (!direction) return {
    setup: null,
    reason: `EMA alignment neutral — price (${price.toFixed(5)}) not clearly above/below EMA50 (${ema50.toFixed(5)}) + EMA200 (${ema200.toFixed(5)})`,
    detail,
  };
  detail.trend = direction;

  // 1b. EMA20 slope: must be rising for LONG, falling for SHORT
  const ema20_3ago = ema20arr[lastIdx - 3];
  const emaSlope   = ema20 - ema20_3ago;
  detail.emaSlope  = emaSlope;
  const emaSlopeStrong = Math.abs(emaSlope) > 0.5 * atr;

  // EMA slope is a scoring factor only — flat/counter slope downgrades quality but doesn't reject
  const emaSlopeAligned = direction === 'LONG' ? emaSlope > 0 : emaSlope < 0;

  // 1c. HTF alignment: no counter-trend trades
  const htfSwings     = findSwings(htf.slice(-100));
  const htfSwingHighs = htfSwings.filter(s => s.type === 'high');
  const htfSwingLows  = htfSwings.filter(s => s.type === 'low');
  const htfTrend      = getTrend(htfSwings);
  detail.htfTrend = htfTrend;
  // HTF conflict downgrades quality to DEVELOPING but no longer hard-rejects
  const htfConflict = htfTrend !== null && htfTrend !== direction;

  // ── GATE 2: PULLBACK QUALITY ───────────────────────────────────────────────
  // 2b. Pullback to EMA20: one of the last 8 candles must have touched within 1.5×ATR
  // Sandwiched check removed — was blocking valid continuation setups
  let pullbackCandle: Candle | null = null;
  let pullbackIdx = -1;
  for (let i = lastIdx; i >= lastIdx - 4; i--) {
    const c   = candles[i];
    const ema = ema20arr[i];
    if (!ema) continue;
    const touchDist = direction === 'LONG'
      ? Math.abs(c.l - ema)
      : Math.abs(c.h - ema);
    if (touchDist <= 1.0 * atr) {
      pullbackCandle = c;
      pullbackIdx    = i;
      break;
    }
  }
  if (!pullbackCandle) return {
    setup: null,
    reason: `No pullback to 20 EMA in last 5 candles (EMA20=${ema20.toFixed(5)}, price=${price.toFixed(5)})`,
    detail,
  };

  // ── GATE 3: MOMENTUM CONFIRMATION ─────────────────────────────────────────
  // ENGULFING / PIN_BAR / STRONG_CLOSE at the pullback candle, or EMA_BOUNCE.
  // EMA_BOUNCE requires: body ≥0.4×ATR + close ≥0.2×ATR beyond EMA (no drift candles).
  const pullbackEma = ema20arr[pullbackIdx];
  const prevCandle  = candles[pullbackIdx - 1];
  const momentum    = detectMomentum(pullbackCandle, prevCandle, direction, atr, pullbackEma);
  detail.momentum   = momentum?.type ?? null;

  let patternType = momentum?.type ?? null;
  if (!patternType) {
    const bounceBody = Math.abs(pullbackCandle.c - pullbackCandle.o);
    if (
      direction === 'LONG' &&
      pullbackCandle.l <= pullbackEma + 0.75 * atr &&
      pullbackCandle.c > pullbackEma &&
      bounceBody >= 0.25 * atr
    ) {
      patternType = 'EMA_BOUNCE';
    } else if (
      direction === 'SHORT' &&
      pullbackCandle.h >= pullbackEma - 0.75 * atr &&
      pullbackCandle.c < pullbackEma &&
      bounceBody >= 0.25 * atr
    ) {
      patternType = 'EMA_BOUNCE';
    }
  }
  if (!patternType) return {
    setup: null,
    reason: 'No rejection candle at 20 EMA (need engulfing, pin bar, strong close, or clean EMA bounce close)',
    detail,
  };

  // ── GATE 4: RSI ────────────────────────────────────────────────────────────
  if (direction === 'LONG') {
    if (rsi < 35 || rsi > 72) return { setup: null, reason: `RSI outside LONG zone (${rsi.toFixed(1)}, need 35–72)`, detail };
  } else {
    if (rsi < 30 || rsi > 65) return { setup: null, reason: `RSI outside SHORT zone (${rsi.toFixed(1)}, need 30–65)`, detail };
  }

  // ── SL / TP (prerequisite for Gate 5) ─────────────────────────────────────
  // Swing high/low of last 5 candles ± 0.3×ATR
  const window5 = candles.slice(lastIdx - 4, lastIdx + 1);
  const sl = direction === 'LONG'
    ? Math.min(...window5.map(c => c.l)) - 0.3 * atr
    : Math.max(...window5.map(c => c.h)) + 0.3 * atr;

  if (direction === 'LONG'  && sl >= price) return { setup: null, reason: 'Inverted SL: sl >= entry for LONG',  detail };
  if (direction === 'SHORT' && sl <= price) return { setup: null, reason: 'Inverted SL: sl <= entry for SHORT', detail };
  const risk = Math.abs(price - sl);
  if (risk <= 0) return { setup: null, reason: 'Risk is zero (price equals SL)', detail };

  const recentSwings = findSwings(recent80);
  const swingHighs   = recentSwings.filter(s => s.type === 'high');
  const swingLows    = recentSwings.filter(s => s.type === 'low');

  const MIN_TP_RR = 2.0;

  // Only consider opposing swings that clear the 2.0R minimum — nearest first
  const opposingSwings = (direction === 'LONG'
    ? swingHighs.filter(s => s.price > price && Math.abs(s.price - price) / risk >= MIN_TP_RR)
    : swingLows.filter(s => s.price < price && Math.abs(s.price - price) / risk >= MIN_TP_RR)
  ).sort((a, b) =>
    direction === 'LONG'
      ? a.price - b.price   // ascending — nearest first for LONG
      : b.price - a.price   // descending — nearest first for SHORT
  );

  // TP1 = nearest qualifying swing; TP2/TP3 = next distinct levels (each ≥0.5R further)
  const structureTPs: number[] = [];
  for (const s of opposingSwings) {
    if (structureTPs.length === 0) {
      structureTPs.push(s.price);
    } else {
      const prev = structureTPs[structureTPs.length - 1];
      if (Math.abs(s.price - prev) / risk >= 0.5) structureTPs.push(s.price);
    }
    if (structureTPs.length === 3) break;
  }

  // PDH/PDL obstacle check
  let pdhlConfluence = false;
  if (pdhl) {
    if (direction === 'LONG' && Math.abs(ema20 - pdhl.pdl) <= 0.5 * atr) pdhlConfluence = true;
    if (direction === 'SHORT' && Math.abs(ema20 - pdhl.pdh) <= 0.5 * atr) pdhlConfluence = true;
    // Trim TP1 back if PDH/PDL is an obstacle between entry and TP1
    if (direction === 'LONG' && pdhl.pdh > price && structureTPs[0] !== undefined && pdhl.pdh < structureTPs[0])
      structureTPs[0] = pdhl.pdh - 0.1 * atr;
    if (direction === 'SHORT' && pdhl.pdl < price && structureTPs[0] !== undefined && pdhl.pdl > structureTPs[0])
      structureTPs[0] = pdhl.pdl + 0.1 * atr;
  }

  // Use structure TPs where found; fall back to R-multiples
  const tp1 = structureTPs[0] ?? (direction === 'LONG' ? price + 2 * risk : price - 2 * risk);
  const tp2 = structureTPs[1] ?? (direction === 'LONG' ? price + 3 * risk : price - 3 * risk);
  const tp3 = structureTPs[2] ?? (direction === 'LONG' ? price + 4 * risk : price - 4 * risk);
  const rrRatio = Math.abs(tp1 - price) / risk;

  // ── GATE 5: VIABILITY (COMPOSITE) ─────────────────────────────────────────
  // All five sub-checks must pass. Returns specific sub-reason on failure.

  // 5a. Structure clearance — entry-TF swings (0.75×ATR required, down from 1.5)
  if (direction === 'SHORT') {
    const nearestSupport = swingLows
      .filter(s => s.price < price)
      .sort((a, b) => b.price - a.price)[0];
    if (nearestSupport) {
      const dist = price - nearestSupport.price;
      if (dist < 1.0 * atr) {
        return { setup: null, reason: `Entry too close to support (${granularity}): swing low ${nearestSupport.price.toFixed(5)} only ${(dist / atr).toFixed(1)}×ATR below entry`, detail };
      }
    }
  }
  if (direction === 'LONG') {
    const nearestResistance = swingHighs
      .filter(s => s.price > price)
      .sort((a, b) => a.price - b.price)[0];
    if (nearestResistance) {
      const dist = nearestResistance.price - price;
      if (dist < 1.0 * atr) {
        return { setup: null, reason: `Entry too close to resistance (${granularity}): swing high ${nearestResistance.price.toFixed(5)} only ${(dist / atr).toFixed(1)}×ATR above entry`, detail };
      }
    }
  }
  // 5b. HTF structure clearance removed — HTF swings are informational via htfConflict flag

  // 5c. Impulse leg strength: last directional swing ≥1.5×ATR (filters chop)
  if (direction === 'LONG') {
    const lastSwingLow  = swingLows[swingLows.length - 1];
    const impulseHighs  = swingHighs.filter(s => lastSwingLow && s.index > lastSwingLow.index);
    const lastImpulseHigh = impulseHighs[impulseHighs.length - 1];
    if (lastSwingLow && lastImpulseHigh) {
      const impulseSize = lastImpulseHigh.price - lastSwingLow.price;
      if (impulseSize < 1.0 * atr) {
        return { setup: null, reason: `Weak impulse leg: last upswing ${impulseSize.toFixed(5)} = ${(impulseSize / atr).toFixed(1)}×ATR — likely chop not trend`, detail };
      }
    }
  }
  if (direction === 'SHORT') {
    const lastSwingHigh = swingHighs[swingHighs.length - 1];
    const impulseLows   = swingLows.filter(s => lastSwingHigh && s.index > lastSwingHigh.index);
    const lastImpulseLow = impulseLows[impulseLows.length - 1];
    if (lastSwingHigh && lastImpulseLow) {
      const impulseSize = lastSwingHigh.price - lastImpulseLow.price;
      if (impulseSize < 1.0 * atr) {
        return { setup: null, reason: `Weak impulse leg: last downswing ${impulseSize.toFixed(5)} = ${(impulseSize / atr).toFixed(1)}×ATR — likely chop not trend`, detail };
      }
    }
  }

  // 5d. TP1 freshness: ≤1 failed approach at TP1 level in last 50 candles (±0.5×ATR zone)
  const tp1RejectCount = candles.slice(-50).filter(c => {
    if (direction === 'LONG')  return c.h >= tp1 - 0.5 * atr && c.c < tp1;
    else                       return c.l <= tp1 + 0.5 * atr && c.c > tp1;
  }).length;
  if (tp1RejectCount >= 3) {
    return { setup: null, reason: `TP1 at ${tp1.toFixed(5)} is a heavily tested level (${tp1RejectCount} failed closes in last 50 candles) — likely to block again`, detail };
  }

  // 5e. Minimum R:R
  if (rrRatio < minRR) return { setup: null, reason: `RR too low (${rrRatio.toFixed(2)} < ${minRR})`, detail };

  // ── BONUS SIGNALS (scoring + confluence only, not gates) ──────────────────
  const avgVol   = candles.slice(-20).reduce((s,c) => s + c.v, 0) / 20;
  const volRatio = avgVol > 0 ? pullbackCandle.v / avgVol : 1;

  const sweepWindow = candles.slice(lastIdx - 5, lastIdx);
  const liquiditySweep = direction === 'LONG'
    ? sweepWindow.some(c => c.l < ema20 && c.c > ema20)
    : sweepWindow.some(c => c.h > ema20 && c.c < ema20);
  const momentumStructures = computeStructures(candles.slice(-120), 4);
  const latestBos = momentumStructures.bosEvents.at(-1);
  const latestChoch = momentumStructures.chochEvents.at(-1);
  const setupNearestResistance = swingHighs.filter(s => s.price > price).sort((a, b) => a.price - b.price)[0]?.price ?? null;
  const setupNearestSupport = swingLows.filter(s => s.price < price).sort((a, b) => b.price - a.price)[0]?.price ?? null;
  const currentMomentum = scoreCurrentMomentum(
    candles,
    atr,
    direction,
    latestBos ? { type: latestBos.type, level: latestBos.brokenLevel } : null,
    latestChoch ? { type: latestChoch.type, level: latestChoch.brokenLevel } : null
  );
  const pullbackCompletion = scorePullbackCompletion(
    candles,
    atr,
    direction,
    latestBos ? { type: latestBos.type, level: latestBos.brokenLevel } : null,
    latestChoch ? { type: latestChoch.type, level: latestChoch.brokenLevel } : null,
    setupNearestSupport,
    setupNearestResistance
  );
  const trendConfirmation = scoreTrendConfirmation(
    candles,
    atr,
    direction,
    latestBos ? { type: latestBos.type, level: latestBos.brokenLevel } : null,
    latestChoch ? { type: latestChoch.type, level: latestChoch.brokenLevel } : null
  );
  const trendSetupPhase = buildTrendSetupPhase(
    candles,
    htf,
    candles,
    granularity,
    HTF_MAP[granularity] || 'HTF',
    granularity,
    currentMomentum.momentumScore,
    trendConfirmation.confirmationScore
  );

  const tpPathSwings = direction === 'LONG'
    ? swingHighs.filter(s => s.price > price && s.price < tp1)
    : swingLows.filter(s => s.price < price && s.price > tp1);
  const clutteredPath = tpPathSwings.length >= 2;

  const session = getSessionLabel(pair);

  // ── SCORING ───────────────────────────────────────────────────────────────
  let score = 60;
  if (emaSlopeStrong)                                                       score += 15;
  if (htfTrend === direction)                                               score += 15;
  const rsiIdeal = direction === 'LONG' ? (rsi >= 45 && rsi <= 60) : (rsi >= 40 && rsi <= 55);
  if (rsiIdeal)                                                             score += 10;
  if (volRatio >= 1.2)                                                      score += 10;
  if (Math.abs(pullbackCandle.c - pullbackCandle.o) > 0.5 * atr)           score += 10;
  if (pdhlConfluence)                                                       score += 10;
  if (liquiditySweep)                                                       score += 15;
  if (clutteredPath)                                                        score -= 15;
  if (session === 'Tokyo' || session === 'Off-hours')                       score -= 15;
  if (session === 'London' || session === 'NY' || session === 'London+NY overlap') score += 10;

  // ── CONFLUENCE TAGS ───────────────────────────────────────────────────────
  const confluence: string[] = ['EMA 20/50/200 aligned'];
  if (patternType === 'ENGULFING')    confluence.push('Engulfing at 20 EMA');
  if (patternType === 'PIN_BAR')      confluence.push('Pin bar at 20 EMA');
  if (patternType === 'STRONG_CLOSE') confluence.push('Strong close off 20 EMA');
  if (patternType === 'EMA_BOUNCE')   confluence.push('EMA bounce close');
  if (htfTrend === direction)         confluence.push('HTF aligned');
  if (htfConflict)                    confluence.push(`HTF counter-trend (${htfTrend})`);
  if (emaSlopeStrong)                 confluence.push('Strong EMA slope');
  if (rsiIdeal)                       confluence.push('RSI ideal zone');
  if (volRatio >= 1.2)                confluence.push('Volume surge');
  if (session === 'London' || session === 'NY' || session === 'London+NY overlap') confluence.push(`${session} session`);
  if (liquiditySweep)                 confluence.push('Liquidity sweep');
  if (pdhlConfluence)                 confluence.push('PDH/PDL confluence');
  if (clutteredPath)                  confluence.push('Cluttered TP path');

  // ── JOURNAL-WEIGHTED SCORING ──────────────────────────────────────────────
  if (patternType && Object.keys(journalStats).length > 0) {
    const dl2 = direction === 'LONG' ? 'Bullish' : 'Bearish';
    const ptName: Record<string, string> = {
      ENGULFING:    `${dl2} Engulfing at 20 EMA`,
      PIN_BAR:      `${dl2} Pin Bar off 20 EMA`,
      STRONG_CLOSE: `${dl2} Strong Close off 20 EMA`,
      EMA_BOUNCE:   `${dl2} EMA 20 Pullback`,
    };
    const histKey = `${ptName[patternType] || 'EMA Pullback'}|||${granularity}`;
    const hist = journalStats[histKey];
    if (hist) {
      const closed = hist.wins + hist.losses;
      if (closed >= 5) {
        const wr = hist.wins / closed;
        if (wr >= 0.65) {
          score += 10;
          confluence.push(`Historical edge (${Math.round(wr * 100)}% WR)`);
        } else if (wr <= 0.40) {
          score -= 10;
          confluence.push(`Historical weakness (${Math.round(wr * 100)}% WR)`);
        }
      }
    }
  }

  const historicalEdge = confluence.some(c => c.startsWith('Historical edge'));

  // HTF conflict or counter-slope caps at DEVELOPING
  const qualityRaw: 'PREMIUM'|'STRONG'|'DEVELOPING' =
    score >= 95 ? 'PREMIUM' : score >= 75 ? 'STRONG' : 'DEVELOPING';
  const quality: 'PREMIUM'|'STRONG'|'DEVELOPING' =
    (htfConflict || !emaSlopeAligned) ? 'DEVELOPING' : qualityRaw;

  const dl = direction === 'LONG' ? 'Bullish' : 'Bearish';
  const patternNames: Record<string,string> = {
    ENGULFING:    `${dl} Engulfing at 20 EMA`,
    PIN_BAR:      `${dl} Pin Bar off 20 EMA`,
    STRONG_CLOSE: `${dl} Strong Close off 20 EMA`,
    EMA_BOUNCE:   `${dl} EMA 20 Pullback`,
  };

  const checklist: SetupChecklist = {
    trend: true,           // passed Gate 1
    pullbackQuality: true, // passed Gate 2
    momentum: true,        // passed Gate 3
    rsi: true,             // passed Gate 4
    viability: true,       // passed Gate 5
    session,
    volumeSurge: volRatio >= 1.5,
    liquiditySweep,
    pdhlConfluence,
    historicalEdge,
  };

  const setup: Setup = {
    pair,
    direction,
    quality,
    rrRatio: Math.round(rrRatio * 100) / 100,
    entry: price,
    sl,
    tp1,
    tp2,
    tp3,
    pattern: patternNames[patternType] || 'EMA Pullback',
    confluence,
    scannedAt: new Date().toISOString(),
    timeframe: granularity,
    session,
    checklist,
    ...currentMomentum,
    ...pullbackCompletion,
    ...trendConfirmation,
    ...trendSetupPhase,
  };

  return { setup, reason: 'OK', detail };
}

export async function runScan(granularity='H1', minRR=1.3): Promise<Setup[]> {
  const htfGran = HTF_MAP[granularity] || 'D';
  const results: Setup[] = [];
  for (const pair of PAIRS) {
    try {
      const [candles, htf] = await Promise.all([
        fetchCandles(pair, granularity, 250),
        fetchCandles(pair, htfGran, 150),
      ]);
      const { setup } = analyzeCandles(candles, htf, pair, granularity, minRR);
      if (setup) {
        setup.newsRisk = await checkNewsRisk(pair);
        results.push(setup);
      }
    } catch(e: any) {
      console.error(`Skip ${pair}:`, e.message);
    }
  }
  results.sort((a,b) => {
    const ord = {PREMIUM:0,STRONG:1,DEVELOPING:2};
    return ord[a.quality]-ord[b.quality] || b.rrRatio-a.rrRatio;
  });
  return results;
}

export async function debugScan(
  granularity='H1', minRR=1.3, journalStats: JournalStats = {}, pairsOverride?: string[]
): Promise<DebugResult[]> {
  const htfGran = HTF_MAP[granularity] || 'D';
  const results: DebugResult[] = [];
  const pairsToScan = (pairsOverride && pairsOverride.length) ? pairsOverride : PAIRS;
  for (const pair of pairsToScan) {
    try {
      const [candles, htf] = await Promise.all([
        fetchCandles(pair, granularity, 250),
        fetchCandles(pair, htfGran, 150),
      ]);
      const { setup, reason, detail } = analyzeCandles(candles, htf, pair, granularity, minRR, true, journalStats);
      if (setup) {
        setup.newsRisk = await checkNewsRisk(pair);
      }
      results.push({
        pair,
        result: setup ? 'SETUP' : 'REJECTED',
        reason,
        detail,
        ...(setup ? { setup } : {}),
      });
    } catch(e: any) {
      results.push({ pair, result: 'ERROR', reason: (e as any).message });
    }
  }
  return results;
}

// ── Trainer: compute labeled structures from real candles ─────────────────────

export interface TrainerStructures {
  swingHighs:  { time: number; price: number }[];
  swingLows:   { time: number; price: number }[];
  bosEvents:   { time: number; type: 'bullish'|'bearish'; brokenLevel: number }[];
  chochEvents: { time: number; type: 'bullish'|'bearish'; brokenLevel: number }[];
  supplyZones: { time: number; obHigh: number; obLow: number }[];
  demandZones: { time: number; obHigh: number; obLow: number }[];
  presentConcepts: string[];
}

function toTs(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

export function computeStructures(candles: Candle[], margin = 5): TrainerStructures {
  const swings = findSwings(candles, margin);
  const highs  = swings.filter(s => s.type === 'high');
  const lows   = swings.filter(s => s.type === 'low');

  const swingHighs = highs.map(s => ({ time: toTs(candles[s.index].t), price: s.price }));
  const swingLows  = lows.map(s => ({ time: toTs(candles[s.index].t), price: s.price }));

  // Overall trend — used to classify BOS (with trend) vs CHoCH (against trend)
  const overallTrend = getTrend(swings);

  const bosEvents:   TrainerStructures['bosEvents']   = [];
  const chochEvents: TrainerStructures['chochEvents'] = [];
  const brokenHighs = new Set<number>(); // swing indices already flagged
  const brokenLows  = new Set<number>();

  // Each swing high/low → find first candle that closes through it
  for (const sh of highs) {
    for (let i = sh.index + 1; i < candles.length; i++) {
      if (candles[i].c > sh.price) {
        const t = toTs(candles[i].t);
        // Breaking a swing HIGH → bullish break
        // In a downtrend that's a CHoCH; in uptrend or null it's a BOS
        if (!brokenHighs.has(sh.index)) {
          brokenHighs.add(sh.index);
          if (overallTrend === 'SHORT') {
            chochEvents.push({ time: t, type: 'bullish', brokenLevel: sh.price });
          } else {
            bosEvents.push({ time: t, type: 'bullish', brokenLevel: sh.price });
          }
        }
        break;
      }
    }
  }
  for (const sl of lows) {
    for (let i = sl.index + 1; i < candles.length; i++) {
      if (candles[i].c < sl.price) {
        const t = toTs(candles[i].t);
        // Breaking a swing LOW → bearish break
        // In an uptrend that's a CHoCH; in downtrend or null it's a BOS
        if (!brokenLows.has(sl.index)) {
          brokenLows.add(sl.index);
          if (overallTrend === 'LONG') {
            chochEvents.push({ time: t, type: 'bearish', brokenLevel: sl.price });
          } else {
            bosEvents.push({ time: t, type: 'bearish', brokenLevel: sl.price });
          }
        }
        break;
      }
    }
  }

  bosEvents.sort((a, b)   => a.time - b.time);
  chochEvents.sort((a, b) => a.time - b.time);

  // Order blocks: last opposing candle before each BOS (limit 4 zones per side to keep chart clean)
  const supplyZones: TrainerStructures['supplyZones'] = [];
  const demandZones: TrainerStructures['demandZones'] = [];

  for (const bos of bosEvents) {
    const bosIdx = candles.findIndex(c => toTs(c.t) === bos.time);
    if (bosIdx < 2) continue;
    if (bos.type === 'bearish' && supplyZones.length < 4) {
      for (let i = bosIdx - 1; i >= Math.max(0, bosIdx - 8); i--) {
        if (candles[i].c > candles[i].o) { // last bullish candle before bearish BOS = supply OB
          supplyZones.push({ time: toTs(candles[i].t), obHigh: candles[i].h, obLow: candles[i].l });
          break;
        }
      }
    } else if (bos.type === 'bullish' && demandZones.length < 4) {
      for (let i = bosIdx - 1; i >= Math.max(0, bosIdx - 8); i--) {
        if (candles[i].c < candles[i].o) { // last bearish candle before bullish BOS = demand OB
          demandZones.push({ time: toTs(candles[i].t), obHigh: candles[i].h, obLow: candles[i].l });
          break;
        }
      }
    }
  }

  const presentConcepts: string[] = ['Swing High', 'Swing Low'];
  if (bosEvents.length   > 0) presentConcepts.push('BOS');
  if (chochEvents.length > 0) presentConcepts.push('CHoCH');
  if (supplyZones.length > 0) presentConcepts.push('Supply Zone');
  if (demandZones.length > 0) presentConcepts.push('Demand Zone');

  return { swingHighs, swingLows, bosEvents, chochEvents, supplyZones, demandZones, presentConcepts };
}

// ── Scout Mode ────────────────────────────────────────────────────────────────
// Produces a report for every pair — no gate filtering. Used by the scout scan.

export interface ScoutReport {
  pair: string;
  displaySymbol: string;
  price: number;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  scoutDirection: 'LONG' | 'SHORT' | 'NEUTRAL';
  tradeDirection: 'LONG' | 'SHORT' | 'NEUTRAL';
  htfBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  zone: 'PREMIUM' | 'DISCOUNT' | 'FAIR VALUE';
  nearestResistance: number | null;
  nearestSupport: number | null;
  recentBOS: { type: 'bullish' | 'bearish'; level: number } | null;
  recentChoCH: { type: 'bullish' | 'bearish'; level: number } | null;
  atr: number;
  rsi: number;
  ema20: number;
  session: string;
  interestLevel: 'HIGH' | 'MEDIUM' | 'LOW';
  timeframe: string;
  scannedAt: string;
  candleTime: string;
  newsRisk?: boolean;
  momentumScore: number;
  momentumLabel: MomentumLabel;
  momentumAlignedWithBias: boolean;
  momentumConflict: boolean;
  pullbackScore: number;
  pullbackStatus: PullbackStatus;
  pullbackCompleted: boolean;
  pullbackReason: string;
  confirmationScore: number;
  confirmationStatus: ConfirmationStatus;
  confirmationConfirmed: boolean;
  confirmationReason: string;
  reversalConfirmed: boolean;
  reversalReason: string;
  setupGrade: SetupGrade;
  setupGradeReason: string;
  evalEligible: boolean;
  evalReason: string;
  entryTimingState: EntryTimingState;
  entryTimingReason: string;
  trendDirection: TrendLabel;
  trendScore: number;
  trendReason: string;
  dailyTrendDirection: DirectionLabel;
  dailySwingStructure: StructureLabel;
  dailyBosDirection: DirectionLabel;
  dailyChochDirection: DirectionLabel;
  h4TrendDirection: DirectionLabel;
  setupTimeframeDirection: DirectionLabel;
  setupTimeframeScore: number;
  setupTimeframeReason: string;
  marketPhase: string;
  marketPhaseReason: string;
  trendSetupAligned: boolean;
  isPullbackAgainstTrend: boolean;
  entryStatus: EntryStatus;
  distanceFromEntryAtr: number | null;
  distanceFromEntryPercent: number | null;
  // Trade levels — derived from active structure first, with EMA20 only as nearby fallback
  entry: number | null;
  sl: number | null;
  tp1: number | null;
  tp2: number | null;
  rrRatio: number | null;
}

function momentumLabel(score: number): MomentumLabel {
  if (score >= 7) return 'Strong Bullish';
  if (score >= 3) return 'Bullish';
  if (score <= -7) return 'Strong Bearish';
  if (score <= -3) return 'Bearish';
  return 'Neutral / Mixed';
}

function momentumAlignment(
  score: number,
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'LONG' | 'SHORT'
) {
  const normalizedBias = bias === 'LONG' ? 'BULLISH' : bias === 'SHORT' ? 'BEARISH' : bias;
  const aligned = (normalizedBias === 'BULLISH' && score >= 3) || (normalizedBias === 'BEARISH' && score <= -3);
  const conflict = (normalizedBias === 'BULLISH' && score <= -3) || (normalizedBias === 'BEARISH' && score >= 3);
  return {
    momentumAlignedWithBias: aligned,
    momentumConflict: conflict,
  };
}

function scoreCurrentMomentum(
  candles: Candle[],
  atr: number,
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'LONG' | 'SHORT',
  recentBOS: { type: 'bullish' | 'bearish'; level: number } | null = null,
  recentChoCH: { type: 'bullish' | 'bearish'; level: number } | null = null
) {
  const recent = candles.slice(-8);
  const atrSafe = atr > 0 ? atr : 0.00001;
  let raw = 0;
  let weightTotal = 0;

  recent.forEach((c, idx) => {
    const range = Math.max(c.h - c.l, 0.00001);
    const body = Math.abs(c.c - c.o);
    const direction = c.c > c.o ? 1 : c.c < c.o ? -1 : 0;
    const bodyStrength = Math.min(1.25, body / atrSafe);
    const closePressure = ((c.c - c.l) / range - 0.5) * 2;
    const weight = 0.75 + (idx / Math.max(1, recent.length - 1)) * 0.5;
    raw += ((direction * bodyStrength * 1.15) + (closePressure * 0.55)) * weight;
    weightTotal += weight;
  });

  const displacementCandles = recent.slice(-3);
  displacementCandles.forEach(c => {
    const range = Math.max(c.h - c.l, 0.00001);
    const body = Math.abs(c.c - c.o);
    const closePosition = (c.c - c.l) / range;
    if (body >= 0.75 * atrSafe && closePosition >= 0.72) raw += 1.35;
    if (body >= 0.75 * atrSafe && closePosition <= 0.28) raw -= 1.35;
  });

  if (recentBOS?.type === 'bullish') raw += 1.4;
  if (recentBOS?.type === 'bearish') raw -= 1.4;
  if (recentChoCH?.type === 'bullish') raw += 1.1;
  if (recentChoCH?.type === 'bearish') raw -= 1.1;

  const normalized = weightTotal > 0 ? raw / (weightTotal * 1.7) : 0;
  const momentumScore = Math.max(-10, Math.min(10, Math.round(normalized * 10)));
  return {
    momentumScore,
    momentumLabel: momentumLabel(momentumScore),
    ...momentumAlignment(momentumScore, bias),
  };
}

function pullbackStatus(score: number): PullbackStatus {
  if (score <= 2) return 'Aggressive pullback / Not ready';
  if (score <= 4) return 'Pullback still active';
  if (score <= 6) return 'Stabilizing';
  if (score <= 8) return 'Reversal forming';
  return 'Pullback completed';
}

function scorePullbackCompletion(
  candles: Candle[],
  atr: number,
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'LONG' | 'SHORT',
  recentBOS: { type: 'bullish' | 'bearish'; level: number } | null = null,
  recentChoCH: { type: 'bullish' | 'bearish'; level: number } | null = null,
  support: number | null = null,
  resistance: number | null = null
) {
  const direction = bias === 'LONG' ? 'BULLISH' : bias === 'SHORT' ? 'BEARISH' : bias;
  if (direction === 'NEUTRAL') {
    return {
      pullbackScore: 3,
      pullbackStatus: pullbackStatus(3),
      pullbackCompleted: false,
      pullbackReason: 'Neutral bias; pullback completion cannot be confirmed.',
    };
  }

  const recent = candles.slice(-10);
  const atrSafe = atr > 0 ? atr : 0.00001;
  let score = 5;
  const reasons: string[] = [];
  const isBullish = direction === 'BULLISH';
  const favorableStructure = isBullish ? 'bullish' : 'bearish';
  const opposingStructure = isBullish ? 'bearish' : 'bullish';
  const body = (c: Candle) => Math.abs(c.c - c.o);
  const range = (c: Candle) => Math.max(c.h - c.l, 0.00001);
  const closePos = (c: Candle) => (c.c - c.l) / range(c);
  const opposingBody = (c: Candle) => isBullish ? Math.max(0, c.o - c.c) : Math.max(0, c.c - c.o);
  const favorableBody = (c: Candle) => isBullish ? Math.max(0, c.c - c.o) : Math.max(0, c.o - c.c);
  const avg = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

  const earlyOpposing = avg(recent.slice(0, 5).map(opposingBody));
  const lateOpposing = avg(recent.slice(-5).map(opposingBody));
  if (lateOpposing < earlyOpposing * 0.7 && earlyOpposing > 0.12 * atrSafe) {
    score += 1.5;
    reasons.push('opposing candle bodies are shrinking');
  } else if (lateOpposing > Math.max(earlyOpposing * 1.15, 0.18 * atrSafe)) {
    score -= 1.5;
    reasons.push('opposing candle bodies are still expanding');
  }

  const last = recent[recent.length - 1];
  const prior = recent.slice(0, -1);
  if (last && prior.length) {
    if (isBullish) {
      const priorLow = Math.min(...prior.map(c => c.l));
      if (last.l < priorLow - 0.05 * atrSafe) {
        score -= 2;
        reasons.push('price is making fresh pullback lows');
      }
    } else {
      const priorHigh = Math.max(...prior.map(c => c.h));
      if (last.h > priorHigh + 0.05 * atrSafe) {
        score -= 2;
        reasons.push('price is making fresh pullback highs');
      }
    }
  }

  const lastThree = recent.slice(-3);
  const hasRejection = lastThree.some(c => {
    const lowerWick = Math.min(c.o, c.c) - c.l;
    const upperWick = c.h - Math.max(c.o, c.c);
    const b = body(c);
    return isBullish
      ? lowerWick >= Math.max(0.25 * atrSafe, b * 1.2) && closePos(c) >= 0.58
      : upperWick >= Math.max(0.25 * atrSafe, b * 1.2) && closePos(c) <= 0.42;
  });
  if (hasRejection) {
    score += 1.5;
    reasons.push(isBullish ? 'bullish rejection printed' : 'bearish rejection printed');
  }

  const hasStrongFavorableClose = lastThree.some(c => (
    favorableBody(c) >= 0.35 * atrSafe &&
    (isBullish ? closePos(c) >= 0.68 : closePos(c) <= 0.32)
  ));
  if (hasStrongFavorableClose) {
    score += 1.5;
    reasons.push(isBullish ? 'buyers are closing candles strong' : 'sellers are closing candles strong');
  }

  const hasActiveOpposingDisplacement = lastThree.some(c => (
    opposingBody(c) >= 0.65 * atrSafe &&
    (isBullish ? closePos(c) <= 0.3 : closePos(c) >= 0.7)
  ));
  if (hasActiveOpposingDisplacement) {
    score -= 2.5;
    reasons.push(isBullish ? 'strong bearish displacement remains active' : 'strong bullish displacement remains active');
  }

  if (recentBOS?.type === favorableStructure) {
    score += 1.5;
    reasons.push(`${favorableStructure} BOS appeared after the pullback`);
  } else if (recentBOS?.type === opposingStructure) {
    score -= 1;
    reasons.push(`${opposingStructure} BOS still favors the pullback`);
  }

  if (recentChoCH?.type === favorableStructure) {
    score += 1.5;
    reasons.push(`${favorableStructure} CHoCH confirms reaction`);
  } else if (recentChoCH?.type === opposingStructure) {
    score -= 1;
    reasons.push(`${opposingStructure} CHoCH warns pullback is not finished`);
  }

  if (last) {
    if (isBullish && support !== null) {
      if (last.l >= support - 0.5 * atrSafe && last.c > support + 0.1 * atrSafe) {
        score += 1;
        reasons.push('price is holding support/demand');
      } else if (last.c < support - 0.2 * atrSafe) {
        score -= 1.5;
        reasons.push('price closed below support/demand');
      }
    } else if (!isBullish && resistance !== null) {
      if (last.h <= resistance + 0.5 * atrSafe && last.c < resistance - 0.1 * atrSafe) {
        score += 1;
        reasons.push('price is holding resistance/supply');
      } else if (last.c > resistance + 0.2 * atrSafe) {
        score -= 1.5;
        reasons.push('price closed above resistance/supply');
      }
    }
  }

  const pullbackScore = Math.max(0, Math.min(10, Math.round(score)));
  return {
    pullbackScore,
    pullbackStatus: pullbackStatus(pullbackScore),
    pullbackCompleted: pullbackScore >= 9,
    pullbackReason: reasons[0] || 'Mixed pullback evidence; no clear completion signal yet.',
  };
}

function confirmationStatus(score: number): ConfirmationStatus {
  if (score <= 2) return 'No confirmation';
  if (score <= 4) return 'Early confirmation';
  if (score <= 6) return 'Building confirmation';
  if (score <= 8) return 'Strong confirmation';
  return 'Confirmed trend resumption';
}

function scoreTrendConfirmation(
  candles: Candle[],
  atr: number,
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'LONG' | 'SHORT',
  recentBOS: { type: 'bullish' | 'bearish'; level: number } | null = null,
  recentChoCH: { type: 'bullish' | 'bearish'; level: number } | null = null
) {
  const direction = bias === 'LONG' ? 'BULLISH' : bias === 'SHORT' ? 'BEARISH' : bias;
  if (direction === 'NEUTRAL') {
    return {
      confirmationScore: 1,
      confirmationStatus: confirmationStatus(1),
      confirmationConfirmed: false,
      confirmationReason: 'Neutral bias; trend resumption is not confirmed.',
    };
  }

  const recent = candles.slice(-10);
  const atrSafe = atr > 0 ? atr : 0.00001;
  let score = 2;
  const reasons: string[] = [];
  const isBullish = direction === 'BULLISH';
  const favorableStructure = isBullish ? 'bullish' : 'bearish';
  const opposingStructure = isBullish ? 'bearish' : 'bullish';
  const body = (c: Candle) => Math.abs(c.c - c.o);
  const range = (c: Candle) => Math.max(c.h - c.l, 0.00001);
  const closePos = (c: Candle) => (c.c - c.l) / range(c);
  const favorableBody = (c: Candle) => isBullish ? Math.max(0, c.c - c.o) : Math.max(0, c.o - c.c);
  const opposingBody = (c: Candle) => isBullish ? Math.max(0, c.o - c.c) : Math.max(0, c.c - c.o);

  if (recentChoCH?.type === favorableStructure) {
    score += 2;
    reasons.push(`${favorableStructure} CHoCH printed after pullback`);
  } else if (recentChoCH?.type === opposingStructure) {
    score -= 2;
    reasons.push(`${opposingStructure} CHoCH is still active`);
  }

  if (recentBOS?.type === favorableStructure) {
    score += 2;
    reasons.push(`${favorableStructure} BOS confirms trend resumption`);
  } else if (recentBOS?.type === opposingStructure) {
    score -= 1.5;
    reasons.push(`${opposingStructure} BOS argues against resumption`);
  }

  const lastFour = recent.slice(-4);
  const favorableDisplacement = lastFour.some(c => (
    favorableBody(c) >= 0.75 * atrSafe &&
    (isBullish ? closePos(c) >= 0.72 : closePos(c) <= 0.28)
  ));
  if (favorableDisplacement) {
    score += 2;
    reasons.push(isBullish ? 'bullish displacement candle printed' : 'bearish displacement candle printed');
  }

  const opposingDisplacement = lastFour.some(c => (
    opposingBody(c) >= 0.75 * atrSafe &&
    (isBullish ? closePos(c) <= 0.28 : closePos(c) >= 0.72)
  ));
  if (opposingDisplacement) {
    score -= 2;
    reasons.push(isBullish ? 'bearish displacement is still active' : 'bullish displacement is still active');
  }

  const last = recent[recent.length - 1];
  const prior = recent.slice(0, -1);
  if (last && prior.length) {
    if (isBullish) {
      const recentSwingHigh = Math.max(...prior.slice(-8).map(c => c.h));
      if (last.c > recentSwingHigh + 0.05 * atrSafe) {
        score += 1.5;
        reasons.push('strong close above recent swing high');
      }
      const priorLow = Math.min(...prior.map(c => c.l));
      if (last.l < priorLow - 0.05 * atrSafe) {
        score -= 2;
        reasons.push('fresh swing low printed');
      }
    } else {
      const recentSwingLow = Math.min(...prior.slice(-8).map(c => c.l));
      if (last.c < recentSwingLow - 0.05 * atrSafe) {
        score += 1.5;
        reasons.push('strong close below recent swing low');
      }
      const priorHigh = Math.max(...prior.map(c => c.h));
      if (last.h > priorHigh + 0.05 * atrSafe) {
        score -= 2;
        reasons.push('fresh swing high printed');
      }
    }
  }

  const lastThree = recent.slice(-3);
  const favorableCloses = lastThree.filter(c => favorableBody(c) > 0).length;
  if (favorableCloses >= 2) {
    score += 1.25;
    reasons.push(isBullish ? 'consecutive bullish closes' : 'consecutive bearish closes');
  }

  const weakFavorableCloses = lastThree.filter(c => (
    favorableBody(c) > 0 &&
    (isBullish ? closePos(c) < 0.58 : closePos(c) > 0.42)
  )).length;
  if (weakFavorableCloses >= 2) {
    score -= 1;
    reasons.push('recent closes are weak');
  }

  const ema20 = calcEMA(candles, 20).at(-1);
  if (last && ema20 !== undefined) {
    if ((isBullish && last.c > ema20) || (!isBullish && last.c < ema20)) {
      score += 1.25;
      reasons.push('EMA20 reclaimed in setup direction');
    } else {
      score -= 1.25;
      reasons.push('EMA20 has not been reclaimed');
    }
  }

  const swings = findSwings(recent, 2);
  const lows = swings.filter(s => s.type === 'low').slice(-2);
  const highs = swings.filter(s => s.type === 'high').slice(-2);
  if (isBullish && lows.length === 2 && lows[1].price > lows[0].price) {
    score += 1.25;
    reasons.push('higher low formed after pullback');
  } else if (!isBullish && highs.length === 2 && highs[1].price < highs[0].price) {
    score += 1.25;
    reasons.push('lower high formed after pullback');
  }

  const confirmationScore = Math.max(0, Math.min(10, Math.round(score)));
  return {
    confirmationScore,
    confirmationStatus: confirmationStatus(confirmationScore),
    confirmationConfirmed: confirmationScore >= 9,
    confirmationReason: reasons[0] || 'No clear resumption signal yet.',
  };
}

function detectReversalConfirmation(
  candles: Candle[],
  tradeDirection: 'LONG' | 'SHORT' | 'NEUTRAL',
  setupTimeframeDirection: DirectionLabel,
  recentChoCH: { type: 'bullish' | 'bearish'; level: number } | null = null
) {
  if (tradeDirection === 'NEUTRAL') {
    return {
      reversalConfirmed: false,
      reversalReason: 'No trade direction available for reversal confirmation.',
    };
  }

  const isLong = tradeDirection === 'LONG';
  const neededStructure = isLong ? 'Bullish' : 'Bearish';
  const neededChoch = isLong ? 'bullish' : 'bearish';
  if (setupTimeframeDirection === neededStructure) {
    return {
      reversalConfirmed: true,
      reversalReason: `${neededStructure} setup timeframe structure shift is active.`,
    };
  }

  if (recentChoCH?.type === neededChoch) {
    return {
      reversalConfirmed: true,
      reversalReason: `${neededChoch} CHoCH detected after the pullback.`,
    };
  }

  const recent = candles.slice(-28);
  const swings = findSwings(recent, 2);
  const last = recent.at(-1);
  if (last) {
    if (isLong) {
      const minorHigh = swings.filter(s => s.type === 'high' && s.index < recent.length - 1).at(-1);
      if (minorHigh && last.c > minorHigh.price) {
        return {
          reversalConfirmed: true,
          reversalReason: `Price closed above recent minor swing high ${roundPrice(minorHigh.price)}.`,
        };
      }
    } else {
      const minorLow = swings.filter(s => s.type === 'low' && s.index < recent.length - 1).at(-1);
      if (minorLow && last.c < minorLow.price) {
        return {
          reversalConfirmed: true,
          reversalReason: `Price closed below recent minor swing low ${roundPrice(minorLow.price)}.`,
        };
      }
    }
  }

  return {
    reversalConfirmed: false,
    reversalReason: isLong
      ? 'Waiting for bullish structure shift, close above minor swing high, or bullish CHoCH.'
      : 'Waiting for bearish structure shift, close below minor swing low, or bearish CHoCH.',
  };
}

function setupStatusLabelFromScores(
  pullbackCompleted: boolean,
  pullbackStatusValue: PullbackStatus,
  pullbackScore: number,
  confirmationConfirmed: boolean,
  confirmationStatusValue: ConfirmationStatus,
  confirmationScore: number
) {
  if (confirmationConfirmed || confirmationScore >= 9) return 'Trend Resumption Confirmed';
  if (confirmationStatusValue === 'Strong confirmation' || confirmationScore >= 7) return 'Strong Confirmation';
  if (confirmationStatusValue === 'Building confirmation' || confirmationStatusValue === 'Early confirmation' || confirmationScore >= 3) return 'Early Confirmation';
  if (pullbackCompleted || pullbackStatusValue === 'Pullback completed' || pullbackScore >= 9) return 'Pullback Complete';
  return 'Pullback Active';
}

function gradeScoutSetup(
  tradeDirection: 'LONG' | 'SHORT' | 'NEUTRAL',
  dailyTrendDirection: DirectionLabel,
  setupTimeframeDirection: DirectionLabel,
  zone: 'PREMIUM' | 'DISCOUNT' | 'FAIR VALUE',
  setupStatus: string,
  reversalConfirmed: boolean
) {
  const tradeTrend = tradeDirection === 'LONG' ? 'Bullish' : tradeDirection === 'SHORT' ? 'Bearish' : 'Mixed';
  const trendDisplay = dailyTrendDirection === 'Bullish' || dailyTrendDirection === 'Bearish' ? dailyTrendDirection : 'Mixed';
  const trendAligned = tradeTrend !== 'Mixed' && trendDisplay === tradeTrend;
  const locationAligned = (tradeDirection === 'LONG' && zone === 'DISCOUNT') || (tradeDirection === 'SHORT' && zone === 'PREMIUM');
  const locationConflict = (tradeDirection === 'LONG' && zone === 'PREMIUM') || (tradeDirection === 'SHORT' && zone === 'DISCOUNT');
  const counterTrend = tradeTrend !== 'Mixed' && trendDisplay !== 'Mixed' && trendDisplay !== tradeTrend;
  const confirmationStarted = reversalConfirmed ||
    setupStatus === 'Early Confirmation' ||
    setupStatus === 'Strong Confirmation' ||
    setupStatus === 'Trend Resumption Confirmed';
  const setupFlowAligned = tradeTrend !== 'Mixed' && setupTimeframeDirection === tradeTrend;

  if (tradeDirection === 'NEUTRAL' || counterTrend || locationConflict) {
    const reason = tradeDirection === 'NEUTRAL'
      ? 'Trade direction is neutral.'
      : locationConflict
      ? 'Location conflicts with trade direction.'
      : 'Trade direction is counter-trend.';
    return { setupGrade: 'C' as SetupGrade, setupGradeReason: reason };
  }

  if (trendAligned && locationAligned && confirmationStarted) {
    return {
      setupGrade: 'A' as SetupGrade,
      setupGradeReason: reversalConfirmed ? 'Trend, location, and reversal confirmation align.' : 'Trend, location, and confirmation have started.',
    };
  }

  if (trendAligned && locationAligned) {
    return {
      setupGrade: 'B' as SetupGrade,
      setupGradeReason: 'Trend and location align, but pullback/reversal is still developing.',
    };
  }

  if (trendDisplay === 'Mixed' && locationAligned && (setupFlowAligned || confirmationStarted)) {
    return {
      setupGrade: 'B' as SetupGrade,
      setupGradeReason: setupFlowAligned
        ? 'Daily trend is mixed, but short-term flow and location align for review.'
        : 'Daily trend is mixed, but location and reversal evidence are developing.',
    };
  }

  if (trendDisplay === 'Mixed' && locationAligned) {
    return {
      setupGrade: 'B' as SetupGrade,
      setupGradeReason: 'Daily trend is mixed, but location aligns; watch for confirmation.',
    };
  }

  return {
    setupGrade: 'C' as SetupGrade,
    setupGradeReason: 'Trend/location alignment is incomplete.',
  };
}

function evaluateScoutForEval(
  tradeDirection: 'LONG' | 'SHORT' | 'NEUTRAL',
  dailyTrendDirection: DirectionLabel,
  zone: 'PREMIUM' | 'DISCOUNT' | 'FAIR VALUE',
  setupGrade: SetupGrade,
  setupStatus: string,
  reversalConfirmed: boolean,
  entryStatus: EntryStatus,
  distanceFromEntryAtr: number | null,
  entry: number | null,
  sl: number | null,
  tp1: number | null
) {
  const failures: string[] = [];
  const tradeTrend = tradeDirection === 'LONG' ? 'Bullish' : tradeDirection === 'SHORT' ? 'Bearish' : 'Mixed';
  const trendAligned = tradeTrend !== 'Mixed' && dailyTrendDirection === tradeTrend;
  const trendAcceptable = trendAligned || (tradeTrend !== 'Mixed' && dailyTrendDirection === 'Neutral');
  const locationAligned = (tradeDirection === 'LONG' && zone === 'DISCOUNT') || (tradeDirection === 'SHORT' && zone === 'PREMIUM');
  const confirmationStarted = ['Early Confirmation', 'Strong Confirmation', 'Trend Resumption Confirmed'].includes(setupStatus);

  if (!['A', 'B'].includes(setupGrade)) failures.push('setup is not A or B grade');
  if (entryStatus !== 'Tradeable') failures.push('entry is not close enough');
  if (!trendAcceptable) failures.push('Daily trend conflicts with trade direction');
  if (!locationAligned) failures.push('location is not aligned with trade direction');
  if (!reversalConfirmed) failures.push('reversal is not confirmed yet');
  if (!confirmationStarted) failures.push('confirmation has not started');
  if (distanceFromEntryAtr === null || distanceFromEntryAtr > 0.25) failures.push('entry is outside Tradeable distance');
  if (entry === null || sl === null || tp1 === null) failures.push('entry, SL, or TP1 is missing');

  if (failures.length) {
    return {
      evalEligible: false,
      evalReason: `Watch only: ${failures.join('; ')}.`,
    };
  }

  return {
    evalEligible: true,
    evalReason: 'Eval eligible: A/B setup, trend is aligned or mixed without conflict, location aligns, reversal confirmed, confirmation started, and entry is Tradeable.',
  };
}

function classifyEntryTiming(
  tradeDirection: 'LONG' | 'SHORT' | 'NEUTRAL',
  zone: 'PREMIUM' | 'DISCOUNT' | 'FAIR VALUE',
  setupGrade: SetupGrade,
  setupStatus: string,
  reversalConfirmed: boolean,
  entryStatus: EntryStatus,
  confirmationScore: number,
  pullbackCompleted: boolean,
  pullbackScore: number,
  entry: number | null,
  sl: number | null,
  tp1: number | null
) {
  const locationAligned = (tradeDirection === 'LONG' && zone === 'DISCOUNT') || (tradeDirection === 'SHORT' && zone === 'PREMIUM');
  const entryNearby = entryStatus === 'Tradeable' || entryStatus === 'Near Entry';
  const levelsReady = entry !== null && sl !== null && tp1 !== null;
  const confirmationStarted = ['Early Confirmation', 'Strong Confirmation', 'Trend Resumption Confirmed'].includes(setupStatus) || confirmationScore >= 3;
  const reactionStarted = reversalConfirmed || confirmationStarted || pullbackCompleted || pullbackScore >= 7;

  if (!levelsReady || tradeDirection === 'NEUTRAL' || setupGrade === 'C' || !locationAligned) {
    return {
      entryTimingState: 'Not Ready' as EntryTimingState,
      entryTimingReason: 'Not ready: trade direction, location, grade, or trade levels are not aligned.',
    };
  }

  if (entryStatus === 'Tradeable' && reversalConfirmed && confirmationStarted) {
    return {
      entryTimingState: 'Entry Triggered' as EntryTimingState,
      entryTimingReason: 'Entry trigger started: price is tradeable, reversal is confirmed, and confirmation has started.',
    };
  }

  if (entryNearby && reactionStarted) {
    return {
      entryTimingState: 'Reaction Started' as EntryTimingState,
      entryTimingReason: 'Reaction started: price is near the area and reversal/reaction evidence is developing. Wait for entry trigger.',
    };
  }

  if (['Tradeable', 'Near Entry', 'Waiting'].includes(entryStatus)) {
    return {
      entryTimingState: 'Area Reached' as EntryTimingState,
      entryTimingReason: 'Area reached: location is valid, but reaction/confirmation has not started yet.',
    };
  }

  return {
    entryTimingState: 'Not Ready' as EntryTimingState,
    entryTimingReason: 'Not ready: price is too far from the actionable area.',
  };
}

function directionFromSignedScore(score: number): DirectionLabel {
  if (score >= 2) return 'Bullish';
  if (score <= -2) return 'Bearish';
  return 'Neutral';
}

function roundPrice(value: number) {
  return Math.round(value * 1e5) / 1e5;
}

function analyzeDirectionalFrame(candles: Candle[], label: string) {
  if (candles.length < 55) {
    return {
      direction: 'Neutral' as DirectionLabel,
      structureDirection: 'Neutral' as DirectionLabel,
      swingStructure: 'Mixed' as StructureLabel,
      lastBosDirection: 'Neutral' as DirectionLabel,
      lastChochDirection: 'Neutral' as DirectionLabel,
      score: 0,
      signedScore: 0,
      reason: `${label}: not enough candles for directional read.`,
    };
  }

  const swings = findSwings(candles.slice(-120), 4);
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');
  const structures = computeStructures(candles.slice(-160), 4);
  const ema20 = calcEMA(candles, 20).at(-1);
  const ema50 = calcEMA(candles, 50).at(-1);
  const last = candles[candles.length - 1];
  let signedScore = 0;
  let structureDirection: DirectionLabel = 'Neutral';
  let swingStructure: StructureLabel = 'Mixed';
  const reasons: string[] = [];

  if (highs.length >= 2 && lows.length >= 2) {
    const higherHigh = highs[highs.length - 1].price > highs[highs.length - 2].price;
    const higherLow = lows[lows.length - 1].price > lows[lows.length - 2].price;
    const lowerHigh = highs[highs.length - 1].price < highs[highs.length - 2].price;
    const lowerLow = lows[lows.length - 1].price < lows[lows.length - 2].price;
    if (higherHigh && higherLow) {
      signedScore += 2.5;
      structureDirection = 'Bullish';
      swingStructure = 'HH/HL';
      reasons.push(`${label}: higher highs / higher lows`);
    } else if (lowerHigh && lowerLow) {
      signedScore -= 2.5;
      structureDirection = 'Bearish';
      swingStructure = 'LH/LL';
      reasons.push(`${label}: lower highs / lower lows`);
    } else if (higherLow) {
      signedScore += 1;
      reasons.push(`${label}: higher low forming`);
    } else if (lowerHigh) {
      signedScore -= 1;
      reasons.push(`${label}: lower high forming`);
    }
  }

  const lastBreak = [...structures.bosEvents, ...structures.chochEvents].sort((a, b) => a.time - b.time).at(-1);
  if (lastBreak?.type === 'bullish') {
    signedScore += 2;
    reasons.push(`${label}: last major break bullish`);
  } else if (lastBreak?.type === 'bearish') {
    signedScore -= 2;
    reasons.push(`${label}: last major break bearish`);
  }

  const latestBos = structures.bosEvents.at(-1);
  let lastBosDirection: DirectionLabel = 'Neutral';
  if (latestBos?.type === 'bullish') {
    signedScore += 1.5;
    lastBosDirection = 'Bullish';
    reasons.push(`${label}: bullish BOS present`);
  } else if (latestBos?.type === 'bearish') {
    signedScore -= 1.5;
    lastBosDirection = 'Bearish';
    reasons.push(`${label}: bearish BOS present`);
  }

  const latestChoch = structures.chochEvents.at(-1);
  let lastChochDirection: DirectionLabel = 'Neutral';
  if (latestChoch?.type === 'bullish') {
    signedScore += 1.25;
    lastChochDirection = 'Bullish';
    reasons.push(`${label}: bullish CHoCH present`);
  } else if (latestChoch?.type === 'bearish') {
    signedScore -= 1.25;
    lastChochDirection = 'Bearish';
    reasons.push(`${label}: bearish CHoCH present`);
  }

  if (ema20 !== undefined && ema50 !== undefined) {
    if (last.c > ema20 && last.c > ema50 && ema20 >= ema50) {
      signedScore += 2;
      reasons.push(`${label}: price above EMA20/EMA50`);
    } else if (last.c < ema20 && last.c < ema50 && ema20 <= ema50) {
      signedScore -= 2;
      reasons.push(`${label}: price below EMA20/EMA50`);
    } else if (last.c > ema20 && last.c > ema50) {
      signedScore += 1;
      reasons.push(`${label}: price above key EMAs`);
    } else if (last.c < ema20 && last.c < ema50) {
      signedScore -= 1;
      reasons.push(`${label}: price below key EMAs`);
    }
  }

  const score = Math.max(0, Math.min(10, Math.round(Math.abs(signedScore))));
  let direction = directionFromSignedScore(signedScore);
  if (structureDirection === 'Bullish' && direction === 'Bearish') direction = 'Neutral';
  if (structureDirection === 'Bearish' && direction === 'Bullish') direction = 'Neutral';
  return {
    direction,
    structureDirection,
    swingStructure,
    lastBosDirection,
    lastChochDirection,
    score,
    signedScore,
    reason: reasons[0] || `${label}: mixed structure and EMA conditions.`,
  };
}

function dominantFrameDirection(frame: ReturnType<typeof analyzeDirectionalFrame>): DirectionLabel {
  return frame.structureDirection !== 'Neutral' ? frame.structureDirection : frame.direction;
}

function buildTrendSetupPhase(
  setupCandles: Candle[],
  trendCandlesA: Candle[],
  trendCandlesB: Candle[],
  setupLabel: string,
  trendLabelA = 'Daily',
  trendLabelB = 'H4',
  momentumScore = 0,
  confirmationScore = 0
) {
  const primaryTrend = analyzeDirectionalFrame(trendCandlesA, trendLabelA);
  const secondaryTrend = analyzeDirectionalFrame(trendCandlesB, trendLabelB);
  const trendSignedScore = (primaryTrend.signedScore * 0.6) + (secondaryTrend.signedScore * 0.4);
  const dailyTrendDirection = primaryTrend.structureDirection;
  const h4TrendDirection = dominantFrameDirection(secondaryTrend);
  let trendDirection: TrendLabel = 'Mixed / Transition';
  if (dailyTrendDirection === 'Bullish' && h4TrendDirection === 'Bullish') trendDirection = 'Bullish';
  else if (dailyTrendDirection === 'Bearish' && h4TrendDirection === 'Bearish') trendDirection = 'Bearish';
  else if (dailyTrendDirection === 'Bullish' && h4TrendDirection === 'Bearish') trendDirection = 'Bullish HTF Pullback';
  else if (dailyTrendDirection === 'Bearish' && h4TrendDirection === 'Bullish') trendDirection = 'Bearish HTF Pullback';
  const trendScore = Math.max(0, Math.min(10, Math.round(Math.abs(trendSignedScore))));
  const setupFrame = analyzeDirectionalFrame(setupCandles, setupLabel);
  const setupTimeframeDirection = setupFrame.direction;
  const setupTimeframeScore = setupFrame.score;
  const trendSetupAligned =
    setupTimeframeDirection !== 'Neutral' &&
    trendDirection === setupTimeframeDirection;
  const isPullbackAgainstTrend =
    setupTimeframeDirection !== 'Neutral' &&
    ((trendDirection === 'Bullish' && setupTimeframeDirection === 'Bearish') ||
      (trendDirection === 'Bearish' && setupTimeframeDirection === 'Bullish') ||
      (trendDirection === 'Bullish HTF Pullback' && setupTimeframeDirection === 'Bearish') ||
      (trendDirection === 'Bearish HTF Pullback' && setupTimeframeDirection === 'Bullish'));

  let marketPhase = 'Mixed / Transition';
  if (trendDirection === 'Bullish' && setupTimeframeDirection === 'Bullish') marketPhase = 'Bullish Continuation';
  else if (trendDirection === 'Bullish' && setupTimeframeDirection === 'Bearish') marketPhase = 'Bullish Pullback';
  else if (trendDirection === 'Bullish HTF Pullback' && setupTimeframeDirection === 'Bearish') marketPhase = 'Bullish Pullback';
  else if (trendDirection === 'Bullish HTF Pullback' && setupTimeframeDirection === 'Bullish') marketPhase = 'Pullback Recovery';
  else if (trendDirection === 'Bearish' && setupTimeframeDirection === 'Bearish') marketPhase = 'Bearish Continuation';
  else if (trendDirection === 'Bearish' && setupTimeframeDirection === 'Bullish') marketPhase = 'Bearish Pullback';
  else if (trendDirection === 'Bearish HTF Pullback' && setupTimeframeDirection === 'Bullish') marketPhase = 'Bearish Pullback';
  else if (trendDirection === 'Bearish HTF Pullback' && setupTimeframeDirection === 'Bearish') marketPhase = 'Pullback Rejection';

  return {
    trendDirection,
    trendScore,
    trendReason: `${primaryTrend.reason}; ${secondaryTrend.reason}`,
    dailyTrendDirection,
    dailySwingStructure: primaryTrend.swingStructure,
    dailyBosDirection: primaryTrend.lastBosDirection,
    dailyChochDirection: primaryTrend.lastChochDirection,
    h4TrendDirection,
    setupTimeframeDirection,
    setupTimeframeScore,
    setupTimeframeReason: setupFrame.reason,
    marketPhase,
    marketPhaseReason: trendDirection === 'Bullish HTF Pullback'
      ? `${trendLabelA} bullish, ${trendLabelB} pulling back.`
      : trendDirection === 'Bearish HTF Pullback'
      ? `${trendLabelA} bearish, ${trendLabelB} pulling back.`
      : trendDirection === 'Mixed / Transition'
      ? `${trendLabelA} or ${trendLabelB} is neutral/mixed.`
      : isPullbackAgainstTrend
      ? `${setupTimeframeDirection} setup timeframe is moving against ${trendDirection} higher-timeframe trend.`
      : trendSetupAligned
      ? `${setupTimeframeDirection} setup timeframe agrees with ${trendDirection} higher-timeframe trend.`
      : 'Trend or setup timeframe is neutral/mixed.',
    trendSetupAligned,
    isPullbackAgainstTrend,
  };
}

function nearestActiveZoneEntry(
  candles: Candle[],
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
  price: number,
  atr: number,
  ema20: number,
  nearestSupport: number | null,
  nearestResistance: number | null
) {
  if (bias === 'NEUTRAL') return null;
  const atrSafe = Math.max(atr, Math.abs(price) * 0.0001, 0.00001);
  const structures = computeStructures(candles.slice(-120), 4);
  const isLong = bias === 'BULLISH';
  const zoneMids = (isLong ? structures.demandZones : structures.supplyZones)
    .slice(-6)
    .map(z => (z.high + z.low) / 2)
    .filter(mid => isLong ? mid <= price + 0.25 * atrSafe : mid >= price - 0.25 * atrSafe)
    .sort((a, b) => Math.abs(price - a) - Math.abs(price - b));

  const candidates = [
    ...zoneMids,
    isLong ? nearestSupport : nearestResistance,
    ema20,
  ].filter((v): v is number => Number.isFinite(Number(v)));

  const active = candidates.find(v => Math.abs(price - v) <= 1.25 * atrSafe);
  return roundPrice(active ?? candidates[0] ?? ema20);
}

function classifyEntryDistance(price: number, entry: number | null, atr: number) {
  if (entry === null || !Number.isFinite(entry)) {
    return {
      entryStatus: 'Waiting' as EntryStatus,
      distanceFromEntryAtr: null,
      distanceFromEntryPercent: null,
    };
  }

  const atrSafe = Math.max(atr, Math.abs(price) * 0.0001, 0.00001);
  const distance = Math.abs(price - entry);
  const distanceFromEntryAtr = Math.round((distance / atrSafe) * 100) / 100;
  const distanceFromEntryPercent = Math.round((distance / Math.max(Math.abs(price), 0.00001)) * 10000) / 100;
  let entryStatus: EntryStatus = 'Too Far';
  if (distanceFromEntryAtr <= 0.25) entryStatus = 'Tradeable';
  else if (distanceFromEntryAtr <= 0.5) entryStatus = 'Near Entry';
  else if (distanceFromEntryAtr <= 1) entryStatus = 'Waiting';

  return {
    entryStatus,
    distanceFromEntryAtr,
    distanceFromEntryPercent,
  };
}

function directionLabelToBias(direction: DirectionLabel): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  if (direction === 'Bullish') return 'BULLISH';
  if (direction === 'Bearish') return 'BEARISH';
  return 'NEUTRAL';
}

function biasToTradeDirection(bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'): 'LONG' | 'SHORT' | 'NEUTRAL' {
  if (bias === 'BULLISH') return 'LONG';
  if (bias === 'BEARISH') return 'SHORT';
  return 'NEUTRAL';
}

function alignedScoutBias(context: ReturnType<typeof buildTrendSetupPhase>): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  const dailyBias = directionLabelToBias(context.dailyTrendDirection);
  const setupBias = directionLabelToBias(context.setupTimeframeDirection);
  const trendBias = context.trendDirection === 'Bullish'
    ? 'BULLISH'
    : context.trendDirection === 'Bearish'
    ? 'BEARISH'
    : 'NEUTRAL';

  if (dailyBias !== 'NEUTRAL' && dailyBias === setupBias && dailyBias === trendBias) {
    return dailyBias;
  }
  return 'NEUTRAL';
}

export interface TrendReport {
  pair: string;
  displaySymbol: string;
  direction: TrendDirection;
  trendScore: number;
  structureState: string;
  marketState: MarketState;
  session: string;
  cleanlinessScore: number;
  htfAlignment: string;
  whyTrending: string[];
  warnings: string[];
  timeframe: string;
  scannedAt: string;
}

export interface TrendScanResult {
  strongBullish: TrendReport[];
  strongBearish: TrendReport[];
  pullbackOpportunities: TrendReport[];
  all: TrendReport[];
}

function signedDirection(direction: TrendDirection): number {
  return direction === 'BULLISH' ? 1 : direction === 'BEARISH' ? -1 : 0;
}

function getEmaTrend(candles: Candle[]): TrendDirection {
  if (candles.length < 55) return 'NEUTRAL';
  const ema20 = calcEMA(candles, 20);
  const ema50 = calcEMA(candles, 50);
  const lastIdx = candles.length - 1;
  const price = candles[lastIdx].c;
  const e20 = ema20[lastIdx];
  const e50 = ema50[lastIdx];
  const e20Prev = ema20[lastIdx - 5];
  if (!e20 || !e50 || !e20Prev) return 'NEUTRAL';
  if (price > e20 && e20 > e50 && e20 > e20Prev) return 'BULLISH';
  if (price < e20 && e20 < e50 && e20 < e20Prev) return 'BEARISH';
  return 'NEUTRAL';
}

function getStructureState(candles: Candle[]): { direction: TrendDirection; label: string } {
  const swings = findSwings(candles.slice(-120), 4);
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');
  const trend = getTrend(swings);
  if (trend === 'LONG') return { direction: 'BULLISH', label: 'Clean HH/HL' };
  if (trend === 'SHORT') return { direction: 'BEARISH', label: 'Clean LH/LL' };
  if (highs.length >= 2 && lows.length >= 2) return { direction: 'NEUTRAL', label: 'Mixed swings' };
  return { direction: 'NEUTRAL', label: 'Limited structure' };
}

function countRecentStructureEvents(candles: Candle[], direction: TrendDirection) {
  const structures = computeStructures(candles.slice(-140), 4);
  const wanted = direction === 'BULLISH' ? 'bullish' : direction === 'BEARISH' ? 'bearish' : null;
  const opposing = direction === 'BULLISH' ? 'bearish' : direction === 'BEARISH' ? 'bullish' : null;
  const recentBos = wanted ? structures.bosEvents.filter(e => e.type === wanted).slice(-3).length : 0;
  const recentChoch = opposing ? structures.chochEvents.filter(e => e.type === opposing).slice(-3).length : structures.chochEvents.slice(-3).length;
  return { recentBos, recentChoch };
}

function getDisplacementStats(candles: Candle[], direction: TrendDirection, atr: number) {
  const sign = signedDirection(direction);
  if (!sign || atr <= 0) return { strong: false, persistence: 0, opposingWickRatio: 0 };
  const recent = candles.slice(-12);
  let aligned = 0;
  let strongBodies = 0;
  let opposingWickTotal = 0;
  for (const c of recent) {
    const body = Math.abs(c.c - c.o);
    const dirOk = sign > 0 ? c.c > c.o : c.c < c.o;
    if (dirOk) aligned++;
    if (dirOk && body >= 0.65 * atr) strongBodies++;
    const upper = c.h - Math.max(c.c, c.o);
    const lower = Math.min(c.c, c.o) - c.l;
    opposingWickTotal += sign > 0 ? upper : lower;
  }
  return {
    strong: strongBodies >= 2 || recent.some(c => Math.abs(c.c - c.o) >= 1.1 * atr),
    persistence: aligned / Math.max(1, recent.length),
    opposingWickRatio: opposingWickTotal / Math.max(atr, 0.00001) / Math.max(1, recent.length),
  };
}

function getChopStats(candles: Candle[], atr: number) {
  const recent = candles.slice(-18);
  const bodies = recent.map(c => Math.abs(c.c - c.o));
  const ranges = recent.map(c => c.h - c.l).filter(v => v > 0);
  const avgBody = bodies.reduce((a, b) => a + b, 0) / Math.max(1, bodies.length);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / Math.max(1, ranges.length);
  let overlaps = 0;
  for (let i = 1; i < recent.length; i++) {
    const overlap = Math.max(0, Math.min(recent[i].h, recent[i - 1].h) - Math.max(recent[i].l, recent[i - 1].l));
    const prevRange = Math.max(recent[i - 1].h - recent[i - 1].l, 0.00001);
    if (overlap / prevRange > 0.55) overlaps++;
  }
  const overlapRatio = overlaps / Math.max(1, recent.length - 1);
  const bodyRatio = avgRange > 0 ? avgBody / avgRange : 0;
  const recentRange = Math.max(...recent.map(c => c.h)) - Math.min(...recent.map(c => c.l));
  const compression = atr > 0 ? recentRange / atr : 0;
  return {
    overlapRatio,
    bodyRatio,
    compression,
    choppy: overlapRatio > 0.55 || bodyRatio < 0.38 || compression < 4.5,
  };
}

function isCleanPullback(candles: Candle[], direction: TrendDirection, atr: number): boolean {
  if (direction === 'NEUTRAL' || candles.length < 55) return false;
  const ema20 = calcEMA(candles, 20);
  const ema50 = calcEMA(candles, 50);
  const recent = candles.slice(-8);
  const lastIdx = candles.length - 1;
  const e20 = ema20[lastIdx];
  const e50 = ema50[lastIdx];
  if (!e20 || !e50 || atr <= 0) return false;
  if (direction === 'BULLISH') {
    return recent.some(c => c.l <= e20 + 0.65 * atr && c.c >= e50) && candles[lastIdx].c >= e20;
  }
  return recent.some(c => c.h >= e20 - 0.65 * atr && c.c <= e50) && candles[lastIdx].c <= e20;
}

function nearHtfZone(candles: Candle[], direction: TrendDirection, price: number, atr: number): boolean {
  if (direction === 'NEUTRAL') return false;
  const structures = computeStructures(candles.slice(-180), 5);
  const zones = direction === 'BULLISH' ? structures.supplyZones : structures.demandZones;
  return zones.slice(-3).some(z => price <= z.obHigh + atr && price >= z.obLow - atr);
}

export function analyzeTrendMarket(pair: string, h1: Candle[], h4: Candle[], daily: Candle[]): TrendReport | null {
  if (h1.length < 80 || h4.length < 80 || daily.length < 80) return null;
  const price = h1[h1.length - 1].c;
  const h1Atr = calcATR(h1.slice(-50));
  const h1BaselineAtr = calcATR(h1.slice(-100, -40));
  const atrExpansion = h1BaselineAtr > 0 ? h1Atr / h1BaselineAtr : 1;
  const dailyDir = getEmaTrend(daily);
  const h4Dir = getEmaTrend(h4);
  const h1Dir = getEmaTrend(h1);
  const structure = getStructureState(h4);
  const directionVotes = [dailyDir, h4Dir, h1Dir, structure.direction].filter(d => d !== 'NEUTRAL');
  const bullishVotes = directionVotes.filter(d => d === 'BULLISH').length;
  const bearishVotes = directionVotes.filter(d => d === 'BEARISH').length;
  const direction: TrendDirection = bullishVotes >= 3 ? 'BULLISH' : bearishVotes >= 3 ? 'BEARISH' : 'NEUTRAL';
  const htfAligned = direction !== 'NEUTRAL' && dailyDir === direction && h4Dir === direction && h1Dir === direction;
  const { recentBos, recentChoch } = countRecentStructureEvents(h4, direction);
  const displacement = getDisplacementStats(h1, direction, h1Atr);
  const chop = getChopStats(h1, h1Atr);
  const cleanPullback = isCleanPullback(h1, direction, h1Atr);
  const nearZone = nearHtfZone(h4, direction, price, h1Atr);
  const emaAligned = direction !== 'NEUTRAL' && h1Dir === direction && h4Dir === direction;
  const overextended = direction !== 'NEUTRAL' && h1Atr > 0 && Math.abs(price - (calcEMA(h1, 20)[h1.length - 1] ?? price)) / h1Atr > 3.2;
  const silverNoiseMultiplier = pair === 'XAG_USD' ? 1.45 : 1;

  let score = 0;
  if (htfAligned) score += 2.0;
  else if (direction !== 'NEUTRAL' && dailyDir === direction && h4Dir === direction) score += 1.2;
  if (recentBos >= 2) score += 1.4;
  else if (recentBos === 1) score += 0.7;
  if (displacement.strong) score += 1.3;
  if (emaAligned) score += 1.1;
  if (structure.direction === direction) score += 1.2;
  if (displacement.persistence >= 0.62) score += 0.9;
  if (atrExpansion >= 1.08) score += 0.8;
  if (!chop.choppy) score += 1.3;
  if (cleanPullback) score += 0.6;

  score -= chop.overlapRatio > 0.5 ? 1.2 * silverNoiseMultiplier : 0;
  score -= chop.bodyRatio < 0.35 ? 1.0 * silverNoiseMultiplier : 0;
  score -= chop.compression < 4.2 ? 1.1 * silverNoiseMultiplier : 0;
  score -= recentChoch * 0.8;
  score -= displacement.opposingWickRatio > 0.55 ? 0.8 * silverNoiseMultiplier : 0;
  score -= nearZone ? 0.8 : 0;
  score -= overextended ? 1.0 : 0;
  if (direction === 'NEUTRAL') score = Math.min(score, 4.0);

  const trendScore = Math.max(0, Math.min(10, Math.round(score * 10) / 10));
  const cleanlinessRaw = 10
    - (chop.overlapRatio * 4.0 * silverNoiseMultiplier)
    - ((1 - Math.min(chop.bodyRatio, 0.7)) * 2.0 * silverNoiseMultiplier)
    - Math.max(0, 4.5 - chop.compression) * 0.45 * silverNoiseMultiplier
    - (recentChoch * 0.7)
    - (displacement.opposingWickRatio > 0.55 ? 1.0 * silverNoiseMultiplier : 0);
  const cleanlinessScore = Math.max(0, Math.min(10, Math.round(cleanlinessRaw * 10) / 10));

  let marketState: MarketState = 'TRENDING';
  if (direction === 'NEUTRAL' || trendScore < 4.5 || cleanlinessScore < 4.5) marketState = 'CHOPPY';
  else if (overextended) marketState = 'EXHAUSTED';
  else if (atrExpansion >= 1.25 && displacement.strong) marketState = 'EXPANDING';
  else if (cleanPullback) marketState = 'PULLBACK';

  const whyTrending: string[] = [];
  const warnings: string[] = [];
  if (htfAligned) whyTrending.push(`Daily + H4 + H1 ${direction.toLowerCase()} alignment`);
  else warnings.push(`HTF mixed: D ${dailyDir}, H4 ${h4Dir}, H1 ${h1Dir}`);
  if (displacement.strong) whyTrending.push(`Strong ${direction.toLowerCase()} displacement`);
  if (recentBos >= 2) whyTrending.push('Consecutive BOS in trend direction');
  else if (recentBos === 1) whyTrending.push('Recent BOS in trend direction');
  if (structure.direction === direction) whyTrending.push(structure.label);
  if (cleanPullback) whyTrending.push('Clean pullback into EMA20/EMA50 trend');
  if (atrExpansion >= 1.08) whyTrending.push('ATR expansion / volatility expansion');
  if (chop.choppy) warnings.push(pair === 'XAG_USD' ? 'Silver chop/compression penalty active' : 'Choppy overlap or compression');
  if (recentChoch) warnings.push('Opposing CHOCH detected');
  if (nearZone) warnings.push(`Near H4 ${direction === 'BULLISH' ? 'supply' : 'demand'}`);
  if (overextended) warnings.push('Structure extended away from EMA20');
  if (!whyTrending.length) whyTrending.push('No clean directional trend yet');

  return {
    pair,
    displaySymbol: pair.replace('_', '/'),
    direction,
    trendScore,
    structureState: structure.label,
    marketState,
    session: getSessionLabel(pair),
    cleanlinessScore,
    htfAlignment: `D ${dailyDir} / H4 ${h4Dir} / H1 ${h1Dir}`,
    whyTrending,
    warnings,
    timeframe: 'D/H4/H1',
    scannedAt: new Date().toISOString(),
  };
}

export async function runTrendScan(): Promise<TrendScanResult> {
  const all: TrendReport[] = [];
  for (const pair of TRENDING_ASSETS) {
    try {
      const [h1, h4, daily] = await Promise.all([
        fetchCandles(pair, 'H1', 250),
        fetchCandles(pair, 'H4', 220),
        fetchCandles(pair, 'D', 220),
      ]);
      const report = analyzeTrendMarket(pair, h1, h4, daily);
      if (report) all.push(report);
    } catch (e: any) {
      console.error(`Trend skip ${pair}:`, e.message);
    }
  }
  all.sort((a, b) => b.trendScore - a.trendScore || b.cleanlinessScore - a.cleanlinessScore);
  const strongBullish = all
    .filter(r => r.direction === 'BULLISH' && ['TRENDING', 'EXPANDING'].includes(r.marketState) && r.trendScore >= 6)
    .slice(0, 10);
  const strongBearish = all
    .filter(r => r.direction === 'BEARISH' && ['TRENDING', 'EXPANDING'].includes(r.marketState) && r.trendScore >= 6)
    .slice(0, 10);
  const pullbackOpportunities = all
    .filter(r => r.direction !== 'NEUTRAL' && r.marketState === 'PULLBACK' && r.trendScore >= 5.5)
    .slice(0, 10);
  return { strongBullish, strongBearish, pullbackOpportunities, all };
}

export function scoutAnalyzeCandles(
  candles: Candle[], htf: Candle[], pair: string, granularity = 'H1', dailyCandles?: Candle[], h4Candles?: Candle[]
): ScoutReport | null {
  // v2 — 2R minimum TP filter
  if (candles.length < 60) return null;

  const price = candles[candles.length - 1].c;
  const atr = calcATR(candles.slice(-50));
  const rsiArr = calcRSI(candles, 14);
  const rsi = rsiArr[candles.length - 1];
  const ema20arr = calcEMA(candles, 20);
  const ema20 = ema20arr[candles.length - 1] ?? price;

  // Bias from swing structure of last 50 candles — tighter window reads current structure
  // not the older rally that may still be inside a 100-bar lookback
  const recentCandles = candles.slice(-50);
  const swings = findSwings(recentCandles, 3);
  const trend = getTrend(swings);
  const bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
    trend === 'LONG' ? 'BULLISH' : trend === 'SHORT' ? 'BEARISH' : 'NEUTRAL';

  // HTF bias — use all available HTF candles with margin=3 to ensure enough swings for getTrend
  const htfSwings = findSwings(htf, 3);
  const htfTrend = getTrend(htfSwings);
  const htfBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
    htfTrend === 'LONG' ? 'BULLISH' : htfTrend === 'SHORT' ? 'BEARISH' : 'NEUTRAL';

  // Zone: premium/discount relative to recent 50-candle range midpoint
  const recent50 = candles.slice(-50);
  const rangeHigh = Math.max(...recent50.map(c => c.h));
  const rangeLow = Math.min(...recent50.map(c => c.l));
  const midpoint = (rangeHigh + rangeLow) / 2;
  const threshold = (rangeHigh - rangeLow) * 0.05;
  const zone: 'PREMIUM' | 'DISCOUNT' | 'FAIR VALUE' =
    price > midpoint + threshold ? 'PREMIUM' : price < midpoint - threshold ? 'DISCOUNT' : 'FAIR VALUE';

  // Nearest support / resistance from recent swings
  const swingHighs = swings.filter(s => s.type === 'high');
  const swingLows  = swings.filter(s => s.type === 'low');
  const nearestResistance = swingHighs.filter(s => s.price > price).sort((a, b) => a.price - b.price)[0]?.price ?? null;
  const nearestSupport    = swingLows.filter(s => s.price < price).sort((a, b) => b.price - a.price)[0]?.price ?? null;

  // Recent BOS and ChoCH detection
  let recentBOS: ScoutReport['recentBOS'] = null;
  let recentChoCH: ScoutReport['recentChoCH'] = null;

  for (const sh of swingHighs.slice(-4)) {
    for (let i = sh.index + 1; i < recentCandles.length; i++) {
      if (recentCandles[i].c > sh.price) {
        const event = { type: 'bullish' as const, level: sh.price };
        if (trend === 'SHORT') { if (!recentChoCH) recentChoCH = event; }
        else { if (!recentBOS) recentBOS = event; }
        break;
      }
    }
  }
  for (const sl of swingLows.slice(-4)) {
    for (let i = sl.index + 1; i < recentCandles.length; i++) {
      if (recentCandles[i].c < sl.price) {
        const event = { type: 'bearish' as const, level: sl.price };
        if (trend === 'LONG') { if (!recentChoCH) recentChoCH = event; }
        else { if (!recentBOS) recentBOS = event; }
        break;
      }
    }
  }

  // ChoCH override: if the most recent structural event is a ChoCH, it defines the new bias.
  // This matches how the indicator works — a confirmed ChoCH flips the trend read
  // regardless of what getTrend says about older swing sequences.
  let finalBias = bias;
  if (recentChoCH?.type === 'bearish') finalBias = 'BEARISH';
  else if (recentChoCH?.type === 'bullish') finalBias = 'BULLISH';
  const trendSetupPhase = buildTrendSetupPhase(
    candles,
    dailyCandles?.length ? dailyCandles : htf,
    h4Candles?.length ? h4Candles : candles,
    granularity,
    'Daily',
    'H4'
  );
  const scoutBias = alignedScoutBias(trendSetupPhase);
  if (scoutBias !== 'NEUTRAL' && finalBias !== 'NEUTRAL' && scoutBias !== finalBias) {
    console.warn(
      `[Scout Direction] ${pair} ${granularity}: overriding ${finalBias} trade bias with ${scoutBias} ` +
      `because Trend=${trendSetupPhase.trendDirection}, Daily=${trendSetupPhase.dailyTrendDirection}, ` +
      `SetupTF=${trendSetupPhase.setupTimeframeDirection}.`
    );
    finalBias = scoutBias;
  } else if (scoutBias !== 'NEUTRAL' && finalBias === 'NEUTRAL') {
    finalBias = scoutBias;
  }

  const currentMomentum = scoreCurrentMomentum(candles, atr, finalBias, recentBOS, recentChoCH);
  const pullbackCompletion = scorePullbackCompletion(
    candles,
    atr,
    finalBias,
    recentBOS,
    recentChoCH,
    nearestSupport,
    nearestResistance
  );
  const trendConfirmation = scoreTrendConfirmation(candles, atr, finalBias, recentBOS, recentChoCH);
  const scoutDirection = biasToTradeDirection(scoutBias);
  const tradeDirection = biasToTradeDirection(finalBias);
  const reversalConfirmation = detectReversalConfirmation(
    candles,
    tradeDirection,
    trendSetupPhase.setupTimeframeDirection,
    recentChoCH
  );
  const setupStatusForGrade = setupStatusLabelFromScores(
    pullbackCompletion.pullbackCompleted,
    pullbackCompletion.pullbackStatus,
    pullbackCompletion.pullbackScore,
    trendConfirmation.confirmationConfirmed,
    trendConfirmation.confirmationStatus,
    trendConfirmation.confirmationScore
  );
  const setupGrade = gradeScoutSetup(
    tradeDirection,
    trendSetupPhase.dailyTrendDirection,
    trendSetupPhase.setupTimeframeDirection,
    zone,
    setupStatusForGrade,
    reversalConfirmation.reversalConfirmed
  );

  // Interest level: how many bullish factors align
  let interestScore = 0;
  if (finalBias !== 'NEUTRAL') interestScore++;
  if (htfBias !== 'NEUTRAL' && htfBias === finalBias) interestScore++;
  if ((finalBias === 'BULLISH' && zone === 'DISCOUNT') || (finalBias === 'BEARISH' && zone === 'PREMIUM')) interestScore++;
  if (recentChoCH) interestScore++;
  if (recentBOS) interestScore++;

  const interestLevel: 'HIGH' | 'MEDIUM' | 'LOW' =
    interestScore >= 4 ? 'HIGH' : interestScore >= 2 ? 'MEDIUM' : 'LOW';

  // ── Trade levels ──────────────────────────────────────────────────────────
  // Entry: nearest active demand/supply or recent pullback structure first;
  // EMA20 is only a fallback when it is still close to current price action.
  // SL: 1×ATR beyond the nearest swing low/high
  // TP1: nearest structural target beyond entry + 1×ATR (skip minor structure)
  // TP2: second structural level
  let entry: number | null = null;
  let sl: number | null = null;
  let tp1: number | null = null;
  let tp2: number | null = null;
  let rrRatio: number | null = null;

  if (finalBias !== 'NEUTRAL') {
    const isLong = finalBias === 'BULLISH';
    entry = nearestActiveZoneEntry(candles, finalBias, price, atr, ema20, nearestSupport, nearestResistance);

    if (isLong) {
      const slBase = nearestSupport ?? (entry - 2 * atr);
      sl = roundPrice(Math.min(slBase, entry - atr) - 0.3 * atr);
      const risk = Math.abs(entry - sl);
      // TP: first swing high giving >= 2R (skip minor structure)
      const minTp = entry + Math.max(atr, 2 * risk);
      console.log(`[scout-v2] ${pair} LONG risk=${risk.toFixed(5)} minTp=${minTp.toFixed(5)}`);
      const tpCandidates = swingHighs
        .filter(s => s.price > minTp)
        .sort((a, b) => a.price - b.price);
      tp1 = tpCandidates[0]
        ? roundPrice(tpCandidates[0].price)
        : roundPrice(entry + 2 * risk);
      tp2 = tpCandidates[1]
        ? roundPrice(tpCandidates[1].price)
        : roundPrice(entry + 3 * risk);
    } else {
      const slBase = nearestResistance ?? (entry + 2 * atr);
      sl = roundPrice(Math.max(slBase, entry + atr) + 0.3 * atr);
      const risk = Math.abs(entry - sl);
      // TP: first swing low giving >= 2R (skip minor structure)
      const minTp = entry - Math.max(atr, 2 * risk);
      const tpCandidates = swingLows
        .filter(s => s.price < minTp)
        .sort((a, b) => b.price - a.price);
      tp1 = tpCandidates[0]
        ? roundPrice(tpCandidates[0].price)
        : roundPrice(entry - 2 * risk);
      tp2 = tpCandidates[1]
        ? roundPrice(tpCandidates[1].price)
        : roundPrice(entry - 3 * risk);
    }

    if (entry !== null && sl !== null && tp1 !== null) {
      const risk = Math.abs(entry - sl);
      const reward = Math.abs(tp1 - entry);
      if (risk > 0) rrRatio = Math.round((reward / risk) * 100) / 100;
    }
  }
  const entryDistance = classifyEntryDistance(price, entry, atr);
  const entryTiming = classifyEntryTiming(
    tradeDirection,
    zone,
    setupGrade.setupGrade,
    setupStatusForGrade,
    reversalConfirmation.reversalConfirmed,
    entryDistance.entryStatus,
    trendConfirmation.confirmationScore,
    pullbackCompletion.pullbackCompleted,
    pullbackCompletion.pullbackScore,
    entry,
    sl,
    tp1
  );
  const evalEligibility = evaluateScoutForEval(
    tradeDirection,
    trendSetupPhase.dailyTrendDirection,
    zone,
    setupGrade.setupGrade,
    setupStatusForGrade,
    reversalConfirmation.reversalConfirmed,
    entryDistance.entryStatus,
    entryDistance.distanceFromEntryAtr,
    entry,
    sl,
    tp1
  );

  return {
    pair,
    displaySymbol: pair.replace('_', '/'),
    price,
    bias: finalBias,
    scoutDirection,
    tradeDirection,
    htfBias,
    zone,
    nearestResistance,
    nearestSupport,
    recentBOS,
    recentChoCH,
    atr,
    rsi: isNaN(rsi) ? 50 : Math.round(rsi * 10) / 10,
    ema20,
    session: getSessionLabel(pair),
    interestLevel,
    timeframe: granularity,
    scannedAt: new Date().toISOString(),
    candleTime: candles[candles.length - 1].t,
    ...currentMomentum,
    ...pullbackCompletion,
    ...trendConfirmation,
    ...reversalConfirmation,
    ...setupGrade,
    ...evalEligibility,
    ...entryTiming,
    ...trendSetupPhase,
    ...entryDistance,
    entry,
    sl,
    tp1,
    tp2,
    rrRatio,
  };
}

export async function runScoutScan(granularity = 'H1', pairsOverride?: string[]): Promise<ScoutReport[]> {
  const htfGran = HTF_MAP[granularity] || 'D';
  const pairsToScan = pairsOverride?.length ? pairsOverride : PAIRS;
  const results: ScoutReport[] = [];
  for (const pair of pairsToScan) {
    try {
      const [candles, htf, dailyCandles, h4Candles] = await Promise.all([
        fetchCandles(pair, granularity, 150),
        fetchCandles(pair, htfGran, 100),
        fetchCandles(pair, 'D', 120),
        fetchCandles(pair, 'H4', 150),
      ]);
      const report = scoutAnalyzeCandles(candles, htf, pair, granularity, dailyCandles, h4Candles);
      if (report) {
        report.newsRisk = await checkNewsRisk(pair);
        results.push(report);
      }
    } catch (e: any) {
      console.error(`Scout skip ${pair}:`, e.message);
    }
  }
  const ord: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  results.sort((a, b) => ord[a.interestLevel] - ord[b.interestLevel]);
  return results;
}
