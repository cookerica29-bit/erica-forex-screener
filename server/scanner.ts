const OANDA_API_KEY = process.env.OANDA_API_KEY || '';
const OANDA_ACCOUNT_TYPE = process.env.OANDA_ACCOUNT_TYPE || 'practice';
const OANDA_BASE = OANDA_ACCOUNT_TYPE === 'live'
  ? 'https://api-fxtrade.oanda.com'
  : 'https://api-fxpractice.oanda.com';

export const PAIRS = ['XAG_USD','XAU_USD','GBP_JPY','NZD_USD','AUD_USD','AUD_JPY','USD_JPY','GBP_USD','EUR_USD'];

const HTF_MAP: Record<string,string> = { M15:'H1', M30:'H4', H1:'H4', H4:'D', D:'W' };

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
    distToLevel?: number;
    atr?: number;
    price?: number;
    structureLevel?: number;
  };
}

async function fetchCandles(instrument: string, granularity: string, count=200): Promise<Candle[]> {
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
  if (highs.length<2 || lows.length<2) return null;
  const hh = highs[highs.length-1].price > highs[highs.length-2].price;
  const hl = lows[lows.length-1].price  > lows[lows.length-2].price;
  const lh = highs[highs.length-1].price < highs[highs.length-2].price;
  const ll = lows[lows.length-1].price  < lows[lows.length-2].price;
  if (hh && hl) return 'LONG';
  if (lh && ll) return 'SHORT';
  return null;
}

function detectMomentum(c: Candle, p: Candle, dir: string, atr: number): {type:string;strength:number}|null {
  const body=Math.abs(c.c-c.o), range=c.h-c.l, bodyRatio=range>0?body/range:0;
  const uw=c.h-Math.max(c.c,c.o), lw=Math.min(c.c,c.o)-c.l;
  const pBody=Math.abs(p.c-p.o), pHigh=Math.max(p.c,p.o), pLow=Math.min(p.c,p.o);
  // Candle too small to be meaningful — filter out noise
  if (body < 0.3 * atr) return null;
  if (dir==='LONG'&&c.c>c.o&&Math.min(c.o,c.c)<=pLow&&Math.max(c.o,c.c)>=pHigh&&body>pBody*0.9)
    return {type:'ENGULFING',strength:80};
  if (dir==='SHORT'&&c.c<c.o&&Math.max(c.o,c.c)>=pHigh&&Math.min(c.o,c.c)<=pLow&&body>pBody*0.9)
    return {type:'ENGULFING',strength:80};
  if (dir==='LONG'&&lw>body*2&&lw>uw*1.5&&bodyRatio<0.4)
    return {type:'PIN_BAR',strength:70};
  if (dir==='SHORT'&&uw>body*2&&uw>lw*1.5&&bodyRatio<0.4)
    return {type:'PIN_BAR',strength:70};
  if (dir==='LONG'&&c.c>c.o&&bodyRatio>0.65&&c.c>p.h)
    return {type:'STRONG_CLOSE',strength:65};
  if (dir==='SHORT'&&c.c<c.o&&bodyRatio>0.65&&c.c<p.l)
    return {type:'STRONG_CLOSE',strength:65};
  return null;
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
  granularity='H1', minRR=1.5, debug=false
): { setup: Setup|null; reason: string; detail: DebugResult['detail'] } {
  const detail: DebugResult['detail'] = {};

  if (candles.length < 80) return { setup: null, reason: 'Not enough candles (<80)', detail };

  const recent = candles.slice(-80);
  const atr = calcATR(recent);
  detail.atr = atr;

  const swings = findSwings(recent);
  const trend = getTrend(swings);
  detail.trend = trend;
  if (!trend) return { setup: null, reason: 'No clear swing structure trend (need HH+HL or LH+LL)', detail };

  const htfSwings = findSwings(htf.slice(-50));
  const htfTrend  = getTrend(htfSwings);
  detail.htfTrend = htfTrend;

  const last  = recent[recent.length-1];
  const prev  = recent[recent.length-2];
  const price = last.c;
  detail.price = price;

  // Look back up to 3 candles for a valid momentum signal
  let momentum = null;
  let momentumCandle = last;
  for (let i = recent.length - 1; i >= recent.length - 3; i--) {
    const m = detectMomentum(recent[i], recent[i-1], trend, atr);
    if (m) { momentum = m; momentumCandle = recent[i]; break; }
  }
  detail.momentum = momentum?.type ?? null;
  if (!momentum) return { setup: null, reason: 'No momentum candle (need engulfing, pin bar, or strong close in last 3 candles)', detail };

  const lows  = swings.filter(s=>s.type==='low');
  const highs = swings.filter(s=>s.type==='high');

  let structureLevel: number;
  if (trend==='LONG') {
    if (!lows.length) return { setup: null, reason: 'LONG trend but no swing lows found', detail };
    structureLevel = lows[lows.length-1].price;
    detail.structureLevel = structureLevel;
    const distToLevel = price - structureLevel;
    detail.distToLevel = distToLevel;
    if (distToLevel < 0) return { setup: null, reason: `Price broke below structure level (${price.toFixed(5)} < support ${structureLevel.toFixed(5)}) — structure invalidated`, detail };
    if (distToLevel > 1.5*atr) return { setup: null, reason: `Price too far above structure level (${distToLevel.toFixed(5)} > 1.5×ATR ${(1.5*atr).toFixed(5)}) — mid-move`, detail };
    if (last.c < (last.o + last.h + last.l)/3) return { setup: null, reason: 'Candle closing bearishly (below avg price) — no bullish conviction', detail };
  } else {
    if (!highs.length) return { setup: null, reason: 'SHORT trend but no swing highs found', detail };
    structureLevel = highs[highs.length-1].price;
    detail.structureLevel = structureLevel;
    const distToLevel = structureLevel - price;
    detail.distToLevel = distToLevel;
    if (distToLevel < 0) return { setup: null, reason: `Price broke above structure level (${price.toFixed(5)} > resistance ${structureLevel.toFixed(5)}) — structure invalidated`, detail };
    if (distToLevel > 1.5*atr) return { setup: null, reason: `Price too far below structure level (${distToLevel.toFixed(5)} > 1.5×ATR ${(1.5*atr).toFixed(5)}) — mid-move`, detail };
    if (last.c > (last.o + last.h + last.l)/3) return { setup: null, reason: 'Candle closing bullishly (above avg price) — no bearish conviction', detail };
  }

  const sl   = trend==='LONG'
    ? Math.min(momentumCandle.l, structureLevel) - 0.3*atr
    : Math.max(momentumCandle.h, structureLevel) + 0.3*atr;
  if (trend === 'LONG' && sl >= price) return { setup: null, reason: 'Inverted SL: sl >= entry for LONG', detail };
  if (trend === 'SHORT' && sl <= price) return { setup: null, reason: 'Inverted SL: sl <= entry for SHORT', detail };
  const risk = Math.abs(price - sl);
  if (risk <= 0) return { setup: null, reason: 'Risk is zero (price equals SL)', detail };

  const opposingSwings = trend==='LONG'
    ? highs.filter(s=>s.price>price)
    : lows.filter(s=>s.price<price);

  let tp1: number;
  if (opposingSwings.length) {
    const nearest = trend==='LONG'
      ? Math.min(...opposingSwings.map(s=>s.price))
      : Math.max(...opposingSwings.map(s=>s.price));
    const potentialRR = Math.abs(nearest-price)/risk;
    tp1 = potentialRR >= minRR ? nearest : (trend==='LONG' ? price+2*risk : price-2*risk);
  } else {
    tp1 = trend==='LONG' ? price+2*risk : price-2*risk;
  }

  const tp2 = trend==='LONG' ? price+3*risk : price-3*risk;
  const tp3 = trend==='LONG' ? price+4*risk : price-4*risk;
  const rrRatio = Math.abs(tp1-price)/risk;
  if (rrRatio < minRR) return { setup: null, reason: `RR too low (${rrRatio.toFixed(2)} < ${minRR})`, detail };

  // Confluence + scoring — HTF conflict is now a penalty, not a blocker
  const confluence: string[] = [];
  if (momentum.type==='ENGULFING')    confluence.push('Engulfing candle');
  if (momentum.type==='PIN_BAR')      confluence.push('Pin bar');
  if (momentum.type==='STRONG_CLOSE') confluence.push('Strong close');
  if (htfTrend===trend)  confluence.push('HTF aligned');
  if (rrRatio>=3) confluence.push('R:R ≥3');
  if (atr>0)      confluence.push('ATR structure');
  const session = getSession();
  if (session === 'London' || session === 'New York') confluence.push(`${session} session`);

  let score = momentum.strength;
  // HTF conflict is a hard block — no counter-trend trades
  if (htfTrend && htfTrend !== trend) return { setup: null, reason: 'HTF conflict — counter-trend setup rejected', detail };
  // HTF aligned bonus
  if (htfTrend === trend) score += 15;
  if (rrRatio>=3) score += 10;
  if (rrRatio>=2) score += 5;
  // Session quality bonus/penalty
  const session = getSession();
  if (session === 'London' || session === 'New York') score += 10;
  if (session === 'Asia') score -= 15;

  const quality: 'PREMIUM'|'STRONG'|'DEVELOPING' =
    score>=95 ? 'PREMIUM' : score>=75 ? 'STRONG' : 'DEVELOPING';

  const setup: Setup = {
    pair,
    direction: trend,
    quality,
    rrRatio: Math.round(rrRatio*100)/100,
    entry: price,
    sl,
    tp1,
    tp2,
    tp3,
    pattern: momentum.type,
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
        fetchCandles(pair, granularity, 200),
        fetchCandles(pair, htfGran, 100),
      ]);
      const { setup } = analyzeCandles(candles, htf, pair, granularity, minRR);
      if (setup) results.push(setup);
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
        fetchCandles(pair, granularity, 200),
        fetchCandles(pair, htfGran, 100),
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
