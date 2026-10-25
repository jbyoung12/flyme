// Mock SSE fixtures for the UI (T2 works before T1/T3/T4 land).
//   node web/mock/gen.mjs   → writes web/mock/*.json (event arrays)
//
// Trajectories follow the §5 REFERENCE PATH exactly (quintic progress, bow,
// Mobius time-warp vertical). Everything else (thrust, air, clearance, checks)
// is a rough kinematic estimate so the numbers look plausible. This is NOT the
// simulator; the real verdicts come from shared/physics.js on the server.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAR, SAFETY, G, CHECKS, DRAG } from '../../shared/constants.js';
import { applyPatch, normalizeSite } from '../../shared/schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/sites/demo-street.json'), 'utf8'));
const r3 = (v) => Math.round(v * 1000) / 1000;
const r2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- reference path (§5)

const quintic = (x) => 10 * x ** 3 - 15 * x ** 4 + 6 * x ** 5;

function refPos(p, t) {
  const T = p.duration_s;
  const tau = Math.min(1, Math.max(0, t / T));
  const d = p.horizontal_delay;
  const s = tau < d ? 0 : quintic((tau - d) / (1 - d));
  const len = Math.hypot(p.target.forward, p.target.right) || 1;
  const h = { forward: p.target.forward / len, right: p.target.right / len };
  const n = { forward: -h.right, right: h.forward };
  const b = p.side_bow_m * 64 * tau ** 3 * (1 - tau) ** 3;
  const k = p.climb_bias;
  const tw = ((1 - k) * tau) / ((1 - k) * tau + k * (1 - tau) || 1);
  return {
    forward: s * p.target.forward + b * n.forward,
    right: s * p.target.right + b * n.right,
    up: p.apex_height_m * 16 * tw ** 2 * (1 - tw) ** 2,
  };
}

const AX = ['forward', 'right', 'up'];
function refDeriv(p, t, h = 1e-3) {
  const a = refPos(p, t - h), b = refPos(p, t), c = refPos(p, t + h);
  const v = {}, acc = {};
  for (const k of AX) { v[k] = (c[k] - a[k]) / (2 * h); acc[k] = (c[k] - 2 * b[k] + a[k]) / (h * h); }
  return { v, acc };
}

// ---------------------------------------------------------------- rough geometry

const HL = CAR.length / 2, HW = CAR.width / 2, HH = CAR.height / 2;

function obstacleAt(o, t) {
  if (!o.velocity || !o.center) return o;
  return { ...o, center: { forward: o.center.forward + o.velocity.forward * t, right: o.center.right + o.velocity.right * t } };
}

// Signed distance between the car box (bottom at pos.up) and an obstacle.
function distance(pos, o) {
  const c = { forward: pos.forward, right: pos.right, up: pos.up + HH };
  if (o.shape === 'box') {
    const swap = Math.abs(Math.sin(((o.heading_deg ?? 0) * Math.PI) / 180)) > 0.7;
    const hl = (swap ? o.size.width : o.size.length) / 2, hw = (swap ? o.size.length : o.size.width) / 2, hh = o.size.height / 2;
    const gaps = [
      Math.abs(c.forward - o.center.forward) - (HL + hl),
      Math.abs(c.right - o.center.right) - (HW + hw),
      Math.abs(c.up - ((o.base_up ?? 0) + hh)) - (HH + hh),
    ];
    if (gaps.every((g) => g < 0)) return Math.max(...gaps);
    return Math.hypot(...gaps.map((g) => Math.max(0, g)));
  }
  if (o.shape === 'cylinder') {
    const df = Math.max(0, Math.abs(c.forward - o.center.forward) - HL);
    const dr = Math.max(0, Math.abs(c.right - o.center.right) - HW);
    const horiz = Math.hypot(df, dr) - o.radius;
    const lo = o.base_up ?? 0, hi = lo + o.height;
    const vert = Math.max(lo - (c.up + HH), (c.up - HH) - hi);
    if (horiz < 0 && vert < 0) return Math.max(horiz, vert);
    return Math.hypot(Math.max(0, horiz), Math.max(0, vert));
  }
  // wire: sample the segment, point → box distance
  let best = Infinity;
  const L = Math.hypot(o.to.forward - o.from.forward, o.to.right - o.from.right, o.to.up - o.from.up);
  const n = Math.max(2, Math.ceil(L / 0.25));
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const q = AX.map((k) => o.from[k] + (o.to[k] - o.from[k]) * f);
    const g = [Math.abs(q[0] - c.forward) - HL, Math.abs(q[1] - c.right) - HW, Math.abs(q[2] - c.up) - HH];
    const d = g.every((x) => x < 0) ? Math.max(...g) : Math.hypot(...g.map((x) => Math.max(0, x)));
    best = Math.min(best, d - 0.05);
  }
  return best;
}

function personDistance(pos, o) {
  const df = Math.max(0, Math.abs(pos.forward - o.center.forward) - HL);
  const dr = Math.max(0, Math.abs(pos.right - o.center.right) - HW);
  return Math.hypot(df, dr) - o.radius;
}

// ---------------------------------------------------------------- mock "sim"

function mockSim(site, params) {
  const T = params.duration_s;
  const dt = 0.01;
  let air = CAR.airKg;
  let peakThrust = 0, peakUp = 0, peakDrag = 0;
  let satSpan = 0, satShort = 0, maxErr = 0;
  let minClr = { v: Infinity, t: 0, id: null }, minPed = { v: Infinity, t: 0, id: null };
  const samples = [];
  const hard = site.obstacles.filter((o) => o.type !== 'person');
  const people = site.obstacles.filter((o) => o.type === 'person');
  const steps = Math.round(T / dt);
  for (let i = 0; i <= steps; i++) {
    const t = i * dt;
    const pos = refPos(params, t);
    const { v, acc } = refDeriv(params, t);
    const m = CAR.dryMassKg + air;
    // drag (reported only)
    const drag = 0.5 * DRAG.rho * DRAG.cd * (DRAG.areaHorizontal * (v.forward ** 2 + v.right ** 2) + DRAG.areaVertical * v.up ** 2);
    peakDrag = Math.max(peakDrag, drag);
    let Th = m * Math.hypot(acc.forward, acc.right);
    let Tv = Math.max(0, m * (acc.up + G));
    const want = Math.hypot(Th, Tv);
    if (Th > CAR.maxHorizontalThrustN) Th = CAR.maxHorizontalThrustN;
    let tot = Math.hypot(Th, Tv);
    if (tot > CAR.maxThrustN) { const s = CAR.maxThrustN / tot; Th *= s; Tv *= s; tot = CAR.maxThrustN; }
    if (want - tot > 0.01 * want) { satSpan += dt; satShort = Math.max(satShort, (want - tot) / m); maxErr = Math.min(3.5, Math.max(maxErr, 0.5 * satShort * satSpan ** 2)); }
    else satSpan = Math.max(0, satSpan - dt * 2);
    air = Math.max(0, air - (tot / CAR.exhaustVelocityMs) * dt); // real sim goes ballistic at 0
    peakThrust = Math.max(peakThrust, tot);
    peakUp = Math.max(peakUp, pos.up);

    let clr = Infinity;
    for (const o of hard) {
      const d = distance(pos, obstacleAt(o, t));
      if (t < 0.5 && distance(refPos(params, 0), obstacleAt(o, 0)) <= 0) continue; // overlap grace
      if (d < clr) clr = d;
      if (d < minClr.v) minClr = { v: d, t, id: o.id };
    }
    for (const o of people) {
      const d = personDistance(pos, obstacleAt(o, t));
      if (d < minPed.v) minPed = { v: d, t, id: o.id };
    }
    if (i % 5 === 0) {
      samples.push({ t: r2(t), forward: r3(pos.forward), right: r3(pos.right), up: r3(pos.up), thrust_kN: r2(tot / 1000), air_kg: r2(air), clearance_m: r2(Math.min(clr, 99)) });
    }
  }

  const end = refPos(params, T);
  const finalClr = Math.min(...hard.map((o) => distance(end, obstacleAt(o, T))));
  const missBase = 0.08 + 0.004 * Math.hypot(params.target.forward, params.target.right);
  const miss = missBase + Math.min(2.5, maxErr * 0.8);
  const vVert = 0.55 + 0.12 * params.apex_height_m / T + Math.min(2, maxErr * 0.6);
  const vHor = 0.06 + 0.02 * Math.hypot(params.target.forward, params.target.right) / T + Math.min(1, maxErr * 0.4);
  const labelOf = (id) => site.obstacles.find((o) => o.id === id)?.label ?? id;
  const td = { t: r2(T + 0.08), forward: r3(end.forward - miss * 0.7), right: r3(end.right + miss * 0.3), v_vertical: r2(vVert), v_horizontal: r2(vHor), miss_m: r2(miss) };

  const vals = {
    collision: { value: minClr.v, limit: 0, pass: minClr.v > 0, t: minClr.t, obstacle_id: minClr.id },
    clearance: { value: minClr.v, limit: SAFETY.minClearanceM, pass: minClr.v >= SAFETY.minClearanceM, t: minClr.t, obstacle_id: minClr.id },
    pedestrian: { value: minPed.v, limit: SAFETY.pedestrianKeepOutM, pass: minPed.v >= SAFETY.pedestrianKeepOutM, t: minPed.t, obstacle_id: minPed.id },
    thrust_limit: { value: maxErr, limit: 0.3, pass: maxErr <= 0.3 },
    touchdown_vertical: { value: vVert, limit: SAFETY.maxTouchdownVerticalMs, pass: vVert < SAFETY.maxTouchdownVerticalMs, t: td.t },
    touchdown_horizontal: { value: vHor, limit: SAFETY.maxTouchdownHorizontalMs, pass: vHor < SAFETY.maxTouchdownHorizontalMs, t: td.t },
    landing_accuracy: { value: miss, limit: SAFETY.landingToleranceM, pass: miss <= SAFETY.landingToleranceM, t: td.t },
    air_reserve: { value: air, limit: SAFETY.airReserveKg, pass: air >= SAFETY.airReserveKg },
    landing_zone: { value: finalClr, limit: SAFETY.minClearanceM, pass: finalClr >= SAFETY.minClearanceM, t: td.t },
  };
  const msg = {
    collision: (c) => c.pass ? `closest ${r2(c.value)} m (${labelOf(c.obstacle_id)})` : `hits ${labelOf(c.obstacle_id)} at t=${r2(c.t)} s`,
    clearance: (c) => `${r2(c.value)} m from ${labelOf(c.obstacle_id)} at t=${r2(c.t)} s`,
    pedestrian: (c) => `${r2(c.value)} m from ${labelOf(c.obstacle_id)} at t=${r2(c.t)} s`,
    thrust_limit: (c) => c.pass ? 'thrust within limits' : `saturated; tracking error ${r2(c.value)} m`,
    touchdown_vertical: (c) => `${r2(c.value)} m/s down at touchdown`,
    touchdown_horizontal: (c) => `${r2(c.value)} m/s sideways at touchdown`,
    landing_accuracy: (c) => `lands ${r2(c.value)} m from target`,
    air_reserve: (c) => `${r2(c.value)} kg air left`,
    landing_zone: (c) => `${r2(c.value)} m clear at final pose`,
  };
  const checks = CHECKS.map(({ id, unit }) => {
    const c = vals[id];
    const out = { id, pass: c.pass, value: r2(c.value), limit: c.limit, unit };
    if (c.t !== undefined) out.t = r2(c.t);
    if (c.obstacle_id) out.obstacle_id = c.obstacle_id;
    out.message = msg[id](c);
    return out;
  });
  const failures = checks.filter((c) => !c.pass).map((c) => c.id);
  return {
    schema: 'flyme.sim/1',
    params,
    verdict: failures.length ? 'UNSAFE' : 'SAFE',
    failures,
    checks,
    touchdown: td,
    air: { start_kg: CAR.airKg, used_kg: r2(CAR.airKg - air), remaining_kg: r2(air) },
    peak: { thrust_kN: r2(peakThrust / 1000), up_m: r2(peakUp), drag_N: r2(peakDrag) },
    samples,
  };
}

// ---------------------------------------------------------------- event helpers

function timeline() {
  let t = 0;
  const events = [];
  const add = (type, stage, data, wait = 400) => { t += wait; events.push({ type, stage, t_ms: t, data }); };
  return { events, add };
}

const summary = (sim) => {
  const { samples, ...rest } = sim;
  return rest;
};

const margins = (sim) => ({
  min_clearance_m: sim.checks.find((c) => c.id === 'clearance').value,
  air_remaining_kg: sim.air.remaining_kg,
  touchdown_v_ms: sim.touchdown.v_vertical,
});

// ---------------------------------------------------------------- loop 1 (reconstruct + critique)

// Argon's first guess: SUV 1.4 m too close, street light missed entirely.
const site0 = normalizeSite({
  ...fixture,
  name: 'Demo street (mock reconstruction)',
  round: 0,
  obstacles: fixture.obstacles
    .filter((o) => o.id !== 'o3')
    .map((o) => (o.id === 'o1' ? { ...o, center: { forward: 7.6, right: 0.3 }, confidence: 0.7 } : o)),
  notes: 'Mock reconstruction (web/mock/gen.mjs): SUV placed too close, street light missed — loop 1 fixes both.',
});

function reconstructEvents() {
  const { events, add } = timeline();
  add('status', 'reconstruct', { message: 'Uploading 5 clips to the Files API' }, 200);
  add('status', 'reconstruct', { message: 'Files ACTIVE · calling gemini-4-argon (thinking: high)' }, 900);
  add('thought', 'reconstruct', { text: 'Front clip: a white SUV parked in our lane, roughly 1.5 car lengths ahead.' }, 1100);
  add('thought', 'reconstruct', { text: 'Left clip: a pedestrian walking forward along the sidewalk, ~0.7 m/s.' }, 900);
  add('thought', 'reconstruct', { text: 'Up clip: overhead line crossing the street far ahead, ~6.5 m high.' }, 900);
  add('log', 'reconstruct', { message: `site.json: ${site0.obstacles.length} obstacles, ${site0.surfaces.length} surfaces` }, 700);
  add('site', 'reconstruct', site0, 300);
  add('done', 'reconstruct', {}, 50);
  return events;
}

const CAMS = ['front', 'right', 'back', 'left', 'up'];

const critique1 = {
  cameras: [
    { id: 'front', match_score: 58, issues: ['street light at left edge (x≈18%) missing in render', 'o1 SUV looks ~1.5 m farther in footage (rear bumper at 10 m line)'] },
    { id: 'right', match_score: 74, issues: ['open lane matches; no hazards'] },
    { id: 'back', match_score: 81, issues: [] },
    { id: 'left', match_score: 63, issues: ['street light missing near the 15 m grid line', 'o7 pedestrian position matches'] },
    { id: 'up', match_score: 70, issues: ['o6 overhead line height looks right'] },
  ],
  patch: [
    { op: 'update', id: 'o1', set: { center: { forward: 9.0, right: 0.0 } }, evidence: 'front: SUV rear bumper sits on the 5 m line past where o1 is drawn' },
    { op: 'add', obstacle: { id: 'o3', type: 'pole', label: 'street light', shape: 'cylinder', center: { forward: 14, right: -3.6 }, base_up: 0, radius: 0.15, height: 7, seen_in: ['front', 'left'], confidence: 0.75 }, evidence: 'front: tall pole at x≈18% of frame, between the 10 m and 15 m lines' },
  ],
  done: false,
};
const { site: site1, log: log1 } = applyPatch(site0, critique1.patch);
site1.round = 1;

const critique2 = {
  cameras: [
    { id: 'front', match_score: 88, issues: ['canopy o5 slightly wide; within tolerance'] },
    { id: 'right', match_score: 86, issues: [] },
    { id: 'back', match_score: 90, issues: [] },
    { id: 'left', match_score: 84, issues: [] },
    { id: 'up', match_score: 82, issues: [] },
  ],
  patch: [
    { op: 'update', id: 'o5', set: { radius: 2.2 }, evidence: 'front: canopy edge ends before the 5 m column' },
  ],
  done: true,
};
const { site: site2, log: log2 } = applyPatch(site1, critique2.patch);
site2.round = 2;

function critiqueEvents(round, c, log, patched) {
  const { events, add } = timeline();
  add('status', 'critique', { message: `Round ${round}: comparing ${CAMS.length} renders with footage keyframes` }, 200);
  add('status', 'critique', { message: 'gemini-4-argon (thinking: medium)' }, 600);
  for (const cam of c.cameras) add('log', 'critique', { message: `${cam.id}: ${cam.match_score}/100${cam.issues[0] ? ' — ' + cam.issues[0] : ''}` }, 450);
  add('critique', 'critique', { ...c, round, patch_log: log }, 400);
  add('site', 'critique', patched, 150);
  add('done', 'critique', {}, 50);
  return events;
}

// ---------------------------------------------------------------- loop 2 (plan)

function planEvents(site, target, rounds, final) {
  const { events, add } = timeline();
  add('status', 'plan', { message: 'Agent sandbox ready (pre-warmed at SCAN)' }, 200);
  add('tool', 'plan', { name: 'code_execution', code: 'cat /workspace/input/site.json /workspace/input/target.json' }, 700);
  const outRounds = [];
  const disagreements = [];
  for (const [ri, rd] of rounds.entries()) {
    const n = ri + 1;
    add('thought', 'plan', { text: rd.think }, 1100);
    add('tool', 'plan', { name: 'code_execution', code: `node /workspace/flyme/sim-cli.mjs --site /workspace/input/site.json --params round-${n}.json --svg round-${n}.svg` }, 900);
    const cands = [];
    for (const c of rd.candidates) {
      const params = { target, ...c.params };
      const sim = mockSim(site, params);
      const claim = c.claim ?? { sim_verdict: sim.verdict, failures: sim.failures };
      const disagrees = claim.sim_verdict !== sim.verdict;
      if (disagrees) disagreements.push({ id: c.id, agent: claim.sim_verdict, server: sim.verdict });
      add('attempt', 'plan', { round: n, id: c.id, label: c.label, params, sim, agent_claim: claim, disagrees }, 450);
      cands.push({ id: c.id, label: c.label, params, sim_verdict: sim.verdict, failures: sim.failures, ...(sim.verdict === 'SAFE' ? { margins: margins(sim) } : {}), sim });
    }
    add('sim_result', 'plan', { round: n, summary: cands.map((c) => `${c.id} ${c.sim_verdict}${c.failures.length ? ' (' + c.failures.join(', ') + ')' : ''}`).join(' · ') }, 300);
    const decision = rd.decision;
    const why = typeof rd.why === 'function' ? rd.why(cands) : rd.why ?? null;
    if (decision === 'revise') add('thought', 'plan', { text: rd.revision_notes }, 900);
    if (decision === 'pick') add('log', 'plan', { message: `Picked ${rd.chosen_id}: ${why}` }, 900);
    outRounds.push({ n, candidates: cands, decision, chosen_id: rd.chosen_id ?? null, why, revision_notes: rd.revision_notes ?? null });
  }
  const last = outRounds.at(-1);
  const chosen = last.candidates.find((c) => c.id === last.chosen_id);
  const result = {
    verdict: chosen && chosen.sim_verdict === 'SAFE' ? 'SAFE' : 'REJECT',
    rounds: outRounds,
    final_params: chosen?.params ?? null,
    chosen_id: chosen?.id ?? null,
    semantic_notes: final.semantic_notes,
    reject_reason: chosen ? null : final.reject_reason,
    disagreements,
  };
  add('plan', 'plan', result, 400);
  add('done', 'plan', {}, 50);
  return { events, result };
}

const P = (apex, dur, bow, bias, delay) => ({ apex_height_m: apex, duration_s: dur, side_bow_m: bow, climb_bias: bias, horizontal_delay: delay });

const mainRounds = [
  {
    think: 'Target is 25 m ahead in our lane; the parked SUV o1 (1.75 m tall) sits in the way at 9 m and a pedestrian walks along the left sidewalk. Try four different shapes: direct low hop, left bow, long slow arc, fast high arc.',
    candidates: [
      { id: 'r1a', label: 'direct low hop', params: P(1.6, 3.0, 0, 0.5, 0.1) },
      { id: 'r1b', label: 'left bow over sidewalk', params: P(5, 3.3, -1.8, 0.42, 0.15) },
      { id: 'r1c', label: 'long gentle arc', params: P(6, 6.6, 0, 0.5, 0.15) },
      { id: 'r1d', label: 'fast high arc', params: P(7, 1.6, 0, 0.4, 0.05) },
    ],
    decision: 'revise',
    revision_notes: 'All four failed. r1a clipped the SUV → climb before moving (bias 0.35, delay 0.15). r1b came within the 5 m blast radius of the pedestrian → keep bows small. r1c ran the air below reserve → shorter flight. r1d saturated thrust → slower. Round 2: two climb-first shapes, one quicker variant, one lower arc.',
  },
  {
    think: 'Round 2: climb first so we are above the SUV roof before crossing it, keep durations 3.3–3.8 s for air, small or no bow.',
    candidates: [
      { id: 'r2a', label: 'high arc, slight left bow', params: P(5.6, 3.3, -1.0, 0.45, 0.15) },
      { id: 'r2b', label: 'climb-first over SUV', params: P(5.2, 3.2, 0, 0.45, 0.12) },
      { id: 'r2c', label: 'quick climb-first', params: P(6, 2.1, 0, 0.35, 0.1) },
      { id: 'r2d', label: 'low arc over SUV roof', params: P(2.3, 3.0, 0, 0.45, 0.1), claim: { sim_verdict: 'SAFE', failures: [] } },
    ],
    decision: 'pick',
    chosen_id: 'r2b',
    why: (c) => {
      const a = c.find((x) => x.id === 'r2a'), b = c.find((x) => x.id === 'r2b');
      return `Both r2a and r2b pass. r2a bows left over the sidewalk edge, toward the pedestrian walking ahead on the left — ${a.sim.checks[2].value} m at closest, barely outside the 5 m blast radius, and they may drift toward the curb. r2b stays over the road lane, clears the SUV roof by ${b.sim.checks[1].value} m and lands with ${Math.round(b.sim.air.remaining_kg)} kg of air left.`;
    },
  },
];

const rejectTarget = { forward: 40, right: 0 };
const rejectRounds = [
  {
    think: 'Target is 40 m ahead, directly under the overhead line o6 at 6.5 m. Any descent onto it from above crosses the line; staying under it needs a long, low, flat flight.',
    candidates: [
      { id: 'r1a', label: 'high arc over the line', params: P(8, 4.4, 0, 0.7, 0.1) },
      { id: 'r1b', label: 'low under the line', params: P(5.0, 4.0, 0, 0.6, 0.1) },
      { id: 'r1c', label: 'right bow, high', params: P(7, 4.4, 4, 0.7, 0.1) },
      { id: 'r1d', label: 'long flat glide', params: P(3.5, 6.4, 0, 0.5, 0.1) },
    ],
    decision: 'revise',
    revision_notes: 'Late-peaking arcs cross o6 on the way down; routes that stay under the line need 4+ s and run the air below reserve. Try a steeper drop and faster low routes.',
  },
  {
    think: 'Round 2: climb early and drop steeply before the line, or stay under ~4 m and go faster.',
    candidates: [
      { id: 'r2a', label: 'steep late drop', params: P(10, 4.6, 0, 0.75, 0.1) },
      { id: 'r2b', label: 'fast low under line', params: P(4.0, 2.6, 0, 0.4, 0.05) },
      { id: 'r2c', label: 'left bow under line', params: P(4.2, 4.2, -2.5, 0.45, 0.1) },
      { id: 'r2d', label: 'slow low glide', params: P(3.2, 5.9, 0, 0.5, 0.1) },
    ],
    decision: 'revise',
    revision_notes: 'Steep drop still crosses o6; the fast low route saturates thrust; the left bow hits the sidewalk tree canopy; the slow glide breaks the air reserve. One last round between the extremes.',
  },
  {
    think: 'Round 3: medium speed under the line, and two over-the-line variants with the descent moved later.',
    candidates: [
      { id: 'r3a', label: 'medium low under line', params: P(4.4, 3.0, 0, 0.4, 0.05) },
      { id: 'r3b', label: 'very high, late descent', params: P(12, 5.0, 0, 0.75, 0.1) },
      { id: 'r3c', label: 'right bow under line', params: P(4.6, 4.0, 3.0, 0.4, 0.1) },
      { id: 'r3d', label: 'very slow creep', params: P(3.0, 7.5, 0, 0.5, 0.1) },
    ],
    decision: 'reject',
  },
];

// ---------------------------------------------------------------- write

const out = (name, data) => {
  fs.writeFileSync(path.join(HERE, name), JSON.stringify(data));
  console.log(`wrote web/mock/${name} (${(JSON.stringify(data).length / 1024).toFixed(0)} KB)`);
};

out('reconstruct.json', reconstructEvents());
out('critique-r1.json', critiqueEvents(1, critique1, log1, site1));
out('critique-r2.json', critiqueEvents(2, critique2, log2, site2));
out('site-final.json', site2);

const main = planEvents(site2, { forward: 25, right: 0 }, mainRounds, {
  semantic_notes: ['pedestrian o7 walking ahead along the left sidewalk (left cam)', 'r2d: agent claimed SAFE; server sim found it too close to the SUV roof'],
});
out('plan.json', { target: { forward: 25, right: 0 }, events: main.events });

const rej = planEvents(site2, rejectTarget, rejectRounds, {
  semantic_notes: ['landing spot is directly under overhead line o6 (6.5 m)'],
  reject_reason: 'No safe hop to this spot: it is 40 m out, directly under the overhead line at 6.5 m. Arcs high enough to be quick cross the line on descent; routes that stay under it are either too slow (below the 25 kg air reserve) or too fast (thrust saturates).',
});
out('plan-reject.json', { target: rejectTarget, events: rej.events });

// Table for tuning
for (const [name, r] of [['main', main.result], ['reject', rej.result]]) {
  console.log(`\n${name}: ${r.verdict} chosen=${r.chosen_id}`);
  for (const rd of r.rounds) for (const c of rd.candidates) {
    const s = c.sim;
    console.log(`  ${c.id.padEnd(4)} ${c.label.padEnd(28)} ${s.verdict.padEnd(6)} ${s.failures.join(',').padEnd(30)} clr=${s.checks[1].value} ped=${s.checks[2].value} air=${s.air.remaining_kg} peak=${s.peak.thrust_kN}kN err=${s.checks[3].value}`);
  }
}
