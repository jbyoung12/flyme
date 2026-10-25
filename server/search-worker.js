// worker_threads worker for search-pool.js: runs one chunk of simulations.
import { parentPort } from 'node:worker_threads';
import { simulate } from '../shared/physics.js';
import { reachable, margins } from '../shared/search.js';

parentPort.on('message', ({ id, kind, site, items, shapes }) => {
  try {
    const out = kind === 'routes'
      ? items.map((params) => { const sim = simulate(site, params); return { params: sim.params ?? params, sim, margins: margins(sim) }; })
      : items.map((target) => ({ target, ...reachable(site, target, shapes) }));
    parentPort.postMessage({ id, out });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
