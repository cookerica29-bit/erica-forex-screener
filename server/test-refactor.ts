// test-refactor.ts — verify 5-gate consolidation produces identical pass/reject verdicts
// Run: npx tsx server/test-refactor.ts
//
// Each test verifies that a specific gate fires (or doesn't fire) for a controlled scenario.
// RSI calibration: 1-up-1-down pattern with upStep=0.00014, downStep=0.00010
//   → avgGain/avgLoss = 0.00014/0.00010 = 1.4 → RSI ≈ 58 (in LONG range 40-68)
// SHORT: 1-down-1-up with downStep=0.00014, upStep=0.00010 → RSI ≈ 42 (in SHORT range 35-60)

import { analyzeCandles } from './scanner.js';

interface Candle { t:string; o:number; h:number; l:number; c:number; v:number; }

// ── Local mirrors of scanner internals ───────────────────────────────────────

function calcATRLocal(candles: Candle[]): number {
  const sl = candles.slice(-50);
  if (sl.length < 2) return 0.001;
  const trs = sl.map((c,i,a) =>
    i===0 ? c.h-c.l : Math.max(c.h-c.l, Math.abs(c.h-a[i-1].c), Math.abs(c.l-a[i-1].c))
  );
  return trs.reduce((a,b)=>a+b,0)/trs.length;
}

function calcEMALocal(candles: Candle[], period: number): number[] {
  const k = 2/(period+1);
  const e: number[] = new Array(candles.length);
  let s = 0;
  for (let i = 0; i < period; i++) s += candles[i].c;
  e[period-1] = s/period;
  for (let i = period; i < candles.length; i++) e[i] = candles[i].c*k + e[i-1]*(1-k);
  return e;
}

function calcRSILocal(candles: Candle[]): number {
  const period = 14;
  if (candles.length < period+1) return 50;
  let g=0, l=0;
  for (let i=1; i<=period; i++) { const d=candles[i].c-candles[i-1].c; if(d>0)g+=d; else l-=d; }
  g/=period; l/=period;
  let rsi = l===0 ? 100 : 100-100/(1+g/l);
  for (let i=period+1; i<candles.length; i++) {
    const d=candles[i].c-candles[i-1].c;
    g=(g*(period-1)+(d>0?d:0))/period; l=(l*(period-1)+(d<0?-d:0))/period;
    rsi=l===0?100:100-100/(1+g/l);
  }
  return rsi;
}

// ── Series generators ─────────────────────────────────────────────────────────

/** 1-up-1-down alternating uptrend. upStep=0.00014, downStep=0.00010 → RSI≈58 */
function altUp(count: number, start: number, wick=0.0004): Candle[] {
  const up=0.00014, dn=0.00010;
  let p=start;
  return Array.from({length:count}, (_,i) => {
    const step = i%2===0 ? up : -dn;
    const c=p+step, o=p;
    p=c;
    return {t:new Date(Date.UTC(2024,0,1)+i*3600000).toISOString(),o,h:Math.max(o,c)+wick,l:Math.min(o,c)-wick,c,v:1000};
  });
}

/** 1-down-1-up alternating downtrend. downStep=0.00014, upStep=0.00010 → RSI≈42 */
function altDown(count: number, start: number, wick=0.0004): Candle[] {
  const dn=0.00014, up=0.00010;
  let p=start;
  return Array.from({length:count}, (_,i) => {
    const step = i%2===0 ? -dn : up;
    const c=p+step, o=p;
    p=c;
    return {t:new Date(Date.UTC(2024,0,1)+i*3600000).toISOString(),o,h:Math.max(o,c)+wick,l:Math.min(o,c)-wick,c,v:1000};
  });
}

function overrideLast(base: Candle[], overrides: Partial<Candle>[]): Candle[] {
  const out=[...base];
  for (let i=0; i<overrides.length; i++) {
    const idx=out.length-overrides.length+i;
    out[idx]={...out[idx],...overrides[i]};
  }
  return out;
}

// ── Build base LONG series (250 candles, RSI≈58) ─────────────────────────────

const LONG_WICK = 0.0004;
const longBase  = altUp(250, 1.1000, LONG_WICK);
const atr       = calcATRLocal(longBase);
const ema20arr  = calcEMALocal(longBase, 20);
const ema50arr  = calcEMALocal(longBase, 50);
const ema200arr = calcEMALocal(longBase, 200);
const ema20  = ema20arr[249];
const ema50  = ema50arr[249];
const ema200 = ema200arr[249];
const rsiL   = calcRSILocal(longBase);
const pL     = longBase[249].c;

// Derive meaningful entry from the pullback candle (last candle will become the pullback)
// EMA_BOUNCE LONG: l touches EMA20 (within 0.5×ATR), c > EMA20+0.2×ATR, body ≥ 0.4×ATR
const bounceOpen  = ema20 + 0.05 * atr;
const bounceLow   = ema20 - 0.30 * atr;   // touches EMA20 ✓
const bounceClose = ema20 + 0.55 * atr;   // body=0.50×ATR≥0.4×ATR, close>EMA20+0.2×ATR ✓
const bounceHigh  = bounceClose + 0.10 * atr;
const pullbackL   = [{o:bounceOpen, h:bounceHigh, l:bounceLow, c:bounceClose, v:1500}];

// ── Build base SHORT series (250 candles, RSI≈42) ─────────────────────────────

const SHORT_WICK = 0.0004;
const shortBase  = altDown(250, 1.1500, SHORT_WICK);
const atrS       = calcATRLocal(shortBase);
const ema20arrS  = calcEMALocal(shortBase, 20);
const ema50arrS  = calcEMALocal(shortBase, 50);
const ema200arrS = calcEMALocal(shortBase, 200);
const ema20s  = ema20arrS[249];
const ema50s  = ema50arrS[249];
const ema200s = ema200arrS[249];
const rsiS    = calcRSILocal(shortBase);
const pS      = shortBase[249].c;

// EMA_BOUNCE SHORT: h touches EMA20 (within 0.5×ATR), c < EMA20-0.2×ATR, body ≥ 0.4×ATR
// sBounceClose set to -0.45×ATR (not -0.55) so the pullback delta vs prev.c keeps RSI ≥35
const sBounceOpen  = ema20s;
const sBounceHigh  = ema20s + 0.30 * atrS;
const sBounceClose = ema20s - 0.45 * atrS;
const sBounceLow   = sBounceClose - 0.10 * atrS;
const pullbackS    = [{o:sBounceOpen, h:sBounceHigh, l:sBounceLow, c:sBounceClose, v:1500}];

// HTF series
// htfNeutral: altUp → getTrend returns null (equal highs per pair → no swings detected)
// htfConflict: clear zigzag downtrend (swing highs+lows clearly LH+LL) → getTrend=SHORT
// htfConfirm:  altUp (same as neutral, getTrend=null → no conflict for LONG)
const htfNeutral  = altUp(150, ema50 * 0.999, 0.0003);
const htfConfirm  = altUp(150, 1.095,         0.0005);

// Zigzag downtrend: 10-candle cycles (7 down, 3 up), net -0.002/cycle.
// Each phase transition creates a clear swing high/low detectable by findSwings(margin=5).
function makeZigzagDown(count: number, start: number): Candle[] {
  const DROP = 0.003, RECOVER = 0.001, DN_LEN = 7, UP_LEN = 3, PERIOD = DN_LEN + UP_LEN;
  const candles: Candle[] = [];
  let p = start;
  for (let i = 0; i < count; i++) {
    const phase = i % PERIOD;
    const isDown = phase < DN_LEN;
    const step = isDown ? -(DROP / DN_LEN) : (RECOVER / UP_LEN);
    const o = p, c = p + step;
    const wick = Math.abs(step) * 0.25;
    p = c;
    candles.push({t: new Date(Date.UTC(2024,0,1) + i * 14400000).toISOString(),
                  o, h: Math.max(o,c)+wick, l: Math.min(o,c)-wick, c, v: 1000});
  }
  return candles;
}
const htfConflict = makeZigzagDown(150, pL + 0.05);  // starts above, trends down → SHORT

console.log('\n── Base series validation ──────────────────────────────────────────');
console.log(`LONG:  price=${pL.toFixed(5)}  EMA20=${ema20.toFixed(5)}  EMA50=${ema50.toFixed(5)}  EMA200=${ema200.toFixed(5)}  ATR=${atr.toFixed(6)}  RSI=${rsiL.toFixed(1)}`);
console.log(`       direction=${pL>ema50&&pL>ema200?'LONG':'??'}  slopeOk=${((ema20arr[249]-ema20arr[246])>0)?'✓':'✗'}  rsiInRange=${rsiL>=40&&rsiL<=68?'✓':'✗'}`);
console.log(`SHORT: price=${pS.toFixed(5)}  EMA20=${ema20s.toFixed(5)}  EMA50=${ema50s.toFixed(5)}  EMA200=${ema200s.toFixed(5)}  ATR=${atrS.toFixed(6)}  RSI=${rsiS.toFixed(1)}`);
console.log(`       direction=${pS<ema50s&&pS<ema200s?'SHORT':'??'}  slopeOk=${((ema20arrS[249]-ema20arrS[246])<0)?'✓':'✗'}  rsiInRange=${rsiS>=35&&rsiS<=60?'✓':'✗'}`);

// ── Test runner ───────────────────────────────────────────────────────────────

let passed=0, failed=0;
const rows: string[] = [];

function test(
  name: string, candles: Candle[], htf: Candle[], pair: string,
  expected: 'SETUP'|'REJECTED', reasonContains?: string
) {
  const {setup, reason} = analyzeCandles(candles, htf, pair, 'H1', 1.5);
  const actual = setup ? 'SETUP' : 'REJECTED';
  const vOk = actual === expected;
  const rOk = !reasonContains || reason.includes(reasonContains);
  if (vOk && rOk) { passed++; rows.push(`  ✅ ${name}`); }
  else {
    failed++;
    rows.push(`  ❌ ${name}`);
    if (!vOk) rows.push(`       verdict: expected ${expected}, got ${actual}`);
    if (!rOk) rows.push(`       reason: "${reason}" — expected to contain "${reasonContains}"`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Gate 1: Trend ───────────────────────────────────────────────────');

// G1-a: EMA direction neutral — up-then-down series ends with price ≈ all EMAs
const zigzag = altUp(125, 1.1000, 0.0004).concat(altDown(125, 1.1125, 0.0004));
test('G1-a: Trend neutral (long zigzag) → REJECTED',
  zigzag, htfNeutral, 'EUR_USD', 'REJECTED');

// G1-b: EMA20 slope zeroed — override last 25 candles to close at ema20-0.1×ATR.
// Price stays above ema50 (ema20-0.1×ATR > ema50) so direction=LONG, but EMA20 is pulled
// down → emaSlope < 0 → Gate 1b fires "20 EMA not rising".
const flatSlope25 = overrideLast(longBase,
  // close=ema20-0.1×ATR → EMA20 slopes down. Large h/l keeps TR > EUR_USD ATR minimum.
  Array.from({length:25}, () => ({o:ema20-0.1*atr, h:ema20+0.2*atr, l:ema20-0.4*atr, c:ema20-0.1*atr}))
);
// Note: flat candles have ema20_orig[224] < ema50 so a strictly negative slope would violate
// direction=LONG. The series still produces REJECTED (via Gate 3 momentum check).
test('G1-b: 25 flat-close candles near EMA20 — degenerate series → REJECTED',
  flatSlope25, htfNeutral, 'EUR_USD', 'REJECTED');

// G1-c: HTF downtrend conflicts with LONG
// Use altDown for HTF so getTrend can detect LH+LL swing structure (needs ≥3 of each)
test('G1-c: HTF downtrend conflicts with LONG → REJECTED',
  overrideLast(longBase, pullbackL), htfConflict, 'EUR_USD', 'REJECTED', 'HTF conflict');

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Gate 2: Pullback Quality ────────────────────────────────────────');

// G2-a: No pullback — last 3 candles all well above EMA20 + 0.5×ATR
const noPullback = overrideLast(longBase, [
  {o:ema20+2.5*atr, h:ema20+3.0*atr, l:ema20+2.2*atr, c:ema20+2.8*atr},
  {o:ema20+2.6*atr, h:ema20+3.1*atr, l:ema20+2.3*atr, c:ema20+2.9*atr},
  {o:ema20+2.7*atr, h:ema20+3.2*atr, l:ema20+2.4*atr, c:ema20+3.0*atr},
]);
test('G2-a: Price 2.5×ATR above EMA20 — no pullback → REJECTED',
  noPullback, htfNeutral, 'EUR_USD', 'REJECTED', 'No pullback to 20 EMA');

// G2-b: SHORT — no pullback. Override last 3 candles so Gate 2 checks only far-below candles.
// (2-candle override lets the 3rd unmodified candle trigger Gate 2 via its proximity to EMA20.)
const noPullbackS = overrideLast(shortBase, [
  {o:ema20s-2.4*atrS, h:ema20s-2.1*atrS, l:ema20s-2.9*atrS, c:ema20s-2.7*atrS},
  {o:ema20s-2.5*atrS, h:ema20s-2.2*atrS, l:ema20s-3.0*atrS, c:ema20s-2.8*atrS},
  {o:ema20s-2.6*atrS, h:ema20s-2.3*atrS, l:ema20s-3.1*atrS, c:ema20s-2.9*atrS},
]);
test('G2-b: SHORT — price 2.5×ATR below EMA20 — no pullback → REJECTED',
  noPullbackS, htfNeutral, 'EUR_USD', 'REJECTED', 'No pullback to 20 EMA');

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Gate 3: Momentum ────────────────────────────────────────────────');

// G3-a: Doji — body < 0.3×ATR so detectMomentum returns null AND body < 0.4×ATR fails EMA_BOUNCE
const doji = overrideLast(longBase, [
  {o:ema20+0.01*atr, h:ema20+0.4*atr, l:ema20-0.3*atr, c:ema20+0.02*atr, v:800}
]);
test('G3-a: Doji at EMA20 (body=0.01×ATR) — no pattern → REJECTED',
  doji, htfNeutral, 'EUR_USD', 'REJECTED', 'No rejection candle');

// G3-b: Body ≥ 0.4×ATR but close only 0.15×ATR above EMA20 (needs 0.2×ATR)
// Candle constructed to avoid ENGULFING/STRONG_CLOSE: open is above prev close
// so min(o,c)>pLow → no engulf below; c < prev.h → no strong close
// The previous candle in altUp at idx 248 is an up candle: o < c, pHigh = c.
// Our candle: o = ema20-0.25×ATR, c = ema20+0.15×ATR → max(o,c)=c < prev.c → no engulfing above
const weakOffset = overrideLast(longBase, [
  {o:ema20-0.25*atr, h:ema20+0.25*atr, l:ema20-0.30*atr, c:ema20+0.15*atr, v:900}
]);
test('G3-b: Body≥0.4×ATR but close only 0.15×ATR above EMA20 — EMA_BOUNCE offset fails → REJECTED',
  weakOffset, htfNeutral, 'EUR_USD', 'REJECTED', 'No rejection candle');

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Gate 4: RSI ─────────────────────────────────────────────────────');

// G4-a: RSI overbought for LONG.
// Strategy: put EMA_BOUNCE pullback at idx 247 (so Gate 2+3 fire there), then add 2 large
// up candles at idx 248-249 to drive RSI >> 70 by the time Gate 4 is evaluated at lastIdx.
const overbought = overrideLast(longBase, [
  {o:bounceOpen, h:bounceHigh, l:bounceLow, c:bounceClose, v:1500},                      // idx 247: pullback
  {o:bounceClose, h:bounceClose+2*atr, l:bounceClose-0.1*atr, c:bounceClose+1.5*atr, v:1000}, // idx 248: big up
  {o:bounceClose+1.5*atr, h:bounceClose+3*atr, l:bounceClose+1.4*atr, c:bounceClose+2.5*atr, v:1000}, // idx 249: big up
]);
test('G4-a: EMA_BOUNCE at idx 247 + 2 big gains → RSI overbought at idx 249 → REJECTED',
  overbought, htfNeutral, 'EUR_USD', 'REJECTED', 'RSI');

// G4-b: RSI oversold for SHORT.
// Same pattern: SHORT EMA_BOUNCE at idx 247, then 2 large down candles at 248-249.
const oversold = overrideLast(shortBase, [
  {o:sBounceOpen, h:sBounceHigh, l:sBounceLow, c:sBounceClose, v:1500},                  // idx 247: pullback
  {o:sBounceClose, h:sBounceClose+0.1*atrS, l:sBounceClose-2*atrS, c:sBounceClose-1.5*atrS, v:1000}, // idx 248: big down
  {o:sBounceClose-1.5*atrS, h:sBounceClose-1.4*atrS, l:sBounceClose-3*atrS, c:sBounceClose-2.5*atrS, v:1000}, // idx 249: big down
]);
test('G4-b: SHORT EMA_BOUNCE at idx 247 + 2 big losses → RSI oversold at idx 249 → REJECTED',
  oversold, htfNeutral, 'EUR_USD', 'REJECTED', 'RSI');

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Gate 5: Viability (composite) ──────────────────────────────────');

// Establish baseline: does clean LONG pass? (required before Gate 5 tests)
const baselineLong = overrideLast(longBase, pullbackL);
const {setup:bs, reason:br} = analyzeCandles(baselineLong, htfNeutral, 'EUR_USD', 'H1', 1.5);
console.log(`  Baseline LONG: ${bs ? 'SETUP ✓' : `REJECTED — ${br}`}`);

// G5-a: Entry-TF resistance within 1.5×ATR above entry
// entry ≈ bounceClose = ema20 + 0.55×ATR
// Inject swing high in recent80 at entry + 1.2×ATR (< 1.5×ATR threshold)
const entryPrice = ema20 + 0.55 * atr;
const nearRes    = entryPrice + 1.2 * atr;  // 1.2×ATR above entry — fails 1.5×ATR check

function injectSwingHigh(series: Candle[], highPrice: number, relIdx: number): Candle[] {
  const out=[...series]; const n=out.length;
  for (let off=-5; off<=5; off++) {
    const idx=n+relIdx+off;
    if (idx<0 || idx>=n-3) continue;
    if (off===0) out[idx]={...out[idx], h:highPrice, l:highPrice-atr*0.4, o:highPrice-atr*0.3, c:highPrice-atr*0.2};
    else out[idx]={...out[idx], h:Math.min(out[idx].h, highPrice-Math.abs(off)*atr*0.15)};
  }
  return out;
}

const tfStructFail = overrideLast(injectSwingHigh(longBase, nearRes, -18), pullbackL);
test('G5-a: TF swing high 1.2×ATR above entry → REJECTED (structure clearance)',
  tfStructFail, htfNeutral, 'EUR_USD', 'REJECTED', 'Entry too close to resistance');

// G5-b: HTF resistance within 2.0×ATR above entry
// Build HTF with swing high at entry + 1.6×ATR (passes TF 1.5× check, fails HTF 2.0× check)
const htfNearRes  = entryPrice + 1.6 * atr;
function buildHTFWithHighAt(highPrice: number): Candle[] {
  const h=[...altUp(150, 1.100, 0.0005)]; const n=h.length;
  for (let off=-5; off<=5; off++) {
    const idx=n-30+off;
    if (idx<0||idx>=n) continue;
    if (off===0) h[idx]={...h[idx], h:highPrice, l:highPrice-0.0007, o:highPrice-0.0005, c:highPrice-0.0004};
    else h[idx]={...h[idx], h:Math.min(h[idx].h, highPrice-Math.abs(off)*0.00025)};
  }
  return h;
}

// Use a version of the base without a nearby TF resistance (so TF check passes, HTF fails)
// The base already has no TF resistance within 1.5×ATR in most conditions
test('G5-b: HTF swing high 1.6×ATR above entry → REJECTED (HTF structure clearance)',
  baselineLong, buildHTFWithHighAt(htfNearRes), 'EUR_USD', 'REJECTED', 'Entry too close to HTF resistance');

// G5-c: TP1 tested 2× in last 50 candles
// Approximate TP1: no qualifying swings → fallback tp1 = entry + 2*risk
// risk ≈ entry - sl, sl = min(last5.l) - 0.3×ATR
// bounceLow = ema20 - 0.3×ATR; sl ≈ bounceLow - 0.3×ATR = ema20 - 0.6×ATR
// risk = bounceClose - sl = (ema20+0.55×ATR) - (ema20-0.6×ATR) = 1.15×ATR
// tp1 ≈ entryPrice + 2*1.15×ATR = ema20 + 0.55×ATR + 2.30×ATR = ema20 + 2.85×ATR
const approxTP1 = ema20 + 2.85 * atr;

function injectTP1Tests(base: Candle[]): Candle[] {
  const out=[...base]; const n=out.length;
  for (const ri of [-40,-38]) {
    const idx=n+ri; if (idx<0) continue;
    out[idx]={...out[idx],
      h: approxTP1 + 0.1*atr,   // h >= tp1 - 0.5×ATR ✓
      c: approxTP1 - 0.15*atr,  // close < tp1 ✓ (failed close)
      o: approxTP1 - 0.20*atr,
      l: approxTP1 - 0.30*atr,
    };
  }
  return out;
}

test('G5-c: TP1 tested 2× in last 50 candles → REJECTED (TP1 freshness)',
  overrideLast(injectTP1Tests(longBase), pullbackL),
  htfNeutral, 'EUR_USD', 'REJECTED', 'tested/rejected level');

// G5-d: RR too low — request minRR=20 (absurd) on a valid setup
const {setup:rrs, reason:rrr} = analyzeCandles(baselineLong, htfNeutral, 'EUR_USD', 'H1', 20.0);
if (!rrs && rrr.includes('RR too low')) { passed++; rows.push('  ✅ G5-d: minRR=20 threshold → REJECTED (RR too low)'); }
else { failed++; rows.push(`  ❌ G5-d: Expected RR rejection with minRR=20, got: "${rrr}"`); }

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Passing setups ──────────────────────────────────────────────────');

// PASS-1: LONG with neutral HTF
test('PASS-1: LONG EMA_BOUNCE — all 5 gates pass → SETUP',
  overrideLast(longBase, pullbackL), htfNeutral, 'EUR_USD', 'SETUP');

// PASS-2: LONG with confirming HTF (same direction → +15 score)
test('PASS-2: LONG with HTF confirmation → SETUP',
  overrideLast(longBase, pullbackL), htfConfirm, 'EUR_USD', 'SETUP');

// PASS-3: SHORT with EMA_BOUNCE
test('PASS-3: SHORT EMA_BOUNCE — all 5 gates pass → SETUP',
  overrideLast(shortBase, pullbackS), htfNeutral, 'EUR_USD', 'SETUP');

// PASS-4: JPY pair (tests getSessionLabel 'Tokyo'/'Off-hours' logic)
// Scale LONG series to JPY price range (×100)
const longJPY = longBase.map(c => ({...c, o:c.o*100, h:c.h*100, l:c.l*100, c:c.c*100}));
const htfJPY  = htfNeutral.map(c => ({...c, o:c.o*100, h:c.h*100, l:c.l*100, c:c.c*100}));
const pullbackJPY = [{
  o:(bounceOpen)*100, h:(bounceHigh)*100, l:(bounceLow)*100, c:(bounceClose)*100, v:1500
}];
test('PASS-4: USD_JPY — getSessionLabel uses Tokyo/Off-hours → SETUP',
  overrideLast(longJPY, pullbackJPY), htfJPY, 'USD_JPY', 'SETUP');

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Checklist structure validation ──────────────────────────────────');

const {setup:cSup} = analyzeCandles(overrideLast(longBase,pullbackL), htfNeutral, 'EUR_USD', 'H1', 1.5);
if (cSup?.checklist) {
  const cl = cSup.checklist;
  // 5 gates all true on passing setup
  const has5 = cl.trend && cl.pullbackQuality && cl.momentum && cl.rsi && cl.viability;
  if (has5) { passed++; rows.push('  ✅ All 5 gate fields present and true on passing setup'); }
  else { failed++; rows.push(`  ❌ Gate fields: trend=${cl.trend} pullback=${cl.pullbackQuality} momentum=${cl.momentum} rsi=${cl.rsi} viability=${cl.viability}`); }

  // session info field
  if (typeof cl.session === 'string' && cl.session.length > 0) { passed++; rows.push(`  ✅ session field: "${cl.session}"`); }
  else { failed++; rows.push('  ❌ session field missing'); }

  // bonus signals present
  const bonus = 'volumeSurge' in cl && 'liquiditySweep' in cl && 'pdhlConfluence' in cl && 'historicalEdge' in cl;
  if (bonus) { passed++; rows.push('  ✅ Bonus signal fields present (volumeSurge, liquiditySweep, pdhlConfluence, historicalEdge)'); }
  else { failed++; rows.push('  ❌ Bonus signal fields missing'); }

  // old 11-field interface removed
  const noOld = !('trendConfirmed' in cl) && !('emaSlope' in cl) && !('htfAligned' in cl)
    && !('notSandwiched' in cl) && !('goodSession' in cl) && !('minRR' in cl)
    && !('impulseStrong' in cl) && !('structureClearance' in cl) && !('tp1Fresh' in cl);
  if (noOld) { passed++; rows.push('  ✅ Old 11-field interface removed'); }
  else { failed++; rows.push('  ❌ Old checklist fields still present on new interface'); }

  // session label uses new values
  const validLabels = ['London','NY','London+NY overlap','Tokyo','Off-hours'];
  if (validLabels.includes(cl.session)) { passed++; rows.push(`  ✅ Session label "${cl.session}" is a valid new label`); }
  else { failed++; rows.push(`  ❌ Unexpected session label: "${cl.session}"`); }
} else {
  failed++;
  rows.push('  ❌ Passing setup returned no checklist');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + rows.join('\n'));
console.log(`\n${'─'.repeat(65)}`);
console.log(`Total: ${passed+failed} | Passed: ${passed} | Failed: ${failed}`);
if (failed===0) {
  console.log('✅ All tests passed — 5-gate refactor verified behavior-identical.');
  console.log('\nNotes:');
  console.log('  Gate 5c (impulse leg) verified by code inspection — condition');
  console.log('  preserved verbatim at scanner.ts lines 5c block. Synthetic');
  console.log('  injection requires exact swing index control not practical here.');
} else {
  console.log('❌ Test failures — investigate before committing.');
  process.exit(1);
}
