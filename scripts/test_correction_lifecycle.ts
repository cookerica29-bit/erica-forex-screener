import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CorrectionLifecycleStore } from '../server/correctionLifecycle.js';
import { CorrectionValidationStore } from '../server/correctionValidations.js';
import type { Candle, CorrectionCandidate, Direction } from '../server/corrections.js';

const c = (t: string, o: number, h: number, l: number, close: number): Candle => ({ t, o, h, l, c: close, v: 100 });
const base = '2026-01-01T00:00:00.000Z';
const time = (minutes: number) => new Date(Date.parse(base) + minutes * 60_000).toISOString();
const neutral = (count: number, step = 30) => Array.from({ length: count }, (_, i) => c(time(i * step), 1.2, 1.25, 1.15, 1.2));
const shift30 = [
  c(time(1), 1.1, 1.2, 1.0, 1.1), c(time(2), 1.2, 1.3, 1.1, 1.2), c(time(3), 1.3, 1.5, 1.2, 1.3),
  c(time(4), 1.25, 1.3, 1.1, 1.2), c(time(5), 1.2, 1.25, 1.05, 1.15), c(time(6), 1.3, 1.62, 1.25, 1.6),
];
const trigger5 = (after = 8) => [
  c(time(after), 1.48, 1.50, 1.45, 1.48), c(time(after + 1), 1.49, 1.52, 1.47, 1.50), c(time(after + 2), 1.52, 1.56, 1.49, 1.53),
  c(time(after + 3), 1.51, 1.53, 1.47, 1.49), c(time(after + 4), 1.49, 1.51, 1.46, 1.48), c(time(after + 5), 1.55, 1.62, 1.53, 1.60),
];
function candidate(direction: Direction = 'LONG'): CorrectionCandidate {
  return {
    pair: direction === 'LONG' ? 'EUR_USD' : 'USD_JPY', thesisDirection: direction, correctionDirection: direction === 'LONG' ? 'SHORT' : 'LONG',
    stage: 'CORRECTION_IN_PROGRESS', price: 1.2, dailyStructure: direction, h4Structure: direction, h1Leg: direction === 'LONG' ? 'SHORT' : 'LONG', thesisBasis: [],
    location: { atLocation: true, approaching: false, labels: ['HTF support/resistance'] }, confirmation30m: { shiftDetected: false, retestSeen: false },
    invalidation: { timeframe: 'D', level: direction === 'LONG' ? 1 : 2, rule: 'completed Daily close' }, correctionQuality: { cleanCounterLeg: true, legAtr: 2, bars: 24, extended: false },
    priority: 50, priorityReasons: [], exposure: [], scannedAt: base,
  };
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kairos-lifecycle-'));
const lifecyclePath = path.join(directory, 'lifecycle.json');
const store = new CorrectionLifecycleStore(lifecyclePath);
const bull = candidate('LONG');
const market = new Map([[bull.pair, { m30: neutral(6), m5: neutral(6, 5), h1: neutral(40, 60) }]]);
await store.reconcile([bull], market, new Set(), base);
assert.equal(bull.stage, 'AT_LOCATION');
const episodeId = bull.episodeId!;

market.set(bull.pair, { m30: shift30, m5: trigger5(), h1: neutral(40, 60) });
await store.reconcile([bull], market, new Set(), time(7));
assert.equal(bull.stage, 'WAITING_FOR_RETEST', 'fresh completed 30M break starts retest wait');
assert.equal(bull.lifecycle?.triggerTimestamp, undefined, '5M structure cannot trigger before a retest');
assert.equal(bull.lifecycle?.shiftLevel, 1.5);

market.set(bull.pair, { m30: [...shift30, c(time(8), 1.58, 1.6, 1.49, 1.55)], m5: trigger5(9), h1: neutral(40, 60) });
await store.reconcile([bull], market, new Set(), time(15));
assert.equal(bull.stage, 'TRIGGER_5M_OBSERVED', 'fresh 5M break after retest advances trigger stage');
assert.equal(bull.lifecycle?.retestTimestamp, time(8));
assert.ok((bull.lifecycle?.retestTolerance || 0) > 0, 'stores explainable 10% M30 ATR tolerance');
bull.location = { atLocation: false, approaching: false, labels: [] };
await store.reconcile([bull], market, new Set(), time(16));
assert.equal(bull.stage, 'TRIGGER_5M_OBSERVED', 'stage never moves backward when location evidence disappears');

const reloaded = new CorrectionLifecycleStore(lifecyclePath);
assert.equal((await reloaded.list())[0].episodeId, episodeId, 'persists lifecycle across store restart/load');
await reloaded.reconcile([], market, new Set([bull.pair]), time(20));
assert.equal((await reloaded.list())[0].stage, 'INVALIDATED', 'completed-candle invalidation terminates episode');
const next = candidate('LONG');
await reloaded.reconcile([next], market, new Set(), time(21));
assert.notEqual(next.episodeId, episodeId, 'new correction after a completed episode receives a new ID');

const validationStore = new CorrectionValidationStore(path.join(directory, 'validations.json'));
const legacy = [bull.pair, bull.thesisDirection, bull.correctionDirection, bull.invalidation.level.toFixed(5)].join('|');
const tracked = await validationStore.create({ pair: bull.pair, correctionEpisodeId: legacy, scanTimestamp: base, dailyThesis: 'BULLISH', h4Context: 'LONG', h1CorrectionLeg: 'BEARISH', h1CorrectionStage: 'AT_LOCATION', locationContext: 'support' });
await validationStore.syncLifecycle([bull]);
const linked = (await validationStore.list())[0];
assert.equal(linked.correctionEpisodeId, bull.episodeId, 'migrates an open legacy validation to native episode ID');
assert.equal(linked.chochBos30mObserved, 'YES');
assert.equal(linked.retestObserved, 'YES');
assert.equal(linked.trigger5mObserved, 'YES');
assert.equal((await validationStore.create({ ...tracked.record, correctionEpisodeId: bull.episodeId! })).created, false, 'native episode duplicate protection remains active');

await fs.rm(directory, { recursive: true, force: true });
console.log('Correction lifecycle tests passed: progression, no early trigger, persistence, invalidation, new episode, validation linkage, duplicate protection.');
