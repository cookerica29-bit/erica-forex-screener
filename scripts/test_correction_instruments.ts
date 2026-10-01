import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  analyzeCorrection, Candle, computeCorrectionMaturity, CORRECTION_INSTRUMENTS, FX_CORRECTION_PAIRS,
  instrumentMeta, modelHTFZones,
} from '../server/corrections.js';

// Metals + indices in the correction universe. Detection is untouched: FX
// output must be byte-identical to commit e109dfe, and the new instruments run
// through the same ATR/structure-relative rules with their own units.

// ── deterministic fixtures ──────────────────────────────────────────────────
// Existing-suite style waves (same as scripts/test_corrections.ts).
function wave(count: number, start: number, slope: number, amplitude = 2, period = 12): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = start + slope * index + Math.sin(index * Math.PI * 2 / period) * amplitude;
    const open = close - slope * .2;
    return { t: new Date(Date.UTC(2025, 0, 1, index)).toISOString(), o: open, h: Math.max(open, close) + .35, l: Math.min(open, close) - .35, c: close, v: 100 };
  });
}
function fixture(dailySlope: number, h4Slope: number, h1Slope: number) {
  const daily = wave(240, 100, dailySlope, 2.5);
  const current = daily.at(-1)!.c;
  const h4 = wave(160, current - h4Slope * 159, h4Slope, 1.3);
  const h1 = wave(120, current - h1Slope * 119, h1Slope, .65);
  const m30 = wave(100, current + 2, h1Slope, .4);
  return { daily, h4, h1, m30, livePrice: h1.at(-1)!.c };
}
// Piecewise-linear 1H path through exact pivot nodes; doji candles (o=h=l=c)
// so every swing extreme is exactly the node price.
function path(nodes: Array<[number, number]>): Candle[] {
  const out: Candle[] = [];
  for (let n = 0; n < nodes.length - 1; n++) {
    const [i0, p0] = nodes[n]; const [i1, p1] = nodes[n + 1];
    for (let i = i0; i < i1; i++) {
      const price = i === i0 ? p0 : p0 + (p1 - p0) * (i - i0) / (i1 - i0);
      out.push({ t: new Date(Date.UTC(2025, 5, 1, i)).toISOString(), o: price, h: price, l: price, c: price, v: 100 });
    }
  }
  const [last, lastPrice] = nodes.at(-1)!;
  out.push({ t: new Date(Date.UTC(2025, 5, 1, last)).toISOString(), o: lastPrice, h: lastPrice, l: lastPrice, c: lastPrice, v: 100 });
  return out;
}
const mirror = (candles: Candle[], axis: number): Candle[] => candles.map(c => ({ ...c, o: axis - c.o, h: axis - c.l, l: axis - c.h, c: axis - c.c }));
// Surfaced-candidate fixtures: Daily thesis from fixture(); 1H path with a
// complete bullish leg (turn low b-6 after an earlier higher low) up to the
// b+4 peak, then a confirmed counter-structure (lower low + lower high).
function structuredBullish() {
  const base = fixture(.08, .025, -.035);
  const b = Math.round(base.daily.at(-1)!.c);
  const h1 = path([[0, b - 3], [8, b - 4.5], [16, b - 3.5], [26, b - 6], [38, b - 2], [48, b - 5], [62, b + 4], [74, b - 6.5], [84, b - 1], [94, b - 3]]);
  return { ...base, h1, livePrice: h1.at(-1)!.c, b };
}
function structuredBearish() {
  const base = fixture(-.08, -.025, .035);
  const b = Math.round(base.daily.at(-1)!.c);
  const h1 = mirror(path([[0, b - 3], [8, b - 4.5], [16, b - 3.5], [26, b - 6], [38, b - 2], [48, b - 5], [62, b + 4], [74, b - 6.5], [84, b - 1], [94, b - 3]]), 2 * b);
  return { ...base, h1, livePrice: h1.at(-1)!.c, b };
}
const SNAPSHOT_CASES = (): Record<string, [string, any]> => ({
  bull: ['EUR_USD', fixture(.08, .025, -.035)],
  bear: ['GBP_USD', fixture(-.08, -.025, .035)],
  aligned: ['USD_JPY', fixture(.08, .025, .035)],
  ranging: ['EUR_GBP', fixture(0, 0, -.02)],
  structuredBullish: ['EUR_USD', structuredBullish()],
  structuredBearish: ['GBP_USD', structuredBearish()],
});
const stripVolatile = (result: any) => {
  if (!result.candidate) return result;
  const { scannedAt, maturity, ...rest } = result.candidate;
  return { candidate: rest };
};

// e109dfe's full analyzeCorrection output for SNAPSHOT_CASES (only scannedAt removed).
const BASE_E109DFE = {
 "bull": {
  "candidate": {
   "pair": "EUR_USD",
   "thesisDirection": "LONG",
   "correctionDirection": "SHORT",
   "stage": "CORRECTION_IN_PROGRESS",
   "price": 117.54499999999999,
   "dailyStructure": "LONG",
   "h4Structure": "LONG",
   "h1Leg": "SHORT",
   "thesisBasis": [
    "Daily bullish swing structure",
    "Daily close remains inside 115.13400 invalidation",
    "Price supports 200 SMA context"
   ],
   "location": {
    "atLocation": false,
    "approaching": false,
    "labels": [
     "4H demand away"
    ],
    "primaryLabel": "4H demand away",
    "zone": {
     "type": "DEMAND",
     "timeframe": "H4",
     "low": 116.06500000000001,
     "high": 116.42,
     "formedAt": "2025-01-07T09:00:00.000Z",
     "ageCandles": 6,
     "freshness": "TESTED_ONCE",
     "touches": 1,
     "state": "AWAY",
     "distance": 1.1249999999999858,
     "distanceAtr": 1.59,
     "distancePips": 11250,
     "distancePercent": 0.957
    },
    "nearestLevel": 116.06500000000001,
    "distanceAtr": 2.092084006462017
   },
   "confirmation30m": {
    "shiftDetected": false,
    "retestSeen": false
   },
   "invalidation": {
    "timeframe": "D",
    "level": 115.134,
    "rule": "Thesis dies only if a completed Daily structural candle closes below this level."
   },
   "correctionQuality": {
    "cleanCounterLeg": true,
    "legAtr": 1.6,
    "bars": 24,
    "extended": false
   },
   "priority": 75,
   "priorityReasons": [
    "Clear Daily swing thesis",
    "Price agrees with Daily 200 SMA context",
    "4H thesis remains aligned",
    "Clean 1H counter-leg"
   ],
   "exposure": [
    "EUR",
    "USD"
   ],
   "maturity": {
    "correctionStartTime": null,
    "correctionAgeBars": null,
    "correctionStartPrice": null,
    "correctionEndPrice": null,
    "correctionDistancePrice": null,
    "correctionDistancePips": null,
    "correctionDistancePercent": null,
    "priorImpulseStartTime": null,
    "priorImpulseEndTime": null,
    "priorImpulseStartPrice": null,
    "priorImpulseEndPrice": null,
    "priorImpulseDistance": null,
    "retracementPercent": null,
    "correctionDepth": null,
    "crossedEquilibrium": null
   }
  }
 },
 "bear": {
  "candidate": {
   "pair": "GBP_USD",
   "thesisDirection": "SHORT",
   "correctionDirection": "LONG",
   "stage": "CORRECTION_IN_PROGRESS",
   "price": 79.30499999999998,
   "dailyStructure": "SHORT",
   "h4Structure": "SHORT",
   "h1Leg": "LONG",
   "thesisBasis": [
    "Daily bearish swing structure",
    "Daily close remains inside 84.38600 invalidation",
    "Price supports 200 SMA context"
   ],
   "location": {
    "atLocation": false,
    "approaching": false,
    "labels": [
     "4H supply away"
    ],
    "primaryLabel": "4H supply away",
    "zone": {
     "type": "SUPPLY",
     "timeframe": "H4",
     "low": 81.22999999999998,
     "high": 81.58499999999997,
     "formedAt": "2025-01-07T03:00:00.000Z",
     "ageCandles": 12,
     "freshness": "TESTED_TWICE",
     "touches": 2,
     "state": "AWAY",
     "distance": 1.9249999999999972,
     "distanceAtr": 2.72,
     "distancePips": 19250,
     "distancePercent": 2.427
    },
    "nearestLevel": 81.58499999999997,
    "distanceAtr": 3.2229402261712545
   },
   "confirmation30m": {
    "shiftDetected": false,
    "retestSeen": false
   },
   "invalidation": {
    "timeframe": "D",
    "level": 84.386,
    "rule": "Thesis dies only if a completed Daily structural candle closes above this level."
   },
   "correctionQuality": {
    "cleanCounterLeg": true,
    "legAtr": 0.68,
    "bars": 24,
    "extended": false
   },
   "priority": 75,
   "priorityReasons": [
    "Clear Daily swing thesis",
    "Price agrees with Daily 200 SMA context",
    "4H thesis remains aligned",
    "Clean 1H counter-leg"
   ],
   "exposure": [
    "GBP",
    "USD"
   ],
   "maturity": {
    "correctionStartTime": null,
    "correctionAgeBars": null,
    "correctionStartPrice": null,
    "correctionEndPrice": null,
    "correctionDistancePrice": null,
    "correctionDistancePips": null,
    "correctionDistancePercent": null,
    "priorImpulseStartTime": null,
    "priorImpulseEndTime": null,
    "priorImpulseStartPrice": null,
    "priorImpulseEndPrice": null,
    "priorImpulseDistance": null,
    "retracementPercent": null,
    "correctionDepth": null,
    "crossedEquilibrium": null
   }
  }
 },
 "aligned": {
  "other": {
   "pair": "USD_JPY",
   "state": "ALIGNED_TREND",
   "reason": "The active 1H leg is not moving against the Daily thesis."
  }
 },
 "ranging": {
  "other": {
   "pair": "EUR_GBP",
   "state": "NO_CLEAR_THESIS",
   "reason": "Daily swing structure is mixed or ranging."
  }
 },
 "structuredBullish": {
  "candidate": {
   "pair": "EUR_USD",
   "thesisDirection": "LONG",
   "correctionDirection": "SHORT",
   "stage": "AT_LOCATION",
   "price": 115,
   "dailyStructure": "LONG",
   "h4Structure": "LONG",
   "h1Leg": "SHORT",
   "thesisBasis": [
    "Daily bullish swing structure",
    "Daily close remains inside 115.13400 invalidation",
    "Price supports 200 SMA context"
   ],
   "location": {
    "atLocation": true,
    "approaching": false,
    "labels": [
     "4H demand zone",
     "HTF support/resistance",
     "HTF discount"
    ],
    "primaryLabel": "4H demand zone",
    "zone": {
     "type": "DEMAND",
     "timeframe": "H4",
     "low": 114.86500000000001,
     "high": 115.22,
     "formedAt": "2025-01-05T09:00:00.000Z",
     "ageCandles": 54,
     "freshness": "TESTED_TWICE",
     "touches": 2,
     "state": "IN_ZONE",
     "distance": 0,
     "distanceAtr": 0,
     "distancePips": 0,
     "distancePercent": 0
    },
    "nearestLevel": 114.86500000000001,
    "distanceAtr": 0.44999999999996937
   },
   "confirmation30m": {
    "shiftDetected": false,
    "retestSeen": false
   },
   "invalidation": {
    "timeframe": "D",
    "level": 115.134,
    "rule": "Thesis dies only if a completed Daily structural candle closes below this level."
   },
   "correctionQuality": {
    "cleanCounterLeg": false,
    "legAtr": 2.92,
    "bars": 24,
    "extended": true
   },
   "priority": 55,
   "priorityReasons": [
    "Clear Daily swing thesis",
    "Price agrees with Daily 200 SMA context",
    "4H thesis remains aligned",
    "At 4H demand zone",
    "Correction is near invalidation or already extended"
   ],
   "exposure": [
    "EUR",
    "USD"
   ],
   "maturity": {
    "correctionStartTime": "2025-06-03T14:00:00.000Z",
    "correctionAgeBars": 32,
    "correctionStartPrice": 122,
    "correctionEndPrice": 111.5,
    "correctionDistancePrice": 10.5,
    "correctionDistancePips": 105000,
    "correctionDistancePercent": 8.607,
    "priorImpulseStartTime": "2025-06-02T02:00:00.000Z",
    "priorImpulseEndTime": "2025-06-03T14:00:00.000Z",
    "priorImpulseStartPrice": 112,
    "priorImpulseEndPrice": 122,
    "priorImpulseDistance": 10,
    "retracementPercent": 105,
    "correctionDepth": "DEEP",
    "crossedEquilibrium": true
   }
  }
 },
 "structuredBearish": {
  "candidate": {
   "pair": "GBP_USD",
   "thesisDirection": "SHORT",
   "correctionDirection": "LONG",
   "stage": "AT_LOCATION",
   "price": 83,
   "dailyStructure": "SHORT",
   "h4Structure": "SHORT",
   "h1Leg": "LONG",
   "thesisBasis": [
    "Daily bearish swing structure",
    "Daily close remains inside 84.38600 invalidation",
    "Price supports 200 SMA context"
   ],
   "location": {
    "atLocation": true,
    "approaching": false,
    "labels": [
     "4H supply zone",
     "HTF support/resistance"
    ],
    "primaryLabel": "4H supply zone",
    "zone": {
     "type": "SUPPLY",
     "timeframe": "H4",
     "low": 82.72999999999998,
     "high": 83.08499999999997,
     "formedAt": "2025-01-04T15:00:00.000Z",
     "ageCandles": 72,
     "freshness": "TESTED_TWICE",
     "touches": 2,
     "state": "IN_ZONE",
     "distance": 0,
     "distanceAtr": 0,
     "distancePips": 0,
     "distancePercent": 0
    },
    "nearestLevel": 83.08499999999997,
    "distanceAtr": 0.28333333333321753
   },
   "confirmation30m": {
    "shiftDetected": false,
    "retestSeen": false
   },
   "invalidation": {
    "timeframe": "D",
    "level": 84.386,
    "rule": "Thesis dies only if a completed Daily structural candle closes above this level."
   },
   "correctionQuality": {
    "cleanCounterLeg": false,
    "legAtr": 2.92,
    "bars": 24,
    "extended": false
   },
   "priority": 80,
   "priorityReasons": [
    "Clear Daily swing thesis",
    "Price agrees with Daily 200 SMA context",
    "4H thesis remains aligned",
    "At 4H supply zone"
   ],
   "exposure": [
    "GBP",
    "USD"
   ],
   "maturity": {
    "correctionStartTime": "2025-06-03T14:00:00.000Z",
    "correctionAgeBars": 32,
    "correctionStartPrice": 76,
    "correctionEndPrice": 86.5,
    "correctionDistancePrice": 10.5,
    "correctionDistancePips": 105000,
    "correctionDistancePercent": 13.816,
    "priorImpulseStartTime": "2025-06-02T02:00:00.000Z",
    "priorImpulseEndTime": "2025-06-03T14:00:00.000Z",
    "priorImpulseStartPrice": 86,
    "priorImpulseEndPrice": 76,
    "priorImpulseDistance": 10,
    "retracementPercent": 105,
    "correctionDepth": "DEEP",
    "crossedEquilibrium": true
   }
  }
 }
};
const withoutTimestamp = (result: any) => { if (!result.candidate) return result; const { scannedAt, ...rest } = result.candidate; return { candidate: rest }; };
const scale = (candles: Candle[], k: number): Candle[] => candles.map(c => ({ ...c, o: c.o * k, h: c.h * k, l: c.l * k, c: c.c * k }));
const scaled = (f: ReturnType<typeof structuredBullish>, k: number) => ({ daily: scale(f.daily, k), h4: scale(f.h4, k), h1: scale(f.h1, k), m30: scale(f.m30, k), livePrice: f.livePrice * k });

// 1. universe: the 14 committed FX pairs (same order) + metals + indices; own list, not the legacy scanner's
assert.deepEqual([...FX_CORRECTION_PAIRS], ['EUR_USD', 'GBP_USD', 'USD_JPY', 'USD_CAD', 'USD_CHF', 'AUD_USD', 'NZD_USD',
  'EUR_JPY', 'GBP_JPY', 'AUD_JPY', 'NZD_JPY', 'CAD_JPY', 'EUR_GBP', 'EUR_AUD']);
assert.deepEqual(CORRECTION_INSTRUMENTS, [...FX_CORRECTION_PAIRS, 'XAU_USD', 'XAG_USD', 'US30_USD', 'NAS100_USD']);
assert.ok(!/from '\.\/scanner\.js'/.test(fs.readFileSync(new URL('../server/corrections.ts', import.meta.url), 'utf8')), 'correction finder no longer depends on the legacy scanner list');

// 2. units + precision
assert.deepEqual(instrumentMeta('EUR_USD'), { assetClass: 'FX', distanceUnit: 'pips', unitSize: 0.0001, distanceDecimals: 1, displayPrecision: 5 });
assert.deepEqual(instrumentMeta('USD_JPY'), { assetClass: 'FX', distanceUnit: 'pips', unitSize: 0.01, distanceDecimals: 1, displayPrecision: 3 });
assert.equal(instrumentMeta('XAU_USD').distanceUnit, 'usd');
assert.equal(instrumentMeta('XAU_USD').displayPrecision, 3);
assert.equal(instrumentMeta('XAG_USD').distanceDecimals, 3);
for (const index of ['US30_USD', 'NAS100_USD']) {
  assert.equal(instrumentMeta(index).assetClass, 'INDEX');
  assert.equal(instrumentMeta(index).distanceUnit, 'points');
  assert.equal(instrumentMeta(index).unitSize, 1);
}
for (const pair of CORRECTION_INSTRUMENTS) assert.ok(instrumentMeta(pair).unitSize > 0, pair);

// 3. zone distances in the instrument's unit (FX value unchanged)
{
  const c = (i: number, o: number, h: number, l: number, cl: number): Candle => ({ t: new Date(Date.UTC(2025, 0, i + 1)).toISOString(), o, h, l, c: cl, v: 100 });
  const demand = [c(0,104,105,103,104), c(1,103,104,102,103), c(2,102,103,101.5,102), c(3,103,104,102,103), c(4,102,103,101.5,102),
    c(5,100,102,99,101), c(6,102,103,101.5,102), c(7,103,104,102,103), c(8,104,105,103,104), c(9,105,106,104,105), c(10,106,107,105,106)];
  const zone = (pair: string) => modelHTFZones({ pair, daily: [], h4: demand, thesis: 'LONG', livePrice: 102, referenceAtr: 1 })[0];
  assert.equal(zone('EUR_USD').distancePips, 10000, 'FX unchanged');
  assert.equal(zone('USD_JPY').distancePips, 100, 'FX JPY unchanged');
  assert.equal(zone('XAU_USD').distancePips, 1, 'gold: US$ distance');
  assert.equal(zone('US30_USD').distancePips, 1, 'index: points');
  assert.equal(zone('XAU_USD').state, zone('EUR_USD').state, 'zone state never depends on the instrument');
}

// 4. maturity distance in the instrument's unit
{
  const unitPath = (end: number) => path([[0, 104], [8, 98], [16, 103], [26, 95], [36, 105], [46, 100], [61, 120], [71, end]]);
  assert.equal(computeCorrectionMaturity('XAG_USD', unitPath(110), 'LONG').correctionDistancePips, 10);
  assert.equal(computeCorrectionMaturity('NAS100_USD', unitPath(110), 'LONG').correctionDistancePips, 10);
  assert.equal(computeCorrectionMaturity('USD_JPY', unitPath(110), 'LONG').correctionDistancePips, 1000, 'FX unchanged');
  assert.equal(computeCorrectionMaturity('XAG_USD', unitPath(110), 'LONG').retracementPercent, 40, 'retracement is unit-free');
}

// 5. FX output byte-identical to e109dfe
for (const [name, [pair, f]] of Object.entries(SNAPSHOT_CASES())) {
  assert.deepEqual(JSON.parse(JSON.stringify(withoutTimestamp(analyzeCorrection({ pair, ...f })))), (BASE_E109DFE as any)[name], `${name} identical to e109dfe`);
}

// 6. metals and indices surface through the same rules (scale-invariant), with their own units + exposure tags
{
  const reference = analyzeCorrection({ pair: 'EUR_USD', ...structuredBullish() }).candidate!;
  const referenceBear = analyzeCorrection({ pair: 'EUR_USD', ...structuredBearish() }).candidate!;
  const cases: Array<[string, any, any, number]> = [
    ['XAU_USD', scaled(structuredBullish(), 30), reference, 30],
    ['XAG_USD', scaled(structuredBearish(), 0.5), referenceBear, 0.5],
    ['US30_USD', scaled(structuredBullish(), 400), reference, 400],
    ['NAS100_USD', scaled(structuredBearish(), 250), referenceBear, 250],
  ];
  for (const [pair, f, ref, k] of cases) {
    const candidate = analyzeCorrection({ pair, ...f }).candidate;
    assert.ok(candidate, `${pair} surfaces`);
    assert.equal(candidate!.stage, ref.stage, `${pair} stage`);
    assert.equal(candidate!.priority, ref.priority, `${pair} priority`);
    assert.deepEqual(candidate!.priorityReasons, ref.priorityReasons, `${pair} reasons`);
    assert.equal(candidate!.thesisDirection, ref.thesisDirection);
    assert.equal(candidate!.location.atLocation, ref.location.atLocation);
    assert.equal(candidate!.location.zone?.state, ref.location.zone?.state);
    assert.equal(candidate!.location.zone?.timeframe, ref.location.zone?.timeframe);
    assert.equal(candidate!.maturity?.correctionAgeBars, ref.maturity?.correctionAgeBars);
    assert.ok(Math.abs(candidate!.maturity!.retracementPercent! - ref.maturity!.retracementPercent!) <= 0.01, `${pair} retracement`);
    assert.equal(candidate!.maturity?.correctionDepth, ref.maturity?.correctionDepth);
    const meta = instrumentMeta(pair);
    assert.equal(candidate!.maturity!.correctionDistancePips, Number((candidate!.maturity!.correctionDistancePrice! / meta.unitSize).toFixed(meta.distanceDecimals)), `${pair} distance unit`);
    assert.ok(Math.abs(candidate!.maturity!.correctionDistancePrice! - ref.maturity!.correctionDistancePrice! * k) < 1e-6 * k, `${pair} distance scales with price`);
  }
  assert.deepEqual(analyzeCorrection({ pair: 'XAU_USD', ...scaled(structuredBullish(), 30) }).candidate!.exposure, ['XAU', 'USD', 'METALS']);
  assert.deepEqual(analyzeCorrection({ pair: 'US30_USD', ...scaled(structuredBullish(), 400) }).candidate!.exposure, ['USD', 'US_INDICES']);
  assert.deepEqual(reference.exposure, ['EUR', 'USD'], 'FX exposure unchanged');
}

console.log('Correction instrument tests passed: universe (14 FX + 2 metals + 2 indices, own list), units/precision, zone + maturity distances per unit, FX byte-identical to e109dfe, metals/indices surface through unchanged rules, exposure tags.');
