// Unit & acceptance tests for Track 1: Physics, geometry, checks, plot-svg, and sim-cli (PLAN.md §5, §6.5, §9).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CHECK_IDS } from './constants.js';
import { simulate } from './physics.js';
import { runChecks } from './checks.js';
import { plotSvg } from './plot-svg.js';
import { prepareObstacles, carToObstacleClearance3D } from './geometry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_STREET = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sites', 'demo-street.json'), 'utf8'),
);

test('1. Direct low hop over parked SUV (o1) in demo-street clips the car (UNSAFE: collision/clearance)', () => {
  const res = simulate(DEMO_STREET, {
    target: { forward: 25, right: 0 },
    apex_height_m: 1.5, // SUV is 1.75 m tall at forward=9
    duration_s: 3.4,
    side_bow_m: 0,
    climb_bias: 0.5,
    horizontal_delay: 0,
  });

  assert.equal(res.schema, 'flyme.sim/1');
  assert.equal(res.verdict, 'UNSAFE');
  assert.ok(
    res.failures.includes('collision') || res.failures.includes('clearance'),
    `Expected collision or clearance failure, got: ${res.failures.join(', ')}`,
  );
  const clrCheck = res.checks.find((c) => c.id === 'clearance');
  assert.equal(clrCheck.pass, false);
  assert.equal(clrCheck.obstacle_id, 'o1');
});

test('2. Climb-early higher arc over parked SUV in demo-street is SAFE and < 50 ms', () => {
  // Warm up JIT once
  simulate(DEMO_STREET, {
    target: { forward: 25, right: 0 },
    apex_height_m: 5.5,
    duration_s: 3.5,
    side_bow_m: 0,
    climb_bias: 0.35,
    horizontal_delay: 0.1,
  });

  const t0 = performance.now();
  const res = simulate(DEMO_STREET, {
    target: { forward: 25, right: 0 },
    apex_height_m: 5.5,
    duration_s: 3.5,
    side_bow_m: 0,
    climb_bias: 0.35,
    horizontal_delay: 0.1,
  });
  const elapsedMs = performance.now() - t0;

  assert.equal(res.verdict, 'SAFE', `Expected SAFE but failed: ${res.failures.join(', ')} (${JSON.stringify(res.checks.filter((c) => !c.pass))})`);
  assert.deepEqual(res.failures, []);
  assert.equal(res.checks.length, 9);
  assert.deepEqual(res.checks.map((c) => c.id), CHECK_IDS);
  assert.ok(elapsedMs < 50, `Expected < 50 ms per sim, took ${elapsedMs.toFixed(2)} ms`);
  assert.ok(res.air.remaining_kg >= 25, `Expected air remaining >= 25 kg, got ${res.air.remaining_kg}`);
});

test('3. ~20 m hop is feasible; ~45 m hop fails on air_reserve (or thrust_limit if rushed)', () => {
  const emptySite = {
    schema: 'flyme.site/1',
    id: 'open-road',
    name: 'Open road',
    round: 0,
    surfaces: [],
    obstacles: [],
    scale_refs: [],
    notes: '',
  };

  // ~20 m hop is comfortably SAFE
  const hop20 = simulate(emptySite, {
    target: { forward: 20, right: 0 },
    apex_height_m: 4.5,
    duration_s: 3.2,
    side_bow_m: 0,
    climb_bias: 0.4,
    horizontal_delay: 0.08,
  });
  assert.equal(hop20.verdict, 'SAFE', `20m hop failed: ${hop20.failures.join(', ')}`);

  // ~45 m hop with sufficient duration to avoid horizontal thrust saturation runs out of air reserve (< 25 kg)
  const hop45 = simulate(emptySite, {
    target: { forward: 45, right: 0 },
    apex_height_m: 6.0,
    duration_s: 5.5,
    side_bow_m: 0,
    climb_bias: 0.45,
    horizontal_delay: 0.05,
  });
  assert.equal(hop45.verdict, 'UNSAFE');
  assert.ok(
    hop45.failures.includes('air_reserve'),
    `Expected 45m hop to fail air_reserve, got: ${hop45.failures.join(', ')} (air remaining: ${hop45.air.remaining_kg} kg)`,
  );
});

test('4. Moving pedestrian walking into the landing zone fails pedestrian check (D20)', () => {
  const siteWithMovingPed = {
    ...DEMO_STREET,
    obstacles: [
      ...DEMO_STREET.obstacles,
      {
        id: 'o8',
        type: 'person',
        label: 'jaywalker heading to landing zone',
        shape: 'cylinder',
        center: { forward: 25, right: -8.0 }, // Starts 8m away horizontally, walks right at +2.0 m/s
        base_up: 0,
        radius: 0.3,
        height: 1.75,
        velocity: { forward: 0, right: 2.0 }, // At t=3.5s, right = -1.0m (inside 5m keep-out of target {25, 0})
        seen_in: ['front'],
        confidence: 0.9,
      },
    ],
  };

  const res = simulate(siteWithMovingPed, {
    target: { forward: 25, right: 0 },
    apex_height_m: 5.5,
    duration_s: 3.5,
    side_bow_m: 0,
    climb_bias: 0.35,
    horizontal_delay: 0.1,
  });

  assert.equal(res.verdict, 'UNSAFE');
  assert.ok(res.failures.includes('pedestrian'), `Expected pedestrian failure, got: ${res.failures.join(', ')}`);
  const pedCheck = res.checks.find((c) => c.id === 'pedestrian');
  assert.equal(pedCheck.pass, false);
  assert.equal(pedCheck.obstacle_id, 'o8');
});

test('5. Quadratic aerodynamic drag changes touchdown point by < 1% (D21)', () => {
  const params = {
    target: { forward: 25, right: 0 },
    apex_height_m: 5.5,
    duration_s: 3.5,
    side_bow_m: 0,
    climb_bias: 0.35,
    horizontal_delay: 0.1,
  };
  const withDrag = simulate(DEMO_STREET, params, { drag: true });
  const noDrag = simulate(DEMO_STREET, params, { drag: false });

  assert.ok(withDrag.peak.drag_N > 0, 'Expected positive peak.drag_N with drag enabled');
  assert.equal(noDrag.peak.drag_N, 0);

  const dist = Math.hypot(params.target.forward, params.target.right);
  const tdShift = Math.hypot(
    withDrag.touchdown.forward - noDrag.touchdown.forward,
    withDrag.touchdown.right - noDrag.touchdown.right,
  );
  assert.ok(
    tdShift / dist < 0.01,
    `Expected drag to change touchdown point by < 1% of range, got ${((tdShift / dist) * 100).toFixed(3)}% (${tdShift.toFixed(4)} m)`,
  );
});

test('6. Takeoff grace at t=0 handles near-but-clear and overlapping start obstacles (§5)', () => {
  const siteNearStart = {
    schema: 'flyme.site/1',
    id: 'tight-curb',
    name: 'Tight curb start',
    round: 0,
    surfaces: [],
    obstacles: [
      // Overlapping noisy box at t=0 (ignored for t < 0.5 s)
      {
        id: 'o_overlap',
        type: 'barrier',
        label: 'noisy curb box',
        shape: 'box',
        center: { forward: -2.0, right: 0 },
        base_up: 0,
        size: { length: 0.6, width: 1.0, height: 0.3 },
        heading_deg: 0,
        seen_in: ['back'],
        confidence: 0.5,
      },
      // Close pole at t=0 with 0 < clearance(0) < 0.5 m (car right half-width is 1.0 m, pole at right=1.35 m with radius 0.1 m -> c(0)=0.25 m)
      {
        id: 'o_close',
        type: 'pole',
        label: 'parking meter',
        shape: 'cylinder',
        center: { forward: 0, right: 1.35 },
        base_up: 0,
        radius: 0.1,
        height: 1.0,
        seen_in: ['right'],
        confidence: 0.8,
      },
    ],
    scale_refs: [],
    notes: '',
  };

  const prep = prepareObstacles(siteNearStart);
  const cOverlap0 = carToObstacleClearance3D({ forward: 0, right: 0, up: 0 }, prep[0], 0);
  const cClose0 = carToObstacleClearance3D({ forward: 0, right: 0, up: 0 }, prep[1], 0);
  assert.ok(cOverlap0 <= 0, `Expected overlap <= 0 at t=0, got ${cOverlap0}`);
  assert.ok(cClose0 > 0 && cClose0 < 0.5, `Expected 0 < cClose0 < 0.5 at t=0, got ${cClose0}`);

  const res = simulate(siteNearStart, {
    target: { forward: 20, right: -2 }, // Moves away to the left (-right) and climbs immediately
    apex_height_m: 4.5,
    duration_s: 3.4,
    side_bow_m: -1.5,
    climb_bias: 0.38,
    horizontal_delay: 0.0,
  });

  assert.equal(res.verdict, 'SAFE', `Expected takeoff grace to allow liftoff, got failures: ${res.failures.join(', ')}`);
});

test('8. Calibration report: max feasible range at 500 m/s exhaust velocity (§3)', () => {
  const emptySite = {
    schema: 'flyme.site/1',
    id: 'open-road',
    name: 'Open road',
    round: 0,
    surfaces: [],
    obstacles: [],
    scale_refs: [],
    notes: '',
  };

  let maxSafeRangeM = 0;
  for (let dist = 15; dist <= 50; dist += 1) {
    let safeForDist = false;
    for (const dur of [3.0, 3.4, 3.8, 4.2, 4.5]) {
      const r = simulate(emptySite, {
        target: { forward: dist, right: 0 },
        apex_height_m: 3.0,
        duration_s: dur,
        side_bow_m: 0,
        climb_bias: 0.45,
        horizontal_delay: 0.0,
      });
      if (r.verdict === 'SAFE') {
        safeForDist = true;
        break;
      }
    }
    if (safeForDist) maxSafeRangeM = dist;
  }

  assert.ok(maxSafeRangeM >= 25 && maxSafeRangeM < 45, `Expected max feasible range between 25m and 44m, got ${maxSafeRangeM}m`);
});

test('7. Determinism, runChecks standalone, plotSvg, and sim-cli batch + single execution', () => {
  const params = {
    target: { forward: 25, right: 0 },
    apex_height_m: 5.5,
    duration_s: 3.5,
    side_bow_m: 0,
    climb_bias: 0.35,
    horizontal_delay: 0.1,
  };
  const r1 = simulate(DEMO_STREET, params);
  const r2 = simulate(DEMO_STREET, params);
  assert.deepEqual(r1, r2, 'Simulator must be 100% deterministic');

  const standaloneChecks = runChecks(DEMO_STREET, r1);
  assert.equal(standaloneChecks.length, 9);

  // Test sim-cli.mjs in batch mode with --out and --svg
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyme-sim-test-'));
  const batchPath = path.join(tmpDir, 'batch.json');
  const outPath = path.join(tmpDir, 'out.json');
  const svgPath = path.join(tmpDir, 'plot.svg');
  const sitePath = path.join(__dirname, '..', 'fixtures', 'sites', 'demo-street.json');
  const cliPath = path.join(__dirname, 'sim-cli.mjs');

  const batchInput = [
    {
      id: 'r1a',
      label: 'low direct hop',
      params: { target: { forward: 25, right: 0 }, apex_height_m: 1.5, duration_s: 3.4, side_bow_m: 0, climb_bias: 0.5, horizontal_delay: 0 },
    },
    {
      id: 'r1b',
      label: 'climb-first over SUV',
      params,
    },
  ];
  fs.writeFileSync(batchPath, JSON.stringify(batchInput, null, 2));

  const stdout = execFileSync(process.execPath, [
    cliPath,
    '--site', sitePath,
    '--params', batchPath,
    '--out', outPath,
    '--svg', svgPath,
  ], { encoding: 'utf8' });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.schema, 'flyme.sim-batch/1');
  assert.equal(parsed.safe_count, 1);
  assert.deepEqual(parsed.safe_ids, ['r1b']);
  assert.equal(parsed.candidates.length, 2);
  assert.equal(parsed.candidates[0].sim_verdict, 'UNSAFE');
  assert.equal(parsed.candidates[1].sim_verdict, 'SAFE');
  assert.equal(parsed.candidates[0].samples, undefined, 'Summary JSON must omit samples');

  const svgText = fs.readFileSync(svgPath, 'utf8');
  assert.ok(svgText.includes('<svg') && svgText.includes('r1a') && svgText.includes('r1b'));

  const directSvg = plotSvg(DEMO_STREET, [{ id: 'r1b', label: 'climb-first', params, sim: r1 }]);
  assert.ok(directSvg.includes('SIDE VIEW') && directSvg.includes('TOP VIEW'));
});
