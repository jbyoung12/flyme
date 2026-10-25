// Instant "where could I land" map from site.json alone (no flight sim): a
// cell is landable if the parked car would be ≥ 0.5 m from every obstacle,
// ≥ 5 m from every person, and within hop range. Whether a *route* exists is
// still decided by the simulator after the user taps.

import { SAFETY } from './constants.js';
import { prepareObstacles, carToObstacleClearance3D, carToPersonHorizontalDistance2D } from './geometry.js';

export const MAX_HOP_RANGE_M = 35; // empty-street limit at 500 m/s with the 25 kg reserve
export const MIN_HOP_RANGE_M = 5;

// Returns { step_m, cells: [{forward, right, ok, reason, obstacle_id}] }.
// Only obstacles near a cell are tested (bounding-radius cull) to stay fast.
export function landableMap(site, { step = 1.5, radius = MAX_HOP_RANGE_M } = {}) {
  const prepared = prepareObstacles(site).map((p, i) => {
    const o = site.obstacles[i];
    const pts = o.shape === 'wire' ? [o.from, o.to] : [o.center];
    const reach = o.shape === 'wire' ? Math.hypot(o.to.forward - o.from.forward, o.to.right - o.from.right) / 2
      : o.shape === 'box' ? Math.hypot(o.size.length, o.size.width) / 2 : o.radius ?? 0;
    const mid = o.shape === 'wire'
      ? { forward: (o.from.forward + o.to.forward) / 2, right: (o.from.right + o.to.right) / 2 }
      : o.center;
    return { p, o, mid, reach: reach + 3.5 + (o.velocity ? Math.hypot(o.velocity.forward, o.velocity.right) * 5 : 0), pts };
  });
  const cells = [];
  for (let f = -radius; f <= radius + 1e-9; f += step) {
    for (let r = -radius; r <= radius + 1e-9; r += step) {
      const d = Math.hypot(f, r);
      if (d > radius || d < MIN_HOP_RANGE_M) continue;
      const car = { forward: f, right: r, up: 0 };
      let reason = null, obstacle_id = null;
      for (const { p, o, mid, reach } of prepared) {
        if (Math.hypot(mid.forward - f, mid.right - r) > reach + (o.type === 'person' ? SAFETY.pedestrianKeepOutM : 0)) continue;
        if (o.type === 'person') {
          // Person at now and ~4 s later (typical touchdown time).
          if (Math.min(carToPersonHorizontalDistance2D(car, p, 0), carToPersonHorizontalDistance2D(car, p, 4)) < SAFETY.pedestrianKeepOutM) { reason = 'person'; obstacle_id = o.id; break; }
        } else if (carToObstacleClearance3D(car, p, o.velocity ? 4 : 0) < SAFETY.minClearanceM) { reason = 'obstacle'; obstacle_id = o.id; break; }
      }
      cells.push({ forward: +f.toFixed(2), right: +r.toFixed(2), ok: !reason, reason, obstacle_id });
    }
  }
  return { step_m: step, cells };
}
