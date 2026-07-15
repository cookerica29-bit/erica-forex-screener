import type { RequirementStatus } from './stateMachine.js';

export interface ExecutionEvidence {
  plannedEntryReady: boolean;
  entryReached: boolean;
  plannedEntry?: number | null;
  reason?: string;
}

export function evaluatePlannedEntry(evidence: ExecutionEvidence) {
  if (evidence.plannedEntryReady) {
    return {
      status: 'COMPLETE' as RequirementStatus,
      reason: evidence.plannedEntry == null
        ? 'Planned entry requirement is complete.'
        : `Planned entry is defined at ${evidence.plannedEntry}.`,
    };
  }
  return {
    status: 'INCOMPLETE' as RequirementStatus,
    reason: evidence.reason || 'Planned entry is missing or incomplete.',
  };
}

export function evaluateEntryReached(evidence: ExecutionEvidence) {
  if (!evidence.plannedEntryReady) {
    return {
      status: 'NOT_APPLICABLE' as RequirementStatus,
      reason: 'Entry cannot be reached before a planned entry exists.',
    };
  }
  if (evidence.entryReached) {
    return {
      status: 'COMPLETE' as RequirementStatus,
      reason: 'Price has reached the planned entry area.',
    };
  }
  return {
    status: 'INCOMPLETE' as RequirementStatus,
    reason: 'Price has not reached the planned entry area.',
  };
}
