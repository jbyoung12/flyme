// Loop 2, "search" mode: the simulator brute-forces the route shapes to the
// tapped spot and hands Argon the best *different* SAFE routes; Argon judges
// them against the footage (people's paths, sidewalks, moving cars — what the
// sim can't see), may ask for revised routes (re-simulated), then picks one and
// explains why. If nothing is SAFE, nearby spots are searched and a snapped
// target is *suggested* (never applied silently). Output = §6.7 + §6.11.

import fs from 'node:fs';
import { diverseSafe, shapeGrid } from '../shared/search.js';
import { landableMap } from '../shared/landable.js';
import { clampParams, validateAgentResult } from '../shared/schema.js';
import { prepareObstacles, carToObstacleClearance3D, carToPersonHorizontalDistance2D } from '../shared/geometry.js';
import { searchRoutesParallel, simulateMany, reachCells, refineSafe } from './search-pool.js';
import { streamInteraction, parseJson, loadPrompt, fill } from './gemini.js';
import { agentJudge } from './agent-judge.js';
import { keyframePath } from './ingest.js';
import { DEFAULT_RIG } from '../shared/constants.js';

const ROUND_IDS = ['a', 'b', 'c', 'd'];
const SHAPE_KEYS = ['apex_height_m', 'duration_s', 'side_bow_m', 'climb_bias', 'horizontal_delay', 'vertical_drop'];

// ---------------------------------------------------------------- route descriptions for Argon

function insidePoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.right > pt.right) !== (b.right > pt.right) &&
      pt.forward < ((b.forward - a.forward) * (pt.right - a.right)) / (b.right - a.right) + a.forward) inside = !inside;
  }
  return inside;
}

// What a route passes near/over, from its samples: nearest obstacles, people,
// and the surfaces it flies over. Plain facts for Argon's judgment.
export function describeRoute(site, sim) {
  const prepared = prepareObstacles(site);
  const near = new Map();
  const over = new Set();
  for (const s of sim.samples) {
    const car = { forward: s.forward, right: s.right, up: s.up };
    prepared.forEach((p, i) => {
      const o = site.obstacles[i];
      const d = o.type === 'person' ? carToPersonHorizontalDistance2D(car, p, s.t) : carToObstacleClearance3D(car, p, s.t);
      const cur = near.get(o.id);
      if (!cur || d < cur.d) near.set(o.id, { d, t: s.t, up: s.up, o });
    });
    for (const surf of site.surfaces ?? []) if (insidePoly(s, surf.polygon)) over.add(surf.type);
  }
  const list = [...near.values()].sort((a, b) => a.d - b.d);
  const fmt = ({ d, t, up, o }) => `${o.id} ${o.label} (${o.type}${o.velocity ? ', moving' : ''}): ${d.toFixed(1)} m at t=${t.toFixed(1)} s, car ${up.toFixed(1)} m up`;
  return {
    nearest: list.filter((x) => x.o.type !== 'person').slice(0, 3).map(fmt),
    people: list.filter((x) => x.o.type === 'person').slice(0, 3).map(fmt),
    flies_over: [...over],
  };
}

function card(id, label, e, site) {
  return { id, label, params: Object.fromEntries(SHAPE_KEYS.map((k) => [k, e.params[k]])), margins: e.margins, route: describeRoute(site, e.sim) };
}

function labelFor(p) {
  const side = p.side_bow_m > 1 ? 'right-bowed' : p.side_bow_m < -1 ? 'left-bowed' : 'straight';
  const h = p.apex_height_m >= 7 ? 'high' : p.apex_height_m >= 4.5 ? 'mid' : 'low';
  return `${h} ${side} arc${p.vertical_drop > 0 ? ' + straight-down landing' : ''}`;
}

// ---------------------------------------------------------------- Argon judge

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['pick', 'revise'] },
    chosen_id: { type: 'string' },
    why: { type: 'string' },
    revised: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' }, reason: { type: 'string' },
          ...Object.fromEntries(SHAPE_KEYS.map((k) => [k, { type: 'number' }])),
        },
        required: ['label', 'reason', ...SHAPE_KEYS],
      },
    },
    semantic_notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['decision', 'chosen_id', 'why', 'revised', 'semantic_notes'],
};

async function judge({ siteId, site, target, rig = DEFAULT_RIG, cards, round, mustPick }, sse) {
  const input = [];
  for (const c of rig.cameras ?? DEFAULT_RIG.cameras) {
    const kp = keyframePath(siteId, c.id);
    if (!fs.existsSync(kp)) continue;
    input.push({ type: 'text', text: `Camera \`${c.id}\` (yaw ${c.yaw_deg}°: looking ${['forward', 'right', 'back', 'left'][Math.round(c.yaw_deg / 90) % 4]}) — footage keyframe:` });
    input.push({ type: 'image', data: fs.readFileSync(kp).toString('base64'), mime_type: 'image/png' });
  }
  input.push({ type: 'text', text: fill(loadPrompt('plan-search.md'), {
    target: JSON.stringify(target),
    site: JSON.stringify({ name: site.name, notes: site.notes, obstacles: site.obstacles.map(({ id, type, label, center, from, to, velocity, intent_notes }) => ({ id, type, label, center, from, to, velocity, intent_notes })) }),
    candidates: JSON.stringify(cards, null, 1),
    round,
    must_pick: mustPick ? 'This is the final round: you MUST pick one of these candidates (decision "pick"), or explain in `why` why none is acceptable and set chosen_id to "none".' : 'You may pick now, or ask for revised routes (decision "revise") if every candidate has a street-context problem the simulator cannot see.',
  }) });
  sse.status(`Argon is judging ${cards.length} safe routes against the footage (round ${round})`);
  const { text } = await streamInteraction({
    input,
    generation_config: { thinking_level: 'medium' },
    response_format: { type: 'text', mime_type: 'application/json', schema: JUDGE_SCHEMA },
  }, { sse, siteId, label: `plan-search.r${round}` });
  return parseJson(text, 'plan-search judge');
}

// Representative shapes for the cheap "is anything SAFE?" probes (nearby
// spots, departure delays): 18 shapes instead of the full 400.
const PROBE_SHAPES = shapeGrid({ full: false }).filter((x) => x.climb_bias === 0.45 && x.vertical_drop === 0 && x.duration_s !== 4.2);

// The browser went away (new tap, page reload): stop burning CPU on it.
function checkOpen(sse) {
  if (sse.closed) throw new Error('client disconnected; plan cancelled');
}

// ---------------------------------------------------------------- snap

async function suggestNearby(site, target, sse) {
  const zone = landableMap(site, { step: 1.5 });
  const cells = zone.cells
    .filter((c) => c.ok && Math.hypot(c.forward - target.forward, c.right - target.right) <= 4.5)
    .sort((a, b) => Math.hypot(a.forward - target.forward, a.right - target.right) - Math.hypot(b.forward - target.forward, b.right - target.right))
    .slice(0, 8)
    .map(({ forward, right }) => ({ forward, right }));
  if (!cells.length) return null;
  sse.status(`no safe route to the exact spot — checking ${cells.length} spots within 4.5 m`);
  checkOpen(sse);
  const res = await reachCells(site, cells, PROBE_SHAPES);
  const ok = res.filter((r) => r.safe)
    .map((r) => ({ ...r.target, offset_m: +Math.hypot(r.target.forward - target.forward, r.target.right - target.right).toFixed(1) }))
    .sort((a, b) => a.offset_m - b.offset_m);
  return ok[0] ?? null;
}

// ---------------------------------------------------------------- wait

// Everyone moving keeps moving: the site as it will be `wait` seconds from now.
export function siteAfter(site, wait) {
  if (!wait) return site;
  return { ...site, obstacles: site.obstacles.map((o) => o.velocity
    ? { ...o, center: { forward: +(o.center.forward + o.velocity.forward * wait).toFixed(2), right: +(o.center.right + o.velocity.right * wait).toFixed(2) } }
    : o) };
}

// People/cars are what block the hop → find the shortest departure delay
// (3–20 s) after which some route is SAFE.
async function suggestWait(site, target, sse) {
  sse.status('people are in the way — checking whether waiting a few seconds clears the route');
  for (const wait of [3, 6, 10, 15, 20]) {
    checkOpen(sse);
    const res = await simulateMany(siteAfter(site, wait), PROBE_SHAPES.map((sh) => ({ target, ...sh })));
    if (res.some((e) => e.sim.verdict === 'SAFE')) return wait;
  }
  return null;
}

// ---------------------------------------------------------------- main

function sendAttempt(sse, round, id, label, e) {
  sse.send('attempt', { round, id, label, params: e.params, sim: e.sim, agent_claim: { sim_verdict: e.sim.verdict, failures: e.sim.failures }, disagrees: false });
}

function roundCandidate(id, label, e) {
  return { id, label, params: e.params, sim_verdict: e.sim.verdict, failures: e.sim.failures, margins: e.margins, sim: e.sim };
}

export async function planSearch({ siteId, site: siteNow, target, rig = DEFAULT_RIG, wait_s: waitS = 0, judgeWith = 'agent' }, sse) {
  const site = siteAfter(siteNow, waitS);
  if (waitS) sse.log(`planning for departure in ${waitS} s: moving people and cars advanced by their velocity`);
  sse.status('simulator: searching 400 route shapes to the landing spot');
  const t0 = Date.now();
  const found = await searchRoutesParallel(site, target);
  sse.log(`simulator: ${found.safe.length} of ${found.tried} route shapes are SAFE (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  checkOpen(sse);
  if (found.safe.length) {
    const before = Math.max(...found.safe.map((e) => e.margins.min_clearance_m));
    found.safe = await refineSafe(site, found.safe);
    const after = Math.max(...found.safe.map((e) => e.margins.min_clearance_m));
    sse.log(`simulator: refined to ${found.safe.length} SAFE routes · best clearance ${before.toFixed(2)} → ${after.toFixed(2)} m`);
  }

  if (!found.safe.length) {
    // Show the 4 least-bad routes so the user sees why, and suggest a nearby spot.
    const show = found.near.slice(0, 4);
    const cands = show.map((e, i) => { const id = `r1${ROUND_IDS[i]}`; const label = labelFor(e.params); sendAttempt(sse, 1, id, label, e); return roundCandidate(id, label, e); });
    const blockedByMovers = show.some((e) => e.sim.checks.some((c) => !c.pass && c.obstacle_id && site.obstacles.find((o) => o.id === c.obstacle_id)?.velocity));
    const [suggestion, wait] = await Promise.all([
      suggestNearby(site, target, sse),
      blockedByMovers && waitS < 20 ? suggestWait(site, target, sse) : null,
    ]);
    // Name everyone inside the keep-out on the best attempt, not just the closest.
    const prepared = prepareObstacles(site);
    const best = show[0].sim;
    const tooClose = site.obstacles.map((o, i) => {
      if (o.type !== 'person') return null;
      let d = Infinity;
      for (const smp of best.samples) d = Math.min(d, carToPersonHorizontalDistance2D(smp, prepared[i], smp.t));
      return d < 5 ? `${o.id} ${o.label} (${Math.max(d, 0).toFixed(1)} m)` : null;
    }).filter(Boolean);
    const other = [...new Set(show.flatMap((e) => e.sim.checks.filter((c) => !c.pass && c.id !== 'pedestrian').map((c) => c.message)))].slice(0, 2);
    const reasons = [...(tooClose.length ? [`within the 5 m thruster keep-out of ${tooClose.join(', ')}`] : []), ...other];
    const reject_reason = `No safe route to (${target.forward}, ${target.right}) in ${found.tried} route shapes: ${reasons.join('; ')}.` +
      (suggestion ? ` A safe landing exists ${suggestion.offset_m} m away at (${suggestion.forward}, ${suggestion.right}).` : '') +
      (wait ? ` The people in the way will have moved on in about ${wait} s — wait, then hop.` : (blockedByMovers ? ' Waiting up to 20 s does not clear it.' : ''));
    return {
      verdict: 'REJECT',
      rounds: [{ n: 1, candidates: cands, decision: 'reject', chosen_id: null, why: null, revision_notes: null }],
      final_params: null, chosen_id: null, semantic_notes: [], reject_reason,
      suggested_target: suggestion, suggested_wait_s: wait ? waitS + wait : null, disagreements: [], search: { tried: found.tried, safe: 0 },
    };
  }

  // Exactly 4 per round (§6.7): pad with the least-bad UNSAFE routes if few are SAFE.
  const picks = [...diverseSafe(found.safe, 4), ...found.near].slice(0, 4);
  const entries = new Map();
  const cands1 = picks.map((e, i) => {
    const id = `r1${ROUND_IDS[i]}`; const label = labelFor(e.params);
    entries.set(id, e); sendAttempt(sse, 1, id, label, e);
    return roundCandidate(id, label, e);
  });
  const rounds = [];
  const safeCards = (cands) => cands.filter((c) => c.sim_verdict === 'SAFE').map((c) => card(c.id, c.label, entries.get(c.id), site));
  checkOpen(sse);
  let decision = null;
  const disagreements = [];
  if (judgeWith === 'agent') {
    try {
      const d = await agentJudge({ siteId, site, target, rig, cards: safeCards(cands1) }, sse);
      // Re-simulate every route the agent designed (D8); its ids map to r2a–r2d.
      const keptOrig = /^r1[a-d]$/.test(d.chosen_id ?? '') && entries.has(d.chosen_id) ? d.chosen_id : null;
      // Keep room for the original the agent chose so round 2 holds the pick.
      const rev = (d.revised ?? []).filter((r) => r?.params).slice(0, keptOrig ? 3 : 4);
      const idMap = new Map(cands1.map((c) => [c.id, c.id]));
      let cands2 = null;
      if (rev.length) {
        const sims = await simulateMany(site, rev.map((r) => clampParams({ ...r.params, target }).params).filter(Boolean));
        const rows = sims.map((e, i) => ({ e, label: rev[i].label ?? labelFor(e.params), claim: rev[i].sim_verdict, agentId: rev[i].id }));
        if (keptOrig) rows.push({ e: entries.get(keptOrig), label: `${cands1.find((c) => c.id === keptOrig).label} (kept)`, agentId: keptOrig });
        for (const c of cands1) if (rows.length < 4 && c.id !== keptOrig) rows.push({ e: entries.get(c.id), label: `${c.label} (kept)`, agentId: `kept-${c.id}` });
        cands2 = rows.map(({ e, label, claim, agentId }, i) => {
          const id = `r2${ROUND_IDS[i]}`;
          idMap.set(agentId ?? id, id);
          entries.set(id, e);
          if (claim && claim !== e.sim.verdict) disagreements.push({ id, agent: claim, server: e.sim.verdict });
          sse.send('attempt', { round: 2, id, label, params: e.params, sim: e.sim, agent_claim: { sim_verdict: claim ?? e.sim.verdict, failures: e.sim.failures }, disagrees: Boolean(claim && claim !== e.sim.verdict) });
          return roundCandidate(id, label, e);
        });
      }
      const chosenId = idMap.get(d.chosen_id) ?? d.chosen_id;
      // Keep the agent's wording consistent with the renumbered ids (r1a kept → r2d).
      if (keptOrig && chosenId !== keptOrig && d.why) d.why = d.why.replaceAll(keptOrig, `${chosenId} (originally ${keptOrig})`).replace(`${chosenId} (originally ${keptOrig}) (originally ${keptOrig})`, `${chosenId} (originally ${keptOrig})`);
      const notes = rev.map((r) => `${r.label ?? r.id}: ${r.reason ?? ''}`).join(' · ') || null;
      rounds.push({ n: 1, candidates: cands1, decision: cands2 ? 'revise' : 'pick', chosen_id: cands2 ? null : chosenId, why: cands2 ? null : d.why, revision_notes: cands2 ? notes : null });
      if (cands2) rounds.push({ n: 2, candidates: cands2, decision: 'pick', chosen_id: chosenId, why: d.why, revision_notes: null });
      decision = { chosen_id: chosenId, why: d.why, semantic_notes: d.semantic_notes ?? [] };
    } catch (err) {
      if (sse.closed) throw err;
      sse.log(`Managed Agent judge failed (${err.message}); falling back to a direct Argon judge`);
      rounds.length = 0;
    }
  }
  if (!decision) {
    const v1 = await judge({ siteId, site, target, rig, cards: safeCards(cands1), round: 1, mustPick: false }, sse);
    decision = v1;
    rounds.push({ n: 1, candidates: cands1, decision: v1.decision === 'revise' ? 'revise' : 'pick', chosen_id: v1.decision === 'revise' ? null : v1.chosen_id, why: v1.why, revision_notes: v1.decision === 'revise' ? v1.revised.map((r) => `${r.label}: ${r.reason}`).join(' · ') : null });

    if (v1.decision === 'revise' && v1.revised?.length) {
      // Re-simulate Argon's revised routes; fill the round with the best originals.
      const revisedParams = v1.revised.slice(0, 4).map((r) => clampParams({ target, ...Object.fromEntries(SHAPE_KEYS.map((k) => [k, r[k]])) }).params).filter(Boolean);
      const sims = await simulateMany(site, revisedParams);
      const pool2 = sims.map((e, i) => ({ e, label: v1.revised[i].label }));
      for (const c of cands1) if (pool2.length < 4) pool2.push({ e: entries.get(c.id), label: `${c.label} (kept)` });
      const cands2 = pool2.slice(0, 4).map(({ e, label }, i) => {
        const id = `r2${ROUND_IDS[i]}`; entries.set(id, e); sendAttempt(sse, 2, id, label, e);
        return roundCandidate(id, label, e);
      });
      const safe2 = cands2.filter((c) => c.sim_verdict === 'SAFE');
      sse.log(`simulator: ${safe2.length} of ${cands2.length} round-2 routes are SAFE`);
      decision = await judge({ siteId, site, target, rig, cards: safe2.length ? safeCards(cands2) : safeCards(cands1), round: 2, mustPick: true }, sse);
      rounds.push({ n: 2, candidates: cands2, decision: 'pick', chosen_id: decision.chosen_id, why: decision.why, revision_notes: null });
    }
  }

  const chosen = entries.get(decision.chosen_id);
  // The simulator, not Argon, has the last word (D8).
  if (!chosen || chosen.sim.verdict !== 'SAFE') {
    const last = rounds.at(-1);
    last.decision = 'reject';
    last.chosen_id = null;
    return { verdict: 'REJECT', rounds, final_params: null, chosen_id: null, semantic_notes: decision.semantic_notes ?? [],
      reject_reason: decision.why || 'Argon found no acceptable route among the simulator-SAFE ones.', disagreements, search: { tried: found.tried, safe: found.safe.length } };
  }
  const out = {
    verdict: 'SAFE', rounds, final_params: chosen.params, chosen_id: decision.chosen_id, wait_s: waitS || null,
    semantic_notes: decision.semantic_notes ?? [], reject_reason: null, disagreements,
    search: { tried: found.tried, safe: found.safe.length },
  };
  const v = validateAgentResult(out);
  if (!v.ok) sse.log(`Warning: search result validation: ${v.errors.join('; ')}`);
  return out;
}
