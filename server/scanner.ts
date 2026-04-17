import { checkNewsRisk } from './newsFilter.js';

const OANDA_API_KEY = process.env.OANDA_API_KEY || '';
const OANDA_ACCOUNT_TYPE = process.env.OANDA_ACCOUNT_TYPE || 'practice';
const OANDA_BASE = OANDA_ACCOUNT_TYPE === 'live'
  ? 'https://api-fxtrade.oanda.com'
  : 'https://api-fxpractice.oanda.com';

export const PAIRS = ['XAG_USD','XAU_USD','GBP_JPY','NZD_USD','AUD_USD','AUD_JPY','USD_JPY','GBP_USD','EUR_USD'];

const HTF_MAP: Record<string,string> = { M15:'H4', M30:'H4', H1:'D', H4:'W', D:'W' };

interface Candle { t:string; o:number; h:number; l:number; c:number; v:number; }
interface Swing  { index:number; price:number; type:'high'|'low'; }

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
}

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
  granularity='H1', minRR=1.5, _debug=false
): { setup: Setup|null; reason: string; detail: DebugResult['detail'] } {
  const detail: DebugResult['detail'] = {};

  // Need 210+ for a stable 200 EMA with warmup
  if (candles.length < 210) return { setup: null, reason: 'Not enough candles (<210)', detail };

  const atr = calcATR(candles.slice(-50));
  detail.atr = atr;
  const pdhl = getPDHL(candles);

  // ATR minimum — reject dead/illiquid markets
  const ATR_MIN: Record<string,number> = {
    XAU_USD: 0.8, XAG_USD: 0.015, GBP_JPY: 0.05,
    USD_JPY: 0.03, AUD_JPY: 0.03, GBP_USD: 0.0004,
    EUR_USD: 0.0003, AUD_USD: 0.0002, NZD_USD: 0.0002,
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

  // ── TREND DETECTION ──────────────────────────────────────────────────────────
  // Direction set by EMA alignment: price must be above/below both 50 & 200 EMA
  let direction: 'LONG'|'SHORT'|null = null;
  if (price > ema50 && price > ema200)      direction = 'LONG';
  else if (price < ema50 && price < ema200) direction = 'SHORT';

  if (!direction) return {
    setup: null,
    reason: `EMA alignment neutral — price (${price.toFixed(5)}) not clearly above/below EMA50 (${ema50.toFixed(5)}) + EMA200 (${ema200.toFixed(5)})`,
    detail,
  };
  detail.trend = direction;

  // HTF hard block — no counter-trend trades
  const htfSwings = findSwings(htf.slice(-100));
  const htfTrend  = getTrend(htfSwings);
  detail.htfTrend = htfTrend;
  if (htfTrend && htfTrend !== direction) {
    return { setup: null, reason: 'HTF conflict — counter-trend setup rejected', detail };
  }

  // ── RSI FILTER ───────────────────────────────────────────────────────────────
  if (direction === 'LONG') {
    if (rsi > 70) return { setup: null, reason: `RSI overbought for LONG (${rsi.toFixed(1)} > 70)`, detail };
    if (rsi < 40 || rsi > 68) return { setup: null, reason: `RSI outside LONG zone (${rsi.toFixed(1)}, need 40–68)`, detail };
  } else {
    if (rsi < 30) return { setup: null, reason: `RSI oversold for SHORT (${rsi.toFixed(1)} < 30)`, detail };
    if (rsi < 35 || rsi > 60) return { setup: null, reason: `RSI outside SHORT zone (${rsi.toFixed(1)}, need 35–60)`, detail };
  }

  // ── 20 EMA SLOPE CHECK ───────────────────────────────────────────────────────
  const ema20_3ago = ema20arr[lastIdx - 3];
  const emaSlope   = ema20 - ema20_3ago;
  detail.emaSlope  = emaSlope;
  const emaSlopeStrong = Math.abs(emaSlope) > 0.5 * atr;

  if (direction === 'LONG'  && emaSlope <= 0) return { setup: null, reason: `20 EMA not rising for LONG (slope=${emaSlope.toFixed(5)})`, detail };
  if (direction === 'SHORT' && emaSlope >= 0) return { setup: null, reason: `20 EMA not falling for SHORT (slope=${emaSlope.toFixed(5)})`, detail };

  // ── PULLBACK TO 20 EMA ───────────────────────────────────────────────────────
  // One of the last 3 candles must have touched within 0.5×ATR of the 20 EMA
  let pullbackCandle: Candle | null = null;
  let pullbackIdx = -1;
  for (let i = lastIdx; i >= lastIdx - 2; i--) {
    const c   = candles[i];
    const ema = ema20arr[i];
    if (!ema) continue;
    const touchDist = direction === 'LONG'
      ? Math.abs(c.l - ema)
      : Math.abs(c.h - ema);
    if (touchDist <= 0.5 * atr) {
      pullbackCandle = c;
      pullbackIdx    = i;
      break;
    }
  }
  if (!pullbackCandle) return {
    setup: null,
    reason: `No pullback to 20 EMA in last 3 candles (EMA20=${ema20.toFixed(5)}, price=${price.toFixed(5)})`,
    detail,
  };

  // ── REJECTION / BOUNCE PATTERN AT 20 EMA ────────────────────────────────────
  const pullbackEma = ema20arr[pullbackIdx];
  const prevCandle  = candles[pullbackIdx - 1];
  const momentum    = detectMomentum(pullbackCandle, prevCandle, direction, atr, pullbackEma);
  detail.momentum   = momentum?.type ?? null;

  let patternType = momentum?.type ?? null;
  // Fallback: EMA touch + close on correct side counts as a valid bounce
  if (!patternType) {
    if (direction === 'LONG'  && pullbackCandle.l <= pullbackEma + 0.5 * atr && pullbackCandle.c > pullbackEma) {
      patternType = 'EMA_BOUNCE';
    } else if (direction === 'SHORT' && pullbackCandle.h >= pullbackEma - 0.5 * atr && pullbackCandle.c < pullbackEma) {
      patternType = 'EMA_BOUNCE';
    }
  }
  if (!patternType) return {
    setup: null,
    reason: 'No rejection candle at 20 EMA (need engulfing, pin bar, strong close, or clean EMA bounce close)',
    detail,
  };

  // ── STOP LOSS ────────────────────────────────────────────────────────────────
  // Swing high/low of last 5 candles ± 0.3×ATR
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

  // Sort opposing swings by distance from entry (nearest first)
  const opposingSwings = (direction === 'LONG'
    ? swingHighs.filter(s => s.price > price)
    : swingLows.filter(s => s.price < price)
  ).sort((a, b) =>
    direction === 'LONG'
      ? a.price - b.price   // ascending — nearest first for LONG
      : b.price - a.price   // descending — nearest first for SHORT
  );

  // Walk swing levels in order. TP1 = first swing that clears minRR.
  // TP2/TP3 = next distinct levels beyond TP1 (each at least 0.5R further).
  // Never skip a nearby swing to chase RR — always respect nearest structure.
  const structureTPs: number[] = [];
  for (const s of opposingSwings) {
    if (structureTPs.length === 0) {
      // TP1: must clear minRR
      if (Math.abs(s.price - price) / risk >= minRR) structureTPs.push(s.price);
    } else {
      // TP2/TP3: must be meaningfully beyond the previous TP
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
  if (rrRatio < minRR) return { setup: null, reason: `RR too low (${rrRatio.toFixed(2)} < ${minRR})`, detail };

  // TP path obstruction
  const tpPathSwings = direction === 'LONG'
    ? swingHighs.filter(s => s.price > price && s.price < tp1)
    : swingLows.filter(s => s.price < price && s.price > tp1);
  const clutteredPath = tpPathSwings.length >= 2;

  // Volume — compare pullback candle to 20-candle average
  const avgVol  = candles.slice(-20).reduce((s,c) => s + c.v, 0) / 20;
  const volRatio = avgVol > 0 ? pullbackCandle.v / avgVol : 1;

  // Liquidity sweep: wick through 20 EMA then closed back above/below it
  const sweepWindow = candles.slice(lastIdx - 5, lastIdx);
  const liquiditySweep = direction === 'LONG'
    ? sweepWindow.some(c => c.l < ema20 && c.c > ema20)
    : sweepWindow.some(c => c.h > ema20 && c.c < ema20);

  const session = getSession();

  // ── SCORING ──────────────────────────────────────────────────────────────────
  let score = 60;
  if (emaSlopeStrong)                                                   score += 15;
  if (htfTrend === direction)                                           score += 15;
  const rsiIdeal = direction === 'LONG' ? (rsi >= 45 && rsi <= 60) : (rsi >= 40 && rsi <= 55);
  if (rsiIdeal)                                                         score += 10;
  if (volRatio >= 1.2)                                                  score += 10;
  if (Math.abs(pullbackCandle.c - pullbackCandle.o) > 0.5 * atr)       score += 10;
  if (pdhlConfluence)                                                   score += 10;
  if (liquiditySweep)                                                   score += 15;
  if (clutteredPath)                                                    score -= 15;
  if (session === 'Asia')                                               score -= 15;
  if (session === 'London' || session === 'New York')                   score += 10;

  // ── CONFLUENCE TAGS ───────────────────────────────────────────────────────────
  const confluence: string[] = ['EMA 20/50/200 aligned'];
  if (patternType === 'ENGULFING')    confluence.push('Engulfing at 20 EMA');
  if (patternType === 'PIN_BAR')      confluence.push('Pin bar at 20 EMA');
  if (patternType === 'STRONG_CLOSE') confluence.push('Strong close off 20 EMA');
  if (patternType === 'EMA_BOUNCE')   confluence.push('EMA bounce close');
  if (htfTrend === direction)         confluence.push('HTF aligned');
  if (emaSlopeStrong)                 confluence.push('Strong EMA slope');
  if (rsiIdeal)                       confluence.push('RSI ideal zone');
  if (volRatio >= 1.2)                confluence.push('Volume surge');
  if (session === 'London' || session === 'New York') confluence.push(`${session} session`);
  if (liquiditySweep)                 confluence.push('Liquidity sweep');
  if (pdhlConfluence)                 confluence.push('PDH/PDL confluence');
  if (clutteredPath)                  confluence.push('Cluttered TP path');

  const quality: 'PREMIUM'|'STRONG'|'DEVELOPING' =
    score >= 95 ? 'PREMIUM' : score >= 75 ? 'STRONG' : 'DEVELOPING';

  const dl = direction === 'LONG' ? 'Bullish' : 'Bearish';
  const patternNames: Record<string,string> = {
    ENGULFING:    `${dl} Engulfing at 20 EMA`,
    PIN_BAR:      `${dl} Pin Bar off 20 EMA`,
    STRONG_CLOSE: `${dl} Strong Close off 20 EMA`,
    EMA_BOUNCE:   `${dl} EMA 20 Pullback`,
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

export async function debugScan(granularity='H1', minRR=1.5): Promise<DebugResult[]> {
  const htfGran = HTF_MAP[granularity] || 'D';
  const results: DebugResult[] = [];
  for (const pair of PAIRS) {
    try {
      const [candles, htf] = await Promise.all([
        fetchCandles(pair, granularity, 250),
        fetchCandles(pair, htfGran, 150),
      ]);
      const { setup, reason, detail } = analyzeCandles(candles, htf, pair, granularity, minRR, true);
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
