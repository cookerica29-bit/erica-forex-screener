import type { RequirementStatus } from './stateMachine.js';

export interface StructureEvidence {
  confirmed: boolean;
  reason?: string;
}

export function evaluateStructure(evidence: StructureEvidence) {
  if (evidence.confirmed) {
    return {
      status: 'COMPLETE' as RequirementStatus,
      reason: evidence.reason || 'Structure confirmation is present.',
    };
  }
  return {
    status: 'INCOMPLETE' as RequirementStatus,
    reason: evidence.reason || 'Structure confirmation is missing.',
  };
}
