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
];

const HTF_MAP: Record<string,string> = { M15:'H4', M30:'H4', H1:'D', H4:'W', D:'W' };

interface Candle { t:string; o:number; h:number; l:number; c:number; v:number; }
interface Swing  { index:number; price:number; type:'high'|'low'; }

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
  newsRisk?: boolean;
}

export function scoutAnalyzeCandles(
  candles: Candle[], htf: Candle[], pair: string, granularity = 'H1'
): ScoutReport | null {
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

  // HTF bias — 50 candles as well for consistency
  const htfSwings = findSwings(htf.slice(-50), 5);
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

  // Interest level: how many bullish factors align
  let interestScore = 0;
  if (finalBias !== 'NEUTRAL') interestScore++;
  if (htfBias !== 'NEUTRAL' && htfBias === finalBias) interestScore++;
  if ((finalBias === 'BULLISH' && zone === 'DISCOUNT') || (finalBias === 'BEARISH' && zone === 'PREMIUM')) interestScore++;
  if (recentChoCH) interestScore++;
  if (recentBOS) interestScore++;

  const interestLevel: 'HIGH' | 'MEDIUM' | 'LOW' =
    interestScore >= 4 ? 'HIGH' : interestScore >= 2 ? 'MEDIUM' : 'LOW';

  return {
    pair,
    displaySymbol: pair.replace('_', '/'),
    price,
    bias: finalBias,
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
  };
}

export async function runScoutScan(granularity = 'H1', pairsOverride?: string[]): Promise<ScoutReport[]> {
  const htfGran = HTF_MAP[granularity] || 'D';
  const pairsToScan = pairsOverride?.length ? pairsOverride : PAIRS;
  const results: ScoutReport[] = [];
  for (const pair of pairsToScan) {
    try {
      const [candles, htf] = await Promise.all([
        fetchCandles(pair, granularity, 150),
        fetchCandles(pair, htfGran, 100),
      ]);
      const report = scoutAnalyzeCandles(candles, htf, pair, granularity);
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
