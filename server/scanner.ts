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

// Fixed: H4 confirms against Daily (was Weekly — too strict)
const HTF_MAP: Record<string,string> = { M15:'H1', M30:'H4', H1:'H4', H4:'D', D:'W' };

interface Candle { t:string; o:number; h:number; l:number; c:number; v:number; }
interface Swing  { index:number; price:number; type:'high'|'low'; }

export interface SetupChecklist {
  trendConfirmed: boolean;
  bosConfirmed: boolean;
  pullbackToOB: boolean;
  momentumCandle: boolean;
  rsiInZone: boolean;
  htfAligned: boolean;
  notSandwiched: boolean;
  minRR: boolean;
  volumeSurge: boolean;
  liquiditySweep: boolean;
  pdhlConfluence: boolean;
  goodSession: boolean;
  historicalEdge: boolean;
  structureClearance: boolean;
  tp1Fresh: boolean;
  impulseStrong: boolean;
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
    rsi?: number;
    bosLevel?: number;
    obHigh?: number;
    obLow?: number;
  };
}

async function fetchCandles(instrument: string, granularity: string, count=250): Promise<Candle[]> {
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

function findSwings(candles: Candle[], margin=5): Swing[] {
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

// Confirms a BOS occurred in the given direction within the last `lookbackCandles` candles.
// For LONG: a candle closed above the second-to-last swing high.
// For SHORT: a candle closed below the second-to-last swing low.
function detectBOS(
  candles: Candle[],
  swings: Swing[],
  direction: 'LONG'|'SHORT',
  lookbackCandles = 50
): { confirmed: boolean; bosLevel: number } {
  const highs  = swings.filter(s => s.type === 'high');
  const lows   = swings.filter(s => s.type === 'low');
  const minIdx = candles.length - 1 - lookbackCandles;

  if (direction === 'LONG' && highs.length >= 2) {
    const prevHigh = highs[highs.length - 2];
    for (let i = Math.max(prevHigh.index + 1, minIdx); i < candles.length; i++) {
      if (candles[i].c > prevHigh.price) {
        return { confirmed: true, bosLevel: prevHigh.price };
      }
    }
  }

  if (direction === 'SHORT' && lows.length >= 2) {
    const prevLow = lows[lows.length - 2];
    for (let i = Math.max(prevLow.index + 1, minIdx); i < candles.length; i++) {
      if (candles[i].c < prevLow.price) {
        return { confirmed: true, bosLevel: prevLow.price };
      }
    }
  }

  return { confirmed: false, bosLevel: 0 };
}

// Finds the Order Block: the last opposing candle in the most recent impulse.
// For LONG: last bearish candle since the last swing low.
// For SHORT: last bullish candle since the last swing high.
function findOrderBlock(
  candles: Candle[],
  direction: 'LONG'|'SHORT',
  swings: Swing[]
): { high: number; low: number; index: number } | null {
  const lastIdx = candles.length - 1;

  if (direction === 'LONG') {
    const lows = swings.filter(s => s.type === 'low');
    const lastSwingLow = lows[lows.length - 1];
    if (!lastSwingLow) return null;
    for (let i = lastIdx - 1; i >= lastSwingLow.index; i--) {
      if (candles[i].c < candles[i].o) {
        return { high: candles[i].h, low: candles[i].l, index: i };
      }
    }
  }

  if (direction === 'SHORT') {
    const highs = swings.filter(s => s.type === 'high');
    const lastSwingHigh = highs[highs.length - 1];
    if (!lastSwingHigh) return null;
    for (let i = lastIdx - 1; i >= lastSwingHigh.index; i--) {
      if (candles[i].c > candles[i].o) {
        return { high: candles[i].h, low: candles[i].l, index: i };
      }
    }
  }

  return null;
}

function detectMomentum(c: Candle, p: Candle, dir: string, atr: number, structureLevel: number): {type:string;strength:number}|null {
  const body=Math.abs(c.c-c.o), range=c.h-c.l, bodyRatio=range>0?body/range:0;
  const uw=c.h-Math.max(c.c,c.o), lw=Math.min(c.c,c.o)-c.l;
  const pBody=Math.abs(p.c-p.o), pHigh=Math.max(p.c,p.o), pLow=Math.min(p.c,p.o);
  if (body < 0.3 * atr) return null;
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

function getSession(): string {
  const h = new Date().getUTCHours();
  if (h>=22||h<8)  return 'Asia';
  if (h>=8&&h<13)  return 'London';
  if (h>=13&&h<22) return 'New York';
  return 'Transition';
}

function analyzeCandles(
  candles: Candle[], htf: Candle[], pair: string,
  granularity='H1', minRR=1.5, _debug=false,
  journalStats: JournalStats = {}
): { setup: Setup|null; reason: string; detail: DebugResult['detail'] } {
  const detail: DebugResult['detail'] = {};

  // Reduced from 210 — no longer need 200-period EMA warmup
  if (candles.length < 100) return { setup: null, reason: 'Not enough candles (<100)', detail };

  const atr = calcATR(candles.slice(-50));
  detail.atr = atr;
  const pdhl = getPDHL(candles);

  // ATR minimum — reject dead/illiquid markets
  const ATR_MIN: Record<string,number> = {
    XAU_USD: 0.8,   XAG_USD: 0.015,
    USD_JPY: 0.03,  EUR_JPY: 0.04,  GBP_JPY: 0.05,
    AUD_JPY: 0.03,  NZD_JPY: 0.03,  CAD_JPY: 0.03,
    GBP_USD: 0.0004, EUR_USD: 0.0003, AUD_USD: 0.0002,
    NZD_USD: 0.0002, USD_CAD: 0.0003, USD_CHF: 0.0003,
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

  const lastIdx = candles.length - 1;
  const last    = candles[lastIdx];
  const price   = last.c;
  detail.price  = price;

  // RSI
  const rsiArr = calcRSI(candles, 14);
  const rsi    = rsiArr[lastIdx];
  detail.rsi   = rsi;
  if (isNaN(rsi)) return { setup: null, reason: 'Insufficient data for RSI calculation', detail };

  // ── TREND DETECTION (swing structure) ────────────────────────────────────────
  const entrySwings = findSwings(candles, 5);
  const direction   = getTrend(entrySwings);
  if (!direction) return { setup: null, reason: 'No clear swing structure (need HH/HL or LH/LL)', detail };
  detail.trend = direction;

  // ── BOS CONFIRMATION ─────────────────────────────────────────────────────────
  const bos = detectBOS(candles, entrySwings, direction, 30);
  if (!bos.confirmed) return {
    setup: null,
    reason: `No confirmed BOS in ${direction} direction within last 30 candles`,
    detail,
  };
  detail.bosLevel = bos.bosLevel;

  // ── HTF HARD BLOCK — no counter-trend trades ──────────────────────────────────
  const htfSwings     = findSwings(htf.slice(-100));
  const htfSwingHighs = htfSwings.filter(s => s.type === 'high');
  const htfSwingLows  = htfSwings.filter(s => s.type === 'low');
  const htfTrend      = getTrend(htfSwings);
  detail.htfTrend = htfTrend;
  if (htfTrend && htfTrend !== direction) {
    return { setup: null, reason: `HTF conflict — ${HTF_MAP[granularity] ?? 'HTF'} is ${htfTrend} but setup is ${direction}`, detail };
  }

  // ── RSI FILTER ───────────────────────────────────────────────────────────────
  if (direction === 'LONG') {
    if (rsi > 70) return { setup: null, reason: `RSI overbought for LONG (${rsi.toFixed(1)} > 70)`, detail };
    if (rsi < 40 || rsi > 68) return { setup: null, reason: `RSI outside LONG zone (${rsi.toFixed(1)}, need 40–68)`, detail };
  } else {
    if (rsi < 30) return { setup: null, reason: `RSI oversold for SHORT (${rsi.toFixed(1)} < 30)`, detail };
    if (rsi < 35 || rsi > 60) return { setup: null, reason: `RSI outside SHORT zone (${rsi.toFixed(1)}, need 35–60)`, detail };
  }

  // ── ORDER BLOCK PULLBACK ──────────────────────────────────────────────────────
  const ob = findOrderBlock(candles, direction, entrySwings);
  if (!ob) return { setup: null, reason: 'No order block found in current impulse', detail };
  detail.obHigh = ob.high;
  detail.obLow  = ob.low;

  // Price must be touching or inside the OB zone (within 0.5×ATR tolerance)
  const inOB = direction === 'LONG'
    ? last.l <= ob.high + 0.5 * atr && last.c >= ob.low - 0.5 * atr
    : last.h >= ob.low - 0.5 * atr  && last.c <= ob.high + 0.5 * atr;

  if (!inOB) return {
    setup: null,
    reason: `Price not pulling back into OB (OB: ${ob.low.toFixed(5)}–${ob.high.toFixed(5)}, price: ${price.toFixed(5)})`,
    detail,
  };

  // ── MOMENTUM CANDLE AT OB ────────────────────────────────────────────────────
  const prevCandle = candles[lastIdx - 1];
  const obLevel    = direction === 'LONG' ? ob.high : ob.low;
  const momentum   = detectMomentum(last, prevCandle, direction, atr, obLevel);
  detail.momentum  = momentum?.type ?? null;

  let patternType = momentum?.type ?? null;

  // Fallback: OB_BOUNCE — meaningful directional close from within the OB
  if (!patternType) {
    const bounceBody = Math.abs(last.c - last.o);
    const obMid      = (ob.high + ob.low) / 2;
    if (
      direction === 'LONG' &&
      last.l <= ob.high &&
      last.c > obMid &&
      bounceBody >= 0.4 * atr
    ) {
      patternType = 'OB_BOUNCE';
    } else if (
      direction === 'SHORT' &&
      last.h >= ob.low &&
      last.c < obMid &&
      bounceBody >= 0.4 * atr
    ) {
      patternType = 'OB_BOUNCE';
    }
  }

  if (!patternType) return {
    setup: null,
    reason: 'No rejection candle at OB (need engulfing, pin bar, strong close, or OB bounce)',
    detail,
  };

  // ── STOP LOSS ────────────────────────────────────────────────────────────────
  const window5 = candles.slice(lastIdx - 4, lastIdx + 1);
  const sl = direction === 'LONG'
    ? Math.min(...window5.map(c => c.l)) - 0.3 * atr
    : Math.max(...window5.map(c => c.h)) + 0.3 * atr;

  if (direction === 'LONG'  && sl >= price) return { setup: null, reason: 'Inverted SL: sl >= entry for LONG',  detail };
  if (direction === 'SHORT' && sl <= price) return { setup: null, reason: 'Inverted SL: sl <= entry for SHORT', detail };
  const risk = Math.abs(price - sl);
  if (risk <= 0) return { setup: null, reason: 'Risk is zero (price equals SL)', detail };

  // ── TAKE PROFIT ──────────────────────────────────────────────────────────────
  const recentSwings = findSwings(recent80);
  const swingHighs   = recentSwings.filter(s => s.type === 'high');
  const swingLows    = recentSwings.filter(s => s.type === 'low');

  const MIN_TP_RR = 2.0;

  const opposingSwings = (direction === 'LONG'
    ? swingHighs.filter(s => s.price > price && Math.abs(s.price - price) / risk >= MIN_TP_RR)
    : swingLows.filter(s => s.price < price && Math.abs(s.price - price) / risk >= MIN_TP_RR)
  ).sort((a, b) =>
    direction === 'LONG' ? a.price - b.price : b.price - a.price
  );

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
    if (direction === 'LONG'  && Math.abs(ob.low  - pdhl.pdl) <= 0.5 * atr) pdhlConfluence = true;
    if (direction === 'SHORT' && Math.abs(ob.high - pdhl.pdh) <= 0.5 * atr) pdhlConfluence = true;
    if (direction === 'LONG'  && pdhl.pdh > price && structureTPs[0] !== undefined && pdhl.pdh < structureTPs[0])
      structureTPs[0] = pdhl.pdh - 0.1 * atr;
    if (direction === 'SHORT' && pdhl.pdl < price && structureTPs[0] !== undefined && pdhl.pdl > structureTPs[0])
      structureTPs[0] = pdhl.pdl + 0.1 * atr;
  }

  const tp1 = structureTPs[0] ?? (direction === 'LONG' ? price + 2 * risk : price - 2 * risk);
  const tp2 = structureTPs[1] ?? (direction === 'LONG' ? price + 3 * risk : price - 3 * risk);
  const tp3 = structureTPs[2] ?? (direction === 'LONG' ? price + 4 * risk : price - 4 * risk);
  const rrRatio = Math.abs(tp1 - price) / risk;
  if (rrRatio < minRR) return { setup: null, reason: `RR too low (${rrRatio.toFixed(2)} < ${minRR})`, detail };

  // TP path obstruction
  const tpPathSwings = direction === 'LONG'
    ? swingHighs.filter(s => s.price > price && s.price < tp1)
    : swingLows.filter(s => s.price < price && s.price > tp1);
  const clutteredPath = tpPathSwings.length >= 2;

  // ── FILTER: Impulse leg strength ──────────────────────────────────────────────
  if (direction === 'LONG') {
    const lastSwingLow    = swingLows[swingLows.length - 1];
    const impulseHighs    = swingHighs.filter(s => lastSwingLow && s.index > lastSwingLow.index);
    const lastImpulseHigh = impulseHighs[impulseHighs.length - 1];
    if (lastSwingLow && lastImpulseHigh) {
      const impulseSize = lastImpulseHigh.price - lastSwingLow.price;
      if (impulseSize < 1.5 * atr) {
        return { setup: null, reason: `Weak impulse leg: last upswing ${impulseSize.toFixed(5)} = ${(impulseSize / atr).toFixed(1)}×ATR — likely chop not trend`, detail };
      }
    }
  }
  if (direction === 'SHORT') {
    const lastSwingHigh  = swingHighs[swingHighs.length - 1];
    const impulseLows    = swingLows.filter(s => lastSwingHigh && s.index > lastSwingHigh.index);
    const lastImpulseLow = impulseLows[impulseLows.length - 1];
    if (lastSwingHigh && lastImpulseLow) {
      const impulseSize = lastSwingHigh.price - lastImpulseLow.price;
      if (impulseSize < 1.5 * atr) {
        return { setup: null, reason: `Weak impulse leg: last downswing ${impulseSize.toFixed(5)} = ${(impulseSize / atr).toFixed(1)}×ATR — likely chop not trend`, detail };
      }
    }
  }

  // ── FILTER: Entry too close to opposing structure ──────────────────────────────
  if (direction === 'SHORT') {
    const nearestSupport = swingLows.filter(s => s.price < price).sort((a, b) => b.price - a.price)[0];
    if (nearestSupport) {
      const dist = price - nearestSupport.price;
      if (dist < 1.5 * atr) {
        return { setup: null, reason: `Entry too close to support (${granularity}): swing low ${nearestSupport.price.toFixed(5)} only ${(dist / atr).toFixed(1)}×ATR below entry`, detail };
      }
    }
    const nearestHTFSupport = htfSwingLows.filter(s => s.price < price).sort((a, b) => b.price - a.price)[0];
    if (nearestHTFSupport) {
      const dist = price - nearestHTFSupport.price;
      if (dist < 2.0 * atr) {
        return { setup: null, reason: `Entry too close to HTF support: ${HTF_MAP[granularity]} swing low ${nearestHTFSupport.price.toFixed(5)} only ${(dist / atr).toFixed(1)}×ATR below entry`, detail };
      }
    }
  }
  if (direction === 'LONG') {
    const nearestResistance = swingHighs.filter(s => s.price > price).sort((a, b) => a.price - b.price)[0];
    if (nearestResistance) {
      const dist = nearestResistance.price - price;
      if (dist < 1.5 * atr) {
        return { setup: null, reason: `Entry too close to resistance (${granularity}): swing high ${nearestResistance.price.toFixed(5)} only ${(dist / atr).toFixed(1)}×ATR above entry`, detail };
      }
    }
    const nearestHTFResistance = htfSwingHighs.filter(s => s.price > price).sort((a, b) => a.price - b.price)[0];
    if (nearestHTFResistance) {
      const dist = nearestHTFResistance.price - price;
      if (dist < 2.0 * atr) {
        return { setup: null, reason: `Entry too close to HTF resistance: ${HTF_MAP[granularity]} swing high ${nearestHTFResistance.price.toFixed(5)} only ${(dist / atr).toFixed(1)}×ATR above entry`, detail };
      }
    }
  }

  // ── FILTER: TP1 is a tested/congested level ───────────────────────────────────
  const tp1RejectCount = candles.slice(-50).filter(c => {
    if (direction === 'LONG')  return c.h >= tp1 - 0.5 * atr && c.c < tp1;
    else                       return c.l <= tp1 + 0.5 * atr && c.c > tp1;
  }).length;
  if (tp1RejectCount >= 2) {
    return { setup: null, reason: `TP1 at ${tp1.toFixed(5)} is a tested/rejected level (${tp1RejectCount} failed closes in last 50 candles) — likely to block again`, detail };
  }

  // Volume — compare last candle to 20-candle average
  const avgVol   = candles.slice(-20).reduce((s,c) => s + c.v, 0) / 20;
  const volRatio = avgVol > 0 ? last.v / avgVol : 1;

  // Liquidity sweep: wick through OB boundary then closed back
  const sweepWindow    = candles.slice(lastIdx - 5, lastIdx);
  const liquiditySweep = direction === 'LONG'
    ? sweepWindow.some(c => c.l < ob.low  && c.c > ob.low)
    : sweepWindow.some(c => c.h > ob.high && c.c < ob.high);

  const session = getSession();

  // ── SCORING ───────────────────────────────────────────────────────────────────
  let score = 60;
  if (htfTrend === direction)                                           score += 15;
  const rsiIdeal = direction === 'LONG' ? (rsi >= 45 && rsi <= 60) : (rsi >= 40 && rsi <= 55);
  if (rsiIdeal)                                                         score += 10;
  if (volRatio >= 1.2)                                                  score += 10;
  if (Math.abs(last.c - last.o) > 0.5 * atr)                           score += 10;
  if (pdhlConfluence)                                                   score += 10;
  if (liquiditySweep)                                                   score += 15;
  if (clutteredPath)                                                    score -= 15;
  if (session === 'Asia')                                               score -= 15;
  if (session === 'London' || session === 'New York')                   score += 10;

  // ── CONFLUENCE TAGS ───────────────────────────────────────────────────────────
  const confluence: string[] = ['BOS confirmed'];
  if (patternType === 'ENGULFING')    confluence.push('Engulfing at OB');
  if (patternType === 'PIN_BAR')      confluence.push('Pin bar at OB');
  if (patternType === 'STRONG_CLOSE') confluence.push('Strong close at OB');
  if (patternType === 'OB_BOUNCE')    confluence.push('OB bounce');
  if (htfTrend === direction)         confluence.push('HTF aligned');
  if (rsiIdeal)                       confluence.push('RSI ideal zone');
  if (volRatio >= 1.2)                confluence.push('Volume surge');
  if (session === 'London' || session === 'New York') confluence.push(`${session} session`);
  if (liquiditySweep)                 confluence.push('Liquidity sweep');
  if (pdhlConfluence)                 confluence.push('PDH/PDL confluence');
  if (clutteredPath)                  confluence.push('Cluttered TP path');

  // ── JOURNAL-WEIGHTED SCORING ──────────────────────────────────────────────────
  if (patternType && Object.keys(journalStats).length > 0) {
    const dl2 = direction === 'LONG' ? 'Bullish' : 'Bearish';
    const ptName: Record<string, string> = {
      ENGULFING:    `${dl2} Engulfing at OB`,
      PIN_BAR:      `${dl2} Pin Bar at OB`,
      STRONG_CLOSE: `${dl2} Strong Close at OB`,
      OB_BOUNCE:    `${dl2} OB Pullback`,
    };
    const histKey = `${ptName[patternType] || 'OB Pullback'}|||${granularity}`;
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

  const quality: 'PREMIUM'|'STRONG'|'DEVELOPING' =
    score >= 95 ? 'PREMIUM' : score >= 75 ? 'STRONG' : 'DEVELOPING';

  const dl = direction === 'LONG' ? 'Bullish' : 'Bearish';
  const patternNames: Record<string,string> = {
    ENGULFING:    `${dl} Engulfing at OB`,
    PIN_BAR:      `${dl} Pin Bar at OB`,
    STRONG_CLOSE: `${dl} Strong Close at OB`,
    OB_BOUNCE:    `${dl} OB Pullback`,
  };

  const checklist: SetupChecklist = {
    trendConfirmed: true,
    bosConfirmed: true,
    pullbackToOB: true,
    momentumCandle: true,
    rsiInZone: true,
    htfAligned: htfTrend === direction,
    notSandwiched: true,
    minRR: true,
    volumeSurge: volRatio >= 1.5,
    liquiditySweep,
    pdhlConfluence,
    goodSession: session === 'London' || session === 'New York',
    historicalEdge,
    structureClearance: true,
    tp1Fresh: true,
    impulseStrong: true,
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
    pattern: patternNames[patternType] || 'OB Pullback',
    confluence,
    scannedAt: new Date().toISOString(),
    timeframe: granularity,
    session,
    checklist,
  };

  return { setup, reason: 'OK', detail };
}

export async function runScan(granularity='H1', minRR=1.5): Promise<Setup[]> {
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
  granularity='H1', minRR=1.5, journalStats: JournalStats = {}
): Promise<DebugResult[]> {
  const htfGran = HTF_MAP[granularity] || 'D';
  const results: DebugResult[] = [];
  for (const pair of PAIRS) {
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
