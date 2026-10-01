import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Candle, CorrectionCandidate, Direction, atr, currentLeg, swings, structure } from './corrections.js';

export type LifecycleStage = 'CORRECTION_IN_PROGRESS' | 'APPROACHING_LOCATION' | 'AT_LOCATION' |
  'SHIFT_30M_DETECTED' | 'WAITING_FOR_RETEST' | 'TRIGGER_5M_OBSERVED' | 'TREND_RESUMED' | 'INVALIDATED';

export interface StageEvent { stage: LifecycleStage; at: string; evidence?: string; }
export interface CorrectionLifecycle {
  episodeId: string;
  signature: string;
  pair: string;
  thesisDirection: Direction;
  correctionDirection: Direction;
  invalidationLevel: number;
  stage: LifecycleStage;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  stageTimestamps: Partial<Record<LifecycleStage, string>>;
  history: StageEvent[];
  shiftLevel?: number;
  shiftTimestamp?: string;
  retestTimestamp?: string;
  triggerTimestamp?: string;
  invalidationTimestamp?: string;
  retestTolerance?: number;
}

export interface LifecycleMarketData { daily?: Candle[]; m30: Candle[]; m5: Candle[]; h1: Candle[]; }
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CORRECTION_LIFECYCLES_PATH = path.join(__dirname, '..', 'data', 'correction_lifecycles.local.json');
const TERMINAL = new Set<LifecycleStage>(['TREND_RESUMED', 'INVALIDATED']);
const ORDER: LifecycleStage[] = ['CORRECTION_IN_PROGRESS', 'APPROACHING_LOCATION', 'AT_LOCATION', 'SHIFT_30M_DETECTED', 'WAITING_FOR_RETEST', 'TRIGGER_5M_OBSERVED', 'TREND_RESUMED'];

export function lifecycleSignature(candidate: Pick<CorrectionCandidate, 'pair' | 'thesisDirection' | 'correctionDirection' | 'invalidation'>) {
  return [candidate.pair, candidate.thesisDirection, candidate.correctionDirection, candidate.invalidation.level.toFixed(5)].join('|').toUpperCase();
}

function freshBreak(candles: Candle[], thesis: Direction, after: string) {
  const pivots = swings(candles, 2).filter(p => p.type === (thesis === 'LONG' ? 'high' : 'low'));
  for (let p = pivots.length - 1; p >= 0; p--) {
    const pivot = pivots[p];
    const index = candles.findIndex((c, i) => i > pivot.index && c.t > after && (thesis === 'LONG' ? c.c > pivot.price : c.c < pivot.price));
    if (index >= 0) return { level: pivot.price, candle: candles[index], index };
  }
  return null;
}

function advance(record: CorrectionLifecycle, stage: LifecycleStage, at: string, evidence?: string) {
  if (record.stage === stage || TERMINAL.has(record.stage)) return;
  if (stage !== 'INVALIDATED' && ORDER.indexOf(stage) < ORDER.indexOf(record.stage)) return;
  record.stage = stage;
  record.updatedAt = at;
  record.stageTimestamps[stage] = at;
  record.history.push({ stage, at, evidence });
  if (TERMINAL.has(stage)) record.completedAt = at;
}

export function applyLifecycleEvidence(record: CorrectionLifecycle, candidate: CorrectionCandidate | undefined, data: LifecycleMarketData, now: string, invalidated = false) {
  if (invalidated) {
    record.invalidationTimestamp = data.daily?.at(-1)?.t || now;
    advance(record, 'INVALIDATED', record.invalidationTimestamp, 'Completed Daily structural candle closed beyond thesis invalidation.');
    return record;
  }
  if (!candidate || TERMINAL.has(record.stage)) return record;
  if (candidate.location.atLocation) advance(record, 'AT_LOCATION', now, candidate.location.labels.join(' + '));
  else if (candidate.location.approaching) advance(record, 'APPROACHING_LOCATION', now, 'Within the existing approaching-location boundary.');

  if (!record.shiftTimestamp) {
    const shift = freshBreak(data.m30, record.thesisDirection, record.startedAt);
    if (shift) {
      record.shiftLevel = shift.level;
      record.shiftTimestamp = shift.candle.t;
      advance(record, 'SHIFT_30M_DETECTED', shift.candle.t, `Completed 30M close broke ${shift.level}.`);
      advance(record, 'WAITING_FOR_RETEST', shift.candle.t, `Watching the broken 30M level ${shift.level}.`);
    }
  }
  if (record.shiftTimestamp && !record.retestTimestamp && record.shiftLevel != null) {
    const tolerance = atr(data.m30) * 0.10;
    record.retestTolerance = tolerance;
    const retest = data.m30.find(c => c.t > record.shiftTimestamp! && (record.thesisDirection === 'LONG'
      ? c.l <= record.shiftLevel! + tolerance && c.h >= record.shiftLevel! - tolerance
      : c.h >= record.shiftLevel! - tolerance && c.l <= record.shiftLevel! + tolerance));
    if (retest) { record.retestTimestamp = retest.t; record.updatedAt = now; }
  }
  if (record.retestTimestamp && !record.triggerTimestamp) {
    const trigger = freshBreak(data.m5, record.thesisDirection, record.retestTimestamp);
    if (trigger) {
      record.triggerTimestamp = trigger.candle.t;
      advance(record, 'TRIGGER_5M_OBSERVED', trigger.candle.t, `Fresh completed 5M structure break after retest at ${trigger.level}.`);
    }
  }
  if (record.triggerTimestamp && currentLeg(data.h1) === record.thesisDirection && structure(data.m30.slice(-100)) === record.thesisDirection) {
    advance(record, 'TREND_RESUMED', now, 'Completed 1H leg and 30M structure realigned with Daily thesis.');
  }
  return record;
}

export class CorrectionLifecycleStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(public readonly filePath = process.env.CORRECTION_LIFECYCLES_PATH || DEFAULT_CORRECTION_LIFECYCLES_PATH) {}
  private async read(): Promise<CorrectionLifecycle[]> { try { const value = JSON.parse(await fs.readFile(this.filePath, 'utf8')); return Array.isArray(value) ? value : []; } catch (e: any) { if (e.code !== 'ENOENT') throw e; return []; } }
  private async write(records: CorrectionLifecycle[]) { await fs.mkdir(path.dirname(this.filePath), { recursive: true }); const temp = `${this.filePath}.tmp`; await fs.writeFile(temp, `${JSON.stringify(records, null, 2)}\n`); await fs.rename(temp, this.filePath); }
  async list() { return this.read(); }
  async reconcile(candidates: CorrectionCandidate[], market: Map<string, LifecycleMarketData>, invalidatedPairs: Set<string>, now = new Date().toISOString()) {
    const operation = async () => {
      const records = await this.read();
      const active = records.filter(r => !TERMINAL.has(r.stage));
      for (const candidate of candidates) {
        const signature = lifecycleSignature(candidate);
        let record = active.find(r => r.signature === signature);
        if (!record) {
          record = { episodeId: `${signature}|${now}`, signature, pair: candidate.pair, thesisDirection: candidate.thesisDirection, correctionDirection: candidate.correctionDirection, invalidationLevel: candidate.invalidation.level, stage: 'CORRECTION_IN_PROGRESS', startedAt: now, updatedAt: now, stageTimestamps: { CORRECTION_IN_PROGRESS: now }, history: [{ stage: 'CORRECTION_IN_PROGRESS', at: now, evidence: 'Correction finder surfaced a new active counter-leg.' }] };
          records.push(record); active.push(record);
        }
        const data = market.get(candidate.pair);
        if (data) applyLifecycleEvidence(record, candidate, data, now);
        candidate.episodeId = record.episodeId;
        candidate.stage = record.stage;
        candidate.lifecycle = record;
        candidate.confirmation30m = { shiftDetected: !!record.shiftTimestamp, bosLevel: record.shiftLevel, retestSeen: !!record.retestTimestamp };
      }
      for (const record of active) if (invalidatedPairs.has(record.pair)) {
        const data = market.get(record.pair);
        if (data) applyLifecycleEvidence(record, undefined, data, now, true);
      }
      await this.write(records);
      return records;
    };
    const next = this.queue.then(operation, operation); this.queue = next.then(() => undefined, () => undefined); return next;
  }
}

export const correctionLifecycleStore = new CorrectionLifecycleStore();
