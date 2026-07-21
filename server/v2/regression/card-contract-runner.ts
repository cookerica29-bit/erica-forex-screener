import fs from 'fs';
import { buildForexV2LifecycleCard } from '../cardContract.js';
import type { ScoutReport } from '../../scanner.js';

interface Failure {
  caseName: string;
  message: string;
}

const failures: Failure[] = [];

function assertCase(caseName: string, condition: boolean, message: string) {
  if (!condition) failures.push({ caseName, message });
}

function filterByTimeframe<T extends { timeframe?: string | null }>(rows: T[], timeframe: string) {
  return rows.filter(row => timeframe === 'ALL' || String(row.timeframe || '').toUpperCase() === timeframe);
}

function report(overrides: Partial<ScoutReport> = {}): ScoutReport {
  return {
    pair: 'EUR_USD',
    displaySymbol: 'EUR/USD',
    price: 1.1661,
    bias: 'BULLISH',
    scoutDirection: 'LONG',
    tradeDirection: 'LONG',
    htfBias: 'BULLISH',
    zone: 'DISCOUNT',
    nearestResistance: 1.1725,
    nearestSupport: 1.1638,
    recentBOS: null,
    recentChoCH: null,
    atr: 0.002,
    rsi: 52,
    ema20: 1.165,
    session: 'London',
    interestLevel: 'HIGH',
    timeframe: 'M30',
    scannedAt: '2026-07-14T12:00:00.000Z',
    candleTime: '2026-07-14T12:00:00.000Z',
    momentumScore: 4,
    momentumLabel: 'Bullish',
    momentumAlignedWithBias: true,
    momentumConflict: false,
    pullbackScore: 8,
    pullbackStatus: 'Reversal forming',
    pullbackCompleted: false,
    pullbackReason: 'Pullback is stabilizing.',
    confirmationScore: 8,
    confirmationStatus: 'Strong confirmation',
    confirmationConfirmed: false,
    confirmationReason: 'Confirmation is building.',
    reversalConfirmed: true,
    reversalReason: 'Bullish structure confirmed.',
    setupGrade: 'A',
    setupGradeReason: 'Trend and location align.',
    evalEligible: false,
    evalReason: 'Watch only.',
    entryTimingState: 'Area Reached',
    entryTimingReason: 'Area reached.',
    trendDirection: 'Bullish',
    trendScore: 8,
    trendReason: 'Daily and H4 bullish.',
    dailyTrendDirection: 'Bullish',
    dailySwingStructure: 'HH/HL',
    dailyBosDirection: 'Bullish',
    dailyChochDirection: 'Neutral',
    h4TrendDirection: 'Bullish',
    setupTimeframeDirection: 'Bullish',
    setupTimeframeScore: 8,
    setupTimeframeReason: 'M30 bullish.',
    marketPhase: 'Bullish Continuation',
    marketPhaseReason: 'Trend and setup align.',
    trendSetupAligned: true,
    isPullbackAgainstTrend: false,
    entryStatus: 'Waiting',
    distanceFromEntryAtr: 0.4,
    distanceFromEntryPercent: 0.02,
    zoneTouchState: 'REJECTING',
    activeZoneType: 'DEMAND',
    activeZoneHigh: 1.166,
    activeZoneLow: 1.164,
    currentCandleHigh: 1.167,
    currentCandleLow: 1.164,
    zoneInteraction: 'FRESH_TEST',
    decisionLevel: 1.1675,
    decisionLevelConfirmed: true,
    decisionLevelReason: 'Decision level confirmed.',
    entrySource: 'Nearest demand / pullback zone',
    slSource: 'Below nearest support with ATR buffer',
    tp1Source: 'Next valid swing high at or above 2R',
    tp2Source: 'Next swing high beyond TP1',
    planQuality: 'Clean',
    planQualityReason: 'Plan has complete levels.',
    entry: 1.1652,
    sl: 1.1638,
    tp1: 1.169,
    tp2: 1.1725,
    rrRatio: 2.71,
    ...overrides,
  } as ScoutReport;
}

const card = buildForexV2LifecycleCard(report());
assertCase('Card exposes engine state', card.state === 'SETUP_CONFIRMED_WAITING_FOR_ENTRY', `unexpected state ${card.state}`);
assertCase('Card exposes next step from engine', /planned entry/.test(card.next_step), `unexpected next step ${card.next_step}`);
assertCase('Card exposes transition reason', card.transition_reason.length > 0, 'missing transition reason');
assertCase('Card exposes completed requirements', card.completed.includes('Liquidity Sweep') && card.completed.includes('Structure Confirmation'), `unexpected completed ${card.completed.join(',')}`);
assertCase('Card exposes missing requirements', card.missing.includes('Entry Reached'), `unexpected missing ${card.missing.join(',')}`);
assertCase('Execution plan matches engine input', card.execution_plan.planned_entry === '1.16520' && card.execution_plan.stop === '1.16380' && card.execution_plan.tp1 === '1.16900', `unexpected execution plan ${JSON.stringify(card.execution_plan)}`);
assertCase('Lifecycle progress highlights current state', card.lifecycle.some(step => step.status === 'active' && step.label === 'Entry Planned'), `unexpected lifecycle ${JSON.stringify(card.lifecycle)}`);

const contextBlockedCard = buildForexV2LifecycleCard(report({
  pair: 'AUD_USD',
  displaySymbol: 'AUD/USD',
  tradeDirection: 'LONG',
  bias: 'BULLISH',
  zone: 'PREMIUM',
  dailyTrendDirection: 'Bearish',
  h4TrendDirection: 'Bullish',
  reversalConfirmed: true,
  reversalReason: 'bullish CHoCH detected after the pullback.',
  confirmationConfirmed: true,
  decisionLevelConfirmed: false,
  zoneTouchState: 'NONE',
  zoneInteraction: 'NONE',
  entryStatus: 'Tradeable',
  entryTimingState: 'Not Ready',
  entry: 0.69902,
  sl: 0.698,
  tp1: 0.70126,
  rrRatio: 2.2,
}));
assertCase('Context-blocked card stays in building state', contextBlockedCard.state === 'BUILDING', `unexpected state ${contextBlockedCard.state}`);
assertCase('Context-blocked card labels active stage clearly', contextBlockedCard.lifecycle.some(step => step.status === 'active' && step.label === 'Market Scan — Context Blocked'), `unexpected lifecycle ${JSON.stringify(contextBlockedCard.lifecycle)}`);
assertCase('Context-blocked card separates conflicts from pending work', contextBlockedCard.blocking_conflicts.includes('Daily Bias') && contextBlockedCard.blocking_conflicts.includes('Location') && contextBlockedCard.not_yet_met.includes('Liquidity Sweep') && contextBlockedCard.not_yet_met.includes('Entry Reached'), `unexpected split conflicts=${contextBlockedCard.blocking_conflicts.join(',')} pending=${contextBlockedCard.not_yet_met.join(',')}`);
assertCase('Context-blocked card keeps later completed evidence visible', contextBlockedCard.completed.includes('Structure Confirmation') && contextBlockedCard.completed.includes('Planned Entry'), `unexpected completed ${contextBlockedCard.completed.join(',')}`);
assertCase('Context-blocked card explains gated lifecycle', Boolean(contextBlockedCard.stage_note && contextBlockedCard.stage_note.includes('cannot advance until Daily Bias and Location are resolved')), `unexpected note ${contextBlockedCard.stage_note}`);

const html = fs.readFileSync('public/index.html', 'utf8');
const rendererStart = html.indexOf('function renderForexV2LifecycleCard');
const rendererEnd = html.indexOf('function renderScoutCard', rendererStart);
const renderer = html.slice(rendererStart, rendererEnd);
const forexCardRendererStart = html.indexOf('function renderForexCard');
const forexCardRendererEnd = html.indexOf('function renderV2List', forexCardRendererStart);
const forexCardRenderer = html.slice(forexCardRendererStart, forexCardRendererEnd);
const compareBranchStart = forexCardRenderer.indexOf('if (forexCardV2CompareEnabled())');
const compareBranchEnd = forexCardRenderer.indexOf('return renderForexV2LifecycleCard', compareBranchStart);
const compareBranch = forexCardRenderer.slice(compareBranchStart, compareBranchEnd);
const inspectorStart = html.indexOf('function v2RequirementKeysByStatus');
const inspectorEnd = html.indexOf('function renderForexV2LifecycleCard', inspectorStart);
const inspector = html.slice(inspectorStart, inspectorEnd);
const scoutRenderer = html.slice(rendererEnd);
const filteredFunctionStart = html.indexOf('function getFiltered');
const filteredFunctionEnd = html.indexOf('function entryStatusRank', filteredFunctionStart);
const filteredFunction = html.slice(filteredFunctionStart, filteredFunctionEnd);
const timeframeFixture = [
  { pair: 'EUR_USD', timeframe: 'H4' },
  { pair: 'AUD_USD', timeframe: 'H1' },
  { pair: 'GBP_JPY', timeframe: 'M30' },
];
assertCase('Frontend v2 renderer exists', rendererStart > -1 && rendererEnd > rendererStart, 'v2 renderer function not found');
assertCase('Frontend reads Decision Engine card payload', renderer.includes('r.v2LifecycleCard'), 'renderer should consume v2LifecycleCard');
assertCase('Frontend v2 renderer avoids trading calculations', !/(BOS|CHoCH|premium|discount|liquidity|entryTimingState|decisionLevelConfirmed|recentBOS|recentChoCH)/i.test(renderer), 'v2 renderer should not duplicate trading logic terms');
assertCase('Frontend separates conflict and pending requirement lists', renderer.includes('Blocking Conflicts') && renderer.includes('Not Yet Met') && renderer.includes('card.blocking_conflicts') && renderer.includes('card.not_yet_met'), 'v2 renderer should split incomplete requirements into conflict and pending groups');
assertCase('Frontend renders stage note when lifecycle is gated', renderer.includes('card.stage_note') && renderer.includes('entry-note'), 'v2 renderer should show gated lifecycle note when present');
assertCase('Frontend v2 renderer restores shared trade actions', renderer.includes("renderTradeActionBlock(actionSetup, 'v2-scout')") && renderer.includes('const actionSetup = {'), 'v2 renderer should render the shared calculator/journal action block');
assertCase('Frontend v2 journal action uses Scout direction and unique key', renderer.includes('direction: tradeDirectionForReport(r)') && renderer.includes("-v2`"), 'v2 journal action should use current Scout direction and a v2-specific key');
assertCase('Frontend v2 journal action uses valid journal quality', renderer.includes("quality: 'DEVELOPING'") && !renderer.includes('quality: r.setupGrade'), 'v2 journal action should not send A/B/C grade as journal quality enum');
assertCase('Frontend shared trade action posts to journal', html.includes('function saveCardTradeToJournal') && html.includes("fetch('/api/journal'") && html.includes('Save to Journal'), 'shared trade action should persist through existing journal POST flow');
assertCase('Dead legacy pushToJournal helper removed', !html.includes('function pushToJournal(') && !html.includes('onclick="pushToJournal'), 'legacy pushToJournal helper should not remain without callers');
assertCase('Frontend renders timeframe display filter', html.includes('id="timeframeFilter"') && html.includes('Timeframe: H4') && html.includes('Timeframe: All'), 'timeframe display filter should be present');
assertCase('Frontend getFiltered reads timeframe filter', filteredFunction.includes("document.getElementById('timeframeFilter')?.value || 'ALL'") && filteredFunction.includes("String(x.timeframe || '').toUpperCase() !== timeframe"), 'getFiltered should filter by ScoutReport timeframe');
assertCase('Timeframe filter keeps only H4 rows', filterByTimeframe(timeframeFixture, 'H4').map(row => row.pair).join(',') === 'EUR_USD', 'H4 filter should only keep H4 rows');
assertCase('Timeframe filter ALL excludes nothing', filterByTimeframe(timeframeFixture, 'ALL').length === timeframeFixture.length, 'ALL timeframe filter should not exclude rows');
assertCase('V2 renderer is the default card surface', html.includes("localStorage.getItem(FOREX_CARD_V2_FLAG) !== 'false'") && html.includes('if (!forexCardV2Enabled()) return renderScoutCard(r);'), 'v2 renderer should be default, with v1 available only by explicit opt-out');
assertCase('Comparison mode renders both cards', html.includes('V1 Card') && html.includes('V2 Lifecycle Card') && html.includes('renderScoutCard(r)'), 'comparison mode should render both cards');
assertCase('Comparison mode keeps paired cards in one wrapper', compareBranch.includes('<div class="forex-v2-compare">') && compareBranch.includes('forex-v2-compare-side-v1') && compareBranch.includes('forex-v2-compare-side-v2'), 'comparison branch should wrap V1 and V2 sides together');
assertCase('Comparison wrapper renders exactly one V1 and one V2 card', (compareBranch.match(/renderScoutCard\(r\)/g) || []).length === 1 && (compareBranch.match(/renderForexV2LifecycleCard\(r\)/g) || []).length === 1, 'comparison wrapper should contain one V1 renderer and one V2 renderer');
assertCase('V2 mode suppresses separate developing card grid', html.includes('renderDevelopingSetups(forexCardV2Enabled() ? [] : filtered);'), 'v2 mode should not render a separate V1-like developing grid before lifecycle cards');
assertCase('Developer inspector is collapsed in v2 renderer', inspector.includes('<details class="forex-v2-inspector">') && inspector.includes('<summary>Developer State Inspector</summary>') && renderer.includes('renderV2DeveloperInspector(card)'), 'developer inspector should render as collapsed details');
assertCase('Developer inspector reads only v2 card payload', inspectorStart > -1 && inspectorEnd > inspectorStart && inspector.includes('card?.engine_snapshot?.requirements') && inspector.includes('card?.execution_plan') && !/\br\./.test(inspector), 'inspector should read from v2LifecycleCard-derived card only');
assertCase('Developer inspector hidden when v2 disabled', scoutRenderer.includes('function renderScoutCard') && !scoutRenderer.includes('Developer State Inspector'), 'v1 renderer should not include developer inspector');

console.log('\n-- Kairos Forex v2 Card Contract Regression Suite ------------------');
const groupedFailures = new Set(failures.map(f => f.caseName));
if (!failures.length) {
  console.log(`PASS v2 card state=${card.state}`);
  console.log(`PASS execution plan entry=${card.execution_plan.planned_entry}, stop=${card.execution_plan.stop}, tp1=${card.execution_plan.tp1}`);
  console.log('PASS frontend renderer consumes v2LifecycleCard without trading logic terms');
  console.log('PASS developer inspector is v2-only and card-payload sourced');
} else {
  for (const failure of failures) console.log(`FAIL ${failure.caseName}: ${failure.message}`);
}
const totalCases = 18;
console.log(`\nTotal: ${totalCases} | Passed: ${totalCases - groupedFailures.size} | Failed: ${groupedFailures.size}`);

if (failures.length) process.exit(1);
