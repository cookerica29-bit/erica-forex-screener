// Required env vars: OANDA_API_KEY, OANDA_ACCOUNT_TYPE
// Optional alerts/execution: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TRADINGVIEW_WEBHOOK_SECRET, BOT_URL, WEBHOOK_SECRET
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { getJournalEntries, createJournalEntry, updateJournalEntry, deleteJournalEntry, clearAllJournalEntries, getPatternStats, getSetting, setSetting, deleteSetting, getSettingsStorageInfo } from './db.js';
import { debugScan, Setup, JournalStats, fetchCandles, computeStructures, PAIRS as FULL_PAIRS, runScoutScan, ScoutReport, runScalpScan, ScalpReport, runTrendScan, TrendReport, TrendScanResult, runIndependentWatchlistScan } from './scanner.js';
import {
  isLocationAlignedForTrade,
  isSetupFlowAlignedForTrade,
  isTradeableScoutSignal,
  isWatchScoutSignal,
  scoutNextMilestone,
  scoutNextStep,
  scoutPhaseState,
  scoutShortReason,
  scoutTradeDirection,
  tradeableSignalAlertKey,
  tradeableSignalDataKey,
} from './scoutPhase.js';
import { attachForexV2LifecycleCards } from './v2/cardContract.js';
import { formatLifecycleDiagnosticsSummary, recordLifecycleShadowScan } from './v2/diagnostics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());

const server = createServer(app);

app.use(express.json());
app.use(express.text({ type: 'text/plain' }));

let latestSetups: Setup[] = [];
let latestScoutResults: ScoutReport[] = [];
let latestScoutDiagnostics: ScoutDiagnosticsReport | null = null;
let latestScalpResults: ScalpReport[] = [];
let latestTrendResults: TrendScanResult | null = null;
let lastTrendScanTime: string | null = null;
let trendScanInFlight: Promise<TrendScanResult> | null = null;
let trendingMembershipInitialized = false;
let previousTrendingPairs = new Set<string>();
let latestRejected: Array<{ pair: string; reason: string; detail: any; granularity: string }> = [];
let cachedJournalStats: JournalStats = {};
let lastScanTime: string | null = null;
let pendingApprovals: (Setup & { id: string })[] = [];
const tradeableSignalAlerts = new Map<string, number>();
const tradeableSignalCandleTimes = new Map<string, string>();
const tradeableSignalDiagnosticOutcomes = new Map<string, { decision: ScoutDiagnosticDecision; reasons: string[]; updatedAt: number }>();
const TRADEABLE_SIGNAL_ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const pineConfirmations = new Map<string, PineConfirmation>();
const pineConfirmationAlerts = new Map<string, number>();
const PINE_CONFIRMATION_TTL_MS = 12 * 60 * 60 * 1000;
const PINE_CONFIRMATION_ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const pineZones = new Map<string, PineZone>();
const PINE_ZONE_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_SCOUT_ALERT_RR = 2.0;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_AI_STUDIO_MODEL = process.env.OPENAI_AI_STUDIO_MODEL || 'gpt-4.1-mini';
const AI_STUDIO_DISCLAIMER = 'Educational trading content only. This is not financial advice, not a signal service, and no trade outcome is guaranteed.';

type ScoutDiagnosticDecision = 'Alert sent' | 'Watch only' | 'Rejected' | 'Duplicate suppressed' | 'Stale candle suppressed' | 'Cooldown suppressed' | 'Market closed suppressed' | 'Telegram failed';

interface ScoutDiagnosticRow {
  pair: string;
  timeframe: string;
  directionConsidered: string;
  trendHtfAlignment: string;
  location: string;
  structureShift: string;
  reversalConfirmation: string;
  timingState: string;
  entryDistance: number | null;
  rr: number | null;
  session: string;
  cooldownStatus: string;
  candleTime: string;
  staleCandleStatus: string;
  finalDecision: ScoutDiagnosticDecision;
  rejectionReasons: string[];
  setupGrade: string;
  evalEligible: boolean;
  interestLevel: string;
  entryStatus: string;
  pineConfirmation: string;
}

interface ScoutDiagnosticsReport {
  generatedAt: string;
  source: string;
  summary: {
    totalPairsScanned: number;
    totalCandidatesFound: number;
    totalASetups: number;
    totalBSetups: number;
    totalEvalEligible: number;
    totalAlertsSent: number;
    topRejectionReasons: Array<{ reason: string; count: number }>;
    repeatedPairCounts: Array<{ pair: string; count: number }>;
    scannedButNeverCandidates: string[];
    timeframesActive: string[];
    metalsScanned: Array<{ pair: string; timeframes: string[] }>;
    rrFilterBlocks: number;
    pineConfirmationBlocks: number;
    cooldownSuppressions: number;
    staleCandleSuppressions: number;
    sessionSuppressions: number;
  };
  rows: ScoutDiagnosticRow[];
  notes: string[];
}

interface PineConfirmation {
  symbol: string;
  displaySymbol: string;
  timeframe: string;
  direction: 'LONG' | 'SHORT';
  zoneType: 'DEMAND' | 'SUPPLY' | 'UNKNOWN';
  rejectionType: string;
  price?: number;
  zoneHigh?: number;
  zoneLow?: number;
  message: string;
  receivedAt: string;
  sourceTime?: string;
  matched: boolean;
  matchReason: string;
  scoutKey?: string;
}

interface PineZone {
  symbol: string;
  displaySymbol: string;
  timeframe: string;
  direction: 'LONG' | 'SHORT';
  zoneType: 'DEMAND' | 'SUPPLY';
  zoneHigh: number;
  zoneLow: number;
  price?: number;
  message: string;
  receivedAt: string;
  sourceTime?: string;
  source: 'TradingView/Pine';
}

type AiStudioSection = { label: string; value: string; large?: boolean };
type AiStudioTemplate = { name: string; useCase?: string; length?: string; tone?: string; outputs?: string; angle?: string };
type AiStudioBrand = {
  voice?: string[] | string;
  avoid?: string[] | string;
  audience?: string;
  teachingStructure?: string[];
  signatureSegments?: string[];
};
type AiStudioKnowledgeItem = {
  title?: string;
  category?: string;
  summary?: string;
  details?: string;
  example?: string;
  status?: string;
};

function aiStudioTemplate(templateKey = 'quickTradeBreakdown', templates?: Record<string, AiStudioTemplate>) {
  const fallback = {
    name: 'Quick Trade Breakdown',
    useCase: 'Fast setup explanation for a single scanner signal.',
    length: '2-4 min',
    tone: 'Direct, tactical, concise',
    outputs: 'YouTube, Shorts, X, Instagram',
    angle: 'fast setup review',
  };
  return templates?.[templateKey] || templates?.quickTradeBreakdown || fallback;
}

function aiStudioDirection(trade: any) {
  const raw = String(trade?.direction || trade?.bias || trade?.trendDirection || '').toUpperCase();
  return raw.includes('SHORT') || raw.includes('SELL') || raw.includes('BEAR') ? 'SHORT' : 'LONG';
}

function aiStudioNumber(value: any, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return Math.abs(n) >= 100 ? n.toFixed(3) : n.toFixed(5);
}

function aiStudioFoundTime(row: any) {
  const raw = row?.scannedAt || row?.candleTime || row?.foundAt;
  if (!raw) return 'Recent';
  try { return new Date(raw).toLocaleString(); } catch { return String(raw); }
}

function aiStudioPairLabel(raw: any) {
  return String(raw || 'this pair').replace('_', '/');
}

function aiStudioBrandProfile(input: AiStudioBrand = {}) {
  const voiceList = Array.isArray(input.voice) ? input.voice : String(input.voice || 'Professional, Educational, Calm, Confident').split(',');
  const avoidList = Array.isArray(input.avoid) ? input.avoid : String(input.avoid || 'Clickbait, Hype, False urgency, Guaranteed profit language').split(',');
  const structure = Array.isArray(input.teachingStructure) && input.teachingStructure.length
    ? input.teachingStructure
    : ['Hook', 'Setup Overview', 'Scanner Analysis', 'Risk Discussion', 'Educational Lesson', 'Call To Action'];
  const segments = Array.isArray(input.signatureSegments) && input.signatureSegments.length
    ? input.signatureSegments
    : ["Today's Setup", 'Why It Qualified', 'Kairos Insight', 'Risk Reminder', "Today's Lesson", "What I'll Be Watching Next"];
  const audience = input.audience || 'Prop Firm Traders';
  const audienceLine = audience === 'Beginner'
    ? 'Explain terms simply and define scanner context before assuming trading knowledge.'
    : audience === 'Advanced'
    ? 'Keep the explanation efficient and focus on process, structure, risk, and execution quality.'
    : audience === 'Intermediate'
    ? 'Balance plain-English teaching with practical trading terminology.'
    : 'Connect the lesson to patience, risk control, drawdown protection, and eval consistency.';
  return {
    voice: voiceList.map(v => String(v).trim()).filter(Boolean).join(', ') || 'Professional, Educational',
    avoid: avoidList.map(v => String(v).trim()).filter(Boolean).join(', ') || 'Clickbait, Hype, False urgency, Guaranteed profit language',
    audience,
    structure,
    segments,
    audienceLine,
  };
}

function aiStudioSignatureBlock(profile: ReturnType<typeof aiStudioBrandProfile>) {
  return profile.segments.map(segment => {
    if (/risk/i.test(segment)) return `${segment}: This is a review candidate, not a guaranteed trade. Risk must stay defined before entry.`;
    if (/qualified|why/i.test(segment)) return `${segment}: It qualified because the scanner found structure, location, and a defined trade plan from available data.`;
    if (/insight/i.test(segment)) return `${segment}: Kairos helps narrow attention, but chart confirmation still matters.`;
    if (/watch/i.test(segment)) return `${segment}: I am watching whether price respects the planned area and whether confirmation holds.`;
    if (/lesson/i.test(segment)) return `${segment}: The lesson is to separate a good area from a confirmed entry.`;
    return `${segment}: Use the scanner output as a starting point for structured review.`;
  }).join('\n');
}

function aiStudioTeachingBlock(profile: ReturnType<typeof aiStudioBrandProfile>, context: any) {
  const map: Record<string, string> = {
    Hook: `Hook: ${context.pair} printed a ${context.grade}-grade ${context.direction} idea, but the value is in reviewing the process, not chasing a signal.`,
    'Setup Overview': `Setup Overview: ${context.pair} on ${context.tf} is framed as a ${context.direction} idea from ${context.location}.`,
    'Scanner Analysis': 'Scanner Analysis: Kairos surfaced the setup using available scanner data, including grade, bias/location context, and planned levels.',
    'Risk Discussion': `Risk Discussion: Entry ${context.entry}, SL ${context.sl}, TP ${context.tp}, planned R:R ${context.rr}. No outcome is guaranteed.`,
    'Educational Lesson': `Educational Lesson: ${profile.audienceLine}`,
    'Call To Action': 'Call To Action: Review the chart, journal the idea, and only act if the live setup still confirms.',
  };
  return profile.structure.map(section => map[section]).filter(Boolean).join('\n');
}

function aiStudioKnowledgeItems(items: AiStudioKnowledgeItem[] = []) {
  return items.filter(item => item?.status === 'Approved').slice(0, 5);
}

function aiStudioKnowledgeBlock(items: AiStudioKnowledgeItem[] = [], context: any = {}) {
  const approved = aiStudioKnowledgeItems(items);
  if (!approved.length) return 'No approved Knowledge Base items are available yet.';
  return [`Approved Knowledge References for ${context.pair || 'this episode'}:`, ...approved.map(item => {
    const example = item.example ? ` Example: ${item.example}` : '';
    return `- ${item.title || 'Untitled'} (${item.category || 'Knowledge'}): ${item.summary || ''}${example}`;
  })].join('\n');
}

function aiStudioKnowledgeTitles(items: AiStudioKnowledgeItem[] = []) {
  const titles = aiStudioKnowledgeItems(items).slice(0, 4).map(item => item.title).filter(Boolean);
  return titles.length ? titles.join(', ') : 'No approved knowledge selected yet';
}

function aiStudioTemplateCopy(templateKey: string, template: AiStudioTemplate, context: any) {
  const { pair, direction, sideWord, grade, location, tf, rr, entry, tp } = context;
  const base = {
    title: `${pair} ${grade} Setup: ${sideWord.toUpperCase()} Trade Plan from ${location}`,
    intro: `Today I am breaking down a ${grade}-grade ${pair} scanner signal and showing how I would review it before taking action.`,
    focus: `The scanner found a ${sideWord} ${tf} setup with location marked as ${location}. The goal is to understand trend, location, timing, and risk.`,
    takeaway: 'The scanner is not here to replace judgment. It is here to help me find cleaner opportunities faster, then use manual confirmation before risking capital.',
    short: `This ${pair} ${grade}-grade setup caught my attention because the scanner found ${sideWord} structure at ${location}.`,
    social: `Scanner found a ${grade}-grade ${pair} idea. I am watching ${location} for a ${sideWord} continuation setup.`,
  };
  if (templateKey === 'educationalLesson') {
    base.title = `Educational Lesson: Why ${pair} Became a ${grade} Setup`;
    base.intro = `In this lesson, I am using ${pair} to teach how trend, location, confirmation, and risk come together in a scanner setup.`;
    base.takeaway = 'The lesson is to understand the setup type first, then decide whether price action confirms the idea.';
  } else if (templateKey === 'tradeJournalReview') {
    base.title = `Trade Journal Review: ${pair} ${grade} Setup`;
    base.intro = `This is a journal-style review of a ${pair} scanner setup, focused on decision quality instead of hype.`;
  } else if (templateKey === 'scannerExplainer') {
    base.title = `Scanner Explainer: Why Kairos Flagged ${pair}`;
    base.focus = `The scanner read the trade as ${direction}, with ${location} location, an entry near ${entry}, and a target around ${tp}. This is about understanding the scanner output, not blindly following it.`;
  } else if (templateKey === 'weeklyMarketRecap') {
    base.title = `Weekly Market Recap: ${pair} and the Cleanest Scanner Setups`;
  } else if (templateKey === 'propFirmChallengeUpdate') {
    base.title = `Prop Firm Challenge Update: ${pair} Scanner Setup and Risk Plan`;
    base.social = `Eval update: watching ${pair} ${direction}. Clean scanner idea, but the priority is risk control and journal discipline.`;
  }
  return { ...base, template };
}

function buildMockAiEpisode(input: any) {
  const trade = input?.trade || {};
  const templateKey = input?.templateKey || 'quickTradeBreakdown';
  const template = aiStudioTemplate(templateKey, input?.templates);
  const pair = trade.displaySymbol || aiStudioPairLabel(trade.pair || trade.symbol || 'this pair');
  const direction = aiStudioDirection(trade);
  const sideWord = direction === 'LONG' ? 'bullish' : 'bearish';
  const grade = trade.setupGrade || 'A';
  const location = trade.zone || trade.location || 'key location';
  const tf = trade.timeframe || 'H4';
  const rr = trade.rrRatio || '—';
  const entry = aiStudioNumber(trade.entry);
  const sl = aiStudioNumber(trade.sl);
  const tp = aiStudioNumber(trade.tp1 || trade.tp);
  const found = aiStudioFoundTime(trade);
  const brand = aiStudioBrandProfile(input?.brand);
  const templateCopy = aiStudioTemplateCopy(templateKey, template, { pair, direction, sideWord, grade, location, tf, rr, entry, sl, tp, found });
  const brandContext = { pair, direction, grade, location, tf, rr, entry, sl, tp };
  const teachingBlock = aiStudioTeachingBlock(brand, brandContext);
  const signatureBlock = aiStudioSignatureBlock(brand);
  const knowledgeBlock = aiStudioKnowledgeBlock(input?.knowledge, brandContext);
  const knowledgeTitles = aiStudioKnowledgeTitles(input?.knowledge);
  return {
    trade: { ...trade, displaySymbol: pair },
    templateKey,
    templateName: template.name,
    provider: 'mock',
    disclaimer: AI_STUDIO_DISCLAIMER,
    summary: {
      pair, direction, grade, template: template.name, brandVoice: brand.voice, audience: brand.audience,
      timeframe: tf, location, entry, sl, tp, rr, status: trade.entryStatus || trade.status || 'Ready for Review',
    },
    sections: [
      { label: 'YouTube Title', value: templateCopy.title },
      { label: 'Long-form YouTube Script', large: true, value: `Intro:\n${templateCopy.intro}\n\nBrand DNA:\nVoice: ${brand.voice}\nAudience: ${brand.audience}\nAvoid: ${brand.avoid}\n\nContext:\n${templateCopy.focus}\n\nTeaching Structure:\n${teachingBlock}\n\nApproved Knowledge Base:\n${knowledgeBlock}\n\nTrade Plan:\nDirection: ${direction}\nEntry: ${entry}\nStop loss: ${sl}\nTarget: ${tp}\nEstimated R:R: ${rr}\nFound time: ${found}\n\nReview:\nThis is the kind of signal I want to journal because it gives a clear structure to study. I would still check the live chart, confirm price behavior at the zone, and make sure the setup matches my eval risk plan before entering.\n\nSignature Segments:\n${signatureBlock}\n\nTakeaway:\n${templateCopy.takeaway}\n\nDisclaimer:\n${AI_STUDIO_DISCLAIMER}` },
      { label: 'Shorts Script', value: `${templateCopy.short}\nThe plan is simple: entry near ${entry}, stop at ${sl}, and first target around ${tp}.\nI am not treating this as an automatic entry. I want confirmation at the zone first.\n${brand.segments.slice(0, 2).join(' / ')}: find the opportunity, explain why it qualified, then manually verify the trade.\n\n${AI_STUDIO_DISCLAIMER}` },
      { label: 'YouTube Description', value: `In this video, I review a ${grade}-grade ${pair} forex scanner signal and walk through the trade idea, location, risk, and target plan.\n\nPair: ${pair}\nTimeframe: ${tf}\nDirection: ${direction}\nEntry: ${entry}\nStop Loss: ${sl}\nTarget: ${tp}\nR:R: ${rr}\nAudience: ${brand.audience}\nBrand Voice: ${brand.voice}\nApproved Knowledge Used: ${knowledgeTitles}\n\n${AI_STUDIO_DISCLAIMER}` },
      { label: 'Tags', value: `forex trading, ${pair.replace('/', '')}, forex scanner, trade breakdown, prop firm trading, smart money concepts, supply and demand, trading journal` },
      { label: 'Thumbnail Prompt', value: `Dark premium trading dashboard thumbnail showing ${pair}, ${grade} Setup, ${direction}, entry ${entry}, and a clean chart with supply/demand zones. Bold text: "${pair} ${grade} SETUP"` },
      { label: 'X Post', value: `${pair} ${grade} setup on my scanner today.\n\nDirection: ${direction}\nLocation: ${location}\nR:R: ${rr}\n\nNot an auto-entry. The next step is chart confirmation and journal review.\n\n${AI_STUDIO_DISCLAIMER}` },
      { label: 'Instagram Caption', value: `${templateCopy.social}\n\nEntry: ${entry}\nSL: ${sl}\nTP: ${tp}\nR:R: ${rr}\n\nScanner finds the opportunity. The chart confirms the entry.\n\n${AI_STUDIO_DISCLAIMER}` },
      { label: 'Facebook Post', value: `${templateCopy.social} Entry ${entry}, stop ${sl}, target ${tp}, planned R:R ${rr}. This remains a review candidate, not an automatic entry. Voice: ${brand.voice}. ${AI_STUDIO_DISCLAIMER}` },
      { label: 'LinkedIn Post', value: `${templateCopy.social} The focus is process quality, journaling, and decision consistency for ${brand.audience}. Template used: ${template.name}. ${AI_STUDIO_DISCLAIMER}` },
    ] as AiStudioSection[],
  };
}

function aiStudioTradeOutcome(trade: any) {
  const raw = String(trade?.reviewResult || trade?.result || trade?.outcome || trade?.tradeResult || '').trim().toUpperCase();
  if (['WINNER', 'WIN', 'TP', 'TP HIT', 'TAKE PROFIT'].includes(raw)) return 'TP Hit';
  if (['STOPPED', 'STOP LOSS', 'SL', 'SL HIT', 'LOSS', 'LOSER', 'FAILED'].includes(raw)) return 'Stop Loss';
  if (['BREAKEVEN', 'BREAK EVEN', 'BE'].includes(raw)) return 'Breakeven';
  if (['RUNNING', 'OPEN'].includes(raw)) return 'Running';
  return 'Unknown';
}

function aiStudioEffectiveFollowUpType(requestedType: string, trade: any) {
  const outcome = aiStudioTradeOutcome(trade);
  if (outcome === 'Unknown' || outcome === 'Running') return 'Trade Update';
  if (requestedType === 'Weekly Recap' || requestedType === 'Lesson Learned' || requestedType === 'Trade Update') return requestedType;
  if (requestedType === 'TP Hit Review' && outcome === 'TP Hit') return requestedType;
  if (requestedType === 'Stop Loss Review' && outcome === 'Stop Loss') return requestedType;
  if (requestedType === 'Breakeven Review' && outcome === 'Breakeven') return requestedType;
  return 'Trade Update';
}

function buildMockAiFollowUp(input: any) {
  const pkg = input?.package || {};
  const trade = pkg.trade || {};
  const summary = pkg.summary || {};
  const requestedType = input?.requestedType || 'Trade Update';
  const templateKey = input?.templateKey || pkg.templateKey || 'quickTradeBreakdown';
  const template = aiStudioTemplate(templateKey, input?.templates);
  const pair = summary.pair || trade.displaySymbol || trade.pair || 'this setup';
  const direction = summary.direction || aiStudioDirection(trade);
  const grade = summary.grade || trade.setupGrade || 'A';
  const entry = summary.entry || aiStudioNumber(trade.entry);
  const sl = summary.sl || aiStudioNumber(trade.sl);
  const tp = summary.tp || aiStudioNumber(trade.tp1 || trade.tp);
  const rr = summary.rr || trade.rrRatio || '—';
  const outcome = aiStudioTradeOutcome(trade);
  const type = aiStudioEffectiveFollowUpType(requestedType, trade);
  const brand = aiStudioBrandProfile(input?.brand);
  const developing = outcome === 'Unknown' || outcome === 'Running';
  const lesson = developing
    ? 'The lesson is to document the plan while the trade is still developing, then compare the plan against the final result later.'
    : outcome === 'TP Hit'
    ? 'The lesson is to review what made the setup work and whether the entry, patience, and target selection were repeatable.'
    : outcome === 'Stop Loss'
    ? 'The lesson is to review whether the setup failed because of direction, location, timing, or trade management.'
    : 'The lesson is to evaluate whether risk was protected without cutting the trade too early.';
  const teachingBlock = aiStudioTeachingBlock(brand, { pair, direction, grade, location: 'original scanner location', tf: summary.timeframe || trade.timeframe || 'scanner timeframe', rr, entry, sl, tp });
  const signatureBlock = aiStudioSignatureBlock(brand);
  const knowledgeBlock = aiStudioKnowledgeBlock(input?.knowledge, { pair, direction, grade, rr, entry, sl, tp });
  const knowledgeTitles = aiStudioKnowledgeTitles(input?.knowledge);
  return {
    type, requestedType, outcome, developing, templateKey, templateName: template.name, provider: 'mock', disclaimer: AI_STUDIO_DISCLAIMER,
    summary: { pair, direction, grade, template: template.name, brandVoice: brand.voice, audience: brand.audience, entry, sl, tp, rr, outcome: developing ? 'Still developing' : outcome },
    sections: [
      { label: 'Follow-up YouTube Title', value: `${type === 'Trade Update' ? 'Trade Update' : type}: ${pair} ${grade} Setup Review` },
      { label: 'Follow-up Long-form Script', large: true, value: `Intro:\nThis is a follow-up episode for the ${pair} ${grade} setup from the scanner.\n\nStatus:\n${developing ? 'The trade outcome is not confirmed yet, so this follow-up is framed as a developing Trade Update.' : `Known outcome: ${outcome}.`}\n\nBrand DNA:\nVoice: ${brand.voice}\nAudience: ${brand.audience}\nAvoid: ${brand.avoid}\n\nOriginal Trade Plan:\nPair: ${pair}\nDirection: ${direction}\nEntry: ${entry}\nStop Loss: ${sl}\nTarget: ${tp}\nR:R: ${rr}\n\nStory Mode Review:\nThe goal of this follow-up is not to make the scanner look perfect. The goal is to document what happened after the original signal and turn the trade into a useful lesson.\n\nTeaching Structure:\n${teachingBlock}\n\nApproved Knowledge Base:\n${knowledgeBlock}\n\nLesson:\n${lesson}\n\nSignature Segments:\n${signatureBlock}\n\nDisclaimer:\n${AI_STUDIO_DISCLAIMER}` },
      { label: 'Follow-up Shorts Script', value: `${pair} follow-up.\nThe original scanner idea was ${direction} from ${entry}, with stop at ${sl} and target near ${tp}.\n${developing ? 'The trade is still developing, so I am not calling this a win or loss yet.' : `The recorded outcome is: ${outcome}.`}\nThe point is simple: every setup becomes data when you review it honestly.\n${brand.segments.slice(0, 2).join(' / ')}. Template: ${template.name}.\n\n${AI_STUDIO_DISCLAIMER}` },
      { label: 'Follow-up Description', value: `Follow-up review for the ${pair} ${grade} scanner setup.\n\nOriginal direction: ${direction}\nEntry: ${entry}\nStop Loss: ${sl}\nTarget: ${tp}\nR:R: ${rr}\nOutcome status: ${developing ? 'Still developing / unknown' : outcome}\n\nTemplate: ${template.name}\nBrand Voice: ${brand.voice}\nAudience: ${brand.audience}\nApproved Knowledge Used: ${knowledgeTitles}\n\n${AI_STUDIO_DISCLAIMER}` },
      { label: 'Follow-up Social Post', value: `${pair} scanner follow-up:\n\nOriginal plan: ${direction}\nEntry: ${entry}\nSL: ${sl}\nTP: ${tp}\nR:R: ${rr}\n\n${developing ? 'Outcome is still developing, so this is a Trade Update, not a win/loss claim.' : `Outcome: ${outcome}.`}\n\nThe value is in reviewing the process for ${brand.audience}.\n\nTemplate: ${template.name}\n${AI_STUDIO_DISCLAIMER}` },
      { label: 'Lesson / Takeaway', value: `${lesson}\n\nSignature Segments:\n${signatureBlock}\n\n${AI_STUDIO_DISCLAIMER}` },
    ] as AiStudioSection[],
  };
}

const AI_STUDIO_VISUAL_ASSET_TYPES = ['YouTube Thumbnail', 'YouTube Short Cover', 'Chart Callout Graphic', 'Community Post Image', 'Instagram Carousel Slide', 'X Post Graphic'];

function buildMockAiVisualBriefs(input: any) {
  const pkg = input?.package || {};
  const summary = pkg.summary || {};
  const trade = pkg.trade || {};
  const brand = aiStudioBrandProfile(input?.brand);
  const context = {
    pair: summary.pair || trade.displaySymbol || trade.pair || 'Scanner Setup',
    direction: summary.direction || aiStudioDirection(trade),
    grade: summary.grade || trade.setupGrade || 'A',
    timeframe: summary.timeframe || trade.timeframe || 'H4',
    location: summary.location || trade.location || trade.zone || 'key location',
    entry: summary.entry || aiStudioNumber(trade.entry),
    sl: summary.sl || aiStudioNumber(trade.sl),
    tp: summary.tp || aiStudioNumber(trade.tp1 || trade.tp),
    rr: summary.rr || trade.rrRatio || '—',
    templateName: pkg.templateName || aiStudioTemplate(pkg.templateKey, input?.templates).name,
    brandVoice: brand.voice,
    knowledgeTitles: aiStudioKnowledgeTitles(input?.knowledge),
  };
  return AI_STUDIO_VISUAL_ASSET_TYPES.map(type => {
    const headline = type === 'YouTube Thumbnail' ? `${context.pair} ${context.grade} Setup` : type === 'YouTube Short Cover' ? `${context.pair} Setup` : 'Setup Watch';
    return {
      type,
      fields: [
        { label: 'Thumbnail Concept', value: `${type} for a ${context.templateName} about ${context.pair}. Show the scanner-driven ${context.direction} idea as a structured review, not a guaranteed outcome.` },
        { label: 'Headline Text', value: headline },
        { label: 'Subtext', value: `${context.direction} · ${context.timeframe} · ${context.location} · ${context.rr}R` },
        { label: 'Chart Focus', value: `Focus on planned entry ${context.entry}, stop ${context.sl}, and target ${context.tp}. Use the chart as evidence for review, not as a promise.` },
        { label: 'Visual Style', value: 'Dark trading dashboard look, calm professional spacing, no hype or fake urgency.' },
        { label: 'Colors / Branding Notes', value: `Use Kairos dark UI styling with blue accents and ${context.direction === 'LONG' ? 'green bullish accents' : 'red bearish accents'}. Brand voice: ${context.brandVoice}.` },
        { label: 'Composition Notes', value: `Keep the pair and grade readable first, chart second, risk/process cue third. ${AI_STUDIO_DISCLAIMER}` },
        { label: 'Image Generation Prompt', value: `Create a polished trading content graphic for ${context.pair} ${context.grade} ${context.direction} setup. Avoid profit guarantees, hype, cash imagery, or fake broker UI. Knowledge themes: ${context.knowledgeTitles}.` },
        { label: 'Canva / Design Prompt', value: `Design a ${type} using Kairos scanner branding. Headline: "${headline}". Include chart/screenshot placeholder, entry/SL/TP callout, and a small risk-review note.` },
      ],
    };
  });
}

function sanitizeAiStudioSections(sections: any, fallback: AiStudioSection[]) {
  if (!Array.isArray(sections)) return fallback;
  const cleaned = sections
    .filter(section => section && typeof section.label === 'string' && typeof section.value === 'string')
    .map(section => ({ label: section.label, value: `${section.value}\n\n${AI_STUDIO_DISCLAIMER}`, large: !!section.large }));
  return cleaned.length ? cleaned : fallback;
}

function sanitizeAiStudioSummary(summary: any, fallback: any) {
  return summary && typeof summary === 'object' && !Array.isArray(summary) ? summary : fallback;
}

async function openAiStudioJson(kind: 'episode' | 'followUp' | 'visualBriefs', input: any, fallback: any) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_AI_STUDIO_MODEL,
      input: [
        {
          role: 'system',
          content: [
            'You generate editable AI Studio trading education content.',
            'Use only the supplied trade, scanner, Brand DNA, Knowledge Base, and template data.',
            'Do not fabricate prices, confirmations, performance, or trade outcomes.',
            'Include disclaimer language that this is educational content, not financial advice.',
            'Return only JSON matching the requested shape.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({ kind, input, requiredShape: kind === 'visualBriefs' ? 'object with assets:[{type, fields:[{label,value}]}]' : 'object with summary and sections:[{label,value,large}]' }),
        },
      ],
      text: { format: { type: 'json_object' } },
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${detail.slice(0, 240)}`);
  }
  const data = await response.json() as any;
  const text = data.output_text || data.output?.flatMap((item: any) => item.content || []).map((part: any) => part.text || '').join('');
  const parsed = JSON.parse(text || '{}');
  if (kind === 'visualBriefs') {
    const assets = Array.isArray(parsed.assets)
      ? parsed.assets
      : Array.isArray(parsed.visualBriefs)
      ? parsed.visualBriefs
      : Array.isArray(parsed.briefs)
      ? parsed.briefs
      : null;
    if (!assets) throw new Error('OpenAI visual briefs response did not include an assets array');
    return assets;
  }
  return parsed && typeof parsed === 'object' ? parsed : fallback;
}

async function aiStudioGenerate(kind: 'episode' | 'followUp' | 'visualBriefs', input: any, mockBuilder: (input: any) => any) {
  const provider = input?.provider === 'openai' ? 'openai' : 'mock';
  const mock = mockBuilder(input);
  if (provider !== 'openai') return { provider: 'mock', usedFallback: false, result: mock };
  try {
    const generated = await openAiStudioJson(kind, input, mock);
    if (kind === 'episode') {
      return { provider: 'openai', usedFallback: false, result: { ...mock, ...generated, provider: 'openai', summary: sanitizeAiStudioSummary(generated.summary, mock.summary), sections: sanitizeAiStudioSections(generated.sections, mock.sections) } };
    }
    if (kind === 'followUp') {
      return { provider: 'openai', usedFallback: false, result: { ...mock, ...generated, provider: 'openai', summary: sanitizeAiStudioSummary(generated.summary, mock.summary), sections: sanitizeAiStudioSections(generated.sections, mock.sections) } };
    }
    return { provider: 'openai', usedFallback: false, result: Array.isArray(generated) ? generated : mock };
  } catch (error: any) {
    console.warn(`[AI Studio] OpenAI ${kind} fallback: ${error.message}`);
    return { provider: 'mock', requestedProvider: 'openai', usedFallback: true, fallbackReason: error.message, result: mock };
  }
}

// Priority pairs — pushed by Claude after each forex scan via POST /api/priority-pairs
// When set, the scanner and frontend only scan these pairs instead of the full 16-pair list.
interface PriorityPairsData {
  pairs: string[];       // OANDA format: EUR_USD, XAU_USD, etc.
  setAt: string;         // ISO timestamp
  meta?: Record<string, any>; // optional grade/direction info from the scan
}
let priorityPairsData: PriorityPairsData | null = null;
const PRIORITY_PAIRS_SETTING_KEY = 'priority_pairs';

// Convert bare symbol (EURUSD, XAU_USD, FX:EURUSD) to OANDA underscore format
function toOandaFormat(symbol: string): string {
  const s = symbol.replace(/^[^:]+:/, '').toUpperCase(); // strip exchange prefix
  const compact = s.replace(/[^A-Z0-9_]/g, '');
  const aliases: Record<string, string> = {
    GOLD: 'XAU_USD',
    XAU: 'XAU_USD',
    XAUUSD: 'XAU_USD',
    SILVER: 'XAG_USD',
    XAG: 'XAG_USD',
    XAGUSD: 'XAG_USD',
    US30: 'US30_USD',
    US30USD: 'US30_USD',
    NAS100: 'NAS100_USD',
    NAS100USD: 'NAS100_USD',
  };
  if (aliases[compact]) return aliases[compact];
  if (s.includes('_')) return s;                          // already OANDA format
  if (compact.length === 6) return `${compact.slice(0, 3)}_${compact.slice(3)}`; // EURUSD → EUR_USD
  return compact;
}

function parsePriorityPairs(value: string | null): PriorityPairsData | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PriorityPairsData>;
    if (!Array.isArray(parsed.pairs) || parsed.pairs.length === 0 || !parsed.setAt) return null;
    return {
      pairs: parsed.pairs.map(toOandaFormat).filter(p => p.length >= 5),
      setAt: parsed.setAt,
      meta: parsed.meta,
    };
  } catch (e) {
    console.warn('[Priority] Stored priority pairs are invalid:', e);
    return null;
  }
}

function normalizePriorityPairsInput(pairs: unknown[], meta: unknown) {
  const normalized: string[] = [];
  const structuredMeta: Record<string, any> = meta && typeof meta === 'object' && !Array.isArray(meta)
    ? { ...(meta as Record<string, any>) }
    : {};
  const byPair: Record<string, any> = {};

  for (const item of pairs) {
    const rawPair = typeof item === 'string'
      ? item
      : item && typeof item === 'object'
        ? (item as any).pair || (item as any).symbol || (item as any).ticker
        : '';
    const pair = toOandaFormat(String(rawPair || '').trim());
    if (pair.length < 5) continue;
    if (!normalized.includes(pair)) normalized.push(pair);
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const { pair: _pair, symbol: _symbol, ticker: _ticker, ...fields } = item as Record<string, any>;
      byPair[pair] = { ...(byPair[pair] || {}), ...normalizePriorityMetadataFields(fields), pair };
    }
  }

  for (const [key, value] of Object.entries(structuredMeta)) {
    const pair = toOandaFormat(String(key));
    if (normalized.includes(pair) && value && typeof value === 'object' && !Array.isArray(value)) {
      byPair[pair] = { ...(byPair[pair] || {}), ...normalizePriorityMetadataFields(value as Record<string, any>), pair };
    }
  }

  if (Object.keys(byPair).length) {
    structuredMeta.byPair = { ...(structuredMeta.byPair || {}), ...byPair };
  }

  return { normalized, structuredMeta };
}

function normalizePriorityMetadataFields(fields: Record<string, any>) {
  const normalized = { ...fields };
  if (normalized.stop_loss === undefined && normalized.stopLoss !== undefined) normalized.stop_loss = normalized.stopLoss;
  if (normalized.target_1 === undefined && normalized.target1 !== undefined) normalized.target_1 = normalized.target1;
  if (normalized.target_2 === undefined && normalized.target2 !== undefined) normalized.target_2 = normalized.target2;
  if (normalized.rr_estimate === undefined && normalized.rrEstimate !== undefined) normalized.rr_estimate = normalized.rrEstimate;
  return normalized;
}

async function loadPriorityPairsFromStorage(source = 'LOAD') {
  const storage = await getSettingsStorageInfo();
  const stored = await getSetting(PRIORITY_PAIRS_SETTING_KEY);
  const parsed = parsePriorityPairs(stored);
  priorityPairsData = parsed?.pairs.length ? parsed : null;
  console.log(`[Priority] ${source} storage=${storage.backend} durable=${storage.durable} active=${priorityPairsData !== null}${storage.path ? ` path=${storage.path}` : ''}`);
  return priorityPairsData;
}

async function sendTelegram(text: string, parseMode?: 'Markdown') {
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;
  if (!telegramToken || !telegramChatId) {
    console.warn('[Telegram] Alerts disabled: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    return { ok: false, skipped: true, error: 'Telegram not configured' };
  }

  const response = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: telegramChatId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
    }),
  });
  const data = await response.json() as any;
  if (!data.ok) console.error('[Telegram] API error:', JSON.stringify(data));
  return data;
}

function isIndexSymbol(symbol: string) {
  return ['US30_USD', 'NAS100_USD'].includes(symbol);
}

function hasClearDailyOrH4Trend(report: ScoutReport) {
  return ['Bullish', 'Bearish'].includes(report.dailyTrendDirection || '') ||
    ['Bullish', 'Bearish'].includes(report.h4TrendDirection || '');
}

function scoutDiagnosticReasons(report: ScoutReport, kind: 'entry' | 'watch' = 'entry') {
  const reasons: string[] = [];
  const direction = scoutTradeDirection(report);
  const tradeTrend = direction === 'LONG' ? 'Bullish' : direction === 'SHORT' ? 'Bearish' : 'Mixed';
  const locationAligned = isLocationAlignedForTrade(report);
  const flowAligned = isSetupFlowAlignedForTrade(report);
  const clearTrend = hasClearDailyOrH4Trend(report);
  const confirmationStarted = ['Early Confirmation', 'Strong Confirmation', 'Trend Resumption Confirmed'].includes(displayScoutSetupStatus(report));

  if (isIndexSymbol(report.pair)) reasons.push('index symbols are not Telegram Scout alert candidates');
  if (direction === 'NEUTRAL') reasons.push('trade direction is neutral');
  if (kind === 'entry' && report.evalEligible !== true) reasons.push(report.evalReason || 'eval eligibility is false');
  if (kind === 'watch' && report.evalEligible === true) reasons.push('eval eligible setup is handled by entry alert path');
  if (kind === 'watch' && !['A', 'B'].includes(report.setupGrade || '')) reasons.push('watch alerts require A or B setup grade');
  if (report.rrRatio === null || report.rrRatio < MIN_SCOUT_ALERT_RR) reasons.push(`R:R is below ${MIN_SCOUT_ALERT_RR.toFixed(1)}`);
  if (!clearTrend) reasons.push('Daily/H4 trend is not clear enough');
  if (!locationAligned) reasons.push('location is not aligned with trade direction');
  if (!flowAligned) reasons.push('current timeframe flow is not aligned with trade direction');
  if (kind === 'entry' && !confirmationStarted) reasons.push('confirmation has not started');
  if (kind === 'entry' && !report.reversalConfirmed) reasons.push('reversal confirmation is not active');
  if (kind === 'entry' && report.entryTimingState !== 'Entry Triggered') reasons.push(`timing is ${report.entryTimingState}, not Entry Triggered`);
  if (kind === 'watch' && !['Reaction Started', 'Area Reached'].includes(report.entryTimingState || '')) reasons.push(`watch timing is ${report.entryTimingState}, not Reaction Started or Area Reached`);
  if (kind === 'entry' && report.entryStatus !== 'Tradeable') reasons.push(`entry status is ${report.entryStatus}, not Tradeable`);
  if (kind === 'watch' && !['Tradeable', 'Near Entry', 'Waiting'].includes(report.entryStatus || '')) reasons.push(`watch entry status is ${report.entryStatus}`);
  if (report.entry === null || report.sl === null || report.tp1 === null) reasons.push('entry, SL, or TP1 is missing');
  if (report.decisionLevelConfirmed !== true) reasons.push(report.decisionLevelReason || 'decision level is not confirmed');
  if (report.distanceFromEntryAtr !== null && report.distanceFromEntryAtr > 0.25 && kind === 'entry') reasons.push(`entry distance is ${report.distanceFromEntryAtr} ATR, above Tradeable threshold`);
  if (report.setupGrade === 'C') reasons.push(report.setupGradeReason || 'C setup / lower priority');
  if (tradeTrend !== 'Mixed' && report.dailyTrendDirection !== tradeTrend && report.dailyTrendDirection !== 'Neutral') reasons.push('Daily trend conflicts with trade direction');

  return [...new Set(reasons.filter(Boolean))];
}

function scoutAlertKind(report: ScoutReport): 'entry' | 'watch' | null {
  if (isTradeableScoutSignal(report)) return 'entry';
  if (isWatchScoutSignal(report)) return 'watch';
  return null;
}

function diagnosticDataKey(report: ScoutReport, kind: 'entry' | 'watch') {
  return tradeableSignalDataKey(report, kind);
}

function diagnosticAlertKey(report: ScoutReport, kind: 'entry' | 'watch') {
  return tradeableSignalAlertKey(report, kind);
}

function setScoutDiagnosticOutcome(report: ScoutReport, kind: 'entry' | 'watch', decision: ScoutDiagnosticDecision, reasons: string[] = []) {
  tradeableSignalDiagnosticOutcomes.set(diagnosticAlertKey(report, kind), {
    decision,
    reasons,
    updatedAt: Date.now(),
  });
  if (tradeableSignalDiagnosticOutcomes.size > 500) {
    const stale = [...tradeableSignalDiagnosticOutcomes.entries()]
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      .slice(0, tradeableSignalDiagnosticOutcomes.size - 500);
    stale.forEach(([key]) => tradeableSignalDiagnosticOutcomes.delete(key));
  }
}

function scoutDiagnosticRow(report: ScoutReport, source = 'current cache'): ScoutDiagnosticRow {
  const kind = scoutAlertKind(report);
  const now = Date.now();
  const direction = scoutTradeDirection(report);
  const activeKind = kind || 'entry';
  const dataKey = diagnosticDataKey(report, activeKind);
  const alertKey = diagnosticAlertKey(report, activeKind);
  const recordedOutcome = kind ? tradeableSignalDiagnosticOutcomes.get(alertKey) : null;
  const previousCandleTime = tradeableSignalCandleTimes.get(dataKey);
  const alertedAt = tradeableSignalAlerts.get(alertKey);
  const cooldownActive = Boolean(alertedAt && now - alertedAt < TRADEABLE_SIGNAL_ALERT_COOLDOWN_MS);
  const staleCandle = Boolean(previousCandleTime && previousCandleTime === report.candleTime);
  const marketOpen = isForexMarketOpen();
  let finalDecision: ScoutDiagnosticDecision = 'Rejected';
  let rejectionReasons = scoutDiagnosticReasons(report, activeKind);

  if (kind) {
    finalDecision = kind === 'entry' ? 'Alert sent' : 'Watch only';
    rejectionReasons = [];
    if (recordedOutcome) {
      finalDecision = recordedOutcome.decision;
      rejectionReasons = recordedOutcome.reasons;
    } else if (!marketOpen) {
      finalDecision = 'Market closed suppressed';
      rejectionReasons.push('Forex market is closed by New York session check');
    } else if (!report.candleTime) {
      finalDecision = 'Rejected';
      rejectionReasons.push('missing scout candle timestamp');
    } else if (staleCandle) {
      finalDecision = 'Stale candle suppressed';
      rejectionReasons.push(`same candle already processed: ${report.candleTime}`);
    } else if (cooldownActive) {
      finalDecision = 'Cooldown suppressed';
      rejectionReasons.push('same alert key is inside Scout Telegram cooldown');
    }
  }

  return {
    pair: report.pair,
    timeframe: report.timeframe,
    directionConsidered: direction,
    trendHtfAlignment: `Daily=${report.dailyTrendDirection}; H4=${report.h4TrendDirection}; Trend=${report.trendDirection}; SetupTF=${report.setupTimeframeDirection}`,
    location: report.zone,
    structureShift: report.reversalConfirmed ? `Detected: ${report.reversalReason}` : `Waiting: ${report.reversalReason}`,
    reversalConfirmation: report.confirmationStatus ? `${report.confirmationStatus}: ${report.confirmationReason}` : 'No confirmation data',
    timingState: `${entryTimingDisplay(report)} (${report.entryTimingState})`,
    entryDistance: report.distanceFromEntryAtr,
    rr: report.rrRatio,
    session: report.session,
    cooldownStatus: cooldownActive ? 'Active cooldown' : 'No active cooldown',
    candleTime: report.candleTime,
    staleCandleStatus: staleCandle ? 'Stale candle / already processed' : 'Fresh or unprocessed candle',
    finalDecision,
    rejectionReasons,
    setupGrade: report.setupGrade,
    evalEligible: report.evalEligible,
    interestLevel: report.interestLevel,
    entryStatus: report.entryStatus,
    pineConfirmation: report.pineConfirmation
      ? `Confirmed: ${report.pineConfirmation.message}`
      : report.pineZone
      ? 'Pine zone stored, no rejection confirmation'
      : 'No Pine confirmation attached',
  };
}

function buildScoutDiagnostics(reports: ScoutReport[], source = 'current cache'): ScoutDiagnosticsReport {
  const enriched = enrichScoutReports(reports);
  const rows = enriched.map(report => scoutDiagnosticRow(report, source));
  const reasonCounts = new Map<string, number>();
  for (const row of rows) {
    for (const reason of row.rejectionReasons) reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
  }
  const pairCounts = new Map<string, number>();
  for (const row of rows) pairCounts.set(row.pair, (pairCounts.get(row.pair) || 0) + 1);
  const candidatePairs = new Set(rows.filter(r => r.finalDecision === 'Alert sent' || r.finalDecision === 'Watch only').map(r => r.pair));
  const metals = ['XAU_USD', 'XAG_USD'];
  const timeframesActive = [...new Set(rows.map(r => r.timeframe))].sort();

  return {
    generatedAt: new Date().toISOString(),
    source,
    summary: {
      totalPairsScanned: rows.length,
      totalCandidatesFound: rows.filter(r => r.finalDecision === 'Alert sent' || r.finalDecision === 'Watch only').length,
      totalASetups: rows.filter(r => r.setupGrade === 'A').length,
      totalBSetups: rows.filter(r => r.setupGrade === 'B').length,
      totalEvalEligible: rows.filter(r => r.evalEligible).length,
      totalAlertsSent: rows.filter(r => r.finalDecision === 'Alert sent').length,
      topRejectionReasons: [...reasonCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([reason, count]) => ({ reason, count })),
      repeatedPairCounts: [...pairCounts.entries()]
        .filter(([, count]) => count > 1)
        .sort((a, b) => b[1] - a[1])
        .map(([pair, count]) => ({ pair, count })),
      scannedButNeverCandidates: [...pairCounts.keys()].filter(pair => !candidatePairs.has(pair)).sort(),
      timeframesActive,
      metalsScanned: metals.map(pair => ({
        pair,
        timeframes: rows.filter(r => r.pair === pair).map(r => r.timeframe).sort(),
      })),
      rrFilterBlocks: rows.filter(r => r.rejectionReasons.some(reason => reason.includes('R:R is below'))).length,
      pineConfirmationBlocks: rows.filter(r => r.rejectionReasons.some(reason => reason.toLowerCase().includes('confirmation'))).length,
      cooldownSuppressions: rows.filter(r => r.finalDecision === 'Cooldown suppressed').length,
      staleCandleSuppressions: rows.filter(r => r.finalDecision === 'Stale candle suppressed').length,
      sessionSuppressions: rows.filter(r => r.finalDecision === 'Market closed suppressed').length,
    },
    rows,
    notes: [
      'Diagnostics are read-only and do not change strategy logic, grading, levels, alerts, or journal behavior.',
      'Alert sent means the row qualifies for the existing Scout Telegram alert path before Telegram API success/failure is known.',
      'Historical questions like "last week" are limited to rows/logs available since this server process started; no persistent alert-decision history existed before this diagnostics pass.',
    ],
  };
}

function logScoutDiagnostics(report: ScoutDiagnosticsReport) {
  console.log(`[Scout Diagnostics] ${report.generatedAt} ${report.source}`);
  console.log(`[Scout Diagnostics] scanned=${report.summary.totalPairsScanned} candidates=${report.summary.totalCandidatesFound} A=${report.summary.totalASetups} B=${report.summary.totalBSetups} eval=${report.summary.totalEvalEligible} alerts=${report.summary.totalAlertsSent}`);
  console.log(`[Scout Diagnostics] timeframes=${report.summary.timeframesActive.join(', ') || 'none'} metals=${report.summary.metalsScanned.map(m => `${m.pair}:${m.timeframes.join('/') || 'not scanned'}`).join(', ')}`);
  console.log(`[Scout Diagnostics] top rejections=${report.summary.topRejectionReasons.map(r => `${r.reason} (${r.count})`).join(' | ') || 'none'}`);
  console.log(`[Scout Diagnostics] repeated pairs=${report.summary.repeatedPairCounts.map(r => `${r.pair} x${r.count}`).join(', ') || 'none'}`);
  for (const row of report.rows) {
    console.log(
      `[Scout Diagnostics] ${row.pair} ${row.timeframe} dir=${row.directionConsidered} trend="${row.trendHtfAlignment}" ` +
      `loc=${row.location} structure="${row.structureShift}" reversal="${row.reversalConfirmation}" timing="${row.timingState}" ` +
      `dist=${row.entryDistance ?? 'N/A'}ATR rr=${row.rr ?? 'N/A'} session="${row.session}" cooldown="${row.cooldownStatus}" ` +
      `candle=${row.candleTime || 'N/A'} stale="${row.staleCandleStatus}" decision="${row.finalDecision}" ` +
      `reasons="${row.rejectionReasons.join('; ') || 'none'}"`
    );
  }
}

function scoutKey(pair: string, timeframe: string) {
  return `${pair}|${String(timeframe || '').toUpperCase()}`;
}

function pineConfirmationKey(symbol: string, timeframe: string, direction: 'LONG' | 'SHORT') {
  return `${scoutKey(symbol, timeframe)}|${direction}`;
}

function pineZoneKey(symbol: string, timeframe: string, direction: 'LONG' | 'SHORT') {
  return pineConfirmationKey(symbol, timeframe, direction);
}

function directionFromZoneType(zoneType: PineConfirmation['zoneType']) {
  if (zoneType === 'DEMAND') return 'LONG' as const;
  if (zoneType === 'SUPPLY') return 'SHORT' as const;
  return null;
}

function cleanupPineConfirmations(now = Date.now()) {
  for (const [key, confirmation] of pineConfirmations) {
    if (now - Date.parse(confirmation.receivedAt) > PINE_CONFIRMATION_TTL_MS) pineConfirmations.delete(key);
  }
  for (const [key, zone] of pineZones) {
    if (now - Date.parse(zone.receivedAt) > PINE_ZONE_TTL_MS) pineZones.delete(key);
  }
  for (const [key, alertedAt] of pineConfirmationAlerts) {
    if (now - alertedAt > PINE_CONFIRMATION_ALERT_COOLDOWN_MS) pineConfirmationAlerts.delete(key);
  }
}

function pineZoneForReport(report: ScoutReport) {
  const direction = report.tradeDirection === 'LONG' || report.tradeDirection === 'SHORT' ? report.tradeDirection : null;
  if (!direction) return null;
  return pineZones.get(pineZoneKey(report.pair, report.timeframe, direction)) || null;
}

function enrichScoutReports(reports: ScoutReport[]) {
  cleanupPineConfirmations();
  return reports.map(report => {
    const direction = report.tradeDirection === 'LONG' || report.tradeDirection === 'SHORT' ? report.tradeDirection : null;
    if (!direction) return report;
    const confirmation = pineConfirmations.get(pineConfirmationKey(report.pair, report.timeframe, direction));
    const pineZone = pineZones.get(pineZoneKey(report.pair, report.timeframe, direction));
    return confirmation || pineZone ? { ...report, pineConfirmation: confirmation, pineZone } : report;
  });
}

function isValidScoutForPineConfirmation(report: ScoutReport, direction: 'LONG' | 'SHORT') {
  return report.tradeDirection === direction &&
    (report.setupGrade === 'A' || report.setupGrade === 'B') &&
    report.rrRatio !== null &&
    report.rrRatio >= MIN_SCOUT_ALERT_RR &&
    report.entry !== null &&
    report.sl !== null &&
    report.tp1 !== null;
}

function findScoutForPineConfirmation(symbol: string, timeframe: string, direction: 'LONG' | 'SHORT') {
  return latestScoutResults.find(report =>
    report.pair === symbol &&
    String(report.timeframe || '').toUpperCase() === String(timeframe || '').toUpperCase() &&
    isValidScoutForPineConfirmation(report, direction)
  );
}

function displayScoutTrend(report: ScoutReport) {
  if (report.dailyTrendDirection === 'Bullish' || report.trendDirection === 'Bullish') return 'Bullish';
  if (report.dailyTrendDirection === 'Bearish' || report.trendDirection === 'Bearish') return 'Bearish';
  return 'Mixed';
}

function displayScoutPhase(report: ScoutReport) {
  const trend = displayScoutTrend(report);
  const h4 = report.h4TrendDirection === 'Neutral' ? 'Mixed' : (report.h4TrendDirection || 'Mixed');
  if ((trend === 'Bullish' && h4 === 'Bullish') || (trend === 'Bearish' && h4 === 'Bearish')) return 'Trend Move';
  if ((trend === 'Bullish' && h4 === 'Bearish') || (trend === 'Bearish' && h4 === 'Bullish')) return 'Pullback';
  if (String(report.marketPhase || '').includes('Recovery')) return 'Recovery';
  return 'Transition';
}

function displayScoutSetupStatus(report: ScoutReport) {
  const confirmationScore = Number.isFinite(Number(report.confirmationScore)) ? Number(report.confirmationScore) : 0;
  const pullbackScore = Number.isFinite(Number(report.pullbackScore)) ? Number(report.pullbackScore) : 0;
  if (report.confirmationConfirmed || confirmationScore >= 9) return 'Trend Resumption Confirmed';
  if (report.confirmationStatus === 'Strong confirmation' || confirmationScore >= 7) return 'Strong Confirmation';
  if (report.confirmationStatus === 'Building confirmation' || report.confirmationStatus === 'Early confirmation' || confirmationScore >= 3) return 'Early Confirmation';
  if (report.pullbackCompleted || report.pullbackStatus === 'Pullback completed' || pullbackScore >= 9) return 'Pullback Complete';
  return 'Pullback Active';
}

function simpleScoutStatus(report: ScoutReport) {
  const direction = report.tradeDirection || (report.bias === 'BULLISH' ? 'LONG' : report.bias === 'BEARISH' ? 'SHORT' : 'NEUTRAL');
  if (report.setupGrade === 'C') return 'Counter-trend';
  if (report.setupGrade === 'B') return 'Still Pulling Back';
  if (report.entryTimingState === 'Area Reached') {
    if (direction === 'LONG') return 'Approaching Demand';
    if (direction === 'SHORT') return 'Approaching Supply';
    return 'Approaching Zone';
  }
  if (report.entryTimingState === 'Reaction Started') {
    if (direction === 'LONG') return 'Wait for Bullish Rejection';
    if (direction === 'SHORT') return 'Wait for Bearish Rejection';
    return 'Wait for Rejection';
  }
  if (report.reversalConfirmed || report.confirmationConfirmed || Number(report.confirmationScore) >= 3) return 'Confirmation Started';
  return 'Still Pulling Back';
}

function zoneTouchStateForScout(report: ScoutReport) {
  return ['APPROACHING', 'TESTING', 'REJECTING'].includes(String(report.zoneTouchState || ''))
    ? String(report.zoneTouchState)
    : 'NONE';
}

function zoneTimingLabelForScout(report: ScoutReport) {
  const direction = report.tradeDirection || (report.bias === 'BULLISH' ? 'LONG' : report.bias === 'BEARISH' ? 'SHORT' : 'NEUTRAL');
  const zoneState = zoneTouchStateForScout(report);
  if (direction === 'LONG') {
    if (report.zoneInteraction === 'DEMAND_RECLAIM') return 'Demand Reclaim / Retest';
    if (zoneState === 'REJECTING') return 'Rejecting Demand / Reaction Started';
    if (zoneState === 'TESTING') return 'Testing Demand';
    if (zoneState === 'APPROACHING') return 'Approaching Demand';
  }
  if (direction === 'SHORT') {
    if (report.zoneInteraction === 'SUPPLY_RECLAIM') return 'Supply Reclaim / Retest';
    if (zoneState === 'REJECTING') return 'Rejecting Supply / Reaction Started';
    if (zoneState === 'TESTING') return 'Testing Supply';
    if (zoneState === 'APPROACHING') return 'Approaching Supply';
  }
  return '';
}

function getNewYorkMarketParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  return {
    weekday: get('weekday'),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

function isForexMarketOpen(now = new Date()) {
  const { weekday, hour, minute } = getNewYorkMarketParts(now);
  const minutes = hour * 60 + minute;
  if (weekday === 'Sat') return false;
  if (weekday === 'Sun') return minutes >= 17 * 60;
  if (weekday === 'Fri') return minutes < 17 * 60;
  return true;
}

function formatScoutLevel(value: number | null) {
  if (value === null) return 'N/A';
  return value >= 100 ? value.toFixed(3) : value.toFixed(5);
}

function activeScoutZoneRange(report: ScoutReport) {
  const pineZone = (report as any).pineZone || pineZoneForReport(report);
  if (
    pineZone &&
    (pineZone.zoneType === 'DEMAND' || pineZone.zoneType === 'SUPPLY') &&
    pineZone.zoneHigh != null &&
    pineZone.zoneLow != null
  ) {
    const zoneHigh = Math.max(pineZone.zoneHigh, pineZone.zoneLow);
    const zoneLow = Math.min(pineZone.zoneHigh, pineZone.zoneLow);
    return {
      type: pineZone.zoneType,
      source: 'PINE' as const,
      label: pineZone.zoneType === 'DEMAND' ? 'Pine Indicator Demand Zone' : 'Pine Indicator Supply Zone',
      text: `${formatScoutLevel(zoneLow)}-${formatScoutLevel(zoneHigh)}`,
    };
  }
  const high = report.activeZoneHigh;
  const low = report.activeZoneLow;
  const type = report.activeZoneType === 'DEMAND' || report.activeZoneType === 'SUPPLY' ? report.activeZoneType : null;
  if (!type || high == null || low == null) return null;
  const zoneHigh = Math.max(high, low);
  const zoneLow = Math.min(high, low);
  return {
    type,
    source: 'SCANNER' as const,
    label: type === 'DEMAND' ? 'Active Scanner Demand Zone' : 'Active Scanner Supply Zone',
    text: `${formatScoutLevel(zoneLow)}-${formatScoutLevel(zoneHigh)}`,
  };
}

function shortScoutStateText(state: string) {
  return ({
    'Entry Proven': 'Entry Ready',
    'Decision Pending': 'Needs Break',
    'At Watch Area': 'Watching Zone',
    'Trend Watch': 'Trend Watch',
    'Counter Trend Recovery': 'Counter Trend Recovery',
    'Market Read': 'Observe',
    'Lower Priority': 'Skip / Low',
  } as Record<string, string>)[state] || state || 'Observe';
}

function shortScoutPhaseText(phase: string) {
  return ({
    'Trend Move': 'Trending',
    'Pullback': 'Pullback',
    'Recovery': 'Recovery',
    'Reversal Forming': 'Reversal Forming',
    'Transition': 'Choppy / Mixed',
  } as Record<string, string>)[phase] || phase || 'Choppy / Mixed';
}

function shortScoutTimingText(timing: string) {
  return String(timing || 'Waiting')
    .replace('Entry Triggered', 'Entry Ready')
    .replace('Demand Reclaim / Retest', 'Demand Reclaim')
    .replace('Supply Reclaim / Retest', 'Supply Reclaim')
    .replace('Rejecting Demand / Reaction Started', 'Demand Reaction')
    .replace('Rejecting Supply / Reaction Started', 'Supply Reaction')
    .replace('Testing Demand', 'At Demand')
    .replace('Testing Supply', 'At Supply')
    .replace('Approaching Demand', 'Near Demand')
    .replace('Approaching Supply', 'Near Supply')
    .replace('Area Reached', 'At Zone')
    .replace('Not Ready', 'Waiting');
}

function entryTimingDisplay(report: ScoutReport) {
  const state = report.entryTimingState || 'Not Ready';
  const direction = report.tradeDirection || (report.bias === 'BULLISH' ? 'LONG' : report.bias === 'BEARISH' ? 'SHORT' : 'NEUTRAL');
  if (state === 'Entry Triggered') return 'Entry Triggered';
  const zoneLabel = zoneTimingLabelForScout(report);
  if (zoneLabel) return zoneLabel;
  if (state === 'Reaction Started') {
    return 'Reaction Started';
  }
  if (state === 'Area Reached') {
    if (direction === 'SHORT') return 'Approaching Supply';
    if (direction === 'LONG') return 'Approaching Demand';
    return 'Area Reached';
  }
  return state;
}

function entryTimingReasonDisplay(report: ScoutReport) {
  const state = report.entryTimingState || 'Not Ready';
  const direction = report.tradeDirection || (report.bias === 'BULLISH' ? 'LONG' : report.bias === 'BEARISH' ? 'SHORT' : 'NEUTRAL');
  const zoneState = zoneTouchStateForScout(report);
  const activeZone = activeScoutZoneRange(report);
  const zoneSource = activeZone?.source === 'PINE' ? 'Pine indicator' : 'scanner';
  const demandArea = activeZone?.type === 'DEMAND' ? `${zoneSource} support/demand area around ${activeZone.text}` : 'demand';
  const supplyArea = activeZone?.type === 'SUPPLY' ? `${zoneSource} supply/resistance area around ${activeZone.text}` : 'supply';
  if (state === 'Reaction Started' && report.decisionLevelConfirmed === true) {
    if (zoneState === 'APPROACHING') {
      if (direction === 'SHORT') {
        return `Price is below the active ${supplyArea} and approaching it. Decision level is confirmed, but wait for a supply tap and bearish rejection before treating this as active.`;
      }
      if (direction === 'LONG') {
        return `Price is above the active ${demandArea} and approaching it. Decision level is confirmed, but wait for a demand tap and bullish rejection before treating this as active.`;
      }
    }
    if (direction === 'SHORT' && activeZone?.type === 'SUPPLY' && report.zoneInteraction === 'SUPPLY_RECLAIM') {
      return `Price is retesting the active ${supplyArea} after trading above it. Decision level is confirmed; wait for the entry trigger before treating this as active.`;
    }
    if (direction === 'LONG' && activeZone?.type === 'DEMAND' && report.zoneInteraction === 'DEMAND_RECLAIM') {
      return `Price is reclaiming/retesting the active ${demandArea} after trading below it. Decision level is confirmed; wait for the entry trigger before treating this as active.`;
    }
    if (direction === 'SHORT' && activeZone?.type === 'SUPPLY') {
      return `Price is reacting from the active ${supplyArea}. Decision level is confirmed; wait for the entry trigger before treating this as active.`;
    }
    if (direction === 'LONG' && activeZone?.type === 'DEMAND') {
      return `Price is reacting from the active ${demandArea}. Decision level is confirmed; wait for the entry trigger before treating this as active.`;
    }
    return 'Decision level is confirmed and reaction is developing. Wait for the entry trigger before treating this as active.';
  }
  if (zoneState === 'REJECTING') {
    if (direction === 'SHORT' && report.zoneInteraction === 'SUPPLY_RECLAIM') {
      return `Price is retesting the active ${supplyArea} after trading above it. Wait for bearish rejection before treating this as active.`;
    }
    if (direction === 'LONG' && report.zoneInteraction === 'DEMAND_RECLAIM') {
      return `Price is reclaiming/retesting the active ${demandArea} after trading below it. Wait for bullish rejection before treating this as active.`;
    }
    if (direction === 'SHORT') return `Price has touched the ${supplyArea} and bearish reaction evidence has started. Wait for entry trigger before treating this as active.`;
    if (direction === 'LONG') return `Price has touched the ${demandArea} and bullish reaction evidence has started. Wait for entry trigger before treating this as active.`;
    return 'Price has touched the zone and reaction evidence has started. Wait for entry trigger before treating this as active.';
  }
  if (zoneState === 'TESTING') {
    if (direction === 'SHORT') return `Current price/candle is touching the ${supplyArea}. Wait for bearish rejection before entry.`;
    if (direction === 'LONG') return `Current price/candle is touching the ${demandArea}. Wait for bullish rejection before entry.`;
    return 'Current price/candle is touching the zone. Wait for rejection before entry.';
  }
  if (zoneState === 'APPROACHING') {
    if (direction === 'SHORT') return `Price is below the ${supplyArea} and approaching the zone, but it has not touched it yet.`;
    if (direction === 'LONG') return `Price is above the ${demandArea} and approaching the zone, but it has not touched it yet.`;
    return 'Price is approaching the zone, but it has not touched it yet.';
  }
  if (state === 'Reaction Started') {
    if (direction === 'SHORT') return 'Reaction evidence is developing, but current price is not overlapping supply. Do not treat this as a supply test yet.';
    if (direction === 'LONG') return 'Reaction evidence is developing, but current price is not overlapping demand. Do not treat this as a demand test yet.';
    return 'Reaction evidence is developing, but price is not overlapping the zone.';
  }
  if (state === 'Area Reached') {
    if (direction === 'SHORT') return 'Price may be moving toward supply above; wait for a supply tap/rejection before entry.';
    if (direction === 'LONG') return 'Price may be moving toward demand below; wait for a demand tap/rejection before entry.';
  }
  return report.entryTimingReason || report.evalReason || report.setupGradeReason || 'Scout timing update';
}

function entryActionDisplay(report: ScoutReport) {
  const state = report.entryTimingState || 'Not Ready';
  const direction = report.tradeDirection || (report.bias === 'BULLISH' ? 'LONG' : report.bias === 'BEARISH' ? 'SHORT' : 'NEUTRAL');
  if (state === 'Entry Triggered') return 'Entry trigger active';
  if (state === 'Reaction Started') {
    if (direction === 'SHORT') return 'Wait for Bearish Rejection';
    if (direction === 'LONG') return 'Wait for Bullish Rejection';
    return 'Wait for Rejection';
  }
  if (state === 'Area Reached') {
    if (direction === 'SHORT') return 'Watch Supply';
    if (direction === 'LONG') return 'Watch Demand';
    return 'Watch Zone';
  }
  return 'Wait';
}

function scoutStateDisplay(report: ScoutReport) {
  const direction = scoutTradeDirection(report);
  if (report.entryTimingState === 'Entry Triggered' && report.decisionLevelConfirmed === true) {
    return {
      state: 'Entry Proven',
      action: 'Review the active entry plan',
    };
  }
  if (report.setupGrade === 'C') {
    return {
      state: 'Lower Priority',
      action: 'Do not force a trade',
    };
  }
  if (report.entryTimingState === 'Reaction Started') {
    if (report.decisionLevelConfirmed === true) {
      return {
        state: 'At Watch Area',
        action: 'Decision level confirmed; wait for entry trigger',
      };
    }
    return {
      state: 'Decision Pending',
      action: direction === 'SHORT'
        ? 'Wait for price to confirm below nearby support'
        : direction === 'LONG'
        ? 'Wait for price to confirm above nearby resistance'
        : 'Wait for a clear decision-level break',
    };
  }
  if (report.entryTimingState === 'Area Reached') {
    return {
      state: 'At Watch Area',
      action: 'Watch the key levels; no entry yet',
    };
  }
  if (report.trendWatchEligible === true) {
    return {
      state: 'Trend Watch',
      action: 'Track the trend and wait for a pullback or decision break',
    };
  }
  return {
    state: 'Market Read',
    action: 'Monitor only',
  };
}

async function notifyTradeableScoutSignals(reports: ScoutReport[], source: string) {
  const candidates = [
    ...reports.filter(isTradeableScoutSignal).map(report => ({ report, kind: 'entry' as const })),
    ...reports.filter(isWatchScoutSignal).map(report => ({ report, kind: 'watch' as const })),
  ];
  latestScoutDiagnostics = buildScoutDiagnostics(reports, `${source} pre-alert`);
  if (!candidates.length) {
    logScoutDiagnostics(latestScoutDiagnostics);
    return;
  }

  if (!isForexMarketOpen()) {
    console.log(`[Telegram] ${source}: market closed; skipped ${candidates.length} scout timing alert${candidates.length === 1 ? '' : 's'}`);
    candidates.forEach(({ report, kind }) => setScoutDiagnosticOutcome(report, kind, 'Market closed suppressed', ['Forex market is closed by New York session check']));
    latestScoutDiagnostics = buildScoutDiagnostics(reports, `${source} market closed`);
    logScoutDiagnostics(latestScoutDiagnostics);
    return;
  }

  const now = Date.now();
  for (const [key, alertedAt] of tradeableSignalAlerts) {
    if (now - alertedAt >= TRADEABLE_SIGNAL_ALERT_COOLDOWN_MS) tradeableSignalAlerts.delete(key);
  }

  for (const { report, kind } of candidates) {
    if (!report.candleTime) {
      console.warn(`[Telegram] ${source}: skipped ${report.pair} ${report.timeframe}; missing scout candle timestamp`);
      setScoutDiagnosticOutcome(report, kind, 'Rejected', ['missing scout candle timestamp']);
      latestScoutDiagnostics = buildScoutDiagnostics(reports, `${source} missing candle timestamp`);
      continue;
    }

    const dataKey = tradeableSignalDataKey(report, kind);
    const previousCandleTime = tradeableSignalCandleTimes.get(dataKey);
    if (previousCandleTime === report.candleTime) {
      console.log(`[Telegram] ${kind} scout signal stale candle skipped for ${report.pair} ${report.timeframe} @ ${report.candleTime}`);
      setScoutDiagnosticOutcome(report, kind, 'Stale candle suppressed', [`same candle already processed: ${report.candleTime}`]);
      latestScoutDiagnostics = buildScoutDiagnostics(reports, `${source} stale candle`);
      continue;
    }

    const key = tradeableSignalAlertKey(report, kind);
    const alertedAt = tradeableSignalAlerts.get(key);
    if (alertedAt && now - alertedAt < TRADEABLE_SIGNAL_ALERT_COOLDOWN_MS) {
      console.log(`[Telegram] ${kind} scout signal suppressed by cooldown for ${report.pair} ${report.timeframe}`);
      setScoutDiagnosticOutcome(report, kind, 'Cooldown suppressed', ['same alert key is inside Scout Telegram cooldown']);
      latestScoutDiagnostics = buildScoutDiagnostics(reports, `${source} cooldown`);
      continue;
    }
    tradeableSignalCandleTimes.set(dataKey, report.candleTime);

    const tradeDirection = scoutTradeDirection(report);
    const direction = tradeDirection === 'LONG'
      ? '🟢 LONG'
      : tradeDirection === 'SHORT'
      ? '🔴 SHORT'
      : '⚪ REVIEW';
    const isEntryAlert = kind === 'entry';
    const phase = scoutPhaseState(report);
    const nextStep = scoutNextStep(report, phase);
    const nextMilestone = scoutNextMilestone(nextStep);
    const reason = scoutShortReason(report, phase);
    const title = isEntryAlert
      ? `🚨 *ENTER NOW — ${report.displaySymbol}*`
      : `👀 *Almost Ready — Review setup — ${report.displaySymbol}*`;
    const activeZone = activeScoutZoneRange(report);
    const activeZoneLine = activeZone ? `\n${activeZone.label}: ${activeZone.text}` : '';
    const softAlertLine = isEntryAlert ? '' : '\nAction: Review setup. Wait for confirmation before entry.';
    const text = `${title}\nPair: ${report.displaySymbol}\nTimeframe: ${report.timeframe}\nDirection: ${direction}\nGrade: ${report.setupGrade || 'C'}\nPhase: ${phase.label}\nEntry: ${formatScoutLevel(report.entry)}\nSL: ${formatScoutLevel(report.sl)}\nTP1: ${formatScoutLevel(report.tp1)}\nR:R: ${report.rrRatio ?? 'N/A'}\nProgress: ${phase.progress}%\nNEXT STEP: ${nextStep}\nNEXT MILESTONE: ${nextMilestone}${softAlertLine}\nReason: ${reason}${activeZoneLine}\n→ https://erica-forex-screener-production.up.railway.app`;

    try {
      const data = await sendTelegram(text, 'Markdown');
      if (data.ok) {
        tradeableSignalAlerts.set(key, now);
        setScoutDiagnosticOutcome(report, kind, kind === 'entry' ? 'Alert sent' : 'Watch only');
        console.log(`[Telegram] ${kind} scout signal sent for ${report.pair} ${report.timeframe}`);
        latestScoutDiagnostics = buildScoutDiagnostics(reports, `${source} post-alert sent`);
      } else {
        setScoutDiagnosticOutcome(report, kind, 'Telegram failed', ['Telegram API did not return ok']);
        latestScoutDiagnostics = buildScoutDiagnostics(reports, `${source} telegram failed`);
      }
    } catch (e: any) {
      console.error(`[Telegram] ${kind} scout signal failed for ${report.pair}:`, e.message);
      setScoutDiagnosticOutcome(report, kind, 'Telegram failed', [e.message]);
      latestScoutDiagnostics = buildScoutDiagnostics(reports, `${source} telegram failed`);
    }
  }
  latestScoutDiagnostics = buildScoutDiagnostics(reports, `${source} complete`);
  logScoutDiagnostics(latestScoutDiagnostics);
}

function getSurfacedTrends(results: TrendScanResult) {
  const surfaced = new Map<string, { report: TrendReport; section: string }>();
  const add = (reports: TrendReport[], section: string) => {
    for (const report of reports) {
      if (!surfaced.has(report.pair)) surfaced.set(report.pair, { report, section });
    }
  };
  add(results.strongBullish, 'Strong Bullish Trends');
  add(results.strongBearish, 'Strong Bearish Trends');
  add(results.pullbackOpportunities, 'Pullback Opportunities');
  return surfaced;
}

function recordV2LifecycleShadow(reports: ScoutReport[], source: string) {
  try {
    const diagnostics = recordLifecycleShadowScan(reports, source);
    console.log(formatLifecycleDiagnosticsSummary(diagnostics.summary));
    for (const transition of diagnostics.transitions.slice(-10)) {
      if (transition.from === transition.to) continue;
      console.log(
        `[V2 Lifecycle Transition] ${transition.symbol} ${transition.timeframe}: ` +
        `${transition.from || 'NEW'} -> ${transition.to}. Reason: ${transition.reason}`
      );
    }
  } catch (e: any) {
    console.warn('[V2 Lifecycle Shadow] diagnostics failed:', e.message);
  }
}

async function notifyNewTrendingPairs(results: TrendScanResult) {
  const surfaced = getSurfacedTrends(results);
  const currentPairs = new Set(surfaced.keys());
  const analyzedPairs = new Set(results.all.map(report => report.pair));
  if (!trendingMembershipInitialized) {
    if (!analyzedPairs.size) {
      console.warn('[Trending] Baseline deferred: no markets were analyzed successfully');
      return;
    }
    previousTrendingPairs = currentPairs;
    trendingMembershipInitialized = true;
    console.log(`[Trending] Baseline initialized with ${currentPairs.size} surfaced market${currentPairs.size === 1 ? '' : 's'}`);
    return;
  }

  const added = [...surfaced.values()].filter(({ report }) => !previousTrendingPairs.has(report.pair));
  // Preserve membership for assets that failed market-data analysis this cycle.
  // A transient provider failure must not turn recovered markets into false "new" alerts.
  previousTrendingPairs = new Set([
    ...currentPairs,
    ...[...previousTrendingPairs].filter(pair => !analyzedPairs.has(pair)),
  ]);
  for (const { report, section } of added) {
    console.log(`[Trending] New ${section} surfaced without Telegram alert: ${report.pair}`);
  }
  if (added.length) console.log(`[Trending] ${added.length} newly surfaced market${added.length === 1 ? '' : 's'} detected`);
}

async function refreshTrendingMarkets() {
  if (trendScanInFlight) return trendScanInFlight;
  trendScanInFlight = (async () => {
    console.log(`[Trending] Running scan at ${new Date().toISOString()}`);
    const results = await runTrendScan();
    latestTrendResults = results;
    lastTrendScanTime = new Date().toISOString();
    await notifyNewTrendingPairs(results);
    return results;
  })();
  try {
    return await trendScanInFlight;
  } finally {
    trendScanInFlight = null;
  }
}

async function scheduledTrendScan() {
  try {
    await refreshTrendingMarkets();
  } catch (e: any) {
    console.error('[Trending] Scan failed:', e.message);
  }
}

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const num = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(num) ? num : undefined;
}

function normalizeDirection(value: unknown): 'LONG' | 'SHORT' | undefined {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'BUY' || normalized === 'LONG') return 'LONG';
  if (normalized === 'SELL' || normalized === 'SHORT') return 'SHORT';
  return undefined;
}

function normalizeSymbol(value: unknown) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return { symbol: '', displaySymbol: '' };
  const compact = raw.replace(/^OANDA:/, '').replace(/[^A-Z]/g, '');
  if (compact.length === 6) {
    return { symbol: `${compact.slice(0, 3)}_${compact.slice(3)}`, displaySymbol: `${compact.slice(0, 3)}/${compact.slice(3)}` };
  }
  return { symbol: compact, displaySymbol: raw.replace('_', '/') };
}

function normalizeTradingViewScoutSymbol(value: unknown) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return { symbol: '', displaySymbol: '' };
  const stripped = raw.replace(/^[^:]+:/, '').replace(/[^A-Z0-9_]/g, '');
  if (stripped.includes('_')) return { symbol: stripped, displaySymbol: stripped.replace('_', '/') };

  const special: Record<string, string> = {
    XAUUSD: 'XAU_USD',
    XAGUSD: 'XAG_USD',
    US30USD: 'US30_USD',
    NAS100USD: 'NAS100_USD',
  };
  if (special[stripped]) return { symbol: special[stripped], displaySymbol: special[stripped].replace('_', '/') };
  if (stripped.length === 6) {
    const symbol = `${stripped.slice(0, 3)}_${stripped.slice(3)}`;
    return { symbol, displaySymbol: symbol.replace('_', '/') };
  }
  return { symbol: stripped, displaySymbol: stripped.replace('_', '/') };
}

function normalizeTimeframe(value: unknown) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return '';
  const tradingViewMinutes: Record<string, string> = {
    '1': 'M1',
    '5': 'M5',
    '15': 'M15',
    '30': 'M30',
    '60': 'H1',
    '120': 'H2',
    '240': 'H4',
    '360': 'H6',
    '720': 'H12',
  };
  if (tradingViewMinutes[normalized]) return tradingViewMinutes[normalized];
  return normalized;
}

function normalizeZoneType(value: unknown): PineConfirmation['zoneType'] {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized.includes('DEMAND') || normalized === 'DISCOUNT' || normalized === 'SUPPORT') return 'DEMAND';
  if (normalized.includes('SUPPLY') || normalized === 'PREMIUM' || normalized === 'RESISTANCE') return 'SUPPLY';
  return 'UNKNOWN';
}

function parseTradingViewBody(body: any): any {
  if (typeof body !== 'string') return body || {};
  try {
    return JSON.parse(body);
  } catch {
    return { message: body };
  }
}

function calculateRr(direction: 'LONG' | 'SHORT', entry: number, stopLoss: number, tp: number) {
  const risk = direction === 'LONG' ? entry - stopLoss : stopLoss - entry;
  const reward = direction === 'LONG' ? tp - entry : entry - tp;
  if (risk <= 0 || reward <= 0) return undefined;
  return Number((reward / risk).toFixed(1));
}

function queueSetups(setups: Setup[]) {
  const premium = setups.filter(s => !isIndexSymbol(s.pair) && (s.quality === 'PREMIUM' || s.quality === 'STRONG'));
  for (const setup of premium) {
    const exists = pendingApprovals.some(
      p => p.pair === setup.pair && p.timeframe === setup.timeframe &&
           Math.abs(p.entry - setup.entry) < (setup.pair.includes('JPY') ? 0.1 : 0.001)
    );
    if (!exists) {
      pendingApprovals.push({ ...setup, id: `${setup.pair}-${Date.now()}` });
      console.log(`[Legacy] Queued old strategy setup without Telegram alert for ${setup.pair} ${setup.timeframe}`);
    }
  }
  if (pendingApprovals.length > 20) {
    pendingApprovals = pendingApprovals.slice(-20);
  }
}

async function scheduledScan(forceTf?: string) {
  const tfsToRun = forceTf ? [forceTf] : ['H4', 'M30'];
  const tfs = tfsToRun.join(' + ');
  console.log(`[Scanner] Running scan at ${new Date().toISOString()} (${tfs})`);
  try {
    await loadPriorityPairsFromStorage('SCAN_LOAD');
    // Refresh journal stats for historical edge/weakness scoring
    try { cachedJournalStats = await getPatternStats(); } catch { /* non-fatal */ }

    const pairsOverride = priorityPairsData?.pairs;
    if (pairsOverride?.length) {
      console.log(`[Scanner] Priority mode — scanning ${pairsOverride.length} pairs: ${pairsOverride.join(', ')}`);
    }
    const debugResults = await Promise.all(tfsToRun.map(tf => debugScan(tf, 1.5, cachedJournalStats, pairsOverride)));
    const h4Debug  = debugResults[0] ?? [];
    const m30Debug = debugResults[1] ?? [];

    const ord: Record<string,number> = { PREMIUM: 0, STRONG: 1, DEVELOPING: 2 };
    latestSetups = [
      ...h4Debug.filter(r => r.result === 'SETUP' && r.setup).map(r => r.setup!),
      ...m30Debug.filter(r => r.result === 'SETUP' && r.setup).map(r => r.setup!),
    ].sort((a, b) => ord[a.quality] - ord[b.quality] || b.rrRatio - a.rrRatio);

    // Near-misses: rejected pairs that had a trend direction detected
    latestRejected = [
      ...h4Debug.filter(r => r.result === 'REJECTED' && r.detail?.trend).map(r => ({ pair: r.pair, reason: r.reason ?? '', detail: r.detail, granularity: 'H4' })),
      ...m30Debug.filter(r => r.result === 'REJECTED' && r.detail?.trend).map(r => ({ pair: r.pair, reason: r.reason ?? '', detail: r.detail, granularity: 'M30' })),
    ];

    lastScanTime = new Date().toISOString();
    console.log(`[Scanner] Found ${latestSetups.length} setups (${tfs}), ${latestSetups.filter(s=>s.quality==='PREMIUM').length} premium, ${latestRejected.length} near-misses`);
    queueSetups(latestSetups);

    // Scout scan — produces a report for every pair (no gate filtering).
    // Keep this independent from priority setup queueing so LOW-interest
    // and non-priority pairs still render in scout mode.
    try {
      const scoutTimeframes = forceTf ? [forceTf] : ['H4', 'H1'];
      latestScoutResults = (await Promise.all(scoutTimeframes.map(tf => runScoutScan(tf)))).flat();
      console.log(`[Scout] ${latestScoutResults.length} pairs scanned, ${latestScoutResults.filter(r => r.interestLevel === 'HIGH').length} HIGH interest`);
      recordV2LifecycleShadow(latestScoutResults, 'scheduled scout scan');
      await notifyTradeableScoutSignals(latestScoutResults, 'scheduled scout scan');
    } catch (e: any) {
      console.warn('[Scout] Scan failed:', e.message);
    }
  } catch(e: any) {
    console.error('[Scanner] Scan failed:', e.message);
  }
}

// Load persisted priority pairs from storage, then run first scan
async function init() {
  try {
    const restored = await loadPriorityPairsFromStorage('STARTUP_LOAD');
    if (restored) {
      console.log(`[Priority] Restored from storage: ${priorityPairsData.pairs.join(', ')}`);
    }
  } catch (e) {
    console.warn('[Priority] Could not load from storage on startup:', e);
  }
  scheduledScan();
  scheduledTrendScan();
  setInterval(scheduledScan, 15 * 60 * 1000);
  setInterval(scheduledTrendScan, 15 * 60 * 1000);
}
init();

// ─── SCANNER API ──────────────────────────────────────────────────────────────
app.get('/api/setups', (_req, res) => {
  res.json({ setups: latestSetups, lastScanTime, count: latestSetups.length });
});

app.post('/api/scan', async (req, res) => {
  const tf = (req.query.tf as string) || undefined;
  await scheduledScan(tf);
  res.json({ setups: latestSetups, lastScanTime, count: latestSetups.length });
});

// ── Scout API ──────────────────────────────────────────────────────────────────
app.get('/api/scout', (_req, res) => {
  const reports = attachForexV2LifecycleCards(enrichScoutReports(latestScoutResults));
  res.json({ reports, lastScanTime, count: reports.length, pineConfirmations: Array.from(pineConfirmations.values()), pineZones: Array.from(pineZones.values()) });
});

app.post('/api/scout', async (req, res) => {
  const tf = (req.query.tf as string) || 'H4';
  try {
    await loadPriorityPairsFromStorage('SCOUT_LOAD');
    if (priorityPairsData?.pairs?.length) {
      console.log(`[Scout] Priority mode active for setup queue, ignored for scout card coverage (${priorityPairsData.pairs.length} priority pairs)`);
    }
    latestScoutResults = await runScoutScan(tf);
    recordV2LifecycleShadow(latestScoutResults, 'manual scout scan');
    await notifyTradeableScoutSignals(latestScoutResults, 'manual scout scan');
    lastScanTime = new Date().toISOString();
    const reports = attachForexV2LifecycleCards(enrichScoutReports(latestScoutResults));
    res.json({ reports, lastScanTime, count: reports.length, pineConfirmations: Array.from(pineConfirmations.values()), pineZones: Array.from(pineZones.values()) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/scout/diagnostics', async (req, res) => {
  const shouldRun = String(req.query.run || '').toLowerCase() === 'true';
  const tfParam = String(req.query.tf || '').trim();
  const requestedTimeframes = tfParam
    ? tfParam.split(',').map(tf => tf.trim().toUpperCase()).filter(Boolean)
    : [];
  try {
    if (shouldRun) {
      await loadPriorityPairsFromStorage('SCOUT_DIAGNOSTICS_LOAD');
      const timeframes = requestedTimeframes.length ? requestedTimeframes : ['H4', 'H1', 'M30'];
      const reports = (await Promise.all(timeframes.map(tf => runScoutScan(tf)))).flat();
      recordV2LifecycleShadow(reports, `manual diagnostics ${timeframes.join(',')}`);
      const diagnostics = buildScoutDiagnostics(reports, `manual diagnostics ${timeframes.join(',')}`);
      latestScoutDiagnostics = diagnostics;
      latestScoutResults = reports;
      lastScanTime = new Date().toISOString();
      logScoutDiagnostics(diagnostics);
      return res.json(diagnostics);
    }

    if (!latestScoutDiagnostics) {
      latestScoutDiagnostics = buildScoutDiagnostics(latestScoutResults, 'current cache');
    }
    return res.json(latestScoutDiagnostics);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Scalping API ─────────────────────────────────────────────────────────────
app.get('/api/scalp', (_req, res) => {
  res.json({ reports: latestScalpResults, lastScanTime, count: latestScalpResults.length });
});

app.post('/api/scalp', async (_req, res) => {
  try {
    latestScalpResults = await runScalpScan();
    res.json({ reports: latestScalpResults, lastScanTime: new Date().toISOString(), count: latestScalpResults.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Independent Watchlist Analysis API ───────────────────────────────────────
// Separate from Scout/Scalping filters. Used for manual review of a pasted list.
app.post('/api/independent-watchlist-scan', async (req, res) => {
  try {
    const rawSymbols = Array.isArray(req.body?.symbols) ? req.body.symbols : [];
    const symbols = Array.from(new Set(rawSymbols.map((s: unknown) => toOandaFormat(String(s || ''))).filter(Boolean)));
    const minRR = Number.isFinite(Number(req.body?.minRR)) ? Math.max(1, Number(req.body.minRR)) : 2;
    if (!symbols.length) {
      res.status(400).json({ error: 'symbols array is required' });
      return;
    }
    const candidates = await runIndependentWatchlistScan(symbols, minRR);
    res.json({
      candidates,
      top: candidates.slice(0, 2),
      symbols,
      minRR,
      count: candidates.length,
      scannedAt: new Date().toISOString(),
      note: 'Independent watchlist scan only. Does not change Scout, Scalping, alerts, journals, entries, stops, or targets.',
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Trending API ──────────────────────────────────────────────────────────────
app.get('/api/trending', (_req, res) => {
  res.json({
    ...(latestTrendResults ?? { strongBullish: [], strongBearish: [], pullbackOpportunities: [], all: [] }),
    lastScanTime: lastTrendScanTime,
  });
});

app.post('/api/trending', async (_req, res) => {
  try {
    const results = await refreshTrendingMarkets();
    res.json({ ...results, lastScanTime: lastTrendScanTime });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/debug', async (req, res) => {
  const granularity = (req.query.tf as string) || 'H1';
  const minRR = parseFloat((req.query.minRR as string) || '1.5');
  const pairFilter = (req.query.pair as string) || null;
  try {
    const results = await debugScan(granularity, minRR, cachedJournalStats);
    const filtered = pairFilter ? results.filter(r => r.pair === pairFilter) : results;
    res.json(filtered);
  } catch(e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/near-misses', (_req, res) => {
  res.json(latestRejected);
});

// ─── PRIORITY PAIRS API ───────────────────────────────────────────────────────
// Claude posts here after each forex scan to set the active pair list.
// GET  /api/priority-pairs  → { active: bool, pairs: string[], setAt, fullList }
// POST /api/priority-pairs  → { pairs: ["EURUSD","XAUUSD",...], meta?: {...} }
// DELETE /api/priority-pairs → clears priority mode, reverts to full 16-pair list

app.get('/api/priority-pairs', async (_req, res) => {
  let storage = await getSettingsStorageInfo();
  let stale = false;
  try {
    await loadPriorityPairsFromStorage('GET');
    storage = await getSettingsStorageInfo();
  } catch (e: any) {
    stale = priorityPairsData !== null;
    storage = await getSettingsStorageInfo();
    console.warn(`[Priority] GET storage read failed storage=${storage.backend} active=${priorityPairsData !== null}: ${e.message}`);
    if (!stale) {
      return res.status(503).json({
        error: 'Priority pair storage is unavailable',
        active: null,
        pairs: FULL_PAIRS,
        setAt: null,
        meta: null,
        fullList: FULL_PAIRS,
        storage,
      });
    }
  }
  res.json({
    active: priorityPairsData !== null,
    pairs: priorityPairsData?.pairs ?? FULL_PAIRS,
    setAt: priorityPairsData?.setAt ?? null,
    meta: priorityPairsData?.meta ?? null,
    fullList: FULL_PAIRS,
    storage,
    stale,
  });
});

app.post('/api/priority-pairs', async (req, res) => {
  const { pairs, meta } = req.body as { pairs?: unknown; meta?: unknown };
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return res.status(400).json({ error: 'Body must include non-empty pairs array' });
  }
  const { normalized, structuredMeta } = normalizePriorityPairsInput(pairs, meta);
  if (normalized.length === 0) {
    return res.status(400).json({ error: 'No valid pair symbols after normalization' });
  }
  const record: PriorityPairsData = { pairs: normalized, setAt: new Date().toISOString(), meta: structuredMeta };
  const persisted = await setSetting(PRIORITY_PAIRS_SETTING_KEY, JSON.stringify(record));
  if (!persisted) {
    const latestStorage = await getSettingsStorageInfo();
    console.warn(`[Priority] POST failed storage=${latestStorage.backend} durable=${latestStorage.durable} detail=${latestStorage.detail}${latestStorage.path ? ` path=${latestStorage.path}` : ''}`);
    return res.status(500).json({
      error: 'Priority pairs could not be persisted',
      storage: latestStorage,
      fix: 'Configure DATABASE_URL/MYSQL_URL or attach a Railway volume so RAILWAY_VOLUME_MOUNT_PATH is present.',
    });
  }
  priorityPairsData = record;
  const persistedStorage = await getSettingsStorageInfo();
  console.log(`[Priority] POST storage=${persistedStorage.backend} durable=${persistedStorage.durable} count=${normalized.length}${persistedStorage.path ? ` path=${persistedStorage.path}` : ''}: ${normalized.join(', ')}`);
  res.json({ success: true, active: true, pairs: normalized, count: normalized.length, setAt: record.setAt, meta: record.meta, storage: persistedStorage });
});

app.delete('/api/priority-pairs', async (_req, res) => {
  const persisted = await deleteSetting(PRIORITY_PAIRS_SETTING_KEY);
  if (!persisted) {
    const latestStorage = await getSettingsStorageInfo();
    console.warn(`[Priority] DELETE failed storage=${latestStorage.backend} durable=${latestStorage.durable} detail=${latestStorage.detail}${latestStorage.path ? ` path=${latestStorage.path}` : ''}`);
    return res.status(500).json({ error: 'Priority pairs could not be cleared from persistent storage', storage: latestStorage });
  }
  priorityPairsData = null;
  const persistedStorage = await getSettingsStorageInfo();
  console.log(`[Priority] DELETE storage=${persistedStorage.backend} durable=${persistedStorage.durable}${persistedStorage.path ? ` path=${persistedStorage.path}` : ''} — reverting to full 16-pair list`);
  res.json({ success: true, message: 'Priority pairs cleared, reverted to full list', storage: persistedStorage });
});

const OANDA_API_KEY = process.env.OANDA_API_KEY || '';
const OANDA_ACCOUNT_TYPE = process.env.OANDA_ACCOUNT_TYPE || 'practice';
const OANDA_BASE = OANDA_ACCOUNT_TYPE === 'live'
  ? 'https://api-fxtrade.oanda.com'
  : 'https://api-fxpractice.oanda.com';

// ─── OANDA CANDLES ────────────────────────────────────────────────────────────
app.get('/api/candles', async (req, res) => {
  const { instrument, granularity, count = '200' } = req.query as Record<string, string>;
  if (!instrument || !granularity) return res.status(400).json({ error: 'Missing params' });
  if (!OANDA_API_KEY) return res.status(500).json({ error: 'OANDA_API_KEY not configured' });
  try {
    const url = `${OANDA_BASE}/v3/instruments/${instrument}/candles?granularity=${granularity}&count=${count}&price=M`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${OANDA_API_KEY}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) return res.status(response.status).json({ error: `OANDA error: ${response.status}` });
    const data = await response.json() as any;
    const candles = data.candles.filter((c: any) => c.complete).map((c: any) => ({
      t: c.time, o: parseFloat(c.mid.o), h: parseFloat(c.mid.h),
      l: parseFloat(c.mid.l), c: parseFloat(c.mid.c), v: c.volume,
    }));
    return res.json(candles);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch OANDA data' });
  }
});

// ─── JOURNAL API ──────────────────────────────────────────────────────────────
app.get('/api/journal', async (_req, res) => {
  try {
    const entries = await getJournalEntries();
    return res.json(entries);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch journal' });
  }
});

app.post('/api/journal', async (req, res) => {
  try {
    const b = req.body;
    // Normalize field names — scanner uses pair/sl/rrRatio; client form uses symbol/stopLoss/rr1
    const normalized = {
      symbol:        b.symbol      || b.pair,
      displaySymbol: b.displaySymbol || (b.pair ? b.pair.replace('_', '/') : undefined),
      direction:     b.direction,
      quality:       b.quality,
      pattern:       b.pattern,
      timeframe:     b.timeframe,
      entry:         b.entry,
      stopLoss:      b.stopLoss    || b.sl,
      tp1:           b.tp1,
      tp2:           b.tp2,
      tp3:           b.tp3,
      rr1:           b.rr1         || b.rrRatio,
      rr2:           b.rr2,
      rr3:           b.rr3,
      confluences:   b.confluences || b.confluence,
      session:       b.session,
      newsRisk:      b.newsRisk ?? b.news_risk ?? false,
      notes:         b.notes,
      result:        b.result,
      directionCorrect: b.direction_correct ?? b.directionCorrect,
      entryQuality:  b.entry_quality ?? b.entryQuality,
      reviewNotes:   b.review_notes ?? b.reviewNotes,
      reversalConfirmed: b.reversal_confirmed ?? b.reversalConfirmed,
      reversalReason: b.reversal_reason ?? b.reversalReason,
      setupGrade: b.setup_grade ?? b.setupGrade,
      setupGradeReason: b.setup_grade_reason ?? b.setupGradeReason,
    };
    const id = await createJournalEntry(normalized);
    return res.json({ success: true, id });
  } catch (err) {
    console.error('[Journal] POST error:', err);
    return res.status(500).json({ error: 'Failed to create journal entry' });
  }
});

app.patch('/api/journal/:id', async (req, res) => {
  try {
    const b = req.body;
    await updateJournalEntry(parseInt(req.params.id), {
      outcome: b.outcome,
      pnl: b.pnl,
      notes: b.notes,
      tradeType: b.trade_type ?? b.tradeType,
      result: b.result,
      directionCorrect: b.direction_correct ?? b.directionCorrect,
      entryQuality: b.entry_quality ?? b.entryQuality,
      reviewNotes: b.review_notes ?? b.reviewNotes,
      reversalConfirmed: b.reversal_confirmed ?? b.reversalConfirmed,
      reversalReason: b.reversal_reason ?? b.reversalReason,
      setupGrade: b.setup_grade ?? b.setupGrade,
      setupGradeReason: b.setup_grade_reason ?? b.setupGradeReason,
    });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update journal entry' });
  }
});

app.delete('/api/journal/:id', async (req, res) => {
  try {
    await deleteJournalEntry(parseInt(req.params.id));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete journal entry' });
  }
});

app.delete('/api/journal', async (_req, res) => {
  try {
    await clearAllJournalEntries();
    cachedJournalStats = {};
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to clear journal' });
  }
});

async function notifyPineConfirmation(confirmation: PineConfirmation, report: ScoutReport) {
  if (!isForexMarketOpen()) {
    console.log(`[TradingView] Pine confirmation stored without Telegram alert; market closed for ${confirmation.symbol} ${confirmation.timeframe}`);
    return { ok: false, skipped: true, reason: 'market_closed' };
  }

  const alertKey = `${pineConfirmationKey(confirmation.symbol, confirmation.timeframe, confirmation.direction)}|${report.candleTime}|${confirmation.sourceTime || confirmation.receivedAt}`;
  const now = Date.now();
  const alertedAt = pineConfirmationAlerts.get(alertKey);
  if (alertedAt && now - alertedAt < PINE_CONFIRMATION_ALERT_COOLDOWN_MS) {
    console.log(`[TradingView] Pine confirmation suppressed by cooldown for ${confirmation.symbol} ${confirmation.timeframe}`);
    return { ok: false, skipped: true, reason: 'cooldown' };
  }

  const direction = confirmation.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  const pineZoneRange = confirmation.zoneHigh != null && confirmation.zoneLow != null
    ? `${formatScoutLevel(Math.min(confirmation.zoneHigh, confirmation.zoneLow))}-${formatScoutLevel(Math.max(confirmation.zoneHigh, confirmation.zoneLow))}`
    : 'N/A';
  const text = `✅ *ENTRY TRIGGER — Pine Rejection Confirmed*\nPair: ${confirmation.displaySymbol}\nDirection: ${direction}\nTimeframe: ${confirmation.timeframe}\nInternal Grade: ${report.setupGrade}\nTrend: ${displayScoutTrend(report)}\nNow: ${report.setupTimeframeDirection}\nMarket Type: ${shortScoutPhaseText(displayScoutPhase(report))}\nLocation: ${report.zone}\nZone Status: ${shortScoutTimingText(entryTimingDisplay(report))}\nPine Indicator Zone: ${confirmation.zoneType} ${pineZoneRange}\nRejection: ${confirmation.rejectionType || 'Confirmed'}\nPrice: ${confirmation.price !== undefined ? formatScoutLevel(confirmation.price) : 'N/A'}\nEntry: ${formatScoutLevel(report.entry)}\nSL: ${formatScoutLevel(report.sl)}\nTP1: ${formatScoutLevel(report.tp1)}\nR:R: ${report.rrRatio ?? 'N/A'}\nSupport: ${formatScoutLevel(report.nearestSupport)}\nResistance: ${formatScoutLevel(report.nearestResistance)}\nReason: Scanner setup matched a TradingView/Pine supply-demand rejection.\nMessage: ${confirmation.message || 'Pine rejection confirmed'}\n→ https://erica-forex-screener-production.up.railway.app`;

  const data = await sendTelegram(text, 'Markdown');
  if (data.ok) pineConfirmationAlerts.set(alertKey, now);
  return data;
}

// ─── TRADINGVIEW SCOUT CONFIRMATION LAYER ────────────────────────────────────
app.post('/api/tradingview-confirmation', async (req, res) => {
  try {
    const configuredSecret = process.env.TRADINGVIEW_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;
    if (!configuredSecret) {
      return res.status(500).json({ error: 'TradingView confirmations disabled: missing TRADINGVIEW_WEBHOOK_SECRET' });
    }

    const body = parseTradingViewBody(req.body);
    if (body.secret !== configuredSecret) {
      return res.status(401).json({ error: 'Invalid TradingView alert secret' });
    }

    const { symbol, displaySymbol } = normalizeTradingViewScoutSymbol(body.symbol || body.ticker || body.pair);
    const timeframe = normalizeTimeframe(body.timeframe || body.interval);
    const zoneType = normalizeZoneType(body.zoneType || body.zone_type || body.zone || body.location);
    const direction = normalizeDirection(body.direction || body.action || body.side) || directionFromZoneType(zoneType);
    const price = toNumber(body.price || body.close);
    const zoneHigh = toNumber(body.zoneHigh || body.zone_high || body.supplyHigh || body.demandHigh);
    const zoneLow = toNumber(body.zoneLow || body.zone_low || body.supplyLow || body.demandLow);
    const eventName = String(body.rejectionType || body.rejection_type || body.event || body.type || '').trim();
    const isZoneOnlyUpdate = /zone[_\s-]*(update|sync|created|active)/i.test(eventName) || String(body.mode || '').toLowerCase() === 'zone';
    const rejectionType = isZoneOnlyUpdate ? 'Zone update' : String(eventName || 'Supply/Demand rejection').trim();
    const message = String(body.message || body.note || (isZoneOnlyUpdate ? `${zoneType} zone synced from Pine` : `${zoneType} rejection confirmed`)).slice(0, 300);
    const sourceTime = body.time || body.timestamp ? String(body.time || body.timestamp) : undefined;

    if (!symbol || !direction || !timeframe || zoneType === 'UNKNOWN') {
      return res.status(400).json({
        error: 'TradingView confirmation must include symbol, timeframe, and zoneType supply/demand. Direction can be sent directly or inferred from zoneType.',
        received: {
          symbol: Boolean(symbol),
          timeframe: Boolean(timeframe),
          direction: Boolean(direction),
          zoneType,
        },
      });
    }

    cleanupPineConfirmations();
    const hasPineZone = zoneHigh != null && zoneLow != null && (zoneType === 'DEMAND' || zoneType === 'SUPPLY');
    const receivedAt = new Date().toISOString();
    let pineZone: PineZone | undefined;
    if (hasPineZone) {
      pineZone = {
        symbol,
        displaySymbol,
        timeframe,
        direction,
        zoneType,
        zoneHigh,
        zoneLow,
        price,
        message,
        receivedAt,
        sourceTime,
        source: 'TradingView/Pine',
      };
      pineZones.set(pineZoneKey(symbol, timeframe, direction), pineZone);
    }

    if (isZoneOnlyUpdate) {
      return res.json({
        success: true,
        matched: false,
        matchReason: 'Pine indicator zone stored. No rejection confirmation was processed.',
        zoneStored: Boolean(pineZone),
        confirmationStored: false,
        pineZone,
      });
    }

    const report = findScoutForPineConfirmation(symbol, timeframe, direction);
    const confirmation: PineConfirmation = {
      symbol,
      displaySymbol,
      timeframe,
      direction,
      zoneType,
      rejectionType,
      price,
      zoneHigh,
      zoneLow,
      message,
      receivedAt,
      sourceTime,
      matched: Boolean(report),
      matchReason: report
        ? `${report.setupGrade} Scout setup matched by symbol, timeframe, and direction.`
        : 'No current A/B Scout setup matched symbol, timeframe, and direction.',
      scoutKey: report ? scoutKey(report.pair, report.timeframe) : undefined,
    };
    pineConfirmations.set(pineConfirmationKey(symbol, timeframe, direction), confirmation);

    let telegram: any = { ok: false, skipped: true, reason: 'no_matching_scout' };
    if (report) {
      telegram = await notifyPineConfirmation(confirmation, report);
    }

    return res.json({
      success: true,
      matched: Boolean(report),
      matchReason: confirmation.matchReason,
      zoneStored: Boolean(pineZone),
      telegram,
      confirmation,
      pineZone,
    });
  } catch (e: any) {
    console.error('[TradingView] Confirmation failed:', e.message);
    return res.status(500).json({ error: 'Failed to process TradingView confirmation' });
  }
});

// ─── TRADINGVIEW PAPER ALERT RELAY ────────────────────────────────────────────
app.post('/api/tradingview-alert', async (req, res) => {
  try {
    const configuredSecret = process.env.TRADINGVIEW_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;
    if (!configuredSecret) {
      return res.status(500).json({ error: 'TradingView alerts disabled: missing TRADINGVIEW_WEBHOOK_SECRET' });
    }

    const body = parseTradingViewBody(req.body);
    if (body.secret !== configuredSecret) {
      return res.status(401).json({ error: 'Invalid TradingView alert secret' });
    }

    const { symbol, displaySymbol } = normalizeSymbol(body.symbol || body.ticker || body.pair);
    const direction = normalizeDirection(body.action || body.direction || body.side);
    const entry = toNumber(body.entry || body.price || body.close);
    const stopLoss = toNumber(body.sl || body.stop || body.stopLoss || body.stop_loss);
    const tp1 = toNumber(body.tp || body.tp1 || body.takeProfit || body.take_profit);
    const timeframe = String(body.timeframe || body.interval || 'TradingView').trim();
    const strategy = String(body.strategy || body.pattern || 'TradingView Alert').trim();
    const session = String(body.session || 'TradingView').trim();

    if (!symbol || !direction || entry === undefined || stopLoss === undefined || tp1 === undefined) {
      return res.status(400).json({
        error: 'TradingView alert must include symbol, action/direction, entry, sl, and tp',
        received: {
          symbol: Boolean(symbol),
          direction: Boolean(direction),
          entry: entry !== undefined,
          sl: stopLoss !== undefined,
          tp: tp1 !== undefined,
        },
      });
    }

    const rr1 = calculateRr(direction, entry, stopLoss, tp1);
    if (rr1 === undefined) {
      return res.status(400).json({ error: 'Invalid risk/reward: check entry, sl, tp, and direction' });
    }

    const id = await createJournalEntry({
      symbol,
      displaySymbol,
      direction,
      quality: 'DEVELOPING',
      pattern: strategy,
      timeframe,
      entry,
      stopLoss,
      tp1,
      rr1,
      confluences: ['TradingView alert', body.mode === 'paper' ? 'Paper trade' : 'Alert relay'],
      session,
      newsRisk: Boolean(body.newsRisk || body.news_risk),
      notes: `TradingView paper alert${body.message ? `: ${String(body.message).slice(0, 300)}` : ''}`,
      tradeType: 'paper',
    });

    console.log(`[TradingView] Paper alert journaled without Telegram alert for ${displaySymbol}`);
    return res.json({ success: true, journalId: id, telegram: 'disabled', mode: 'paper' });
  } catch (e: any) {
    console.error('[TradingView] Alert failed:', e.message);
    return res.status(500).json({ error: 'Failed to process TradingView alert' });
  }
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', oanda: OANDA_API_KEY ? 'configured' : 'missing', accountType: OANDA_ACCOUNT_TYPE });
});

// ─── APPROVALS API ────────────────────────────────────────────────────────────
app.get('/api/approvals', (_req, res) => {
  res.json(pendingApprovals);
});

app.delete('/api/approvals/:id', (req, res) => {
  pendingApprovals = pendingApprovals.filter(p => p.id !== req.params.id);
  res.json({ success: true });
});

app.post('/api/approvals/:id/execute', async (req, res) => {
  const setup = pendingApprovals.find(p => p.id === req.params.id);
  if (!setup) return res.status(404).json({ error: 'Setup not found' });

  const botUrl = process.env.BOT_URL;
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!botUrl || !webhookSecret) {
    return res.status(500).json({ error: 'Bot execution disabled: missing BOT_URL or WEBHOOK_SECRET' });
  }

  try {
    const payload = {
      secret: webhookSecret,
      action: setup.direction === 'LONG' ? 'buy' : 'sell',
      symbol: (setup.pair || (setup as any).symbol || '').replace('_', ''),
      entry: setup.entry,
      sl: setup.sl || (setup as any).stopLoss || (setup as any).stop_loss || 0,
      tp: setup.tp1 || (setup as any).tp || 0,
      comment: `${setup.quality}-${setup.pattern}`,
    };

    const response = await fetch(`${botUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    pendingApprovals = pendingApprovals.filter(p => p.id !== setup.id);
    return res.json({ success: true, result });
  } catch(e: any) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/approvals/manual', (req, res) => {
  const setup = req.body;
  if (!setup || (!setup.pair && !setup.symbol) || !setup.direction) {
    return res.status(400).json({ error: 'Invalid setup data' });
  }
  // Normalize - ensure pair field exists
  if (!setup.pair && setup.symbol) setup.pair = setup.symbol;

  const exists = pendingApprovals.some(
    p => p.pair === setup.pair && p.timeframe === setup.timeframe &&
    Math.abs(p.entry - setup.entry) < (setup.pair.includes('JPY') ? 0.1 : 0.001)
  );
  if (!exists) {
    pendingApprovals.push({ ...setup, id: `${setup.pair}-manual-${Date.now()}` });
  }
  return res.json({ success: true, queued: !exists });
});

// ─── TEST ENDPOINTS ───────────────────────────────────────────────────────────
app.get('/api/test-telegram', async (_req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return res.json({ error: 'Telegram not configured' });
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: '🔔 Telegram test from scanner', parse_mode: 'Markdown' }),
  });
  const data = await r.json();
  return res.json(data);
});

// ─── AI STUDIO BACKEND PROVIDERS ──────────────────────────────────────────────
app.post('/api/ai-studio/generate-episode', async (req, res) => {
  try {
    const result = await aiStudioGenerate('episode', req.body || {}, buildMockAiEpisode);
    return res.json(result);
  } catch (error: any) {
    console.error('[AI Studio] generate episode failed:', error.message);
    return res.status(500).json({ error: 'Failed to generate episode' });
  }
});

app.post('/api/ai-studio/generate-follow-up', async (req, res) => {
  try {
    const result = await aiStudioGenerate('followUp', req.body || {}, buildMockAiFollowUp);
    return res.json(result);
  } catch (error: any) {
    console.error('[AI Studio] generate follow-up failed:', error.message);
    return res.status(500).json({ error: 'Failed to generate follow-up' });
  }
});

app.post('/api/ai-studio/generate-visual-briefs', async (req, res) => {
  try {
    const result = await aiStudioGenerate('visualBriefs', req.body || {}, buildMockAiVisualBriefs);
    return res.json(result);
  } catch (error: any) {
    console.error('[AI Studio] generate visual briefs failed:', error.message);
    return res.status(500).json({ error: 'Failed to generate visual briefs' });
  }
});

// ─── TRAINER ──────────────────────────────────────────────────────────────────
const TRAINER_PAIRS = ['EUR_USD','GBP_USD','USD_JPY','EUR_JPY','GBP_JPY','AUD_USD','NZD_USD','USD_CAD'];
const TRAINER_CONFIG: Record<string, { gran: string; count: number }> = {
  beginner:     { gran: 'H1', count: 70  },
  intermediate: { gran: 'H4', count: 80  },
  advanced:     { gran: 'H4', count: 100 },
};

app.get('/api/trainer/chart', async (req, res) => {
  const level = (req.query.level as string) || 'intermediate';
  const cfg   = TRAINER_CONFIG[level] || TRAINER_CONFIG.intermediate;
  const pair  = TRAINER_PAIRS[Math.floor(Math.random() * TRAINER_PAIRS.length)];
  try {
    const raw    = await fetchCandles(pair, cfg.gran, cfg.count);
    const structures = computeStructures(raw);
    const candles = raw.map(c => ({
      time:  Math.floor(new Date(c.t).getTime() / 1000),
      open:  c.o, high: c.h, low: c.l, close: c.c,
    }));
    res.json({ pair: pair.replace('_', '/'), timeframe: cfg.gran, candles, structures });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── STATIC ───────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = parseInt(process.env.PORT || '8080', 10);
console.log(`PORT env var is: ${process.env.PORT}`);
server.listen(PORT, () => {
  console.log(`✅ Forex Scanner running on http://localhost:${PORT}`);
  console.log(`   OANDA: ${OANDA_API_KEY ? '✓ configured' : '✗ missing key'} (${OANDA_ACCOUNT_TYPE})`);
  console.log(`[Config] TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? 'set' : 'MISSING'}`);
});
