import { evaluateLifecycle, type LifecycleInput } from '../lifecycle.js';
import { isValidLifecycleTransition, type LifecycleState } from '../stateMachine.js';

interface Failure {
  caseName: string;
  message: string;
}

const failures: Failure[] = [];

function assertCase(caseName: string, condition: boolean, message: string) {
  if (!condition) failures.push({ caseName, message });
}

function base(overrides: Partial<LifecycleInput> = {}): LifecycleInput {
  return {
    symbol: 'EUR_USD',
    timeframe: 'M30',
    direction: 'LONG',
    daily_bias: 'Neutral',
    h4_bias: 'Neutral',
    liquidity_swept: false,
    structure_confirmed: false,
    location_valid: false,
    planned_entry_ready: false,
    planned_entry: null,
    entry_reached: false,
    ...overrides,
  };
}

const sequence: Array<{ name: string; input: LifecycleInput; expected: LifecycleState; missing?: string }> = [
  {
    name: 'BUILDING has missing context',
    input: base(),
    expected: 'BUILDING',
    missing: 'Daily Bias',
  },
  {
    name: 'ALMOST_READY waits for liquidity',
    input: base({
      daily_bias: 'Bullish',
      h4_bias: 'Bullish',
      location_valid: true,
      planned_entry_ready: true,
      planned_entry: 1.1,
      liquidity_reason: 'Waiting for sell-side liquidity sweep.',
    }),
    expected: 'ALMOST_READY',
    missing: 'Liquidity Sweep',
  },
  {
    name: 'LIQUIDITY_SWEPT waits for structure',
    input: base({
      daily_bias: 'Bullish',
      h4_bias: 'Bullish',
      location_valid: true,
      planned_entry_ready: true,
      planned_entry: 1.1,
      liquidity_swept: true,
      liquidity_reason: 'Sell-side liquidity swept.',
    }),
    expected: 'LIQUIDITY_SWEPT',
    missing: 'Structure Confirmation',
  },
  {
    name: 'STRUCTURE_CONFIRMED waits for planned entry',
    input: base({
      daily_bias: 'Bullish',
      h4_bias: 'Bullish',
      location_valid: true,
      liquidity_swept: true,
      structure_confirmed: true,
      planned_entry_ready: false,
      structure_reason: 'M30 minor structure shifted bullish.',
    }),
    expected: 'STRUCTURE_CONFIRMED',
    missing: 'Planned Entry',
  },
  {
    name: 'WAITING_FOR_ENTRY after confirmed setup',
    input: base({
      daily_bias: 'Bullish',
      h4_bias: 'Bullish',
      location_valid: true,
      liquidity_swept: true,
      structure_confirmed: true,
      planned_entry_ready: true,
      planned_entry: 1.101,
      entry_reached: false,
    }),
    expected: 'SETUP_CONFIRMED_WAITING_FOR_ENTRY',
    missing: 'Entry Reached',
  },
  {
    name: 'ENTRY_REACHED when planned entry touched',
    input: base({
      daily_bias: 'Bullish',
      h4_bias: 'Bullish',
      location_valid: true,
      liquidity_swept: true,
      structure_confirmed: true,
      planned_entry_ready: true,
      planned_entry: 1.101,
      entry_reached: true,
    }),
    expected: 'ENTRY_REACHED',
  },
];

for (const testCase of sequence) {
  const result = evaluateLifecycle(testCase.input);
  assertCase(testCase.name, result.current_state === testCase.expected, `expected ${testCase.expected}, got ${result.current_state}`);
  assertCase(testCase.name, Boolean(result.reason), 'state should include a reason');
  assertCase(testCase.name, Boolean(result.next_step), 'state should include a next step');
  assertCase(testCase.name, Object.keys(result.requirements).length === 7, 'state should include all tracked requirements');
  if (testCase.missing) {
    assertCase(testCase.name, result.missing_requirements.includes(testCase.missing), `expected missing requirement ${testCase.missing}`);
  }
}

const deterministicA = evaluateLifecycle(sequence[4].input);
const deterministicB = evaluateLifecycle(sequence[4].input);
assertCase(
  'Deterministic output for identical input',
  JSON.stringify(deterministicA) === JSON.stringify(deterministicB),
  'identical lifecycle input should produce identical output',
);

const invalidTransitions: Array<[LifecycleState, LifecycleState]> = [
  ['BUILDING', 'ENTRY_REACHED'],
  ['ENTRY_REACHED', 'ALMOST_READY'],
  ['COMPLETED', 'BUILDING'],
  ['TP2_REACHED', 'ALMOST_READY'],
];

for (const [from, to] of invalidTransitions) {
  assertCase(
    `Invalid transition ${from} -> ${to}`,
    !isValidLifecycleTransition(from, to),
    `${from} -> ${to} should be invalid`,
  );
}

const validTransitions: Array<[LifecycleState, LifecycleState]> = [
  ['BUILDING', 'ALMOST_READY'],
  ['ALMOST_READY', 'LIQUIDITY_SWEPT'],
  ['LIQUIDITY_SWEPT', 'STRUCTURE_CONFIRMED'],
  ['STRUCTURE_CONFIRMED', 'SETUP_CONFIRMED_WAITING_FOR_ENTRY'],
  ['SETUP_CONFIRMED_WAITING_FOR_ENTRY', 'ENTRY_REACHED'],
];

for (const [from, to] of validTransitions) {
  assertCase(
    `Valid transition ${from} -> ${to}`,
    isValidLifecycleTransition(from, to),
    `${from} -> ${to} should be valid`,
  );
}

console.log('\n-- Kairos Forex v2 Lifecycle Regression Suite ----------------------');
for (const testCase of sequence) {
  const result = evaluateLifecycle(testCase.input);
  const caseFailures = failures.filter(f => f.caseName === testCase.name);
  if (!caseFailures.length) {
    console.log(`PASS ${testCase.name} -> ${result.current_state}`);
  } else {
    console.log(`FAIL ${testCase.name}`);
    caseFailures.forEach(f => console.log(`   - ${f.message}`));
  }
}

const groupedFailures = new Set(failures.map(f => f.caseName));
console.log(`\nTotal: ${sequence.length + invalidTransitions.length + validTransitions.length + 1} | Passed: ${sequence.length + invalidTransitions.length + validTransitions.length + 1 - groupedFailures.size} | Failed: ${groupedFailures.size}`);

if (failures.length) process.exit(1);
