// Parallel route search + reachability map on a worker_threads pool, so the
// simulator can brute-force hundreds of routes in a few seconds.

import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { shapeGrid } from '../shared/search.js';

const SIZE = Math.max(2, Math.min(10, os.cpus().length - 1));
let workers = null;
let seq = 0;
const pending = new Map();

function spawnWorker(slot) {
  const w = new Worker(new URL('./search-worker.js', import.meta.url), { execArgv: [] });
  w.on('message', ({ id, out, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    error ? p.reject(new Error(error)) : p.resolve(out);
  });
  const failWorker = (err) => {
    for (const [id, p] of pending.entries()) {
      if (p.worker === w) {
        pending.delete(id);
        p.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    if (workers && workers[slot] === w) workers[slot] = spawnWorker(slot);
  };
  w.on('error', failWorker);
  w.on('exit', (code) => { if (code !== 0) failWorker(new Error(`search worker exited with code ${code}`)); });
  return w;
}

function pool() {
  if (workers) return workers;
  workers = Array.from({ length: SIZE }, (_, i) => spawnWorker(i));
  return workers;
}

async function runChunks(kind, site, items, shapes) {
  const ws = pool();
  const chunks = Array.from({ length: ws.length }, () => []);
  items.forEach((it, i) => chunks[i % ws.length].push(it));
  const parts = await Promise.all(chunks.map((chunk, i) => chunk.length && new Promise((resolve, reject) => {
    const id = ++seq;
    const w = ws[i];
    pending.set(id, { resolve, reject, worker: w });
    w.postMessage({ id, kind, site, items: chunk, shapes });
  })));
  return parts.filter(Boolean).flat();
}

// All shapes to one target → { safe, near, tried } (same shape as searchRoutes).
export async function searchRoutesParallel(site, target) {
  const all = await runChunks('routes', site, shapeGrid().map((s) => ({ target, ...s })));
  const safe = all.filter((e) => e.sim.verdict === 'SAFE');
  const near = all.filter((e) => e.sim.verdict !== 'SAFE')
    .sort((a, b) => a.sim.failures.length - b.sim.failures.length || b.margins.air_remaining_kg - a.margins.air_remaining_kg)
    .slice(0, 8);
  return { safe, near, tried: all.length };
}

// Local refinement: coarse grids miss the best routes (agent mode found 1.00 m
// clearance where the grid's best was 0.69 m). Hill-climb from the top SAFE
// routes with small parameter nudges, keeping SAFE results only.
const NUDGES = { apex_height_m: 0.6, duration_s: 0.3, side_bow_m: 1.5, climb_bias: 0.06, horizontal_delay: 0.05, vertical_drop: 0.08 };
const BOUNDS = { apex_height_m: [0.5, 20], duration_s: [1, 8], side_bow_m: [-15, 15], climb_bias: [0.25, 0.75], horizontal_delay: [0, 0.4], vertical_drop: [0, 0.4] };
export const routeScore = (m) => Math.min(m.min_clearance_m ?? 0, 2) + 0.01 * (m.air_remaining_kg ?? 0) + 0.05 * Math.min(Math.max((m.min_person_m ?? 99) - 5, 0), 5);

export async function refineSafe(site, safe, { seeds = 3, iters = 3 } = {}) {
  const all = [...safe];
  const key = (p) => Object.keys(NUDGES).map((k) => (+p[k]).toFixed(3)).join('|');
  const seen = new Set(all.map((e) => key(e.params)));
  let frontier = [...safe].sort((a, b) => routeScore(b.margins) - routeScore(a.margins)).slice(0, seeds);
  for (let it = 0; it < iters && frontier.length; it++) {
    const cand = [];
    for (const e of frontier) for (const [k, d] of Object.entries(NUDGES)) for (const sgn of [-1, 1]) {
      const p = { ...e.params, [k]: Math.min(BOUNDS[k][1], Math.max(BOUNDS[k][0], +(e.params[k] + sgn * d).toFixed(3))) };
      const kk = key(p);
      if (!seen.has(kk)) { seen.add(kk); cand.push(p); }
    }
    const res = (await simulateMany(site, cand)).filter((e) => e.sim.verdict === 'SAFE');
    all.push(...res);
    const best = Math.max(...frontier.map((e) => routeScore(e.margins)));
    frontier = res.filter((e) => routeScore(e.margins) > best - 1e-6).sort((a, b) => routeScore(b.margins) - routeScore(a.margins)).slice(0, seeds);
  }
  return all;
}

// Simulate explicit params in parallel → [{params, sim, margins}].
export function simulateMany(site, paramsList) {
  return runChunks('routes', site, paramsList);
}

// Early-exit reachability for a handful of landing spots (snap search).
export function reachCells(site, targets, shapes = shapeGrid({ full: false })) {
  return runChunks('reach', site, targets, shapes);
}

// Reachability map: grid of landing spots (car frame) → [{target, safe, ...}].
export const REACH_STEP_M = 3;
export const REACH_RADIUS_M = 33;
export async function reachMap(site) {
  const cells = [];
  for (let f = -REACH_RADIUS_M; f <= REACH_RADIUS_M; f += REACH_STEP_M) {
    for (let r = -REACH_RADIUS_M; r <= REACH_RADIUS_M; r += REACH_STEP_M) {
      const d = Math.hypot(f, r);
      if (d >= 8 && d <= REACH_RADIUS_M) cells.push({ forward: f, right: r });
    }
  }
  const shapes = shapeGrid({ full: false }).filter((s) => s.vertical_drop === 0 && s.climb_bias === 0.45);
  return { step_m: REACH_STEP_M, cells: await runChunks('reach', site, cells, shapes) };
}
