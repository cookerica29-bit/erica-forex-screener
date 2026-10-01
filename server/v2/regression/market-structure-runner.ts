import { evaluateHierarchicalContext } from '../context.js';
import { completedStateSet, validateLifecycleDependencies } from '../dependencyGraph.js';
import { activeDealingRange, evaluateLocation } from '../location.js';
import { buildLiquidityPools, detectEqualHighsLows, detectLiquiditySweeps } from '../liquidity.js';
import {
  analyzeHierarchicalStructure,
  analyzeTimeframeStructure,
  detectStructureEvents,
  findInstitutionalSwings,
  type Candle,
  type SwingPoint,
} from '../structure.js';

interface Failure {
  caseName: string;
  message: string;
}

const failures: Failure[] = [];

function assertCase(caseName: string, condition: boolean, message: string) {
  if (!condition) failures.push({ caseName, message });
}

function c(i: number, o: number, h: number, l: number, close: number): Candle {
  return { t: `2026-07-14T${String(i).padStart(2, '0')}:00:00.000Z`, o, h, l, c: close };
}

const bullishBosCandles = [
  c(0, 10, 10.5, 9.5, 10),
  c(1, 10, 12, 9.8, 11.6),
  c(2, 11.5, 11.7, 10.4, 10.8),
  c(3, 10.8, 11.2, 8.8, 9.2),
  c(4, 9.2, 10.8, 9, 10.1),
  c(5, 10.1, 12.8, 10, 12.4),
];

const bearishToBullishChochCandles = [
  c(0, 11.6, 12, 11, 11.4),
  c(1, 11.4, 12.5, 11.2, 12.1),
  c(2, 12.1, 11.8, 10.5, 11),
  c(3, 11, 12, 10.8, 11.5),
  c(4, 11.5, 11.2, 9.8, 10.2),
  c(5, 10.2, 11, 9.6, 10.8),
  c(6, 10.8, 12.8, 10.9, 12.6),
];

const equalLiquiditySwings: SwingPoint[] = [
  { index: 1, price: 1.105, type: 'high' },
  { index: 4, price: 1.1052, type: 'high' },
  { index: 2, price: 1.094, type: 'low' },
  { index: 5, price: 1.0939, type: 'low' },
];

const sweepCandles = [
  c(0, 1.1, 1.101, 1.098, 1.1),
  c(1, 1.1, 1.105, 1.099, 1.104),
  c(2, 1.104, 1.1045, 1.094, 1.096),
  c(3, 1.096, 1.103, 1.095, 1.102),
  c(4, 1.102, 1.1052, 1.1, 1.104),
  c(5, 1.104, 1.1045, 1.0939, 1.095),
  c(6, 1.095, 1.096, 1.0925, 1.0948),
  c(7, 1.0948, 1.101, 1.092, 1.0965),
  c(8, 1.0965, 1.1062, 1.096, 1.1048),
];

const bosEvents = detectStructureEvents(bullishBosCandles, 'M30', 1);
assertCase(
  'Bullish BOS detection',
  bosEvents.some(event => event.type === 'BOS' && event.direction === 'Bullish'),
  `expected bullish BOS, got ${JSON.stringify(bosEvents)}`,
);

const chochEvents = detectStructureEvents(bearishToBullishChochCandles, 'M30', 1);
assertCase(
  'Bullish CHoCH detection after bearish structure',
  chochEvents.some(event => event.type === 'CHoCH' && event.direction === 'Bullish'),
  `expected bullish CHoCH, got ${JSON.stringify(chochEvents)}`,
);

const equalPools = detectEqualHighsLows(equalLiquiditySwings, 0.0003);
assertCase(
  'Equal highs/lows liquidity pools',
  equalPools.some(pool => pool.source === 'EQUAL_HIGHS' && pool.type === 'BUY_SIDE') &&
    equalPools.some(pool => pool.source === 'EQUAL_LOWS' && pool.type === 'SELL_SIDE'),
  `expected equal high and low pools, got ${JSON.stringify(equalPools)}`,
);

const pools = buildLiquidityPools(equalLiquiditySwings, 0.0003);
const sweeps = detectLiquiditySweeps(sweepCandles, pools);
assertCase(
  'Liquidity sweep detection',
  sweeps.some(sweep => sweep.type === 'SELL_SIDE_SWEEP' && sweep.rejected) &&
    sweeps.some(sweep => sweep.type === 'BUY_SIDE_SWEEP' && sweep.rejected),
  `expected buy-side and sell-side rejected sweeps, got ${JSON.stringify(sweeps)}`,
);

const range = activeDealingRange([
  c(0, 50, 55, 45, 50),
  c(1, 50, 60, 44, 59),
  c(2, 59, 58, 40, 42),
], 'Daily active dealing range');
assertCase('Active dealing range high/low', range.high === 60 && range.low === 40 && range.equilibrium === 50, `unexpected range ${JSON.stringify(range)}`);
assertCase('Premium location', evaluateLocation(57, range).zone === 'PREMIUM', 'expected 57 to be premium');
assertCase('Discount location', evaluateLocation(43, range).zone === 'DISCOUNT', 'expected 43 to be discount');
assertCase('Equilibrium location', evaluateLocation(50.5, range).zone === 'EQUILIBRIUM', 'expected 50.5 to be equilibrium');

const hierarchy = analyzeHierarchicalStructure({
  daily: bullishBosCandles,
  h4: bullishBosCandles,
  m30: bullishBosCandles,
});
const context = evaluateHierarchicalContext(hierarchy);
assertCase('Hierarchical market structure aligns Daily/H4/M30', hierarchy.aligned && hierarchy.executionAligned, `unexpected hierarchy ${JSON.stringify(hierarchy)}`);
assertCase('Hierarchical context direction', context.direction === 'LONG', `expected LONG context, got ${context.direction}`);

const invalidDependency = validateLifecycleDependencies('STRUCTURE_CONFIRMED', completedStateSet(['ALMOST_READY']));
assertCase('Dependency blocks structure before liquidity', !invalidDependency.valid && Boolean(invalidDependency.blocker), 'expected structure dependency blocker');
const validDependency = validateLifecycleDependencies('STRUCTURE_CONFIRMED', completedStateSet(['ALMOST_READY', 'LIQUIDITY_SWEPT']));
assertCase('Dependency allows structure after liquidity', validDependency.valid, `unexpected blocker ${validDependency.blocker}`);

const swings = findInstitutionalSwings(bullishBosCandles, 1);
const tfStructure = analyzeTimeframeStructure(bullishBosCandles, 'M30', 1);
assertCase('Institutional swing detection is deterministic', JSON.stringify(swings) === JSON.stringify(findInstitutionalSwings(bullishBosCandles, 1)), 'swing detection should be deterministic');
assertCase('Timeframe structure includes reason', Boolean(tfStructure.reason), 'structure read should include a reason');

console.log('\n-- Kairos Forex v2 Institutional Structure Regression Suite --------');
const groupedFailures = new Set(failures.map(f => f.caseName));
if (!failures.length) {
  console.log(`PASS structure events: BOS=${bosEvents.length}, CHoCH=${chochEvents.length}`);
  console.log(`PASS liquidity: pools=${pools.length}, sweeps=${sweeps.length}`);
  console.log(`PASS location: range=${range.low}-${range.high}, eq=${range.equilibrium}`);
  console.log(`PASS dependency graph validation`);
} else {
  for (const failure of failures) console.log(`FAIL ${failure.caseName}: ${failure.message}`);
}
console.log(`\nTotal: 14 | Passed: ${14 - groupedFailures.size} | Failed: ${groupedFailures.size}`);

if (failures.length) process.exit(1);
