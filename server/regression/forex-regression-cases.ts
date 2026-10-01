import type { ScoutReport } from '../scanner.js';
import type { ScoutPhaseLabel } from '../scoutPhase.js';

export interface ForexRegressionCase {
  name: string;
  report: ScoutReport;
  expected: {
    phase: ScoutPhaseLabel;
    progress?: number;
    nextStep?: string | RegExp;
    nextMilestone?: string | RegExp;
    alertRoute: 'urgent' | 'soft' | 'none';
    headlineIncludes?: string;
  };
}

type ScoutOverrides = Partial<ScoutReport>;

function scoutReport(overrides: ScoutOverrides): ScoutReport {
  const direction = overrides.tradeDirection || 'LONG';
  const bullish = direction === 'LONG';
  return {
    pair: bullish ? 'EUR_USD' : 'GBP_JPY',
    displaySymbol: bullish ? 'EUR/USD' : 'GBP/JPY',
    price: bullish ? 1.105 : 214.5,
    bias: bullish ? 'BULLISH' : 'BEARISH',
    scoutDirection: direction,
    tradeDirection: direction,
    htfBias: bullish ? 'BULLISH' : 'BEARISH',
    zone: bullish ? 'DISCOUNT' : 'PREMIUM',
    nearestResistance: bullish ? 1.108 : 215.2,
    nearestSupport: bullish ? 1.103 : 213.4,
    recentBOS: null,
    recentChoCH: null,
    atr: bullish ? 0.001 : 0.6,
    rsi: bullish ? 52 : 48,
    ema20: bullish ? 1.104 : 214.7,
    session: 'London+NY overlap',
    interestLevel: 'HIGH',
    timeframe: 'H1',
    scannedAt: '2026-06-30T18:00:00.000Z',
    candleTime: '2026-06-30T18:00:00.000Z',
    newsRisk: false,
    momentumScore: 70,
    momentumLabel: bullish ? 'Bullish' : 'Bearish',
    momentumAlignedWithBias: true,
    momentumConflict: false,
    pullbackScore: 70,
    pullbackStatus: 'Stabilizing',
    pullbackCompleted: true,
    pullbackReason: 'Pullback is controlled.',
    confirmationScore: 70,
    confirmationStatus: 'Building confirmation',
    confirmationConfirmed: true,
    confirmationReason: bullish ? 'Bullish confirmation is active.' : 'Bearish confirmation is active.',
    reversalConfirmed: true,
    reversalReason: bullish ? 'Bullish reaction detected.' : 'Bearish reaction detected.',
    setupGrade: 'A',
    setupGradeReason: 'Trend and location align; structure shift detected.',
    evalEligible: false,
    evalReason: 'Entry trigger is not active yet.',
    entryTimingState: 'Reaction Started',
    entryTimingReason: bullish
      ? 'Reaction started: price is near the area.'
      : 'Reaction started: price is near the area.',
    trendDirection: bullish ? 'Bullish' : 'Bearish',
    trendScore: 70,
    trendReason: 'Trend is clear.',
    dailyTrendDirection: bullish ? 'Bullish' : 'Bearish',
    dailySwingStructure: bullish ? 'HH/HL' : 'LH/LL',
    dailyBosDirection: bullish ? 'Bullish' : 'Bearish',
    dailyChochDirection: 'Neutral',
    h4TrendDirection: bullish ? 'Bullish' : 'Bearish',
    setupTimeframeDirection: bullish ? 'Bullish' : 'Bearish',
    setupTimeframeScore: 70,
    setupTimeframeReason: 'Current timeframe flow aligns.',
    marketPhase: 'Trend Move',
    marketPhaseReason: 'Trending market.',
    trendSetupAligned: true,
    isPullbackAgainstTrend: false,
    entryStatus: 'Near Entry',
    distanceFromEntryAtr: 0.25,
    distanceFromEntryPercent: 0.02,
    zoneTouchState: 'REJECTING',
    activeZoneType: bullish ? 'DEMAND' : 'SUPPLY',
    activeZoneHigh: bullish ? 1.1052 : 214.9,
    activeZoneLow: bullish ? 1.1044 : 214.3,
    currentCandleHigh: bullish ? 1.1051 : 214.8,
    currentCandleLow: bullish ? 1.1046 : 214.4,
    zoneInteraction: bullish ? 'DEMAND_RECLAIM' : 'SUPPLY_RECLAIM',
    decisionLevel: bullish ? 1.106 : 214.1,
    decisionLevelConfirmed: true,
    decisionLevelReason: bullish
      ? 'price has closed above nearest resistance 1.10600.'
      : 'price has closed below nearest support 214.100.',
    entrySource: 'Active zone',
    slSource: 'Structure',
    tp1Source: 'Structure',
    tp2Source: 'Extension',
    planQuality: 'Clean',
    planQualityReason: 'Plan has enough room.',
    entry: bullish ? 1.105 : 214.5,
    sl: bullish ? 1.103 : 215.2,
    tp1: bullish ? 1.109 : 213.1,
    tp2: bullish ? 1.111 : 212.4,
    rrRatio: 2.0,
    ...overrides,
  };
}

export const forexRegressionCases: ForexRegressionCase[] = [
  {
    name: 'Bullish Enter Now routes to urgent Telegram alert',
    report: scoutReport({
      pair: 'EUR_USD',
      displaySymbol: 'EUR/USD',
      tradeDirection: 'LONG',
      bias: 'BULLISH',
      entryStatus: 'Tradeable',
      entryTimingState: 'Entry Triggered',
      evalEligible: true,
      evalReason: 'Eval eligible.',
      decisionLevelConfirmed: true,
    }),
    expected: {
      phase: 'Enter Now',
      progress: 100,
      nextStep: 'Review active entry plan',
      nextMilestone: 'Entry trigger active',
      alertRoute: 'urgent',
      headlineIncludes: 'ENTER NOW',
    },
  },
  {
    name: 'Bearish Enter Now routes to urgent Telegram alert',
    report: scoutReport({
      pair: 'GBP_JPY',
      displaySymbol: 'GBP/JPY',
      tradeDirection: 'SHORT',
      bias: 'BEARISH',
      entryStatus: 'Tradeable',
      entryTimingState: 'Entry Triggered',
      evalEligible: true,
      evalReason: 'Eval eligible.',
      decisionLevelConfirmed: true,
    }),
    expected: {
      phase: 'Enter Now',
      progress: 100,
      nextStep: 'Review active entry plan',
      nextMilestone: 'Entry trigger active',
      alertRoute: 'urgent',
      headlineIncludes: 'ENTER NOW',
    },
  },
  {
    name: 'Bullish Almost Ready stays soft and waits for confirmation',
    report: scoutReport({
      pair: 'EUR_GBP',
      displaySymbol: 'EUR/GBP',
      tradeDirection: 'LONG',
      bias: 'BULLISH',
      entryTimingState: 'Reaction Started',
      evalEligible: false,
      reversalConfirmed: false,
      confirmationConfirmed: false,
    }),
    expected: {
      phase: 'Almost Ready',
      progress: 85,
      nextStep: 'Wait for bullish confirmation',
      nextMilestone: 'Bullish confirmation',
      alertRoute: 'soft',
      headlineIncludes: 'Almost Ready',
    },
  },
  {
    name: 'Bearish Almost Ready stays soft and waits for confirmation',
    report: scoutReport({
      pair: 'XAU_USD',
      displaySymbol: 'XAU/USD',
      tradeDirection: 'SHORT',
      bias: 'BEARISH',
      entryTimingState: 'Area Reached',
      evalEligible: false,
      reversalConfirmed: false,
      confirmationConfirmed: false,
    }),
    expected: {
      phase: 'Almost Ready',
      progress: 85,
      nextStep: 'Wait for bearish confirmation',
      nextMilestone: 'Bearish confirmation',
      alertRoute: 'soft',
      headlineIncludes: 'Almost Ready',
    },
  },
  {
    name: 'Waiting setup asks for price to reach entry and does not alert',
    report: scoutReport({
      pair: 'AUD_USD',
      displaySymbol: 'AUD/USD',
      tradeDirection: 'LONG',
      bias: 'BULLISH',
      entryStatus: 'Too Far',
      entryTimingState: 'Not Ready',
      evalEligible: false,
      distanceFromEntryAtr: 2.4,
      setupGrade: 'B',
    }),
    expected: {
      phase: 'Waiting',
      progress: 55,
      nextStep: 'Wait for price to reach entry',
      nextMilestone: 'Reach entry area',
      alertRoute: 'none',
    },
  },
  {
    name: 'Decision-level wait uses close above level without urgent alert',
    report: scoutReport({
      pair: 'NZD_USD',
      displaySymbol: 'NZD/USD',
      tradeDirection: 'LONG',
      bias: 'BULLISH',
      entryTimingState: 'Reaction Started',
      evalEligible: false,
      decisionLevel: 1.1054,
      decisionLevelConfirmed: false,
      decisionLevelReason: 'price has not closed above nearest resistance 1.10540 yet',
    }),
    expected: {
      phase: 'Almost Ready',
      progress: 85,
      nextStep: 'Wait for close above 1.10540',
      nextMilestone: /close above 1\.10540/i,
      alertRoute: 'soft',
    },
  },
  {
    name: 'Skip setup does not alert',
    report: scoutReport({
      pair: 'USD_CAD',
      displaySymbol: 'USD/CAD',
      tradeDirection: 'LONG',
      bias: 'BULLISH',
      setupGrade: 'C',
      setupGradeReason: 'Location conflicts with trade direction.',
      zone: 'PREMIUM',
      entryTimingState: 'Not Ready',
      evalEligible: false,
    }),
    expected: {
      phase: 'Skip',
      progress: 0,
      nextStep: 'Do not trade this setup',
      nextMilestone: 'Do not trade',
      alertRoute: 'none',
    },
  },
];

export const duplicateEnterNowCase = {
  name: 'Duplicate Enter Now same candle is suppressed by dedupe key',
  report: forexRegressionCases[0].report,
};
