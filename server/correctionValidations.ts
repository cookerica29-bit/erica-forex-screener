import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { CorrectionCandidate } from './corrections.js';

export type ValidationAnswer = 'YES' | 'NO' | 'PENDING';
export type ValidationStatus = 'OPEN' | 'COMPLETE';

export interface CorrectionValidation {
  id: number;
  pair: string;
  correctionEpisodeId: string;
  scanTimestamp: string;
  dailyThesis: string;
  h4Context: string;
  h1CorrectionLeg: string;
  h1CorrectionStage: string;
  locationContext: string;
  manualSmcAgreement: ValidationAnswer;
  meaningfulLocationAgreement: ValidationAnswer;
  chochBos30mObserved: ValidationAnswer;
  retestObserved: ValidationAnswer;
  trigger5mObserved: ValidationAnswer;
  sensibleTargetBeforeInvalidation: ValidationAnswer;
  falsePositiveReason: string;
  notes: string;
  status: ValidationStatus;
  createdAt: string;
  updatedAt: string;
}

export type CreateCorrectionValidation = Omit<CorrectionValidation,
  'id' | 'correctionEpisodeId' | 'manualSmcAgreement' | 'meaningfulLocationAgreement' |
  'chochBos30mObserved' | 'retestObserved' | 'trigger5mObserved' |
  'sensibleTargetBeforeInvalidation' | 'falsePositiveReason' | 'notes' | 'status' |
  'createdAt' | 'updatedAt'> & {
  correctionEpisodeId?: string;
};

export type UpdateCorrectionValidation = Partial<Pick<CorrectionValidation,
  'manualSmcAgreement' | 'meaningfulLocationAgreement' | 'chochBos30mObserved' |
  'retestObserved' | 'trigger5mObserved' | 'sensibleTargetBeforeInvalidation' |
  'falsePositiveReason' | 'notes' | 'status'>>;

export interface CorrectionValidationSummary {
  target: 20;
  tracked: number;
  complete: number;
  open: number;
  remaining: number;
  manualAgreement: { yes: number; no: number; pending: number; reviewed: number; rate: number | null };
  meaningfulLocation: { yes: number; no: number; pending: number };
  followThrough: { chochBos30m: number; retest: number; trigger5m: number; sensibleTarget: number };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CORRECTION_VALIDATIONS_PATH = path.join(__dirname, '..', 'data', 'correction_validations.local.json');
const ANSWERS = new Set<ValidationAnswer>(['YES', 'NO', 'PENDING']);
const STATUSES = new Set<ValidationStatus>(['OPEN', 'COMPLETE']);

function cleanText(value: unknown, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function answer(value: unknown): ValidationAnswer {
  const normalized = String(value || 'PENDING').toUpperCase() as ValidationAnswer;
  if (!ANSWERS.has(normalized)) throw new Error(`Invalid validation answer: ${value}`);
  return normalized;
}

function status(value: unknown): ValidationStatus {
  const normalized = String(value || 'OPEN').toUpperCase() as ValidationStatus;
  if (!STATUSES.has(normalized)) throw new Error(`Invalid validation status: ${value}`);
  return normalized;
}

export function correctionEpisodeId(input: {
  pair: string; dailyThesis: string; h1CorrectionLeg: string; invalidationLevel?: string | number;
}) {
  const invalidation = input.invalidationLevel == null ? '' : Number(input.invalidationLevel).toFixed(5);
  return [input.pair, input.dailyThesis, input.h1CorrectionLeg, invalidation].map(value => cleanText(value, 60).toUpperCase()).join('|');
}

export class CorrectionValidationStore {
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(public readonly filePath = process.env.CORRECTION_VALIDATIONS_PATH || DEFAULT_CORRECTION_VALIDATIONS_PATH) {}

  private async read(): Promise<CorrectionValidation[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      return [];
    }
  }

  private async write(records: CorrectionValidation[]) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`);
    await fs.rename(temporary, this.filePath);
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  async list() {
    return (await this.read()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async create(input: CreateCorrectionValidation & { invalidationLevel?: string | number }) {
    return this.serialized(async () => {
      const pair = cleanText(input.pair, 20).toUpperCase();
      if (!pair) throw new Error('Pair is required');
      const episodeId = cleanText(input.correctionEpisodeId, 180) || correctionEpisodeId({
        pair,
        dailyThesis: input.dailyThesis,
        h1CorrectionLeg: input.h1CorrectionLeg,
        invalidationLevel: input.invalidationLevel,
      });
      const records = await this.read();
      const duplicate = records.find(record => record.status === 'OPEN' && record.correctionEpisodeId === episodeId);
      if (duplicate) return { record: duplicate, created: false };
      const now = new Date().toISOString();
      const record: CorrectionValidation = {
        id: records.reduce((highest, item) => Math.max(highest, item.id), 0) + 1,
        pair,
        correctionEpisodeId: episodeId,
        scanTimestamp: cleanText(input.scanTimestamp, 60) || now,
        dailyThesis: cleanText(input.dailyThesis, 120),
        h4Context: cleanText(input.h4Context, 160),
        h1CorrectionLeg: cleanText(input.h1CorrectionLeg, 120),
        h1CorrectionStage: cleanText(input.h1CorrectionStage, 120),
        locationContext: cleanText(input.locationContext, 500),
        manualSmcAgreement: 'PENDING',
        meaningfulLocationAgreement: 'PENDING',
        chochBos30mObserved: 'PENDING',
        retestObserved: 'PENDING',
        trigger5mObserved: 'PENDING',
        sensibleTargetBeforeInvalidation: 'PENDING',
        falsePositiveReason: '',
        notes: '',
        status: 'OPEN',
        createdAt: now,
        updatedAt: now,
      };
      records.push(record);
      await this.write(records);
      return { record, created: true };
    });
  }

  async syncLifecycle(candidates: CorrectionCandidate[]) {
    return this.serialized(async () => {
      const records = await this.read();
      let changed = false;
      for (const candidate of candidates) {
        if (!candidate.episodeId || !candidate.lifecycle) continue;
        const legacy = [candidate.pair, candidate.thesisDirection, candidate.correctionDirection, candidate.invalidation.level.toFixed(5)].join('|').toUpperCase();
        const record = records.find(item => item.status === 'OPEN' && (item.correctionEpisodeId === candidate.episodeId || item.correctionEpisodeId === legacy));
        if (!record) continue;
        let recordChanged = false;
        if (record.correctionEpisodeId !== candidate.episodeId) { record.correctionEpisodeId = candidate.episodeId; recordChanged = true; }
        if (record.h1CorrectionStage !== candidate.stage) { record.h1CorrectionStage = candidate.stage; recordChanged = true; }
        if (candidate.lifecycle.shiftTimestamp && record.chochBos30mObserved !== 'YES') { record.chochBos30mObserved = 'YES'; recordChanged = true; }
        if (candidate.lifecycle.retestTimestamp && record.retestObserved !== 'YES') { record.retestObserved = 'YES'; recordChanged = true; }
        if (candidate.lifecycle.triggerTimestamp && record.trigger5mObserved !== 'YES') { record.trigger5mObserved = 'YES'; recordChanged = true; }
        if (recordChanged) { record.updatedAt = new Date().toISOString(); changed = true; }
      }
      if (changed) await this.write(records);
      return records;
    });
  }

  async update(id: number, patch: UpdateCorrectionValidation) {
    return this.serialized(async () => {
      const records = await this.read();
      const index = records.findIndex(record => record.id === id);
      if (index < 0) return null;
      const current = records[index];
      records[index] = {
        ...current,
        ...(patch.manualSmcAgreement !== undefined && { manualSmcAgreement: answer(patch.manualSmcAgreement) }),
        ...(patch.meaningfulLocationAgreement !== undefined && { meaningfulLocationAgreement: answer(patch.meaningfulLocationAgreement) }),
        ...(patch.chochBos30mObserved !== undefined && { chochBos30mObserved: answer(patch.chochBos30mObserved) }),
        ...(patch.retestObserved !== undefined && { retestObserved: answer(patch.retestObserved) }),
        ...(patch.trigger5mObserved !== undefined && { trigger5mObserved: answer(patch.trigger5mObserved) }),
        ...(patch.sensibleTargetBeforeInvalidation !== undefined && { sensibleTargetBeforeInvalidation: answer(patch.sensibleTargetBeforeInvalidation) }),
        ...(patch.falsePositiveReason !== undefined && { falsePositiveReason: cleanText(patch.falsePositiveReason, 500) }),
        ...(patch.notes !== undefined && { notes: cleanText(patch.notes, 2000) }),
        ...(patch.status !== undefined && { status: status(patch.status) }),
        updatedAt: new Date().toISOString(),
      };
      await this.write(records);
      return records[index];
    });
  }

  async summary(): Promise<CorrectionValidationSummary> {
    const records = await this.read();
    const count = (field: keyof CorrectionValidation, value: ValidationAnswer) => records.filter(record => record[field] === value).length;
    const manualYes = count('manualSmcAgreement', 'YES');
    const manualNo = count('manualSmcAgreement', 'NO');
    const reviewed = manualYes + manualNo;
    return {
      target: 20,
      tracked: records.length,
      complete: records.filter(record => record.status === 'COMPLETE').length,
      open: records.filter(record => record.status === 'OPEN').length,
      remaining: Math.max(0, 20 - records.length),
      manualAgreement: { yes: manualYes, no: manualNo, pending: count('manualSmcAgreement', 'PENDING'), reviewed, rate: reviewed ? manualYes / reviewed : null },
      meaningfulLocation: { yes: count('meaningfulLocationAgreement', 'YES'), no: count('meaningfulLocationAgreement', 'NO'), pending: count('meaningfulLocationAgreement', 'PENDING') },
      followThrough: {
        chochBos30m: count('chochBos30mObserved', 'YES'),
        retest: count('retestObserved', 'YES'),
        trigger5m: count('trigger5mObserved', 'YES'),
        sensibleTarget: count('sensibleTargetBeforeInvalidation', 'YES'),
      },
    };
  }
}

export const correctionValidationStore = new CorrectionValidationStore();
