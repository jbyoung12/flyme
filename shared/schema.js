// Contract validators (PLAN.md §6.3, §6.4, §6.6, §6.7), the params bounds
// clamp, and deterministic applyPatch for Loop 1. Zero dependencies: runs in
// Node 22 (agent sandbox), the server, and the browser.
//
// Validators return { ok, errors: [string] } and never throw. Normalizers
// return a fresh object with defaults filled in; they never mutate inputs.

import { PARAM_BOUNDS, CANDIDATES_PER_ROUND, MAX_PLAN_ROUNDS } from './constants.js';

export const OBSTACLE_TYPES = ['vehicle', 'pole', 'sign', 'tree_trunk', 'tree_canopy', 'wire', 'person', 'building', 'barrier', 'other'];
export const SHAPES = ['box', 'cylinder', 'wire'];
export const SURFACE_TYPES = ['road', 'sidewalk', 'parking', 'grass', 'plaza', 'water', 'other'];
export const VERDICTS = ['SAFE', 'UNSAFE'];
export const AGENT_VERDICTS = ['SAFE', 'REJECT'];
export const DECISIONS = ['pick', 'revise', 'reject'];
export const PATCH_OPS = ['add', 'update', 'remove'];

// ---------------------------------------------------------------- helpers

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const result = (errors) => ({ ok: errors.length === 0, errors });

function checkVec(errors, path, v, keys) {
  if (!isObj(v)) return errors.push(`${path}: expected object {${keys.join(', ')}}`);
  for (const k of keys) if (!isNum(v[k])) errors.push(`${path}.${k}: expected finite number`);
}

function checkPositive(errors, path, v) {
  if (!isNum(v) || v <= 0) errors.push(`${path}: expected number > 0`);
}

// ---------------------------------------------------------------- site (§6.3)

export function validateObstacle(o, path = 'obstacle') {
  const errors = [];
  if (!isObj(o)) return result([`${path}: expected object`]);
  if (typeof o.id !== 'string' || !o.id) errors.push(`${path}.id: expected non-empty string`);
  if (!OBSTACLE_TYPES.includes(o.type)) errors.push(`${path}.type: expected one of ${OBSTACLE_TYPES.join('|')}`);
  if (!SHAPES.includes(o.shape)) errors.push(`${path}.shape: expected one of ${SHAPES.join('|')}`);
  if (o.shape === 'box') {
    checkVec(errors, `${path}.center`, o.center, ['forward', 'right']);
    if (!isObj(o.size)) errors.push(`${path}.size: expected {length, width, height}`);
    else for (const k of ['length', 'width', 'height']) checkPositive(errors, `${path}.size.${k}`, o.size[k]);
    if (o.heading_deg !== undefined && !isNum(o.heading_deg)) errors.push(`${path}.heading_deg: expected number`);
  } else if (o.shape === 'cylinder') {
    checkVec(errors, `${path}.center`, o.center, ['forward', 'right']);
    checkPositive(errors, `${path}.radius`, o.radius);
    checkPositive(errors, `${path}.height`, o.height);
  } else if (o.shape === 'wire') {
    checkVec(errors, `${path}.from`, o.from, ['forward', 'right', 'up']);
    checkVec(errors, `${path}.to`, o.to, ['forward', 'right', 'up']);
  }
  if (o.base_up !== undefined && !isNum(o.base_up)) errors.push(`${path}.base_up: expected number`);
  if (o.velocity !== undefined && o.velocity !== null) checkVec(errors, `${path}.velocity`, o.velocity, ['forward', 'right']);
  if (o.confidence !== undefined && (!isNum(o.confidence) || o.confidence < 0 || o.confidence > 1)) errors.push(`${path}.confidence: expected 0..1`);
  if (o.seen_in !== undefined && !Array.isArray(o.seen_in)) errors.push(`${path}.seen_in: expected array`);
  return result(errors);
}

export function validateSite(site) {
  const errors = [];
  if (!isObj(site)) return result(['site: expected object']);
  if (site.schema !== 'flyme.site/1') errors.push('site.schema: expected "flyme.site/1"');
  if (!Array.isArray(site.obstacles)) errors.push('site.obstacles: expected array');
  else {
    const seen = new Set();
    site.obstacles.forEach((o, i) => {
      errors.push(...validateObstacle(o, `site.obstacles[${i}]`).errors);
      if (o && seen.has(o.id)) errors.push(`site.obstacles[${i}].id: duplicate "${o.id}"`);
      if (o) seen.add(o.id);
    });
  }
  if (site.surfaces !== undefined) {
    if (!Array.isArray(site.surfaces)) errors.push('site.surfaces: expected array');
    else site.surfaces.forEach((s, i) => {
      const p = `site.surfaces[${i}]`;
      if (!isObj(s)) return errors.push(`${p}: expected object`);
      if (!SURFACE_TYPES.includes(s.type)) errors.push(`${p}.type: expected one of ${SURFACE_TYPES.join('|')}`);
      if (!Array.isArray(s.polygon) || s.polygon.length < 3) errors.push(`${p}.polygon: expected ≥3 points`);
      else s.polygon.forEach((pt, j) => checkVec(errors, `${p}.polygon[${j}]`, pt, ['forward', 'right']));
    });
  }
  return result(errors);
}

// Fill defaults so downstream code (sim, renderer) never branches on absence.
export function normalizeObstacle(o) {
  const n = clone(o);
  n.label ??= n.type ?? 'object';
  n.seen_in ??= [];
  n.confidence ??= 0.5;
  if (n.shape !== 'wire') n.base_up ??= 0;
  if (n.shape === 'box') n.heading_deg ??= 0;
  if (n.velocity === null) delete n.velocity;
  return n;
}

export function normalizeSite(site) {
  const n = clone(site);
  n.schema = 'flyme.site/1';
  n.round ??= 0;
  n.surfaces ??= [];
  n.obstacles = (n.obstacles ?? []).map(normalizeObstacle);
  n.scale_refs ??= [];
  n.notes ??= '';
  return n;
}

// ---------------------------------------------------------------- params (§6.4)

// Clamp shape params into PARAM_BOUNDS. target is passed through untouched
// (the agent may not move it). Returns { params, violations, errors };
// errors are non-recoverable (missing target / non-numeric fields).
export function clampParams(input) {
  const errors = [];
  const violations = [];
  const params = {};
  if (!isObj(input)) return { params: null, violations, errors: ['params: expected object'] };
  if (!isObj(input.target) || !isNum(input.target.forward) || !isNum(input.target.right)) {
    errors.push('params.target: expected {forward, right} numbers');
  } else {
    params.target = { forward: input.target.forward, right: input.target.right };
  }
  for (const [k, [lo, hi]] of Object.entries(PARAM_BOUNDS)) {
    const v = input[k];
    if (!isNum(v)) { errors.push(`params.${k}: expected finite number`); continue; }
    const c = Math.min(hi, Math.max(lo, v));
    if (c !== v) violations.push({ field: k, value: v, clamped: c, bounds: [lo, hi] });
    params[k] = c;
  }
  return { params: errors.length ? null : params, violations, errors };
}

export function validateParams(p) {
  const { errors, violations } = clampParams(p);
  return result([...errors, ...violations.map((v) => `params.${v.field}: ${v.value} outside [${v.bounds.join(', ')}]`)]);
}

// ---------------------------------------------------------------- critique (§6.6)

export function validateCritique(c) {
  const errors = [];
  if (!isObj(c)) return result(['critique: expected object']);
  if (!Array.isArray(c.cameras)) errors.push('critique.cameras: expected array');
  else c.cameras.forEach((cam, i) => {
    if (!isObj(cam) || typeof cam.id !== 'string') errors.push(`critique.cameras[${i}].id: expected string`);
    else if (!isNum(cam.match_score) || cam.match_score < 0 || cam.match_score > 100) errors.push(`critique.cameras[${i}].match_score: expected 0..100`);
  });
  if (!Array.isArray(c.patch)) errors.push('critique.patch: expected array');
  else c.patch.forEach((op, i) => {
    const p = `critique.patch[${i}]`;
    if (!isObj(op) || !PATCH_OPS.includes(op.op)) return errors.push(`${p}.op: expected one of ${PATCH_OPS.join('|')}`);
    if (op.op === 'add' && !isObj(op.obstacle)) errors.push(`${p}.obstacle: expected object`);
    if (op.op !== 'add' && typeof op.id !== 'string') errors.push(`${p}.id: expected string`);
    if (op.op === 'update' && !isObj(op.set)) errors.push(`${p}.set: expected object`);
  });
  if (typeof c.done !== 'boolean') errors.push('critique.done: expected boolean');
  return result(errors);
}

// Merge `set` into an obstacle: nested objects (center, size, from, to,
// velocity) merge one level so a patch can move just `center.forward`.
function mergeObstacle(o, set) {
  const n = clone(o);
  for (const [k, v] of Object.entries(set)) {
    if (k === 'id') continue;
    if (v === null) delete n[k];
    else if (isObj(v) && isObj(n[k])) n[k] = { ...n[k], ...v };
    else n[k] = clone(v);
  }
  return n;
}

function nextObstacleId(obstacles) {
  let max = 0;
  for (const o of obstacles) {
    const m = /^o(\d+)$/.exec(o.id ?? '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `o${max + 1}`;
}

// Apply a Loop-1 patch in order. Invalid ops are skipped (never throw) and
// reported in `log` so the UI can show what Argon tried. Deterministic: same
// site + patch → same output. Does not touch `round`; the caller bumps it.
export function applyPatch(site, patch) {
  const out = normalizeSite(site);
  const log = [];
  for (const [i, op] of (Array.isArray(patch) ? patch : []).entries()) {
    const entry = { i, op: op?.op, id: op?.id, evidence: op?.evidence ?? '', applied: false, error: null };
    log.push(entry);
    if (!isObj(op) || !PATCH_OPS.includes(op.op)) { entry.error = 'unknown op'; continue; }
    if (op.op === 'add') {
      if (!isObj(op.obstacle)) { entry.error = 'missing obstacle'; continue; }
      const o = normalizeObstacle(op.obstacle);
      if (!o.id || out.obstacles.some((x) => x.id === o.id)) o.id = nextObstacleId(out.obstacles);
      const v = validateObstacle(o);
      if (!v.ok) { entry.error = v.errors.join('; '); continue; }
      out.obstacles.push(o);
      entry.id = o.id;
    } else {
      const idx = out.obstacles.findIndex((x) => x.id === op.id);
      if (idx < 0) { entry.error = `no obstacle "${op.id}"`; continue; }
      if (op.op === 'remove') out.obstacles.splice(idx, 1);
      else {
        if (!isObj(op.set)) { entry.error = 'missing set'; continue; }
        const o = normalizeObstacle(mergeObstacle(out.obstacles[idx], op.set));
        const v = validateObstacle(o);
        if (!v.ok) { entry.error = v.errors.join('; '); continue; }
        out.obstacles[idx] = o;
      }
    }
    entry.applied = true;
  }
  return { site: out, log };
}

// ---------------------------------------------------------------- agent result (§6.7)

export function validateAgentResult(r) {
  const errors = [];
  if (!isObj(r)) return result(['result: expected object']);
  if (!AGENT_VERDICTS.includes(r.verdict)) errors.push(`result.verdict: expected ${AGENT_VERDICTS.join('|')}`);
  if (!Array.isArray(r.rounds) || r.rounds.length < 1 || r.rounds.length > MAX_PLAN_ROUNDS) {
    errors.push(`result.rounds: expected 1..${MAX_PLAN_ROUNDS} rounds`);
  } else r.rounds.forEach((rd, i) => {
    const p = `result.rounds[${i}]`;
    if (!isObj(rd)) return errors.push(`${p}: expected object`);
    if (!Array.isArray(rd.candidates) || rd.candidates.length !== CANDIDATES_PER_ROUND) {
      errors.push(`${p}.candidates: expected exactly ${CANDIDATES_PER_ROUND}`);
    } else rd.candidates.forEach((c, j) => {
      if (!isObj(c) || typeof c.id !== 'string') errors.push(`${p}.candidates[${j}].id: expected string`);
      else if (!isObj(c.params)) errors.push(`${p}.candidates[${j}].params: expected object`);
    });
    if (!DECISIONS.includes(rd.decision)) errors.push(`${p}.decision: expected ${DECISIONS.join('|')}`);
    if (rd.decision === 'pick' && !rd.candidates?.some?.((c) => c?.id === rd.chosen_id)) errors.push(`${p}.chosen_id: not one of this round's candidates`);
  });
  if (r.verdict === 'SAFE' && typeof r.chosen_id !== 'string') errors.push('result.chosen_id: required when SAFE');
  if (r.verdict === 'REJECT' && typeof r.reject_reason !== 'string') errors.push('result.reject_reason: required when REJECT');
  return result(errors);
}

// ---------------------------------------------------------------- Gemini response schemas
// Subset of OpenAPI schema accepted by `response_format.schema`. Shape-specific
// fields are optional here; validateSite enforces them after parsing.

const VEC2 = { type: 'object', properties: { forward: { type: 'number' }, right: { type: 'number' } }, required: ['forward', 'right'] };
const VEC3 = { type: 'object', properties: { forward: { type: 'number' }, right: { type: 'number' }, up: { type: 'number' } }, required: ['forward', 'right', 'up'] };

const OBSTACLE_PROPS = {
  id: { type: 'string' },
  type: { type: 'string', enum: OBSTACLE_TYPES },
  label: { type: 'string' },
  shape: { type: 'string', enum: SHAPES },
  center: VEC2,
  base_up: { type: 'number' },
  size: { type: 'object', properties: { length: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['length', 'width', 'height'] },
  heading_deg: { type: 'number' },
  radius: { type: 'number' },
  height: { type: 'number' },
  from: VEC3,
  to: VEC3,
  velocity: VEC2,
  intent_notes: { type: 'string' },
  seen_in: { type: 'array', items: { type: 'string' } },
  confidence: { type: 'number' },
};

export const OBSTACLE_JSON_SCHEMA = {
  type: 'object',
  properties: OBSTACLE_PROPS,
  required: ['id', 'type', 'label', 'shape', 'seen_in', 'confidence'],
};

export const SITE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    schema: { type: 'string', enum: ['flyme.site/1'] },
    id: { type: 'string' },
    name: { type: 'string' },
    round: { type: 'integer' },
    surfaces: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, type: { type: 'string', enum: SURFACE_TYPES }, polygon: { type: 'array', items: VEC2 } },
        required: ['id', 'type', 'polygon'],
      },
    },
    obstacles: { type: 'array', items: OBSTACLE_JSON_SCHEMA },
    scale_refs: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['schema', 'id', 'name', 'surfaces', 'obstacles', 'scale_refs', 'notes'],
};

export const CRITIQUE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    cameras: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, match_score: { type: 'integer' }, issues: { type: 'array', items: { type: 'string' } } },
        required: ['id', 'match_score', 'issues'],
      },
    },
    patch: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: PATCH_OPS },
          id: { type: 'string' },
          obstacle: OBSTACLE_JSON_SCHEMA,
          set: { type: 'object', properties: OBSTACLE_PROPS },
          evidence: { type: 'string' },
        },
        required: ['op', 'evidence'],
      },
    },
    done: { type: 'boolean' },
  },
  required: ['cameras', 'patch', 'done'],
};

export const PARAMS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    target: VEC2,
    apex_height_m: { type: 'number' },
    duration_s: { type: 'number' },
    side_bow_m: { type: 'number' },
    climb_bias: { type: 'number' },
    horizontal_delay: { type: 'number' },
  },
  required: ['target', ...Object.keys(PARAM_BOUNDS)],
};
