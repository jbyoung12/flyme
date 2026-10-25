// Deterministic flight dynamics & reference trajectory simulator (PLAN.md §5, §6.5).
// Zero dependencies: runs in Node 22 (Managed Agent sandbox), server, and browser.

import { G, CAR, SIM, DRAG } from './constants.js';
import { clampParams, normalizeSite } from './schema.js';
import { prepareObstacles, carToObstacleClearance3D } from './geometry.js';
import { runChecks } from './checks.js';

const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

// Minimum-jerk quintic polynomial q(x) = 10x³ − 15x⁴ + 6x⁵ on [0, 1].
function quintic(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const x3 = x * x * x;
  return x3 * (10 - 15 * x + 6 * x * x);
}

// Evaluate the [0, T] curve smoothly for τ = t / T (used for central differences on t <= T).
function curvePosAtTau(tau, params, hHat, nHat) {
  const tauClamped = Math.max(0, Math.min(1, tau));
  const d = params.horizontal_delay;
  // vertical_drop: the last fraction of the flight is a pure vertical descent
  // (sideways motion and bow finish first), e.g. over a wire and straight down.
  const e = params.vertical_drop ?? 0;
  const hEnd = 1 - e;
  const s = tauClamped <= d ? 0 : quintic((tauClamped - d) / (hEnd - d));

  const sigma = Math.min(1, tauClamped / hEnd);
  const omSigma = 1 - sigma;
  const bow = params.side_bow_m * 64 * (sigma * sigma * sigma) * (omSigma * omSigma * omSigma);
  const omTau = 1 - tauClamped;

  const forward = s * params.target.forward + bow * nHat.forward;
  const right = s * params.target.right + bow * nHat.right;

  const p = params.climb_bias;
  const num = (1 - p) * tauClamped;
  const den = num + p * omTau;
  const tauTilde = den > 0 ? num / den : 0;
  const omTilde = 1 - tauTilde;
  const up = params.apex_height_m * 16 * (tauTilde * tauTilde) * (omTilde * omTilde);

  return { forward, right, up };
}

function targetBasis(target) {
  const dist = Math.hypot(target.forward, target.right);
  const hHat = dist > 1e-9
    ? { forward: target.forward / dist, right: target.right / dist }
    : { forward: 1, right: 0 };
  // Right-perpendicular n̂ = (−ĥ.right, ĥ.forward) (§5)
  const nHat = { forward: -hHat.right, right: hHat.forward };
  return { hHat, nHat };
}

/**
 * Analytic reference position at time t (s) for given flight params (§5).
 */
export function refPosition(t, params) {
  const T = params.duration_s;
  if (t > T) {
    return {
      forward: params.target.forward,
      right: params.target.right,
      up: -SIM.settleRateMs * (t - T),
    };
  }
  const { hHat, nHat } = targetBasis(params.target);
  return curvePosAtTau(t / T, params, hHat, nHat);
}

/**
 * Reference position, velocity, and acceleration at time t (s) using central
 * differences with h = SIM.refDiffH (1e-4 s) (§5).
 */
export function refState(t, params, basis) {
  const T = params.duration_s;
  if (t > T) {
    return {
      pos: {
        forward: params.target.forward,
        right: params.target.right,
        up: -SIM.settleRateMs * (t - T),
      },
      vel: { forward: 0, right: 0, up: -SIM.settleRateMs },
      acc: { forward: 0, right: 0, up: 0 },
    };
  }

  const { hHat, nHat } = basis ?? targetBasis(params.target);
  const h = SIM.refDiffH;
  const p0 = curvePosAtTau(t / T, params, hHat, nHat);
  const pMinus = curvePosAtTau((t - h) / T, params, hHat, nHat);
  const pPlus = curvePosAtTau((t + h) / T, params, hHat, nHat);
  const inv2h = 1 / (2 * h);
  const invH2 = 1 / (h * h);

  return {
    pos: p0,
    vel: {
      forward: (pPlus.forward - pMinus.forward) * inv2h,
      right: (pPlus.right - pMinus.right) * inv2h,
      up: (pPlus.up - pMinus.up) * inv2h,
    },
    acc: {
      forward: (pPlus.forward - 2 * p0.forward + pMinus.forward) * invH2,
      right: (pPlus.right - 2 * p0.right + pMinus.right) * invH2,
      up: (pPlus.up - 2 * p0.up + pMinus.up) * invH2,
    },
  };
}

function minClearanceAt(carPos, preparedObstacles, t) {
  if (preparedObstacles.length === 0) return 99.9;
  let minC = Infinity;
  for (let i = 0; i < preparedObstacles.length; i++) {
    const c = carToObstacleClearance3D(carPos, preparedObstacles[i], t);
    if (c < minC) minC = c;
  }
  return minC;
}

function isNearAnyObstacle(carPos, preparedObstacles, t) {
  const carBound = 2.6; // ~half-diagonal of car + margin
  for (let i = 0; i < preparedObstacles.length; i++) {
    const o = preparedObstacles[i];
    const cf = o.cf0 + o.vx * t;
    const cr = o.cr0 + o.vy * t;
    const d = Math.hypot(carPos.forward - cf, carPos.right - cr, carPos.up + CAR.height / 2 - o.cu0);
    if (d <= o.boundRadius + carBound + 1.0) return true;
  }
  return false;
}

/**
 * Run deterministic 3D flight simulation and safety checks (§5, §6.5).
 * @param {object} site - site.json object
 * @param {object} rawParams - flight params (§6.4)
 * @param {object} [opts] - options ({ drag: boolean, preparedObstacles: Array })
 * @returns {object} SimResult (§6.5)
 */
export function simulate(site, rawParams, opts = {}) {
  const normSite = site?.schema === 'flyme.site/1' ? site : normalizeSite(site ?? {});
  const { params, violations, errors } = clampParams(rawParams);
  if (errors.length > 0) {
    throw new Error(`Invalid flight params: ${errors.join('; ')}`);
  }

  const dragEnabled = opts.drag !== false;
  const preparedObstacles = opts.preparedObstacles ?? prepareObstacles(normSite);
  const basis = targetBasis(params.target);

  const T = params.duration_s;
  const dt = SIM.dt;
  const maxTime = T + SIM.hardCapExtraS;
  const sampleStepInterval = Math.max(1, Math.round(SIM.sampleEvery / dt)); // 5 steps = 0.05 s

  const pos = { forward: 0, right: 0, up: 0 };
  const vel = { forward: 0, right: 0, up: 0 };
  let air = CAR.airKg;
  let step = 0;
  let t = 0;
  let liftedOff = false;

  let peakThrustKN = 0;
  let peakUpM = 0;
  let peakDragN = 0;
  let satError = { maxError: 0, t: 0 };

  const samples = [];
  const evalFrames = [];

  const kh = 0.5 * DRAG.rho * DRAG.cd * DRAG.areaHorizontal;
  const kv = 0.5 * DRAG.rho * DRAG.cd * DRAG.areaVertical;

  let touchdown = null;

  while (t <= maxTime + 1e-9) {
    const ref = refState(t, params, basis);
    const trackingErr = Math.hypot(
      ref.pos.forward - pos.forward,
      ref.pos.right - pos.right,
      ref.pos.up - pos.up,
    );

    const aCmdF = ref.acc.forward + SIM.kp * (ref.pos.forward - pos.forward) + SIM.kd * (ref.vel.forward - vel.forward);
    const aCmdR = ref.acc.right + SIM.kp * (ref.pos.right - pos.right) + SIM.kd * (ref.vel.right - vel.right);
    const aCmdU = ref.acc.up + SIM.kp * (ref.pos.up - pos.up) + SIM.kd * (ref.vel.up - vel.up);

    const m = CAR.dryMassKg + air;
    const reqF = m * aCmdF;
    const reqR = m * aCmdR;
    const reqU = m * (aCmdU + G);

    // Thrust clamping (§5):
    // 1. T_req.up >= 0 (no downward thrust)
    // 2. horizontal component <= 40 kN (scale horizontal only)
    // 3. ||T|| <= 80 kN (scale vector)
    // 4. If air <= 0 -> T = 0 (ballistic)
    let tf = reqF;
    let tr = reqR;
    let tu = Math.max(0, reqU);
    const normAfterUpClamp = Math.hypot(tf, tr, tu);

    if (air <= 0) {
      tf = 0;
      tr = 0;
      tu = 0;
    } else {
      const th = Math.hypot(tf, tr);
      if (th > CAR.maxHorizontalThrustN) {
        const s = CAR.maxHorizontalThrustN / th;
        tf *= s;
        tr *= s;
      }
      const tMag0 = Math.hypot(tf, tr, tu);
      if (tMag0 > CAR.maxThrustN) {
        const s = CAR.maxThrustN / tMag0;
        tf *= s;
        tr *= s;
        tu *= s;
      }
    }

    const tMag = Math.hypot(tf, tr, tu);
    const saturated =
      normAfterUpClamp > 0 &&
      (normAfterUpClamp - tMag) / normAfterUpClamp > SIM.saturationTol;
    if (saturated && trackingErr > satError.maxError) {
      satError = { maxError: trackingErr, t };
    }

    const thrustKN = tMag / 1000;
    if (thrustKN > peakThrustKN) peakThrustKN = thrustKN;
    if (pos.up > peakUpM) peakUpM = pos.up;

    const dragF = dragEnabled ? -kh * Math.abs(vel.forward) * vel.forward : 0;
    const dragR = dragEnabled ? -kh * Math.abs(vel.right) * vel.right : 0;
    const dragU = dragEnabled ? -kv * Math.abs(vel.up) * vel.up : 0;
    const dragMag = Math.hypot(dragF, dragR, dragU);
    if (dragMag > peakDragN) peakDragN = dragMag;

    // Emit sample every 0.05 s
    if (step % sampleStepInterval === 0) {
      const clr = minClearanceAt(pos, preparedObstacles, t);
      samples.push({
        t: round2(t),
        forward: round3(pos.forward),
        right: round3(pos.right),
        up: round3(pos.up),
        thrust_kN: round2(thrustKN),
        air_kg: round2(air),
        clearance_m: round2(clr),
      });
      evalFrames.push({ t, forward: pos.forward, right: pos.right, up: pos.up });
    } else if (isNearAnyObstacle(pos, preparedObstacles, t)) {
      evalFrames.push({ t, forward: pos.forward, right: pos.right, up: pos.up });
    }

    // Semi-implicit Euler step
    const accF = (tf + dragF) / m;
    const accR = (tr + dragR) / m;
    const accU = (tu + dragU) / m - G;

    vel.forward += accF * dt;
    vel.right += accR * dt;
    vel.up += accU * dt;

    pos.forward += vel.forward * dt;
    pos.right += vel.right * dt;
    pos.up += vel.up * dt;

    air = Math.max(0, air - (tMag / CAR.exhaustVelocityMs) * dt);
    step += 1;
    t = Math.round(step * dt * 1e6) / 1e6;

    if (pos.up > SIM.touchdownEpsM) liftedOff = true;

    // Before liftoff: clamp up >= 0 (§5)
    if (!liftedOff && t <= SIM.touchdownMinT && pos.up < 0) {
      pos.up = 0;
      if (vel.up < 0) vel.up = 0;
    }

    if (pos.up > peakUpM) peakUpM = pos.up;

    // Touchdown condition (§5):
    // (t >= 0.85 * T and up <= 0.02 m) or (t > 0.2 s and up <= 0)
    const hitGround =
      (t >= SIM.touchdownMinFrac * T && pos.up <= SIM.touchdownEpsM) ||
      (t > SIM.touchdownMinT && pos.up <= 0);

    if (hitGround || t >= maxTime - 1e-9) {
      if (hitGround) pos.up = 0;
      const vVertical = Math.abs(vel.up);
      const vHorizontal = Math.hypot(vel.forward, vel.right);
      const missM = Math.hypot(pos.forward - params.target.forward, pos.right - params.target.right);

      touchdown = {
        t: round2(t),
        forward: round2(pos.forward),
        right: round2(pos.right),
        v_vertical: round2(vVertical),
        v_horizontal: round2(vHorizontal),
        miss_m: round2(missM),
      };

      const finalClr = minClearanceAt(pos, preparedObstacles, t);
      if (samples.at(-1)?.t !== round2(t)) {
        samples.push({
          t: round2(t),
          forward: round3(pos.forward),
          right: round3(pos.right),
          up: round3(pos.up),
          thrust_kN: round2(thrustKN),
          air_kg: round2(air),
          clearance_m: round2(finalClr),
        });
      }
      evalFrames.push({ t, forward: pos.forward, right: pos.right, up: pos.up });
      break;
    }
  }

  const airUsed = CAR.airKg - air;
  const airSummary = {
    start_kg: CAR.airKg,
    used_kg: round2(airUsed),
    remaining_kg: round2(air),
  };

  const peakSummary = {
    thrust_kN: round2(peakThrustKN),
    up_m: round2(peakUpM),
    drag_N: round2(peakDragN),
  };

  const simTrace = {
    touchdown,
    air: airSummary,
    peak: peakSummary,
    samples,
    _evalFrames: evalFrames,
    _satError: satError,
  };

  const checks = runChecks(normSite, simTrace, preparedObstacles);
  const failures = checks.filter((c) => !c.pass).map((c) => c.id);
  const verdict = failures.length === 0 ? 'SAFE' : 'UNSAFE';

  const clrCheck = checks.find((c) => c.id === 'clearance');
  const margins = {
    min_clearance_m: clrCheck ? clrCheck.value : 99.9,
    air_remaining_kg: airSummary.remaining_kg,
    touchdown_v_ms: touchdown.v_vertical,
  };

  const result = {
    schema: 'flyme.sim/1',
    params,
    verdict,
    failures,
    checks,
    touchdown,
    air: airSummary,
    peak: peakSummary,
    margins,
    samples,
  };

  if (violations.length > 0) {
    result.param_violations = violations;
  }

  return result;
}
