// worker_threads worker for search-pool.js: runs one chunk of simulations.
import { parentPort } from 'node:worker_threads';
import { simulate } from '../shared/physics.js';
import { prepareObstacles } from '../shared/geometry.js';
import { reachable, margins } from '../shared/search.js';

parentPort.on('message', ({ id, kind, site, items, shapes }) => {
  try {
    const preparedObstacles = prepareObstacles(site);
    const out = kind === 'routes'
      ? items.map((params) => { const sim = simulate(site, params, { preparedObstacles }); return { params: sim.params ?? params, sim, margins: margins(sim) }; })
      : items.map((target) => ({ target, ...reachable(site, target, shapes, preparedObstacles) }));
    parentPort.postMessage({ id, out });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
