import assert from 'node:assert/strict';
import { analyzeCorrection, Candle, modelHTFZones, ZONE_RULES } from '../server/corrections.js';

function candle(index: number, o: number, h: number, l: number, c: number): Candle {
  return { t: new Date(Date.UTC(2025, 0, index + 1)).toISOString(), o, h, l, c, v: 100 };
}

function demandSeries(): Candle[] {
  return [
    candle(0, 104, 105, 103, 104), candle(1, 103, 104, 102, 103), candle(2, 102, 103, 101.5, 102),
    candle(3, 103, 104, 102, 103), candle(4, 102, 103, 101.5, 102),
    candle(5, 100, 102, 99, 101), // confirmed swing-low zone: 99–101
    candle(6, 102, 103, 101.5, 102), candle(7, 103, 104, 102, 103), candle(8, 104, 105, 103, 104),
    candle(9, 105, 106, 104, 105), candle(10, 106, 107, 105, 106),
  ];
}

function supplySeries(): Candle[] {
  return demandSeries().map((item, index) => candle(index, 210 - item.o, 210 - item.l, 210 - item.h, 210 - item.c));
}

const demandIn = modelHTFZones({ pair: 'EUR_USD', daily: [], h4: demandSeries(), thesis: 'LONG', livePrice: 100.5, referenceAtr: 1 });
assert.equal(demandIn[0]?.type, 'DEMAND', 'bullish thesis models demand');
assert.equal(demandIn[0]?.timeframe, 'H4');
assert.equal(demandIn[0]?.state, 'IN_ZONE', 'live price inside bounds is IN_ZONE');
assert.deepEqual([demandIn[0]?.low, demandIn[0]?.high], [99, 101]);

const demandApproaching = modelHTFZones({ pair: 'EUR_USD', daily: [], h4: demandSeries(), thesis: 'LONG', livePrice: 102, referenceAtr: 1 });
assert.equal(demandApproaching[0]?.state, 'APPROACHING');
assert.equal(demandApproaching[0]?.distanceAtr, 1);
assert.equal(demandApproaching[0]?.distancePips, 10000);

const demandAway = modelHTFZones({ pair: 'EUR_USD', daily: [], h4: demandSeries(), thesis: 'LONG', livePrice: 104, referenceAtr: 1 });
assert.equal(demandAway[0]?.state, 'AWAY');

const supplyIn = modelHTFZones({ pair: 'USD_JPY', daily: supplySeries(), h4: [], thesis: 'SHORT', livePrice: 109.5, referenceAtr: 1 });
assert.equal(supplyIn[0]?.type, 'SUPPLY', 'bearish thesis models supply');
assert.equal(supplyIn[0]?.state, 'IN_ZONE', 'bearish correction can be inside supply');

const tooYoung = demandSeries().slice(0, 9);
assert.equal(tooYoung.length - 1 - 5, ZONE_RULES.minimumAgeCandles - 1);
assert.equal(modelHTFZones({ pair: 'EUR_USD', daily: [], h4: tooYoung, thesis: 'LONG', livePrice: 102, referenceAtr: 1 }).length, 0, 'unstable zone below minimum age is ignored');

const invalid = demandSeries();
invalid[9] = candle(9, 100, 100.5, 97.5, 98.5);
assert.equal(modelHTFZones({ pair: 'EUR_USD', daily: [], h4: invalid, thesis: 'LONG', livePrice: 102, referenceAtr: 1 }).length, 0, 'completed close beyond distal edge invalidates zone');

const exhausted = demandSeries();
exhausted[6] = candle(6, 101.4, 102, 100.8, 101.5);
exhausted[7] = candle(7, 101.5, 102, 100.7, 101.6);
exhausted[8] = candle(8, 101.6, 102, 100.6, 101.7);
assert.equal(modelHTFZones({ pair: 'EUR_USD', daily: [], h4: exhausted, thesis: 'LONG', livePrice: 102, referenceAtr: 1 }).length, 0, 'zone exhausted by three completed revisits is ignored');

function wave(count: number, start: number, slope: number, amplitude = 2, period = 12): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = start + slope * index + Math.sin(index * Math.PI * 2 / period) * amplitude;
    const open = close - slope * .2;
    return candle(index, open, Math.max(open, close) + .35, Math.min(open, close) - .35, close);
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

const bullish = analyzeCorrection({ pair: 'EUR_USD', ...fixture(.08, .025, -.035) });
const bearish = analyzeCorrection({ pair: 'GBP_USD', ...fixture(-.08, -.025, .035) });
assert.equal(bullish.candidate?.correctionDirection, 'SHORT', 'zone modeling does not change bullish-thesis correction qualification');
assert.equal(bearish.candidate?.correctionDirection, 'LONG', 'zone modeling does not change bearish-thesis correction qualification');
const aligned = analyzeCorrection({ pair: 'USD_JPY', ...fixture(.08, .025, .035) });
assert.equal(aligned.other?.state, 'ALIGNED_TREND', 'zones never create a correction candidate from an aligned 1H leg');

const noZones = modelHTFZones({ pair: 'EUR_USD', daily: [], h4: wave(20, 100, .2, 0), thesis: 'LONG', livePrice: 104, referenceAtr: 1 });
assert.equal(noZones.length, 0, 'no-zone input remains eligible for legacy location fallback');

console.log('HTF zone fixtures passed: demand/supply, age/invalidation, state distances, fallback, and unchanged correction qualification.');
