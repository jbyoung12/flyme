// Deterministic route search over the §6.4 shape space. The simulator does
// the brute-force geometry (which shapes are SAFE to a target, which landing
// spots are reachable at all); Argon then judges the SAFE routes against the
// footage. Zero dependencies (runs in Node 22 and the browser).

import { simulate } from './physics.js';
import { prepareObstacles } from './geometry.js';

// Route shapes, ordered roughly from cheapest/likeliest to exotic so an
// early-exit search (reachability map) usually stops within a few sims.
export function shapeGrid({ full = true } = {}) {
  const apex = full ? [2.5, 4, 5.5, 7, 9] : [3, 5, 7];
  const dur = full ? [2.8, 3.3, 3.8, 4.4] : [3, 3.6, 4.2];
  const bow = full ? [0, -4, 4, -8, 8] : [0, -4, 4];
  const cb = [0.45, 0.6];
  const vd = [0, 0.25];
  const out = [];
  // horizontal_delay 0.25 = climb straight up first (clears people/objects
  // right next to the car before moving sideways).
  const hd = full ? [0.05, 0.25] : [0.05];
  for (const h of hd) for (const v of vd) for (const c of cb) for (const b of bow) for (const a of apex) for (const t of dur) {
    out.push({ apex_height_m: a, duration_s: t, side_bow_m: b, climb_bias: c, horizontal_delay: h, vertical_drop: v });
  }
  return out;
}

export function margins(sim) {
  const val = (id) => sim.checks.find((c) => c.id === id)?.value;
  return {
    min_clearance_m: val('clearance'),
    min_person_m: val('pedestrian'),
    air_remaining_kg: +sim.air.remaining_kg.toFixed(1),
    touchdown_v_ms: +Math.hypot(sim.touchdown?.v_vertical ?? 0, sim.touchdown?.v_horizontal ?? 0).toFixed(2),
    apex_m: sim.peak?.up_m,
  };
}

// Full search to one target. Returns { safe: [{params, sim, margins}], near: [...] }
// where `near` holds the least-bad UNSAFE routes (fewest failures) for REJECT
// explanations.
export function searchRoutes(site, target, { shapes = shapeGrid(), preparedObstacles = prepareObstacles(site) } = {}) {
  const safe = [];
  const near = [];
  for (const s of shapes) {
    const params = { target, ...s };
    const sim = simulate(site, params, { preparedObstacles });
    const entry = { params: sim.params ?? params, sim, margins: margins(sim) };
    if (sim.verdict === 'SAFE') safe.push(entry);
    else near.push(entry);
  }
  near.sort((a, b) => a.sim.failures.length - b.sim.failures.length || b.margins.air_remaining_kg - a.margins.air_remaining_kg);
  return { safe, near: near.slice(0, 8), tried: shapes.length };
}

// Pick up to `n` deliberately different SAFE routes: most clearance, most air,
// farthest from people, then the most different remaining (bow side / apex).
export function diverseSafe(safe, n = 4) {
  if (safe.length <= n) return safe;
  const picks = [];
  const take = (e) => { if (e && !picks.includes(e)) picks.push(e); };
  const by = (k) => [...safe].sort((a, b) => (b.margins[k] ?? 0) - (a.margins[k] ?? 0))[0];
  take(by('min_clearance_m'));
  take(by('air_remaining_kg'));
  take(by('min_person_m'));
  const dist = (a, b) => Math.abs(a.params.side_bow_m - b.params.side_bow_m) / 8 +
    Math.abs(a.params.apex_height_m - b.params.apex_height_m) / 6 + Math.abs(a.params.vertical_drop - b.params.vertical_drop) * 4;
  while (picks.length < n) {
    const next = safe.filter((e) => !picks.includes(e))
      .map((e) => ({ e, d: Math.min(...picks.map((p) => dist(e, p))) }))
      .sort((a, b) => b.d - a.d)[0];
    if (!next) break;
    take(next.e);
  }
  return picks;
}

// Is any SAFE route to `target`? Early exit on the first one (map cells).
export function reachable(site, target, shapes = shapeGrid({ full: false }), preparedObstacles = prepareObstacles(site)) {
  let best = null;
  for (const s of shapes) {
    const sim = simulate(site, { target, ...s }, { preparedObstacles });
    if (sim.verdict === 'SAFE') return { safe: true, air_remaining_kg: +sim.air.remaining_kg.toFixed(0) };
    if (!best || sim.failures.length < best.failures.length) best = sim;
  }
  return { safe: false, failures: best?.failures ?? [] };
}
