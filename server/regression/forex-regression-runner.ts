import {
  scoutAlertRoute,
  scoutNextMilestone,
  scoutNextStep,
  scoutPhaseState,
  scoutTelegramHeadline,
  tradeableSignalAlertKey,
} from '../scoutPhase.js';
import { analyzeCandles } from '../scanner.js';
import { duplicateEnterNowCase, forexRegressionCases } from './forex-regression-cases.js';

interface Failure {
  caseName: string;
  message: string;
}

const failures: Failure[] = [];

function matches(actual: string, expected: string | RegExp) {
  return typeof expected === 'string' ? actual === expected : expected.test(actual);
}

function assertCase(caseName: string, condition: boolean, message: string) {
  if (!condition) failures.push({ caseName, message });
}

for (const testCase of forexRegressionCases) {
  const phase = scoutPhaseState(testCase.report);
  const nextStep = scoutNextStep(testCase.report, phase);
  const nextMilestone = scoutNextMilestone(nextStep);
  const alertRoute = scoutAlertRoute(testCase.report);
  const headline = scoutTelegramHeadline(testCase.report);

  assertCase(
    testCase.name,
    phase.label === testCase.expected.phase,
    `phase expected ${testCase.expected.phase}, got ${phase.label}`,
  );

  if (testCase.expected.progress !== undefined) {
    assertCase(
      testCase.name,
      phase.progress === testCase.expected.progress,
      `progress expected ${testCase.expected.progress}, got ${phase.progress}`,
    );
  }

  if (testCase.expected.nextStep) {
    assertCase(
      testCase.name,
      matches(nextStep, testCase.expected.nextStep),
      `nextStep expected ${String(testCase.expected.nextStep)}, got "${nextStep}"`,
    );
  }

  if (testCase.expected.nextMilestone) {
    assertCase(
      testCase.name,
      matches(nextMilestone, testCase.expected.nextMilestone),
      `nextMilestone expected ${String(testCase.expected.nextMilestone)}, got "${nextMilestone}"`,
    );
  }

  assertCase(
    testCase.name,
    alertRoute === testCase.expected.alertRoute,
    `alertRoute expected ${testCase.expected.alertRoute}, got ${alertRoute}`,
  );

  if (testCase.expected.headlineIncludes) {
    assertCase(
      testCase.name,
      headline.includes(testCase.expected.headlineIncludes),
      `headline expected to include "${testCase.expected.headlineIncludes}", got "${headline}"`,
    );
  }

  if (alertRoute === 'urgent') {
    assertCase(
      testCase.name,
      headline.includes('ENTER NOW') && !headline.includes('Almost Ready'),
      `urgent headline should say ENTER NOW, got "${headline}"`,
    );
  }

  if (alertRoute === 'soft') {
    assertCase(
      testCase.name,
      headline.includes('Almost Ready') && headline.includes('Review setup') && !headline.includes('ENTER NOW'),
      `soft headline should be review wording, got "${headline}"`,
    );
  }

  if (alertRoute === 'none') {
    assertCase(
      testCase.name,
      headline === '',
      `non-alerting setup should not produce a headline, got "${headline}"`,
    );
  }
}

const duplicateKeyA = tradeableSignalAlertKey(duplicateEnterNowCase.report, 'entry');
const duplicateKeyB = tradeableSignalAlertKey({ ...duplicateEnterNowCase.report }, 'entry');
const nextCandleKey = tradeableSignalAlertKey({
  ...duplicateEnterNowCase.report,
  candleTime: '2026-06-30T19:00:00.000Z',
}, 'entry');

assertCase(
  duplicateEnterNowCase.name,
  duplicateKeyA === duplicateKeyB,
  'same setup/candle should produce identical dedupe key',
);
assertCase(
  duplicateEnterNowCase.name,
  duplicateKeyA !== nextCandleKey,
  'new candle should produce a new dedupe key',
);

const tp1FreshnessCaseName = 'TP1 freshness rejects two failed TP1 approaches';
const tp1Freshness = buildTp1FreshnessFixture();
const tp1FreshnessResult = analyzeCandles(tp1Freshness.candles, tp1Freshness.htf, 'EUR_USD', 'H1', 1.5);
assertCase(
  tp1FreshnessCaseName,
  tp1FreshnessResult.setup === null,
  `expected stale TP1 setup to reject, got SETUP with TP1 ${tp1FreshnessResult.setup?.tp1}`,
);
assertCase(
  tp1FreshnessCaseName,
  tp1FreshnessResult.reason.includes('tested/rejected level'),
  `expected tested/rejected level reason, got "${tp1FreshnessResult.reason}"`,
);

const htfConflictCaseName = 'HTF conflict rejects long setup against bearish HTF';
const htfConflict = buildHtfConflictFixture();
const htfConflictResult = analyzeCandles(htfConflict.candles, htfConflict.htf, 'EUR_USD', 'H1', 1.5);
assertCase(
  htfConflictCaseName,
  htfConflictResult.setup === null,
  `expected HTF conflict setup to reject, got SETUP with direction ${htfConflictResult.setup?.direction}`,
);
assertCase(
  htfConflictCaseName,
  htfConflictResult.reason.includes('HTF conflict'),
  `expected HTF conflict reason, got "${htfConflictResult.reason}"`,
);

const weakZoneRejectionCaseName = 'Weak zone rejection close is rejected';
const weakZoneRejection = buildWeakZoneRejectionFixture();
const weakZoneRejectionResult = analyzeCandles(weakZoneRejection.candles, weakZoneRejection.htf, 'EUR_USD', 'H1', 1.5);
assertCase(
  weakZoneRejectionCaseName,
  weakZoneRejectionResult.setup === null,
  `expected weak zone rejection to reject, got SETUP with pattern ${weakZoneRejectionResult.setup?.pattern}`,
);
assertCase(
  weakZoneRejectionCaseName,
  weakZoneRejectionResult.reason.includes('No rejection candle'),
  `expected no rejection candle reason, got "${weakZoneRejectionResult.reason}"`,
);

const structureClearanceCases = [
  {
    name: 'Local TF resistance blocks LONG path',
    fixture: buildLocalLongStructureBlockFixture(),
    reason: 'Entry too close to resistance',
  },
  {
    name: 'Local TF support blocks SHORT path',
    fixture: buildLocalShortStructureBlockFixture(),
    reason: 'Entry too close to support',
  },
  {
    name: 'HTF resistance blocks LONG path',
    fixture: buildHtfLongStructureBlockFixture(),
    reason: 'Entry too close to HTF resistance',
  },
  {
    name: 'HTF support blocks SHORT path',
    fixture: buildHtfShortStructureBlockFixture(),
    reason: 'Entry too close to HTF support',
  },
];

for (const testCase of structureClearanceCases) {
  const result = analyzeCandles(testCase.fixture.candles, testCase.fixture.htf, 'EUR_USD', 'H1', 1.5);
  assertCase(
    testCase.name,
    result.setup === null,
    `expected structure blocker to reject, got SETUP with TP1 ${result.setup?.tp1}`,
  );
  assertCase(
    testCase.name,
    result.reason.includes(testCase.reason),
    `expected reason to include "${testCase.reason}", got "${result.reason}"`,
  );
}

const total = forexRegressionCases.length + 4 + structureClearanceCases.length;
const passed = total - new Set(failures.map(f => f.caseName)).size;

console.log('\n── Forex Scout Regression Suite ───────────────────────────────────');
for (const testCase of forexRegressionCases) {
  const caseFailures = failures.filter(f => f.caseName === testCase.name);
  if (!caseFailures.length) {
    const phase = scoutPhaseState(testCase.report);
    const route = scoutAlertRoute(testCase.report);
    console.log(`✅ ${testCase.name} — ${phase.label}, ${phase.progress}%, alert=${route}`);
  } else {
    console.log(`❌ ${testCase.name}`);
    caseFailures.forEach(f => console.log(`   - ${f.message}`));
  }
}

const duplicateFailures = failures.filter(f => f.caseName === duplicateEnterNowCase.name);
if (!duplicateFailures.length) {
  console.log(`✅ ${duplicateEnterNowCase.name}`);
} else {
  console.log(`❌ ${duplicateEnterNowCase.name}`);
  duplicateFailures.forEach(f => console.log(`   - ${f.message}`));
}

const tp1Failures = failures.filter(f => f.caseName === tp1FreshnessCaseName);
if (!tp1Failures.length) {
  console.log(`✅ ${tp1FreshnessCaseName}`);
} else {
  console.log(`❌ ${tp1FreshnessCaseName}`);
  tp1Failures.forEach(f => console.log(`   - ${f.message}`));
}

const htfFailures = failures.filter(f => f.caseName === htfConflictCaseName);
if (!htfFailures.length) {
  console.log(`✅ ${htfConflictCaseName}`);
} else {
  console.log(`❌ ${htfConflictCaseName}`);
  htfFailures.forEach(f => console.log(`   - ${f.message}`));
}

const weakZoneFailures = failures.filter(f => f.caseName === weakZoneRejectionCaseName);
if (!weakZoneFailures.length) {
  console.log(`✅ ${weakZoneRejectionCaseName}`);
} else {
  console.log(`❌ ${weakZoneRejectionCaseName}`);
  weakZoneFailures.forEach(f => console.log(`   - ${f.message}`));
}

for (const testCase of structureClearanceCases) {
  const caseFailures = failures.filter(f => f.caseName === testCase.name);
  if (!caseFailures.length) {
    console.log(`✅ ${testCase.name}`);
  } else {
    console.log(`❌ ${testCase.name}`);
    caseFailures.forEach(f => console.log(`   - ${f.message}`));
  }
}

console.log(`\nTotal: ${total} | Passed: ${passed} | Failed: ${new Set(failures.map(f => f.caseName)).size}`);

if (failures.length) {
  process.exit(1);
}

interface Candle { t:string; o:number; h:number; l:number; c:number; v:number; }

function calcATRLocal(candles: Candle[]): number {
  const sl = candles.slice(-50);
  if (sl.length < 2) return 0.001;
  const trs = sl.map((c, i, a) =>
    i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - a[i - 1].c), Math.abs(c.l - a[i - 1].c))
  );
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function calcEMALocal(candles: Candle[], period: number): number[] {
  const k = 2 / (period + 1);
  const e: number[] = new Array(candles.length);
  let s = 0;
  for (let i = 0; i < period; i++) s += candles[i].c;
  e[period - 1] = s / period;
  for (let i = period; i < candles.length; i++) e[i] = candles[i].c * k + e[i - 1] * (1 - k);
  return e;
}

function altUp(count: number, start: number, wick = 0.0004): Candle[] {
  const up = 0.00014;
  const dn = 0.00010;
  let p = start;
  return Array.from({ length: count }, (_, i) => {
    const step = i % 2 === 0 ? up : -dn;
    const c = p + step;
    const o = p;
    p = c;
    return { t: new Date(Date.UTC(2024, 0, 1) + i * 3600000).toISOString(), o, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick, c, v: 1000 };
  });
}

function altDown(count: number, start: number, wick = 0.0004): Candle[] {
  const dn = 0.00014;
  const up = 0.00010;
  let p = start;
  return Array.from({ length: count }, (_, i) => {
    const step = i % 2 === 0 ? -dn : up;
    const c = p + step;
    const o = p;
    p = c;
    return { t: new Date(Date.UTC(2024, 0, 1) + i * 3600000).toISOString(), o, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick, c, v: 1000 };
  });
}

function overrideLast(base: Candle[], overrides: Partial<Candle>[]): Candle[] {
  const out = [...base];
  for (let i = 0; i < overrides.length; i++) {
    const idx = out.length - overrides.length + i;
    out[idx] = { ...out[idx], ...overrides[i] };
  }
  return out;
}

function buildTp1FreshnessFixture() {
  const longBase = altUp(250, 1.1000, 0.0004);
  const atr = calcATRLocal(longBase);
  const ema20 = calcEMALocal(longBase, 20)[249];
  const bounceOpen = ema20 + 0.05 * atr;
  const bounceLow = ema20 - 0.30 * atr;
  const bounceClose = ema20 + 0.55 * atr;
  const bounceHigh = bounceClose + 0.10 * atr;
  const pullback = [{ o: bounceOpen, h: bounceHigh, l: bounceLow, c: bounceClose, v: 1500 }];
  const approxTP1 = ema20 + 2.85 * atr;
  const candles = [...longBase];
  for (const ri of [-40, -38]) {
    const idx = candles.length + ri;
    candles[idx] = {
      ...candles[idx],
      h: approxTP1 + 0.1 * atr,
      c: approxTP1 - 0.15 * atr,
      o: approxTP1 - 0.20 * atr,
      l: approxTP1 - 0.30 * atr,
    };
  }
  return {
    candles: overrideLast(candles, pullback),
    htf: altUp(150, ema20 * 0.999, 0.0003),
  };
}

function makeZigzagDown(count: number, start: number): Candle[] {
  const drop = 0.003;
  const recover = 0.001;
  const downLen = 7;
  const upLen = 3;
  const period = downLen + upLen;
  const candles: Candle[] = [];
  let p = start;
  for (let i = 0; i < count; i++) {
    const phase = i % period;
    const isDown = phase < downLen;
    const step = isDown ? -(drop / downLen) : (recover / upLen);
    const o = p;
    const c = p + step;
    const wick = Math.abs(step) * 0.25;
    p = c;
    candles.push({
      t: new Date(Date.UTC(2024, 0, 1) + i * 14400000).toISOString(),
      o,
      h: Math.max(o, c) + wick,
      l: Math.min(o, c) - wick,
      c,
      v: 1000,
    });
  }
  return candles;
}

function buildHtfConflictFixture() {
  const longBase = altUp(250, 1.1000, 0.0004);
  const atr = calcATRLocal(longBase);
  const ema20 = calcEMALocal(longBase, 20)[249];
  const bounceOpen = ema20 + 0.05 * atr;
  const bounceLow = ema20 - 0.30 * atr;
  const bounceClose = ema20 + 0.55 * atr;
  const bounceHigh = bounceClose + 0.10 * atr;
  const pullback = [{ o: bounceOpen, h: bounceHigh, l: bounceLow, c: bounceClose, v: 1500 }];
  const p = longBase[249].c;
  return {
    candles: overrideLast(longBase, pullback),
    htf: makeZigzagDown(150, p + 0.05),
  };
}

function buildWeakZoneRejectionFixture() {
  const longBase = altUp(250, 1.1000, 0.0004);
  const atr = calcATRLocal(longBase);
  const ema20 = calcEMALocal(longBase, 20)[249];
  return {
    candles: overrideLast(longBase, [
      {
        o: ema20 - 0.25 * atr,
        h: ema20 + 0.25 * atr,
        l: ema20 - 0.30 * atr,
        c: ema20 + 0.15 * atr,
        v: 900,
      },
    ]),
    htf: altUp(150, ema20 * 0.999, 0.0003),
  };
}

function buildLongPullbackFixture() {
  const base = altUp(250, 1.1000, 0.0004);
  const atr = calcATRLocal(base);
  const ema20 = calcEMALocal(base, 20)[249];
  const bounceOpen = ema20 + 0.05 * atr;
  const bounceLow = ema20 - 0.30 * atr;
  const bounceClose = ema20 + 0.55 * atr;
  const bounceHigh = bounceClose + 0.10 * atr;
  return {
    base,
    atr,
    ema20,
    entry: bounceClose,
    pullback: [{ o: bounceOpen, h: bounceHigh, l: bounceLow, c: bounceClose, v: 1500 }],
    htf: altUp(150, ema20 * 0.999, 0.0003),
  };
}

function buildShortPullbackFixture() {
  const base = altDown(250, 1.1500, 0.0004);
  const atr = calcATRLocal(base);
  const ema20 = calcEMALocal(base, 20)[249];
  const bounceOpen = ema20;
  const bounceHigh = ema20 + 0.30 * atr;
  const bounceClose = ema20 - 0.45 * atr;
  const bounceLow = bounceClose - 0.10 * atr;
  return {
    base,
    atr,
    ema20,
    entry: bounceClose,
    pullback: [{ o: bounceOpen, h: bounceHigh, l: bounceLow, c: bounceClose, v: 1500 }],
    htf: altDown(150, ema20 * 1.001, 0.0003),
  };
}

function injectSwingHigh(series: Candle[], highPrice: number, atr: number, relIdx: number): Candle[] {
  const out = [...series];
  const n = out.length;
  for (let off = -5; off <= 5; off++) {
    const idx = n + relIdx + off;
    if (idx < 0 || idx >= n - 3) continue;
    if (off === 0) out[idx] = { ...out[idx], h: highPrice, l: highPrice - atr * 0.4, o: highPrice - atr * 0.3, c: highPrice - atr * 0.2 };
    else out[idx] = { ...out[idx], h: Math.min(out[idx].h, highPrice - Math.abs(off) * atr * 0.15) };
  }
  return out;
}

function injectSwingLow(series: Candle[], lowPrice: number, atr: number, relIdx: number): Candle[] {
  const out = [...series];
  const n = out.length;
  for (let off = -5; off <= 5; off++) {
    const idx = n + relIdx + off;
    if (idx < 0 || idx >= n - 3) continue;
    if (off === 0) out[idx] = { ...out[idx], l: lowPrice, h: lowPrice + atr * 0.4, o: lowPrice + atr * 0.3, c: lowPrice + atr * 0.2 };
    else out[idx] = { ...out[idx], l: Math.max(out[idx].l, lowPrice + Math.abs(off) * atr * 0.15) };
  }
  return out;
}

function buildLocalLongStructureBlockFixture() {
  const fx = buildLongPullbackFixture();
  const blockingResistance = fx.entry + 1.2 * fx.atr;
  return {
    candles: overrideLast(injectSwingHigh(fx.base, blockingResistance, fx.atr, -18), fx.pullback),
    htf: fx.htf,
  };
}

function buildLocalShortStructureBlockFixture() {
  const fx = buildShortPullbackFixture();
  const blockingSupport = fx.entry - 1.2 * fx.atr;
  return {
    candles: overrideLast(injectSwingLow(fx.base, blockingSupport, fx.atr, -18), fx.pullback),
    htf: fx.htf,
  };
}

function buildHTFWithHighAt(highPrice: number): Candle[] {
  const h = [...altUp(150, 1.100, 0.0005)];
  const n = h.length;
  for (let off = -5; off <= 5; off++) {
    const idx = n - 30 + off;
    if (idx < 0 || idx >= n) continue;
    if (off === 0) h[idx] = { ...h[idx], h: highPrice, l: highPrice - 0.0007, o: highPrice - 0.0005, c: highPrice - 0.0004 };
    else h[idx] = { ...h[idx], h: Math.min(h[idx].h, highPrice - Math.abs(off) * 0.00025) };
  }
  return h;
}

function buildHTFWithLowAt(lowPrice: number): Candle[] {
  const h = [...altDown(150, 1.150, 0.0005)];
  const n = h.length;
  for (let off = -5; off <= 5; off++) {
    const idx = n - 30 + off;
    if (idx < 0 || idx >= n) continue;
    if (off === 0) h[idx] = { ...h[idx], l: lowPrice, h: lowPrice + 0.0007, o: lowPrice + 0.0005, c: lowPrice + 0.0004 };
    else h[idx] = { ...h[idx], l: Math.max(h[idx].l, lowPrice + Math.abs(off) * 0.00025) };
  }
  return h;
}

function buildHtfLongStructureBlockFixture() {
  const fx = buildLongPullbackFixture();
  return {
    candles: overrideLast(fx.base, fx.pullback),
    htf: buildHTFWithHighAt(fx.entry + 1.6 * fx.atr),
  };
}

function buildHtfShortStructureBlockFixture() {
  const fx = buildShortPullbackFixture();
  return {
    candles: overrideLast(fx.base, fx.pullback),
    htf: buildHTFWithLowAt(fx.entry - 1.6 * fx.atr),
  };
}
