// 3D collision & clearance geometry for flyme (PLAN.md §5, §6.1, §6.3).
// Zero dependencies: runs in Node 22 (Managed Agent sandbox), server, and browser.

import { CAR, SIM } from './constants.js';
import { normalizeSite } from './schema.js';

const HALF_L = CAR.length / 2;
const HALF_W = CAR.width / 2;
const HALF_H = CAR.height / 2;
const SPACING = SIM.sampleSpacingM; // 0.25 m

// Generate 1D grid coordinates from min to max with step <= spacing.
function grid1D(min, max, spacing = SPACING) {
  const span = max - min;
  if (span <= 0) return [min];
  const n = Math.max(1, Math.ceil(span / spacing));
  const out = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    out[i] = min + (span * i) / n;
  }
  return out;
}

// Generate deduplicated surface sample points on an axis-aligned box
// [minX, maxX] x [minY, maxY] x [minZ, maxZ].
function sampleBoxSurface(minX, maxX, minY, maxY, minZ, maxZ, spacing = SPACING) {
  const xs = grid1D(minX, maxX, spacing);
  const ys = grid1D(minY, maxY, spacing);
  const zs = grid1D(minZ, maxZ, spacing);
  const pts = [];
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const nz = zs.length - 1;

  for (let ix = 0; ix <= nx; ix++) {
    for (let iy = 0; iy <= ny; iy++) {
      for (let iz = 0; iz <= nz; iz++) {
        if (ix === 0 || ix === nx || iy === 0 || iy === ny || iz === 0 || iz === nz) {
          pts.push({ f: xs[ix], r: ys[iy], u: zs[iz] });
        }
      }
    }
  }
  return pts;
}

// Precompute car surface sample points relative to car origin (0, 0, 0) at bottom-center.
export const CAR_SURFACE_POINTS = sampleBoxSurface(-HALF_L, HALF_L, -HALF_W, HALF_W, 0, CAR.height, SPACING);

// Precompute sample points and fast parameters for a single normalized obstacle.
export function prepareObstacle(obs) {
  const vx = obs.velocity?.forward ?? 0;
  const vy = obs.velocity?.right ?? 0;
  const baseUp = obs.base_up ?? 0;

  if (obs.shape === 'box') {
    const length = obs.size.length;
    const width = obs.size.width;
    const height = obs.size.height;
    const hl = length / 2;
    const hw = width / 2;
    const hh = height / 2;
    const yawRad = ((obs.heading_deg ?? 0) * Math.PI) / 180;
    const cosY = Math.cos(yawRad);
    const sinY = Math.sin(yawRad);

    // Cap surface grid resolution on huge building boxes so precomputation stays fast,
    // while keeping spacing <= 0.25 m on normal street obstacles.
    const effSpacing = Math.max(SPACING, Math.max(length, width, height) / 40);
    const localPts = sampleBoxSurface(-hl, hl, -hw, hw, 0, height, effSpacing);
    const samplePoints = localPts.map((p) => ({
      f: obs.center.forward + p.f * cosY - p.r * sinY,
      r: obs.center.right + p.f * sinY + p.r * cosY,
      u: baseUp + p.u,
    }));

    return {
      raw: obs,
      id: obs.id,
      type: obs.type,
      label: obs.label ?? obs.type,
      shape: 'box',
      cf0: obs.center.forward,
      cr0: obs.center.right,
      cu0: baseUp + hh,
      baseUp,
      hl,
      hw,
      hh,
      cosY,
      sinY,
      vx,
      vy,
      boundRadius: Math.hypot(hl, hw, hh),
      sampleRadius: 0,
      samplePoints,
    };
  }

  if (obs.shape === 'cylinder') {
    const radius = obs.radius;
    const height = obs.height;
    const hh = height / 2;
    const samplePoints = [];

    const circumference = 2 * Math.PI * radius;
    const nTheta = Math.max(8, Math.ceil(circumference / SPACING));
    const us = grid1D(0, height, SPACING);

    // Side surface
    for (let iu = 0; iu < us.length; iu++) {
      const u = baseUp + us[iu];
      for (let it = 0; it < nTheta; it++) {
        const theta = (2 * Math.PI * it) / nTheta;
        samplePoints.push({
          f: obs.center.forward + radius * Math.cos(theta),
          r: obs.center.right + radius * Math.sin(theta),
          u,
        });
      }
    }

    // Top and bottom disks (interior rings + center)
    const nRad = Math.max(1, Math.ceil(radius / SPACING));
    for (const u of [baseUp, baseUp + height]) {
      samplePoints.push({ f: obs.center.forward, r: obs.center.right, u });
      for (let ir = 1; ir < nRad; ir++) {
        const rRing = (radius * ir) / nRad;
        const nRingTheta = Math.max(6, Math.ceil((2 * Math.PI * rRing) / SPACING));
        for (let it = 0; it < nRingTheta; it++) {
          const theta = (2 * Math.PI * it) / nRingTheta;
          samplePoints.push({
            f: obs.center.forward + rRing * Math.cos(theta),
            r: obs.center.right + rRing * Math.sin(theta),
            u,
          });
        }
      }
    }

    return {
      raw: obs,
      id: obs.id,
      type: obs.type,
      label: obs.label ?? obs.type,
      shape: 'cylinder',
      cf0: obs.center.forward,
      cr0: obs.center.right,
      cu0: baseUp + hh,
      baseUp,
      radius,
      height,
      hh,
      vx,
      vy,
      boundRadius: Math.hypot(radius, hh),
      sampleRadius: 0,
      samplePoints,
    };
  }

  if (obs.shape === 'wire') {
    const ax = obs.from.forward;
    const ay = obs.from.right;
    const az = obs.from.up;
    const bx = obs.to.forward;
    const by = obs.to.right;
    const bz = obs.to.up;
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    const lenSq = dx * dx + dy * dy + dz * dz;
    const nSeg = Math.max(1, Math.ceil(len / SPACING));
    const samplePoints = [];
    for (let i = 0; i <= nSeg; i++) {
      const s = i / nSeg;
      samplePoints.push({
        f: ax + dx * s,
        r: ay + dy * s,
        u: az + dz * s,
      });
    }

    return {
      raw: obs,
      id: obs.id,
      type: obs.type,
      label: obs.label ?? obs.type,
      shape: 'wire',
      ax,
      ay,
      az,
      bx,
      by,
      bz,
      dx,
      dy,
      dz,
      lenSq,
      cf0: 0.5 * (ax + bx),
      cr0: 0.5 * (ay + by),
      cu0: 0.5 * (az + bz),
      vx,
      vy,
      boundRadius: 0.5 * len + SIM.wireRadiusM,
      sampleRadius: SIM.wireRadiusM,
      samplePoints,
    };
  }

  throw new Error(`Unsupported obstacle shape: ${obs.shape}`);
}

// Precompute all obstacles in a site once.
export function prepareObstacles(site) {
  const norm = site?.schema === 'flyme.site/1' && Array.isArray(site.obstacles) ? site : normalizeSite(site ?? {});
  return (norm.obstacles ?? []).map(prepareObstacle);
}

// Exact signed distance from a 3D point (f, r, u) to the car box at carPos.
export function carBoxSignedDistance(f, r, u, carPos) {
  const qx = Math.abs(f - carPos.forward) - HALF_L;
  const qy = Math.abs(r - carPos.right) - HALF_W;
  const qz = Math.abs(u - (carPos.up + HALF_H)) - HALF_H;
  const ox = qx > 0 ? qx : 0;
  const oy = qy > 0 ? qy : 0;
  const oz = qz > 0 ? qz : 0;
  const outside = Math.sqrt(ox * ox + oy * oy + oz * oz);
  const m = qx > qy ? (qx > qz ? qx : qz) : (qy > qz ? qy : qz);
  const inside = m < 0 ? m : 0;
  return outside + inside;
}

// Exact signed distance from a 3D point (f, r, u) to a prepared obstacle at time t.
export function obstacleSignedDistance(f, r, u, prepObs, t = 0) {
  const offF = prepObs.vx * t;
  const offR = prepObs.vy * t;

  if (prepObs.shape === 'box') {
    const df = f - (prepObs.cf0 + offF);
    const dr = r - (prepObs.cr0 + offR);
    const localF = df * prepObs.cosY + dr * prepObs.sinY;
    const localR = -df * prepObs.sinY + dr * prepObs.cosY;
    const localU = u - prepObs.cu0;

    const qx = Math.abs(localF) - prepObs.hl;
    const qy = Math.abs(localR) - prepObs.hw;
    const qz = Math.abs(localU) - prepObs.hh;
    const ox = qx > 0 ? qx : 0;
    const oy = qy > 0 ? qy : 0;
    const oz = qz > 0 ? qz : 0;
    const outside = Math.sqrt(ox * ox + oy * oy + oz * oz);
    const m = qx > qy ? (qx > qz ? qx : qz) : (qy > qz ? qy : qz);
    const inside = m < 0 ? m : 0;
    return outside + inside;
  }

  if (prepObs.shape === 'cylinder') {
    const df = f - (prepObs.cf0 + offF);
    const dr = r - (prepObs.cr0 + offR);
    const dRad = Math.sqrt(df * df + dr * dr) - prepObs.radius;
    const dVert = Math.abs(u - prepObs.cu0) - prepObs.hh;
    const ox = dRad > 0 ? dRad : 0;
    const oy = dVert > 0 ? dVert : 0;
    const outside = Math.sqrt(ox * ox + oy * oy);
    const m = dRad > dVert ? dRad : dVert;
    const inside = m < 0 ? m : 0;
    return outside + inside;
  }

  // wire
  const ax = prepObs.ax + offF;
  const ay = prepObs.ay + offR;
  const az = prepObs.az;
  const apx = f - ax;
  const apy = r - ay;
  const apz = u - az;
  const s = prepObs.lenSq > 0
    ? Math.max(0, Math.min(1, (apx * prepObs.dx + apy * prepObs.dy + apz * prepObs.dz) / prepObs.lenSq))
    : 0;
  const dx = f - (ax + s * prepObs.dx);
  const dy = r - (ay + s * prepObs.dy);
  const dz = u - (az + s * prepObs.dz);
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - SIM.wireRadiusM;
}

// 3D clearance between the car at carPos and a prepared obstacle at time t (§5).
// Distance = min over (car surface sample points -> obstacle signed distance)
//            U (obstacle sample points -> car-box signed distance).
export function carToObstacleClearance3D(carPos, prepObs, t = 0) {
  const offF = prepObs.vx * t;
  const offR = prepObs.vy * t;

  let minDist = Infinity;

  // 1. Car surface sample points -> obstacle signed distance
  for (let i = 0; i < CAR_SURFACE_POINTS.length; i++) {
    const p = CAR_SURFACE_POINTS[i];
    const d = obstacleSignedDistance(carPos.forward + p.f, carPos.right + p.r, carPos.up + p.u, prepObs, t);
    if (d < minDist) minDist = d;
  }

  // 2. Obstacle sample points (translated by velocity * t) -> car-box signed distance
  const samplePts = prepObs.samplePoints;
  const rSub = prepObs.sampleRadius;
  for (let i = 0; i < samplePts.length; i++) {
    const q = samplePts[i];
    const d = carBoxSignedDistance(q.f + offF, q.r + offR, q.u, carPos) - rSub;
    if (d < minDist) minDist = d;
  }

  return minDist;
}

// 2D horizontal distance from the car footprint to a person obstacle at time t (§5).
export function carToPersonHorizontalDistance2D(carPos, prepObs, t = 0) {
  const cf = prepObs.cf0 + prepObs.vx * t;
  const cr = prepObs.cr0 + prepObs.vy * t;

  if (prepObs.shape === 'cylinder') {
    const dx = Math.max(0, Math.abs(cf - carPos.forward) - HALF_L);
    const dy = Math.max(0, Math.abs(cr - carPos.right) - HALF_W);
    const inside = Math.min(Math.max(Math.abs(cf - carPos.forward) - HALF_L, Math.abs(cr - carPos.right) - HALF_W), 0);
    return (dx > 0 || dy > 0 ? Math.hypot(dx, dy) : inside) - prepObs.radius;
  }

  // Fallback if a person obstacle was ever modeled as a box
  let minD = Infinity;
  for (let i = 0; i < CAR_SURFACE_POINTS.length; i++) {
    const p = CAR_SURFACE_POINTS[i];
    if (p.u !== 0) continue;
    const df = carPos.forward + p.f - cf;
    const dr = carPos.right + p.r - cr;
    const lf = df * prepObs.cosY + dr * prepObs.sinY;
    const lr = -df * prepObs.sinY + dr * prepObs.cosY;
    const qx = Math.abs(lf) - prepObs.hl;
    const qy = Math.abs(lr) - prepObs.hw;
    const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
    if (d < minD) minD = d;
  }
  return minD;
}
