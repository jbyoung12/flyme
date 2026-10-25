// Parallel route search + reachability map on a worker_threads pool, so the
// simulator can brute-force hundreds of routes in a few seconds.

import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { shapeGrid } from '../shared/search.js';

const SIZE = Math.max(2, Math.min(10, os.cpus().length - 1));
let workers = null;
let seq = 0;
const pending = new Map();

function pool() {
  if (workers) return workers;
  workers = Array.from({ length: SIZE }, () => {
    const w = new Worker(new URL('./search-worker.js', import.meta.url), { execArgv: [] });
    w.on('message', ({ id, out, error }) => {
      const p = pending.get(id);
      pending.delete(id);
      error ? p.reject(new Error(error)) : p.resolve(out);
    });
    return w;
  });
  return workers;
}

async function runChunks(kind, site, items, shapes) {
  const ws = pool();
  const chunks = Array.from({ length: ws.length }, () => []);
  items.forEach((it, i) => chunks[i % ws.length].push(it));
  const parts = await Promise.all(chunks.map((chunk, i) => chunk.length && new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws[i].postMessage({ id, kind, site, items: chunk, shapes });
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
