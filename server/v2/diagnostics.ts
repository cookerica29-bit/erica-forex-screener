import type { ScoutReport } from '../scanner.js';
import { scoutPhaseState } from '../scoutPhase.js';
import { evaluateLifecycle, lifecycleInputFromScoutReport } from './lifecycle.js';
import { STATE_ORDER, type EngineName, type LifecycleSnapshot, type LifecycleState, type LifecycleTransition } from './stateMachine.js';

export interface ShadowComparison {
  symbol: string;
  timeframe: string;
  v1_result: string;
  v1_mapped_state: LifecycleState;
  v2_result: LifecycleSnapshot;
  matches: boolean;
  disagreement_reason: string | null;
  disagreement_engine: EngineName | null;
  most_important_missing_requirement: string | null;
}

export interface LifecycleDiagnosticsSummary {
  scans: number;
  comparisons: number;
  matching_states: number;
  different_states: number;
  v1_enter_now: number;
  v2_enter_now: number;
  largest_disagreement_category: string | null;
  largest_disagreement_engine: EngineName | null;
  most_common_missing_requirement: string | null;
  average_lifecycle_stage: LifecycleState | null;
  transitions: number;
}

function shadowKey(report: ScoutReport) {
  const direction = report.tradeDirection || report.bias || 'NEUTRAL';
  return [report.pair, report.timeframe, direction].join('|');
}

function mapV1PhaseToLifecycleState(phase: string): LifecycleState {
  if (phase === 'Enter Now') return 'ENTRY_REACHED';
  if (phase === 'Almost Ready') return 'ALMOST_READY';
  if (phase === 'Skip') return 'INVALIDATED';
  return 'BUILDING';
}

function disagreementReason(comparison: Omit<ShadowComparison, 'disagreement_reason'>) {
  if (comparison.matches) return null;
  return comparison.most_important_missing_requirement
    ? `${comparison.most_important_missing_requirement} not confirmed`
    : `${comparison.v1_mapped_state} vs ${comparison.v2_result.current_state}`;
}

function disagreementEngine(v2: LifecycleSnapshot): EngineName | null {
  const missing = Object.values(v2.requirements).find(r => r.status === 'INCOMPLETE');
  return missing?.engine ?? null;
}

function countBy(values: string[]) {
  return values.reduce((acc, value) => {
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}

function topCount(counts: Record<string, number>) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

export class LifecycleDiagnosticsStore {
  private scanCount = 0;
  private comparisons: ShadowComparison[] = [];
  private previousStates = new Map<string, LifecycleState>();
  private transitions: LifecycleTransition[] = [];

  recordScan(reports: ScoutReport[], source = 'unknown scan') {
    this.scanCount += 1;
    const scanComparisons: ShadowComparison[] = reports.map(report => {
      const key = shadowKey(report);
      const previous = this.previousStates.get(key) ?? null;
      const v2 = evaluateLifecycle(lifecycleInputFromScoutReport(report, previous));
      if (previous !== v2.current_state) {
        this.transitions.push({
          key,
          symbol: report.pair,
          timeframe: report.timeframe,
          from: previous,
          to: v2.current_state,
          reason: v2.reason,
          sequence: this.transitions.length + 1,
        });
        this.previousStates.set(key, v2.current_state);
      }
      const phase = scoutPhaseState(report).label;
      const v1Mapped = mapV1PhaseToLifecycleState(phase);
      const partial = {
        symbol: report.pair,
        timeframe: report.timeframe,
        v1_result: phase,
        v1_mapped_state: v1Mapped,
        v2_result: v2,
        matches: v1Mapped === v2.current_state,
        disagreement_engine: v1Mapped === v2.current_state ? null : disagreementEngine(v2),
        most_important_missing_requirement: v2.missing_requirements[0] ?? null,
      };
      return {
        ...partial,
        disagreement_reason: disagreementReason(partial),
      };
    });
    this.comparisons.push(...scanComparisons);
    if (this.comparisons.length > 2500) this.comparisons = this.comparisons.slice(-2500);
    if (this.transitions.length > 1000) this.transitions = this.transitions.slice(-1000);
    return {
      source,
      comparisons: scanComparisons,
      summary: this.summary(),
      transitions: this.transitions.slice(-25),
    };
  }

  summary(): LifecycleDiagnosticsSummary {
    const comparisons = this.comparisons;
    const matching = comparisons.filter(c => c.matches).length;
    const different = comparisons.length - matching;
    const missing = comparisons
      .map(c => c.most_important_missing_requirement)
      .filter((v): v is string => Boolean(v));
    const disagreementCategories = comparisons
      .filter(c => !c.matches)
      .map(c => c.disagreement_reason || 'Unknown disagreement');
    const disagreementEngines = comparisons
      .filter(c => !c.matches)
      .map(c => c.disagreement_engine)
      .filter((v): v is EngineName => Boolean(v));
    const avgOrder = comparisons.length
      ? Math.round(comparisons.reduce((sum, c) => sum + STATE_ORDER[c.v2_result.current_state], 0) / comparisons.length)
      : null;
    const avgStage = avgOrder === null
      ? null
      : Object.entries(STATE_ORDER)
        .sort((a, b) => Math.abs(a[1] - avgOrder) - Math.abs(b[1] - avgOrder) || a[0].localeCompare(b[0]))[0][0] as LifecycleState;

    return {
      scans: this.scanCount,
      comparisons: comparisons.length,
      matching_states: matching,
      different_states: different,
      v1_enter_now: comparisons.filter(c => c.v1_result === 'Enter Now').length,
      v2_enter_now: comparisons.filter(c => ['STRUCTURE_CONFIRMED', 'SETUP_CONFIRMED_WAITING_FOR_ENTRY', 'ENTRY_REACHED'].includes(c.v2_result.current_state)).length,
      largest_disagreement_category: topCount(countBy(disagreementCategories)),
      largest_disagreement_engine: topCount(countBy(disagreementEngines)) as EngineName | null,
      most_common_missing_requirement: topCount(countBy(missing)),
      average_lifecycle_stage: avgStage,
      transitions: this.transitions.length,
    };
  }

  recentTransitions(limit = 25) {
    return this.transitions.slice(-limit);
  }
}

export const lifecycleDiagnostics = new LifecycleDiagnosticsStore();

export function recordLifecycleShadowScan(reports: ScoutReport[], source = 'unknown scan') {
  return lifecycleDiagnostics.recordScan(reports, source);
}

export function formatLifecycleDiagnosticsSummary(summary = lifecycleDiagnostics.summary()) {
  return [
    '[V2 Lifecycle Shadow]',
    `Scans ${summary.scans}`,
    `Comparisons ${summary.comparisons}`,
    `Matching ${summary.matching_states}`,
    `Disagreements ${summary.different_states}`,
    `Top disagreement ${summary.largest_disagreement_category || 'None'}`,
    `Top engine ${summary.largest_disagreement_engine || 'None'}`,
    `Most common missing ${summary.most_common_missing_requirement || 'None'}`,
    `Average lifecycle stage ${summary.average_lifecycle_stage || 'N/A'}`,
    `Transitions ${summary.transitions}`,
  ].join(' | ');
}
