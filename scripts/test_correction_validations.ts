import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CorrectionValidationStore } from '../server/correctionValidations.js';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kairos-correction-validations-'));
const filePath = path.join(directory, 'validations.json');
const store = new CorrectionValidationStore(filePath);

const fixture = {
  pair: 'USD_JPY',
  correctionEpisodeId: 'USD_JPY|SHORT|LONG|151.25000',
  scanTimestamp: '2026-10-01T14:00:00.000Z',
  dailyThesis: 'BEARISH',
  h4Context: 'LONG structure',
  h1CorrectionLeg: 'BULLISH',
  h1CorrectionStage: 'AT_LOCATION',
  locationContext: 'Daily 200 SMA context',
};

const created = await store.create(fixture);
assert.equal(created.created, true, 'creates a validation record');
assert.equal(created.record.manualSmcAgreement, 'PENDING');
assert.equal((await store.list()).length, 1);

const duplicate = await store.create(fixture);
assert.equal(duplicate.created, false, 'protects an active episode from duplicate tracking');
assert.equal(duplicate.record.id, created.record.id);
assert.equal((await store.list()).length, 1);

const updated = await store.update(created.record.id, {
  manualSmcAgreement: 'YES',
  meaningfulLocationAgreement: 'YES',
  chochBos30mObserved: 'YES',
  retestObserved: 'YES',
  trigger5mObserved: 'NO',
  sensibleTargetBeforeInvalidation: 'PENDING',
  falsePositiveReason: '',
  notes: 'Manual completed fixture: valid discovery, no 5M trigger.',
  status: 'COMPLETE',
});
assert.equal(updated?.status, 'COMPLETE', 'updates manual validation fields');
assert.equal(updated?.trigger5mObserved, 'NO');

const second = await store.create({
  ...fixture,
  pair: 'USD_CHF',
  correctionEpisodeId: 'USD_CHF|LONG|SHORT|0.78500',
  dailyThesis: 'BULLISH',
  h1CorrectionLeg: 'BEARISH',
});
assert.equal(second.created, true);

const summary = await store.summary();
assert.deepEqual({ tracked: summary.tracked, complete: summary.complete, open: summary.open, remaining: summary.remaining },
  { tracked: 2, complete: 1, open: 1, remaining: 18 }, 'reports 20-setup progress');
assert.deepEqual(summary.manualAgreement, { yes: 1, no: 0, pending: 1, reviewed: 1, rate: 1 }, 'calculates discovery precision only from reviewed records');
assert.deepEqual(summary.followThrough, { chochBos30m: 1, retest: 1, trigger5m: 0, sensibleTarget: 0 }, 'reports follow-through counts without a win rate');

const reloaded = new CorrectionValidationStore(filePath);
const persisted = await reloaded.list();
assert.equal(persisted.length, 2, 'persists records across store instances');
assert.equal(persisted.find(record => record.id === created.record.id)?.notes, 'Manual completed fixture: valid discovery, no 5M trigger.');

await fs.rm(directory, { recursive: true, force: true });
console.log('Correction validation tests passed: creation, duplicate protection, updates, progress, metrics, persistence.');
