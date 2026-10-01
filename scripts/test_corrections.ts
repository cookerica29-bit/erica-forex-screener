import assert from 'node:assert/strict';
import { analyzeCorrection, Candle } from '../server/corrections.js';

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

const bullishCorrection = analyzeCorrection({ pair: 'EUR_USD', ...fixture(.08, .025, -.035) });
assert.equal(bullishCorrection.candidate?.thesisDirection, 'LONG', 'bullish Daily / bearish 1H should be a correction candidate');
assert.equal(bullishCorrection.candidate?.correctionDirection, 'SHORT');

const bearishCorrection = analyzeCorrection({ pair: 'GBP_USD', ...fixture(-.08, -.025, .035) });
assert.equal(bearishCorrection.candidate?.thesisDirection, 'SHORT', 'bearish Daily / bullish 1H should be a correction candidate');
assert.equal(bearishCorrection.candidate?.correctionDirection, 'LONG');

const aligned = analyzeCorrection({ pair: 'USD_JPY', ...fixture(.08, .025, .035) });
assert.equal(aligned.other?.state, 'ALIGNED_TREND', 'aligned 1H leg belongs outside correction discovery');

const ranging = analyzeCorrection({ pair: 'EUR_GBP', ...fixture(0, 0, -.02) });
assert.equal(ranging.other?.state, 'NO_CLEAR_THESIS', 'range without Daily thesis must not be promoted');

const invalidFixture = fixture(.08, .025, -.035);
const priorLow = Math.min(...invalidFixture.daily.slice(-30, -4).map(c => c.l));
invalidFixture.daily.at(-1)!.c = priorLow - 5;
invalidFixture.daily.at(-1)!.l = priorLow - 5.5;
const invalidated = analyzeCorrection({ pair: 'AUD_USD', ...invalidFixture });
assert.equal(invalidated.other?.state, 'INVALIDATED', 'completed Daily close through structure invalidates the thesis');

console.log('Correction fixtures passed: bullish correction, bearish correction, aligned trend, range/no thesis, invalidated thesis.');
