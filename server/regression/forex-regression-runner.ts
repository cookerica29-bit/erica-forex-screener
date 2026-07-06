import {
  scoutAlertRoute,
  scoutNextMilestone,
  scoutNextStep,
  scoutPhaseState,
  scoutTelegramHeadline,
  tradeableSignalAlertKey,
} from '../scoutPhase.js';
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

const total = forexRegressionCases.length + 1;
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

console.log(`\nTotal: ${total} | Passed: ${passed} | Failed: ${new Set(failures.map(f => f.caseName)).size}`);

if (failures.length) {
  process.exit(1);
}
