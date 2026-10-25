// Safety checks for flyme flight traces (PLAN.md §5, §6.5).
// Zero dependencies: runs in Node 22 (Managed Agent sandbox), server, and browser.

import { CAR, SAFETY, SIM, CHECKS } from './constants.js';
import {
  prepareObstacles,
  carToObstacleClearance3D,
  carToPersonHorizontalDistance2D,
} from './geometry.js';

const round2 = (n) => Math.round(n * 100) / 100;
const CAR_HALF_H = CAR.height / 2;
const CAR_BOUND_RADIUS = Math.hypot(CAR.length / 2, CAR.width / 2, CAR_HALF_H);

const CHECK_LABELS = Object.fromEntries(CHECKS.map((c) => [c.id, c.label]));

/**
 * Evaluate all 9 contract safety checks on a simulation trace.
 * @param {object} site - site.json object
 * @param {object} simTrace - SimResult or internal trace from simulate()
 * @param {Array} [preparedObs] - optional precomputed obstacles from prepareObstacles(site)
 * @returns {Array} checks array in contract order
 */
export function runChecks(site, simTrace, preparedObs) {
  const obstacles = preparedObs ?? prepareObstacles(site);
  const frames = simTrace._evalFrames ?? simTrace.samples ?? [];
  const touchdown = simTrace.touchdown ?? {
    t: frames.at(-1)?.t ?? 0,
    forward: frames.at(-1)?.forward ?? 0,
    right: frames.at(-1)?.right ?? 0,
    v_vertical: 0,
    v_horizontal: 0,
    miss_m: 0,
  };
  const air = simTrace.air ?? {
    start_kg: 250,
    used_kg: 250 - (frames.at(-1)?.air_kg ?? 0),
    remaining_kg: frames.at(-1)?.air_kg ?? 0,
  };
  const satError = simTrace._satError ?? { maxError: 0, t: 0 };

  // Track worst values across the trajectory for collision, clearance, and pedestrian
  let minCollision = { val: Infinity, t: 0, obs: null };
  let minClearance = { val: Infinity, t: 0, obs: null };
  let minPedestrian = { val: Infinity, t: 0, obs: null };

  for (let io = 0; io < obstacles.length; io++) {
    const obs = obstacles[io];
    const isPerson = obs.type === 'person';

    // Initial state at t = 0 for takeoff grace (§5)
    const p0Pos = frames[0]
      ? { forward: frames[0].forward, right: frames[0].right, up: frames[0].up }
      : { forward: 0, right: 0, up: 0 };
    const c0 = carToObstacleClearance3D(p0Pos, obs, 0);
    const overlapAtStart = c0 <= 0;
    const graceClearanceAtStart = c0 > 0 && c0 < SAFETY.minClearanceM;

    const ped0 = isPerson ? carToPersonHorizontalDistance2D(p0Pos, obs, 0) : Infinity;
    const gracePedAtStart = isPerson && ped0 > 0 && ped0 < SAFETY.pedestrianKeepOutM;

    let maxCSoFar = c0;
    let graceClearanceActive = graceClearanceAtStart;
    let maxPedSoFar = ped0;
    let gracePedActive = gracePedAtStart;

    for (let k = 0; k < frames.length; k++) {
      const fr = frames[k];
      const t = fr.t;

      // If an obstacle already overlaps at t = 0, ignore it for t < 0.5 s (§5)
      if (overlapAtStart && t < SIM.overlapIgnoreS) {
        continue;
      }

      const carPos = { forward: fr.forward, right: fr.right, up: fr.up };

      // 3. Pedestrian check (horizontal distance >= 5 m, with takeoff grace if 0 < p(0) < 5 m)
      if (isPerson) {
        const pDist = carToPersonHorizontalDistance2D(carPos, obs, t);
        if (gracePedActive) {
          if (pDist >= maxPedSoFar - 1e-4 && pDist < SAFETY.pedestrianKeepOutM) { // grace lasts while they only get farther away
            maxPedSoFar = Math.max(maxPedSoFar, pDist);
          } else {
            gracePedActive = false;
          }
        }
        if (!gracePedActive && pDist < minPedestrian.val) {
          minPedestrian = { val: pDist, t, obs };
        }
      }

      // Fast triangle-inequality lower bound cull before 3D surface sampling
      if (!graceClearanceActive) {
        const dLower =
          Math.hypot(carPos.forward - (obs.cf0 + obs.vx * t), carPos.right - (obs.cr0 + obs.vy * t), carPos.up + CAR_HALF_H - obs.cu0) -
          obs.boundRadius -
          CAR_BOUND_RADIUS;
        if (dLower >= minCollision.val && (isPerson || dLower >= minClearance.val)) {
          continue;
        }
      }

      const c = carToObstacleClearance3D(carPos, obs, t);

      // 1. Collision check (applies to all obstacles including people)
      if (c < minCollision.val) {
        minCollision = { val: c, t, obs };
      }

      // 2. Clearance check (excludes people; applies takeoff grace when 0 < c(0) < 0.5 m)
      if (!isPerson) {
        if (graceClearanceActive) {
          if (t < SIM.takeoffGraceS && c >= maxCSoFar - 1e-4 && c < SAFETY.minClearanceM) {
            maxCSoFar = Math.max(maxCSoFar, c);
          } else {
            graceClearanceActive = false;
          }
        }
        if (!graceClearanceActive && c < minClearance.val) {
          minClearance = { val: c, t, obs };
        }
      }
    }
  }

  // Final-pose landing zone clearance at t = touchdown.t
  const finalPos = { forward: touchdown.forward, right: touchdown.right, up: 0 };
  let minLandingZone = { val: Infinity, t: touchdown.t, obs: null };
  for (let io = 0; io < obstacles.length; io++) {
    const obs = obstacles[io];
    const c = carToObstacleClearance3D(finalPos, obs, touchdown.t);
    if (c < minLandingZone.val) {
      minLandingZone = { val: c, t: touchdown.t, obs };
    }
  }

  const colVal = Number.isFinite(minCollision.val) ? round2(minCollision.val) : 99.9;
  const colPass = !Number.isFinite(minCollision.val) || minCollision.val > 0;

  const clrVal = Number.isFinite(minClearance.val) ? round2(minClearance.val) : 99.9;
  const clrPass = !Number.isFinite(minClearance.val) || minClearance.val >= SAFETY.minClearanceM;

  const pedVal = Number.isFinite(minPedestrian.val) ? round2(minPedestrian.val) : 99.9;
  const pedPass = !Number.isFinite(minPedestrian.val) || minPedestrian.val >= SAFETY.pedestrianKeepOutM;

  const satVal = round2(satError.maxError ?? 0);
  const satPass = (satError.maxError ?? 0) <= SIM.trackingErrorM;

  const tdVertVal = round2(touchdown.v_vertical);
  const tdVertPass = touchdown.v_vertical < SAFETY.maxTouchdownVerticalMs;

  const tdHorizVal = round2(touchdown.v_horizontal);
  const tdHorizPass = touchdown.v_horizontal < SAFETY.maxTouchdownHorizontalMs;

  const missVal = round2(touchdown.miss_m);
  const missPass = touchdown.miss_m <= SAFETY.landingToleranceM;

  const airVal = round2(air.remaining_kg);
  const airPass = air.remaining_kg >= SAFETY.airReserveKg;

  const lzVal = Number.isFinite(minLandingZone.val) ? round2(minLandingZone.val) : 99.9;
  const lzPass = !Number.isFinite(minLandingZone.val) || minLandingZone.val >= SAFETY.minClearanceM;

  return [
    {
      id: 'collision',
      label: CHECK_LABELS.collision,
      pass: colPass,
      value: colVal,
      limit: 0,
      unit: 'm',
      t: round2(minCollision.t),
      obstacle_id: minCollision.obs?.id ?? null,
      message: minCollision.obs
        ? `${colPass ? 'Min distance' : 'Collision'} ${colVal.toFixed(2)} m ${colPass ? 'from' : 'with'} ${minCollision.obs.label} (${minCollision.obs.id}) at t=${minCollision.t.toFixed(2)} s`
        : 'No obstacles near path',
    },
    {
      id: 'clearance',
      label: CHECK_LABELS.clearance,
      pass: clrPass,
      value: clrVal,
      limit: SAFETY.minClearanceM,
      unit: 'm',
      t: round2(minClearance.t),
      obstacle_id: minClearance.obs?.id ?? null,
      message: minClearance.obs
        ? `${clrVal.toFixed(2)} m from ${minClearance.obs.label} (${minClearance.obs.id}) at t=${minClearance.t.toFixed(2)} s`
        : 'Clearance >= 0.5 m everywhere',
    },
    {
      id: 'pedestrian',
      label: CHECK_LABELS.pedestrian,
      pass: pedPass,
      value: pedVal,
      limit: SAFETY.pedestrianKeepOutM,
      unit: 'm',
      t: round2(minPedestrian.t),
      obstacle_id: minPedestrian.obs?.id ?? null,
      message: minPedestrian.obs
        ? `${pedVal.toFixed(2)} m horizontal to ${minPedestrian.obs.label} (${minPedestrian.obs.id}) at t=${minPedestrian.t.toFixed(2)} s`
        : 'No pedestrians within keep-out radius',
    },
    {
      id: 'thrust_limit',
      label: CHECK_LABELS.thrust_limit,
      pass: satPass,
      value: satVal,
      limit: SIM.trackingErrorM,
      unit: 'm',
      t: round2(satError.t ?? 0),
      obstacle_id: null,
      message: satPass
        ? `Max saturated tracking error ${satVal.toFixed(2)} m <= ${SIM.trackingErrorM} m`
        : `Thrust saturated with ${satVal.toFixed(2)} m tracking error at t=${(satError.t ?? 0).toFixed(2)} s`,
    },
    {
      id: 'touchdown_vertical',
      label: CHECK_LABELS.touchdown_vertical,
      pass: tdVertPass,
      value: tdVertVal,
      limit: SAFETY.maxTouchdownVerticalMs,
      unit: 'm/s',
      t: round2(touchdown.t),
      obstacle_id: null,
      message: `Touchdown vertical ${tdVertVal.toFixed(2)} m/s (limit < ${SAFETY.maxTouchdownVerticalMs} m/s)`,
    },
    {
      id: 'touchdown_horizontal',
      label: CHECK_LABELS.touchdown_horizontal,
      pass: tdHorizPass,
      value: tdHorizVal,
      limit: SAFETY.maxTouchdownHorizontalMs,
      unit: 'm/s',
      t: round2(touchdown.t),
      obstacle_id: null,
      message: `Touchdown horizontal ${tdHorizVal.toFixed(2)} m/s (limit < ${SAFETY.maxTouchdownHorizontalMs} m/s)`,
    },
    {
      id: 'landing_accuracy',
      label: CHECK_LABELS.landing_accuracy,
      pass: missPass,
      value: missVal,
      limit: SAFETY.landingToleranceM,
      unit: 'm',
      t: round2(touchdown.t),
      obstacle_id: null,
      message: `Landed ${missVal.toFixed(2)} m from target (limit <= ${SAFETY.landingToleranceM} m)`,
    },
    {
      id: 'air_reserve',
      label: CHECK_LABELS.air_reserve,
      pass: airPass,
      value: airVal,
      limit: SAFETY.airReserveKg,
      unit: 'kg',
      t: round2(touchdown.t),
      obstacle_id: null,
      message: `${airVal.toFixed(1)} kg air remaining (reserve >= ${SAFETY.airReserveKg} kg)`,
    },
    {
      id: 'landing_zone',
      label: CHECK_LABELS.landing_zone,
      pass: lzPass,
      value: lzVal,
      limit: SAFETY.minClearanceM,
      unit: 'm',
      t: round2(touchdown.t),
      obstacle_id: minLandingZone.obs?.id ?? null,
      message: minLandingZone.obs
        ? `Landing pose ${lzVal.toFixed(2)} m from ${minLandingZone.obs.label} (${minLandingZone.obs.id})`
        : 'Landing zone clear',
    },
  ];
}
