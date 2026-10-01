import 'dotenv/config';

const OANDA_API_KEY = process.env.OANDA_API_KEY || '';
const OANDA_BASE = (process.env.OANDA_ACCOUNT_TYPE || 'practice') === 'live'
  ? 'https://api-fxtrade.oanda.com'
  : 'https://api-fxpractice.oanda.com';

export type Direction = 'LONG' | 'SHORT';
export type CorrectionStage =
  | 'CORRECTION_IN_PROGRESS'
  | 'APPROACHING_LOCATION'
  | 'AT_LOCATION'
  | 'SHIFT_30M_DETECTED'
  | 'WAITING_FOR_RETEST'
  | 'TRIGGER_5M_OBSERVED'
  | 'TREND_RESUMED'
  | 'INVALIDATED';

export interface Candle { t: string; o: number; h: number; l: number; c: number; v: number; }
interface Swing { index: number; price: number; type: 'high' | 'low'; }

export type ZoneTimeframe = 'D' | 'H4';
export type ZoneState = 'IN_ZONE' | 'APPROACHING' | 'AWAY';
export type ZoneFreshness = 'FRESH' | 'TESTED_ONCE' | 'TESTED_TWICE';
export interface HTFZone {
  type: 'DEMAND' | 'SUPPLY'; timeframe: ZoneTimeframe; low: number; high: number;
  formedAt: string; ageCandles: number; freshness: ZoneFreshness; touches: number;
  state: ZoneState; distance: number; distanceAtr: number; distancePips: number; distancePercent: number;
}

export const ZONE_RULES = {
  pivotMargin: 3,
  minimumAgeCandles: 4,
  maximumTouches: 2,
  approachingAtr: 1.5,
} as const;

export interface CorrectionCandidate {
  episodeId?: string;
  pair: string;
  thesisDirection: Direction;
  correctionDirection: Direction;
  stage: CorrectionStage;
  price: number;
  dailyStructure: Direction;
  h4Structure: Direction | null;
  h1Leg: Direction;
  thesisBasis: string[];
  location: { atLocation: boolean; approaching: boolean; labels: string[]; primaryLabel: string; zone?: HTFZone; nearestLevel?: number; distanceAtr?: number };
  confirmation30m: { shiftDetected: boolean; bosLevel?: number; retestSeen: boolean };
  invalidation: { timeframe: 'D' | 'H4'; level: number; rule: string };
  correctionQuality: { cleanCounterLeg: boolean; legAtr: number; bars: number; extended: boolean };
  priority: number;
  priorityReasons: string[];
  exposure: string[];
  scannedAt: string;
  lifecycle?: import('./correctionLifecycle.js').CorrectionLifecycle;
  /** Informational only (completed 1H candles). Never affects qualification, stage, zones or priority. */
  maturity?: CorrectionMaturity;
}

export interface CorrectionScanPayload {
  engine: 'correction_finder_v1';
  generatedAt: string;
  candidates: CorrectionCandidate[];
  otherRegimes: Array<{ pair: string; state: 'ALIGNED_TREND' | 'NO_CLEAR_THESIS' | 'INVALIDATED' | 'NO_CLEAN_CORRECTION'; reason: string }>;
  errors: Array<{ pair: string; error: string }>;
  counts: Record<CorrectionStage | 'OTHER', number>;
  /** Units/precision for every scanned instrument (display only). */
  instruments: Record<string, InstrumentMeta>;
}

function sma(candles: Candle[], period: number): number | null {
  if (candles.length < period) return null;
  return candles.slice(-period).reduce((sum, candle) => sum + candle.c, 0) / period;
}

export function atr(candles: Candle[], period = 14): number {
  const slice = candles.slice(-(period + 1));
  if (slice.length < 2) return 0;
  const values = slice.slice(1).map((candle, i) => Math.max(
    candle.h - candle.l,
    Math.abs(candle.h - slice[i].c),
    Math.abs(candle.l - slice[i].c),
  ));
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function swings(candles: Candle[], margin = 3): Swing[] {
  const result: Swing[] = [];
  for (let i = margin; i < candles.length - margin; i++) {
    const left = candles.slice(i - margin, i);
    const right = candles.slice(i + 1, i + margin + 1);
    if (left.every(c => c.h <= candles[i].h) && right.every(c => c.h <= candles[i].h)) result.push({ index: i, price: candles[i].h, type: 'high' });
    else if (left.every(c => c.l >= candles[i].l) && right.every(c => c.l >= candles[i].l)) result.push({ index: i, price: candles[i].l, type: 'low' });
  }
  return result;
}

export function structure(candles: Candle[]): Direction | null {
  const pivots = swings(candles, 3);
  const highs = pivots.filter(s => s.type === 'high').slice(-3);
  const lows = pivots.filter(s => s.type === 'low').slice(-3);
  if (highs.length < 2 || lows.length < 2) return null;
  const risingHighs = highs.at(-1)!.price > highs.at(-2)!.price;
  const risingLows = lows.at(-1)!.price > lows.at(-2)!.price;
  const fallingHighs = highs.at(-1)!.price < highs.at(-2)!.price;
  const fallingLows = lows.at(-1)!.price < lows.at(-2)!.price;
  if (risingHighs && risingLows) return 'LONG';
  if (fallingHighs && fallingLows) return 'SHORT';
  return null;
}

export function currentLeg(candles: Candle[]): Direction | null {
  const structured = structure(candles.slice(-100));
  if (structured) return structured;
  if (candles.length < 8) return null;
  const recent = candles.slice(-4).reduce((sum, candle) => sum + candle.c, 0) / 4;
  const prior = candles.slice(-8, -4).reduce((sum, candle) => sum + candle.c, 0) / 4;
  const movement = recent - prior;
  const threshold = atr(candles) * 0.35;
  return movement > threshold ? 'LONG' : movement < -threshold ? 'SHORT' : null;
}

function latestStructuralLevel(candles: Candle[], direction: Direction): number | null {
  const wanted = direction === 'LONG' ? 'low' : 'high';
  return swings(candles, 3).filter(s => s.type === wanted).at(-1)?.price ?? null;
}

function detectShift(candles: Candle[], thesis: Direction): { shiftDetected: boolean; bosLevel?: number; retestSeen: boolean } {
  const pivots = swings(candles, 2);
  const wanted = thesis === 'LONG' ? 'high' : 'low';
  const candidates = pivots.filter(s => s.type === wanted && s.index < candles.length - 2);
  const pivot = candidates.at(-1);
  if (!pivot) return { shiftDetected: false, retestSeen: false };
  const breakIndex = candles.findIndex((c, index) => index > pivot.index && (thesis === 'LONG' ? c.c > pivot.price : c.c < pivot.price));
  if (breakIndex < 0) return { shiftDetected: false, retestSeen: false };
  const tolerance = atr(candles) * 0.25;
  const retestSeen = candles.slice(breakIndex + 1).some(c => thesis === 'LONG'
    ? c.l <= pivot.price + tolerance && c.c >= pivot.price - tolerance
    : c.h >= pivot.price - tolerance && c.c <= pivot.price + tolerance);
  return { shiftDetected: true, bosLevel: pivot.price, retestSeen };
}

function currencies(pair: string): string[] {
  return pair.split('_').filter(code => code.length === 3);
}

// ── Instrument universe + units ─────────────────────────────────────────────
// The correction finder owns its universe, independent of the legacy setup
// scanner's instrument list. FX is unchanged. Metals and indices use OANDA
// price data (not tradeable on the configured OANDA accounts -- data only);
// detection rules are ATR/structure-relative and are applied unchanged, never
// tuned per asset class.
export type AssetClass = 'FX' | 'METAL' | 'INDEX';
export interface InstrumentMeta {
  assetClass: AssetClass;
  /** Unit of every *Pips distance field: pips for FX, US$ for metals, index points for indices. */
  distanceUnit: 'pips' | 'usd' | 'points';
  unitSize: number;
  distanceDecimals: number;
  displayPrecision: number;
  exposureTag?: string;
}

export const FX_CORRECTION_PAIRS = [
  'EUR_USD', 'GBP_USD', 'USD_JPY', 'USD_CAD', 'USD_CHF',
  'AUD_USD', 'NZD_USD',
  'EUR_JPY', 'GBP_JPY', 'AUD_JPY', 'NZD_JPY', 'CAD_JPY',
  'EUR_GBP', 'EUR_AUD',
] as const;

const NON_FX_INSTRUMENTS: Record<string, InstrumentMeta> = {
  XAU_USD: { assetClass: 'METAL', distanceUnit: 'usd', unitSize: 1, distanceDecimals: 2, displayPrecision: 3, exposureTag: 'METALS' },
  XAG_USD: { assetClass: 'METAL', distanceUnit: 'usd', unitSize: 1, distanceDecimals: 3, displayPrecision: 5, exposureTag: 'METALS' },
  US30_USD: { assetClass: 'INDEX', distanceUnit: 'points', unitSize: 1, distanceDecimals: 1, displayPrecision: 1, exposureTag: 'US_INDICES' },
  NAS100_USD: { assetClass: 'INDEX', distanceUnit: 'points', unitSize: 1, distanceDecimals: 1, displayPrecision: 1, exposureTag: 'US_INDICES' },
};

export const CORRECTION_INSTRUMENTS: string[] = [...FX_CORRECTION_PAIRS, ...Object.keys(NON_FX_INSTRUMENTS)];

export function instrumentMeta(pair: string): InstrumentMeta {
  const known = NON_FX_INSTRUMENTS[pair];
  if (known) return known;
  const jpy = pair.includes('JPY');
  return { assetClass: 'FX', distanceUnit: 'pips', unitSize: jpy ? 0.01 : 0.0001, distanceDecimals: 1, displayPrecision: jpy ? 3 : 5 };
}

/** Distance in the instrument's unit (FX: pips to 0.1, exactly as before). */
function unitDistance(pair: string, distance: number): number {
  const meta = instrumentMeta(pair);
  return Number((distance / meta.unitSize).toFixed(meta.distanceDecimals));
}

function exposureFor(pair: string): string[] {
  const tag = instrumentMeta(pair).exposureTag;
  return tag ? [...currencies(pair), tag] : currencies(pair);
}

// ── Correction maturity (informational context only) ───────────────────────
export type CorrectionDepth = 'SHALLOW' | 'DEVELOPING' | 'DEEP';

export interface CorrectionMaturity {
  correctionStartTime: string | null;
  correctionAgeBars: number | null;
  correctionStartPrice: number | null;
  correctionEndPrice: number | null;
  correctionDistancePrice: number | null;
  correctionDistancePips: number | null;
  correctionDistancePercent: number | null;
  priorImpulseStartTime: string | null;
  priorImpulseEndTime: string | null;
  priorImpulseStartPrice: number | null;
  priorImpulseEndPrice: number | null;
  priorImpulseDistance: number | null;
  retracementPercent: number | null;
  correctionDepth: CorrectionDepth | null;
  crossedEquilibrium: boolean | null;
}

/** Descriptive thresholds only -- never used to qualify, exclude, rank or sort. */
export const MATURITY_RULES = { pivotMargin: 3, shallowBelow: 33, deepFrom: 66, equilibrium: 50 } as const;

export function classifyCorrectionDepth(retracementPercent: number | null): CorrectionDepth | null {
  if (retracementPercent == null || !Number.isFinite(retracementPercent)) return null;
  if (retracementPercent < MATURITY_RULES.shallowBelow) return 'SHALLOW';
  if (retracementPercent < MATURITY_RULES.deepFrom) return 'DEVELOPING';
  return 'DEEP';
}

function emptyMaturity(): CorrectionMaturity {
  return {
    correctionStartTime: null, correctionAgeBars: null, correctionStartPrice: null, correctionEndPrice: null,
    correctionDistancePrice: null, correctionDistancePips: null, correctionDistancePercent: null,
    priorImpulseStartTime: null, priorImpulseEndTime: null, priorImpulseStartPrice: null, priorImpulseEndPrice: null,
    priorImpulseDistance: null, retracementPercent: null, correctionDepth: null, crossedEquilibrium: null,
  };
}

/**
 * Age and depth of the active 1H counter-leg, from COMPLETED 1H candles only
 * (a candle flagged complete === false is dropped; live price is never used).
 * Reuses the scanner's own swings() pivots.
 *
 * Correction start (bullish Daily thesis -> bearish correction; mirrored for
 * bearish): walk back from the most recent confirmed 1H swing high through the
 * active lower-high sequence to the swing high that began it -- the pivot whose
 * preceding swing high is lower. It must not have been exceeded by any later
 * completed candle. If the sequence runs back to the first swing in the
 * available history, the start is not identifiable and every field is null.
 *
 * Age: the start pivot is bar 0; the first completed 1H candle after it is bar 1.
 * Correction end: the most extreme completed low (bearish) / high (bullish)
 * after the start pivot.
 *
 * Prior impulse: the thesis-direction structural leg ending at the start pivot,
 * found the same way -- walk back through its higher-low (bullish impulse) /
 * lower-high (bearish impulse) sequence of confirmed swings before the start
 * pivot to the swing that began it. If that sequence runs back to the first
 * swing in the available history, the impulse is not identifiable: impulse and
 * retracement fields stay null while start/age/distance are kept.
 */
export function computeCorrectionMaturity(pair: string, h1: Candle[], thesis: Direction): CorrectionMaturity {
  const out = emptyMaturity();
  const completed = h1.filter(candle => (candle as Candle & { complete?: boolean }).complete !== false);
  const bearishCorrection = thesis === 'LONG';
  const pivots = swings(completed, MATURITY_RULES.pivotMargin);
  // "a is beyond b" in the thesis direction: higher for swing highs, lower for swing lows.
  const beyond = (a: number, b: number) => bearishCorrection ? a > b : a < b;
  const origins = pivots.filter(pivot => pivot.type === (bearishCorrection ? 'high' : 'low'));
  if (!origins.length) return out;
  let k = origins.length - 1;
  while (k > 0 && beyond(origins[k - 1].price, origins[k].price)) k--;
  if (k === 0) return out;
  const origin = origins[k];
  const after = completed.slice(origin.index + 1);
  if (!after.length) return out;
  if (after.some(candle => beyond(bearishCorrection ? candle.h : candle.l, origin.price))) return out;

  const startPrice = origin.price;
  const endPrice = bearishCorrection ? Math.min(...after.map(candle => candle.l)) : Math.max(...after.map(candle => candle.h));
  const distance = Math.abs(endPrice - startPrice);
  out.correctionStartTime = completed[origin.index].t;
  out.correctionAgeBars = after.length;
  out.correctionStartPrice = startPrice;
  out.correctionEndPrice = endPrice;
  out.correctionDistancePrice = Number(distance.toFixed(6));
  out.correctionDistancePips = unitDistance(pair, distance);
  out.correctionDistancePercent = Number((distance / Math.max(Math.abs(startPrice), Number.EPSILON) * 100).toFixed(3));

  const opposite = pivots.filter(pivot => pivot.type === (bearishCorrection ? 'low' : 'high') && pivot.index < origin.index);
  // "a is deeper than b" against the thesis: lower for swing lows, higher for swing highs.
  const deeper = (a: number, b: number) => bearishCorrection ? a < b : a > b;
  let j = opposite.length - 1;
  while (j > 0 && deeper(opposite[j - 1].price, opposite[j].price)) j--;
  if (j <= 0) return out;
  const impulseStart = opposite[j];
  const impulseDistance = Math.abs(startPrice - impulseStart.price);
  if (!(impulseDistance > 0) || !beyond(startPrice, impulseStart.price)) return out;
  const retracement = distance / impulseDistance * 100;
  out.priorImpulseStartTime = completed[impulseStart.index].t;
  out.priorImpulseEndTime = completed[origin.index].t;
  out.priorImpulseStartPrice = impulseStart.price;
  out.priorImpulseEndPrice = startPrice;
  out.priorImpulseDistance = Number(impulseDistance.toFixed(6));
  out.retracementPercent = Number(retracement.toFixed(2));
  out.correctionDepth = classifyCorrectionDepth(retracement);
  out.crossedEquilibrium = retracement >= MATURITY_RULES.equilibrium;
  return out;
}

/**
 * Auditable HTF zones: the wick-to-body range of a confirmed swing candle.
 * A zone must be at least four completed candles old, is retired after three
 * later overlaps, and is invalid only after a completed close beyond its wick.
 */
export function modelHTFZones(input: {
  pair: string; daily: Candle[]; h4: Candle[]; thesis: Direction; livePrice: number; referenceAtr: number;
}): HTFZone[] {
  const wanted = input.thesis === 'LONG' ? 'low' : 'high';
  const type = input.thesis === 'LONG' ? 'DEMAND' : 'SUPPLY';
  const zones: HTFZone[] = [];
  const add = (candles: Candle[], timeframe: ZoneTimeframe) => {
    for (const pivot of swings(candles, ZONE_RULES.pivotMargin).filter(item => item.type === wanted)) {
      const ageCandles = candles.length - 1 - pivot.index;
      if (ageCandles < ZONE_RULES.minimumAgeCandles) continue;
      const source = candles[pivot.index];
      const low = type === 'DEMAND' ? source.l : Math.min(source.o, source.c);
      const high = type === 'DEMAND' ? Math.max(source.o, source.c) : source.h;
      const later = candles.slice(pivot.index + 1);
      const invalid = later.some(candle => type === 'DEMAND' ? candle.c < low : candle.c > high);
      if (invalid) continue;
      const touches = later.filter(candle => candle.l <= high && candle.h >= low).length;
      if (touches > ZONE_RULES.maximumTouches) continue;
      const inZone = input.livePrice >= low && input.livePrice <= high;
      const distance = inZone ? 0 : type === 'DEMAND' ? Math.max(0, input.livePrice - high) : Math.max(0, low - input.livePrice);
      // A relevant demand zone is below price; relevant supply is above price. A
      // live excursion beyond the distal edge does not rewrite completed structure.
      if (!inZone && (type === 'DEMAND' ? input.livePrice < low : input.livePrice > high)) continue;
      const distanceAtr = input.referenceAtr ? distance / input.referenceAtr : Infinity;
      zones.push({
        type, timeframe, low, high, formedAt: source.t, ageCandles,
        freshness: touches === 0 ? 'FRESH' : touches === 1 ? 'TESTED_ONCE' : 'TESTED_TWICE', touches,
        state: inZone ? 'IN_ZONE' : distanceAtr <= ZONE_RULES.approachingAtr ? 'APPROACHING' : 'AWAY',
        distance, distanceAtr: Number(distanceAtr.toFixed(2)), distancePips: unitDistance(input.pair, distance),
        distancePercent: Number((distance / Math.max(input.livePrice, Number.EPSILON) * 100).toFixed(3)),
      });
    }
  };
  add(input.daily, 'D');
  add(input.h4, 'H4');
  return zones.sort((a, b) => a.distance - b.distance || (a.timeframe === 'D' ? -1 : 1) || a.ageCandles - b.ageCandles);
}

export function analyzeCorrection(input: {
  pair: string; daily: Candle[]; h4: Candle[]; h1: Candle[]; m30: Candle[]; livePrice?: number;
}): { candidate?: CorrectionCandidate; other?: CorrectionScanPayload['otherRegimes'][number] } {
  const { pair, daily, h4, h1, m30 } = input;
  if (daily.length < 200 || h4.length < 80 || h1.length < 40 || m30.length < 30) {
    return { other: { pair, state: 'NO_CLEAR_THESIS', reason: 'Insufficient completed candles for Daily/4H/1H/30M analysis.' } };
  }
  const dailyDirection = structure(daily.slice(-140));
  if (!dailyDirection) return { other: { pair, state: 'NO_CLEAR_THESIS', reason: 'Daily swing structure is mixed or ranging.' } };

  const price = input.livePrice ?? h1.at(-1)!.c;
  const daily200 = sma(daily, 200)!;
  const smaSupports = dailyDirection === 'LONG' ? price >= daily200 : price <= daily200;
  const invalidationLevel = latestStructuralLevel(daily.slice(-140), dailyDirection);
  if (invalidationLevel == null) return { other: { pair, state: 'NO_CLEAR_THESIS', reason: 'Daily structure has no confirmed invalidation swing.' } };
  const lastDailyClose = daily.at(-1)!.c;
  const invalidated = dailyDirection === 'LONG' ? lastDailyClose < invalidationLevel : lastDailyClose > invalidationLevel;
  if (invalidated) return { other: { pair, state: 'INVALIDATED', reason: 'A completed Daily structural candle closed beyond thesis invalidation.' } };

  const h4Direction = structure(h4.slice(-120));
  const leg = currentLeg(h1);
  const correctionDirection: Direction = dailyDirection === 'LONG' ? 'SHORT' : 'LONG';
  if (leg !== correctionDirection) {
    const state = leg === dailyDirection || h4Direction === dailyDirection ? 'ALIGNED_TREND' : 'NO_CLEAN_CORRECTION';
    return { other: { pair, state, reason: leg ? 'The active 1H leg is not moving against the Daily thesis.' : 'The 1H leg has no clean directional structure.' } };
  }

  const h1Atr = atr(h1);
  if (!h1Atr) return { other: { pair, state: 'NO_CLEAN_CORRECTION', reason: '1H volatility is unavailable.' } };
  const recent = h1.slice(-24);
  const start = recent[0].c;
  const legDistance = Math.abs(price - start) / h1Atr;
  const cleanCounterLeg = recent.slice(-8).filter(c => correctionDirection === 'LONG' ? c.c > c.o : c.c < c.o).length >= 4;

  const dailyWindow = daily.slice(-140);
  const h4Window = h4.slice(-120);
  const dailyPivots = swings(dailyWindow, 3);
  const h4Pivots = swings(h4Window, 3);
  const locationLevels = [...dailyPivots, ...h4Pivots]
    .filter(s => dailyDirection === 'LONG' ? s.type === 'low' && s.price <= price : s.type === 'high' && s.price >= price)
    .map(s => s.price);
  const nearestLevel = locationLevels.sort((a, b) => Math.abs(price - a) - Math.abs(price - b))[0];
  const distanceAtr = nearestLevel == null ? undefined : Math.abs(price - nearestLevel) / h1Atr;
  const supportingLabels: string[] = [];
  if (distanceAtr != null && distanceAtr <= 0.75) supportingLabels.push('HTF support/resistance');
  const smaDistance = Math.abs(price - daily200) / h1Atr;
  if (smaDistance <= 1.25) supportingLabels.push('Daily 200 SMA context');
  const range = daily.slice(-60);
  const rangeHigh = Math.max(...range.map(c => c.h));
  const rangeLow = Math.min(...range.map(c => c.l));
  const rangePosition = (price - rangeLow) / Math.max(rangeHigh - rangeLow, Number.EPSILON);
  if (dailyDirection === 'LONG' && rangePosition <= 0.5) supportingLabels.push('HTF discount');
  if (dailyDirection === 'SHORT' && rangePosition >= 0.5) supportingLabels.push('HTF premium');
  const zone = modelHTFZones({ pair, daily: dailyWindow, h4: h4Window, thesis: dailyDirection, livePrice: price, referenceAtr: h1Atr })[0];
  const fallbackAtLocation = supportingLabels.length > 0 && (distanceAtr == null || distanceAtr <= 0.75 || smaDistance <= 0.75);
  const fallbackApproaching = !fallbackAtLocation && (distanceAtr != null && distanceAtr <= 1.5 || smaDistance <= 1.5);
  const atLocation = zone ? zone.state === 'IN_ZONE' : fallbackAtLocation;
  const approaching = zone ? zone.state === 'APPROACHING' : fallbackApproaching;
  const primaryLabel = zone
    ? `${zone.timeframe === 'D' ? 'Daily' : '4H'} ${zone.type.toLowerCase()} ${zone.state === 'IN_ZONE' ? 'zone' : zone.state === 'APPROACHING' ? 'approaching' : 'away'}`
    : supportingLabels[0] || 'No named HTF location yet';
  const labels = zone ? [primaryLabel, ...supportingLabels] : supportingLabels;

  const confirmation30m = detectShift(m30, dailyDirection);
  const extended = legDistance > 6 || (dailyDirection === 'LONG' ? price <= invalidationLevel + h1Atr * 0.35 : price >= invalidationLevel - h1Atr * 0.35);
  let stage: CorrectionStage = 'CORRECTION_IN_PROGRESS';
  if (approaching) stage = 'APPROACHING_LOCATION';
  if (atLocation) stage = 'AT_LOCATION';

  const priorityReasons: string[] = ['Clear Daily swing thesis'];
  let priority = 40;
  if (smaSupports) { priority += 10; priorityReasons.push('Price agrees with Daily 200 SMA context'); }
  if (h4Direction === dailyDirection) { priority += 10; priorityReasons.push('4H thesis remains aligned'); }
  else if (h4Direction === correctionDirection) { priority += 8; priorityReasons.push('4H is visibly correcting inside Daily thesis'); }
  if (cleanCounterLeg) { priority += 15; priorityReasons.push('Clean 1H counter-leg'); }
  if (atLocation) { priority += 20; priorityReasons.push(`At ${primaryLabel}`); }
  else if (approaching) { priority += 10; priorityReasons.push('Approaching meaningful location'); }
  if (extended) { priority -= 25; priorityReasons.push('Correction is near invalidation or already extended'); }
  if (confirmation30m.shiftDetected) priorityReasons.push('30M shift is informational; it did not gate discovery');

  return { candidate: {
    pair, thesisDirection: dailyDirection, correctionDirection, stage, price,
    dailyStructure: dailyDirection, h4Structure: h4Direction, h1Leg: leg,
    thesisBasis: [`Daily ${dailyDirection === 'LONG' ? 'bullish' : 'bearish'} swing structure`, `Daily close remains inside ${invalidationLevel.toFixed(5)} invalidation`, `Price ${smaSupports ? 'supports' : 'does not support'} 200 SMA context`],
    location: { atLocation, approaching, labels, primaryLabel, zone, nearestLevel, distanceAtr },
    confirmation30m,
    invalidation: { timeframe: 'D', level: invalidationLevel, rule: `Thesis dies only if a completed Daily structural candle closes ${dailyDirection === 'LONG' ? 'below' : 'above'} this level.` },
    correctionQuality: { cleanCounterLeg, legAtr: Number(legDistance.toFixed(2)), bars: 24, extended },
    priority: Math.max(0, priority), priorityReasons,
    exposure: exposureFor(pair), scannedAt: new Date().toISOString(),
    maturity: computeCorrectionMaturity(pair, h1, dailyDirection),
  } };
}

async function fetchTimeframe(pair: string, granularity: string, count: number): Promise<{ completed: Candle[]; livePrice: number }> {
  const url = `${OANDA_BASE}/v3/instruments/${pair}/candles?granularity=${granularity}&count=${count}&price=M`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${OANDA_API_KEY}` } });
  if (!response.ok) throw new Error(`OANDA ${granularity}: ${response.status}`);
  const data = await response.json() as any;
  const mapped = data.candles.map((c: any) => ({ t: c.time, o: +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c, v: c.volume, complete: c.complete }));
  return { completed: mapped.filter((c: any) => c.complete), livePrice: mapped.at(-1).c };
}

export async function scanCorrections(): Promise<CorrectionScanPayload> {
  if (!OANDA_API_KEY || OANDA_API_KEY === 'your_oanda_api_key_here') throw new Error('OANDA_API_KEY is not configured.');
  const candidates: CorrectionCandidate[] = [];
  const otherRegimes: CorrectionScanPayload['otherRegimes'] = [];
  const errors: CorrectionScanPayload['errors'] = [];
  const market = new Map<string, import('./correctionLifecycle.js').LifecycleMarketData>();
  // Keep request pressure modest: four instruments at a time, with four TFs per instrument.
  for (let offset = 0; offset < CORRECTION_INSTRUMENTS.length; offset += 4) {
    await Promise.all(CORRECTION_INSTRUMENTS.slice(offset, offset + 4).map(async pair => {
      try {
        const [daily, h4, h1, m30, m5] = await Promise.all([
          fetchTimeframe(pair, 'D', 260), fetchTimeframe(pair, 'H4', 220),
          fetchTimeframe(pair, 'H1', 180), fetchTimeframe(pair, 'M30', 180), fetchTimeframe(pair, 'M5', 240),
        ]);
        market.set(pair, { daily: daily.completed, h1: h1.completed, m30: m30.completed, m5: m5.completed });
        const result = analyzeCorrection({ pair, daily: daily.completed, h4: h4.completed, h1: h1.completed, m30: m30.completed, livePrice: h1.livePrice });
        if (result.candidate) candidates.push(result.candidate);
        if (result.other) otherRegimes.push(result.other);
      } catch (error: any) { errors.push({ pair, error: error.message }); }
    }));
  }
  candidates.sort((a, b) => b.priority - a.priority || Number(a.correctionQuality.extended) - Number(b.correctionQuality.extended));
  const { correctionLifecycleStore } = await import('./correctionLifecycle.js');
  await correctionLifecycleStore.reconcile(candidates, market, new Set(otherRegimes.filter(r => r.state === 'INVALIDATED').map(r => r.pair)));
  const { correctionValidationStore } = await import('./correctionValidations.js');
  await correctionValidationStore.syncLifecycle(candidates);
  const counts = { CORRECTION_IN_PROGRESS: 0, APPROACHING_LOCATION: 0, AT_LOCATION: 0, SHIFT_30M_DETECTED: 0, WAITING_FOR_RETEST: 0, TRIGGER_5M_OBSERVED: 0, TREND_RESUMED: 0, INVALIDATED: 0, OTHER: otherRegimes.length } as CorrectionScanPayload['counts'];
  for (const candidate of candidates) counts[candidate.stage]++;
  const instruments = Object.fromEntries(CORRECTION_INSTRUMENTS.map(pair => [pair, instrumentMeta(pair)]));
  return { engine: 'correction_finder_v1', generatedAt: new Date().toISOString(), candidates, otherRegimes, errors, counts, instruments };
}
