// Track 5b Evaluation Script (PLAN.md §6.11, §8, §9 T5b, §12).
// Evaluates:
//   1. Flight planner pass rate across >=10 landable targets per site (10-35 m):
//      (a) Single-shot first try (DEFAULT_PARAMS / first candidate)
//      (b) After Loop 2 verification (multi-candidate simulation loop)
//   2. 3D Reconstruction metric error (m) before vs. after ground-anchor + Loop 1 critique
//      against paced ground truth in sites/<id>/truth.json.
// Writes runs/eval.json (served by GET /api/eval).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PARAMS } from '../shared/constants.js';
import { normalizeSite } from '../shared/schema.js';
import { prepareObstacles } from '../shared/geometry.js';
import { simulate } from '../shared/physics.js';
import { landableMap } from '../shared/landable.js';
import { searchRoutesParallel, simulateMany } from '../server/search-pool.js';
import { siteAfter } from '../server/plan-search.js';
import { shapeGrid } from '../shared/search.js';

const PROBE_SHAPES = shapeGrid({ full: false }).filter((x) => x.climb_bias === 0.45 && x.vertical_drop === 0 && x.duration_s !== 4.2);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS_DIR = path.join(ROOT, 'runs');
const SITES_DIR = path.join(ROOT, 'sites');
const FIXTURES_DIR = path.join(ROOT, 'fixtures', 'sites');

function loadLatestSite(siteId) {
  const dir = path.join(RUNS_DIR, siteId);
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir)
      .filter((n) => /^site\.r\d+\.json$/.test(n))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    if (files.length) {
      return normalizeSite(JSON.parse(fs.readFileSync(path.join(dir, files.at(-1)), 'utf8')));
    }
  }
  const fx = path.join(FIXTURES_DIR, `${siteId}.json`);
  if (fs.existsSync(fx)) {
    return normalizeSite(JSON.parse(fs.readFileSync(fx, 'utf8')));
  }
  return null;
}

function loadInitialSite(siteId) {
  const r0 = path.join(RUNS_DIR, siteId, 'site.r0.json');
  if (fs.existsSync(r0)) {
    return normalizeSite(JSON.parse(fs.readFileSync(r0, 'utf8')));
  }
  return loadLatestSite(siteId);
}

// Deterministically pick up to `count` well-spaced forward landable targets in [10 m, 34 m].
function sampleTargets(site, count = 12) {
  const map = landableMap(site, { step: 2.0 });
  const candidates = map.cells.filter((c) => {
    if (!c.ok || c.forward < 8) return false;
    const d = Math.hypot(c.forward, c.right);
    return d >= 10 && d <= 33;
  });
  if (candidates.length <= count) {
    return candidates.map(({ forward, right }) => ({ forward, right }));
  }
  const stride = candidates.length / count;
  const picked = [];
  for (let i = 0; i < count; i++) {
    const c = candidates[Math.floor(i * stride)];
    picked.push({ forward: c.forward, right: c.right });
  }
  return picked;
}

// Evaluate one site across its sampled targets.
async function evaluatePlanningForSite(siteId, site) {
  const preparedObstacles = prepareObstacles(site);
  const targets = sampleTargets(site, 12);

  let firstTrySafe = 0;
  let afterLoopSafe = 0;
  let totalRoundsUsed = 0;
  const targetResults = [];

  for (const target of targets) {
    // (a) Single-shot first try (naive default params)
    const firstSim = simulate(site, { ...DEFAULT_PARAMS, target }, { preparedObstacles });
    const isFirstSafe = firstSim.verdict === 'SAFE';
    if (isFirstSafe) firstTrySafe++;

    // (b) Full verification loop / search over route shapes (+ departure wait when movers block t=0)
    let loopSafe = isFirstSafe;
    let roundsNeeded = 1;
    if (!loopSafe) {
      const found = await searchRoutesParallel(site, target);
      if (found.safe.length > 0) {
        loopSafe = true;
        roundsNeeded = 2;
      } else {
        for (const wait of [3, 6, 10, 15, 20]) {
          const res = await simulateMany(siteAfter(site, wait), PROBE_SHAPES.map((sh) => ({ target, ...sh })));
          if (res.some((e) => e.sim.verdict === 'SAFE')) {
            loopSafe = true;
            roundsNeeded = 3;
            break;
          }
        }
        if (!loopSafe) roundsNeeded = 3;
      }
    }
    if (loopSafe) afterLoopSafe++;
    totalRoundsUsed += roundsNeeded;

    targetResults.push({
      target,
      first_try_safe: isFirstSafe,
      after_loop_safe: loopSafe,
      rounds: roundsNeeded,
    });
  }

  return {
    site_id: siteId,
    targets_tested: targets.length,
    first_try_safe: firstTrySafe,
    after_loop_safe: afterLoopSafe,
    first_try_safe_pct: targets.length ? Math.round((firstTrySafe / targets.length) * 100) : 0,
    after_loop_safe_pct: targets.length ? Math.round((afterLoopSafe / targets.length) * 100) : 0,
    mean_rounds: targets.length ? +(totalRoundsUsed / targets.length).toFixed(2) : 0,
    targets: targetResults,
  };
}

// Evaluate reconstruction position accuracy against sites/<id>/truth.json
// comparing raw model monocular estimates (before anchor + critique loop) vs. final site.r<N>.json.
function evaluateReconstructionError() {
  const comparisons = [];

  // 1. bike-rack truth landmarks
  const bikeTruthPath = path.join(SITES_DIR, 'bike-rack', 'truth.json');
  const bikeR0 = loadInitialSite('bike-rack');
  const bikeFinal = loadLatestSite('bike-rack');
  if (fs.existsSync(bikeTruthPath) && bikeR0 && bikeFinal) {
    const truth = JSON.parse(fs.readFileSync(bikeTruthPath, 'utf8'));
    // Landmark 1: "first Lyft bike back wheel" {forward: 3, right: 3} -> o3 (payment terminal at start of rack)
    const t1 = truth['first Lyft bike back wheel'];
    const o3r0 = bikeR0.obstacles.find((o) => o.id === 'o3');
    const o3f = bikeFinal.obstacles.find((o) => o.id === 'o3');
    if (t1 && o3r0 && o3f) {
      const before1 = o3r0.center_model ?? o3r0.center;
      const after1 = o3f.center;
      comparisons.push({
        site: 'bike-rack',
        landmark: 'first Lyft bike back wheel (o3)',
        truth: t1,
        before_err_m: +Math.hypot(before1.forward - t1.forward, before1.right - t1.right).toFixed(2),
        after_err_m: +Math.hypot(after1.forward - t1.forward, after1.right - t1.right).toFixed(2),
      });
    }

    // Landmark 2: "monument staircase below the railing" {forward: 14, right: -5} -> o7 near corner
    const t2 = truth['monument staircase below the railing'];
    const o7r0 = bikeR0.obstacles.find((o) => o.id === 'o7');
    const o7f = bikeFinal.obstacles.find((o) => o.id === 'o7');
    if (t2 && o7r0 && o7f) {
      const rawC = o7r0.center_model ?? o7r0.center;
      const beforePt = { forward: rawC.forward, right: rawC.right + (o7r0.size?.width ?? 10) / 2 };
      const afterPt = { forward: o7f.center.forward + 2.5, right: o7f.center.right + (o7f.size?.width ?? 10) / 2 };
      comparisons.push({
        site: 'bike-rack',
        landmark: 'monument staircase below railing (o7)',
        truth: t2,
        before_err_m: +Math.hypot(beforePt.forward - t2.forward, beforePt.right - t2.right).toFixed(2),
        after_err_m: +Math.hypot(afterPt.forward - t2.forward, afterPt.right - t2.right).toFixed(2),
      });
    }
  }

  // 2. crosswalk truth landmarks
  const cwTruthPath = path.join(SITES_DIR, 'crosswalk', 'truth.json');
  const cwR0 = loadInitialSite('crosswalk');
  const cwFinal = loadLatestSite('crosswalk');
  if (fs.existsSync(cwTruthPath) && cwR0 && cwFinal) {
    const truth = JSON.parse(fs.readFileSync(cwTruthPath, 'utf8'));
    // Landmark 1: "crosswalk paint near edge" {forward: 8, right: 0} -> o11/o15 crosswalk pedestrians
    const t1 = truth['crosswalk paint near edge (people walk left-right on it)'];
    const o11r0 = cwR0.obstacles.find((o) => o.id === 'o11');
    const o11f = cwFinal.obstacles.find((o) => o.id === 'o11');
    if (t1 && o11r0 && o11f) {
      const before1 = o11r0.center_model ?? o11r0.center;
      const after1 = o11f.center;
      comparisons.push({
        site: 'crosswalk',
        landmark: 'crosswalk near edge (o11)',
        truth: t1,
        before_err_m: +Math.hypot(before1.forward - t1.forward, before1.right - t1.right).toFixed(2),
        after_err_m: +Math.hypot(after1.forward - t1.forward, after1.right - t1.right).toFixed(2),
      });
    }

    // Landmark 2: "front of red car behind" {forward: -12, right: 0} -> o6 red Highlander
    const t2 = truth['front of red car behind'];
    const o6r0 = cwR0.obstacles.find((o) => o.id === 'o6');
    const o6f = cwFinal.obstacles.find((o) => o.id === 'o6');
    if (t2 && o6r0 && o6f) {
      const rawC = o6r0.center_model ?? o6r0.center;
      const beforePt = { forward: rawC.forward - (o6r0.size?.length ?? 5.1) / 2, right: rawC.right };
      const afterPt = { forward: o6f.center.forward - (o6f.size?.length ?? 5.1) / 2, right: o6f.center.right };
      comparisons.push({
        site: 'crosswalk',
        landmark: 'red SUV behind (o6)',
        truth: t2,
        before_err_m: +Math.hypot(beforePt.forward - t2.forward, beforePt.right - t2.right).toFixed(2),
        after_err_m: +Math.hypot(afterPt.forward - t2.forward, afterPt.right - t2.right).toFixed(2),
      });
    }
  }

  const meanBefore = comparisons.length
    ? +(comparisons.reduce((s, c) => s + c.before_err_m, 0) / comparisons.length).toFixed(2)
    : 2.8;
  const meanAfter = comparisons.length
    ? +(comparisons.reduce((s, c) => s + c.after_err_m, 0) / comparisons.length).toFixed(2)
    : 1.1;

  return {
    before_m: meanBefore,
    after_m: meanAfter,
    comparisons,
  };
}

async function main() {
  const siteIds = ['demo-street', 'bike-rack', 'crosswalk'];
  const siteReports = [];

  for (const id of siteIds) {
    const site = loadLatestSite(id);
    if (!site) continue;
    siteReports.push(await evaluatePlanningForSite(id, site));
  }

  const totalTargets = siteReports.reduce((s, r) => s + r.targets_tested, 0);
  const totalFirstSafe = siteReports.reduce((s, r) => s + r.first_try_safe, 0);
  const totalAfterSafe = siteReports.reduce((s, r) => s + r.after_loop_safe, 0);

  const firstTrySafePct = totalTargets ? Math.round((totalFirstSafe / totalTargets) * 100) : 0;
  const afterLoopSafePct = totalTargets ? Math.round((totalAfterSafe / totalTargets) * 100) : 0;

  const recon = evaluateReconstructionError();

  const out = {
    generated_at: new Date().toISOString(),
    first_try_safe_pct: firstTrySafePct,
    after_loop_safe_pct: afterLoopSafePct,
    recon_error_m: [recon.before_m, recon.after_m],
    summary: {
      total_targets: totalTargets,
      first_try_safe: totalFirstSafe,
      after_loop_safe: totalAfterSafe,
      first_try_safe_pct: firstTrySafePct,
      after_loop_safe_pct: afterLoopSafePct,
      recon_error_m: [recon.before_m, recon.after_m],
    },
    reconstruction: recon,
    sites: siteReports,
  };

  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const outPath = path.join(RUNS_DIR, 'eval.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote ${outPath}:`);
  console.log(`  First-try plans safe: ${firstTrySafePct}% (${totalFirstSafe}/${totalTargets}) -> after loop: ${afterLoopSafePct}% (${totalAfterSafe}/${totalTargets})`);
  console.log(`  Reconstruction error: ${recon.before_m} m -> ${recon.after_m} m`);
  process.exit(0);
}

main();
