// Deterministic monocular ranging. Argon is good at "where in the image does
// this object touch the ground" and unreliable at turning that into metres,
// so it reports an `anchor` {camera, x, y} (normalized keyframe coordinates of
// the ground-contact point nearest the camera) plus each keyframe's horizon
// line, and this module intersects that pixel ray with the ground plane.

const RAD = Math.PI / 180;
const MAX_RANGE_M = 40; // beyond this the ground-plane ray is too flat to trust
const MIN_BELOW_HORIZON = 0.035; // closer to the horizon (≳ 25 m) a 0.01 pixel error is metres
const MAX_ANCHOR_SPAN_M = 6; // long objects (bike rows, platforms) have no single contact point

// Pixel (x, y ∈ [0,1], y down) → ground point {forward, right, dist} or null.
// Pitch comes from the observed horizon when given (handheld tilt), else the
// rig's nominal pitch.
export function groundPoint(cam, aspect, x, y, horizonY) {
  const tanH = Math.tan((cam.hfov_deg / 2) * RAD);
  const tanV = tanH / aspect;
  const h = cam.position?.up ?? 1.3;
  const v = (2 * y - 1) * tanV; // image-down offset on the unit focal plane
  const s = (2 * x - 1) * tanH; // image-right offset
  const pitch = Number.isFinite(horizonY) ? Math.atan((2 * horizonY - 1) * tanV) : (cam.pitch_deg ?? 0) * RAD;
  // Ray = axis + v·down + s·right, with axis tilted up by `pitch`.
  const horiz = Math.cos(pitch) + v * Math.sin(pitch);
  const up = Math.sin(pitch) - v * Math.cos(pitch);
  if (Number.isFinite(horizonY) && y - horizonY < MIN_BELOW_HORIZON) return null;
  if (up >= -1e-6) return null; // ray doesn't hit the ground
  const t = h / -up;
  const along = t * horiz, side = t * s;
  const yaw = cam.yaw_deg * RAD;
  const forward = along * Math.cos(yaw) - side * Math.sin(yaw);
  const right = along * Math.sin(yaw) + side * Math.cos(yaw);
  const dist = Math.hypot(forward, right);
  return dist > MAX_RANGE_M ? null : { forward, right, dist, bearing: Math.atan2(right, forward) };
}

// The anchor is the near contact point; the footprint center is further along
// the view ray by the object's half-depth seen from that bearing.
function halfDepth(o, bearing) {
  if (o.shape === 'cylinder') return o.radius ?? 0;
  if (o.shape === 'box' && o.size) {
    const d = bearing - (o.heading_deg ?? 0) * RAD;
    return Math.abs((o.size.length / 2) * Math.cos(d)) + Math.abs((o.size.width / 2) * Math.sin(d));
  }
  return 0;
}

// Returns a corrected copy of `o` (center from its anchor) or `o` unchanged.
// Moving objects keep the model's center: the keyframe is mid-clip, while
// their center is defined at the end of the clip (D20).
// `clips` (runs/<id>/clips.json) gives keyframe_t / duration per camera so a
// moving object anchored mid-clip is advanced to the end of its clip (D20).
export function anchorObstacle(o, rig, horizons = {}, clips = null) {
  const a = o.anchor;
  if (!a || o.shape === 'wire' || (o.base_up ?? 0) > 0.3) return o;
  if (o.shape === 'box' && Math.max(o.size?.length ?? 0, o.size?.width ?? 0) > MAX_ANCHOR_SPAN_M) return o;
  const cam = rig.cameras.find((c) => c.id === a.camera);
  if (!cam || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return o;
  const g = groundPoint(cam, rig.aspect ?? 16 / 9, a.x, a.y, horizons[cam.id]);
  if (!g) return o;
  const hd = halfDepth(o, g.bearing);
  let forward = g.forward + hd * Math.cos(g.bearing);
  let right = g.right + hd * Math.sin(g.bearing);
  if (o.velocity) {
    const clip = clips?.cameras?.find((c) => c.id === cam.id);
    if (!clip || !Number.isFinite(clip.keyframe_t)) return o;
    const dt = Math.max(0, clip.duration_s - clip.keyframe_t);
    forward += o.velocity.forward * dt;
    right += o.velocity.right * dt;
  }
  const center = { forward: +forward.toFixed(2), right: +right.toFixed(2) };
  return { ...o, center, center_model: o.center, center_source: 'anchor' };
}

export function horizonMap(site) {
  return Object.fromEntries((site.camera_horizons ?? []).filter((h) => Number.isFinite(h.horizon_y)).map((h) => [h.id, h.horizon_y]));
}

// Apply anchors to every obstacle; returns {site, moved: [{id, from, to}]}.
export function applyAnchors(site, rig, clips = null) {
  const horizons = horizonMap(site);
  const moved = [];
  let obstacles = site.obstacles.map((o) => {
    const n = anchorObstacle(o, rig, horizons, clips);
    if (n !== o) moved.push({ id: o.id, from: o.center, to: n.center });
    return n;
  });
  // Canopies follow their trunk (same model center → same corrected center).
  const trunks = obstacles.filter((o) => o.type === 'tree_trunk' && o.center_source === 'anchor');
  obstacles = obstacles.map((o) => {
    if (o.type !== 'tree_canopy' || o.center_source === 'anchor') return o;
    const t = trunks.find((t) => Math.hypot(t.center_model.forward - o.center.forward, t.center_model.right - o.center.right) < 1.5);
    return t ? { ...o, center: { ...t.center }, center_model: o.center, center_source: 'anchor' } : o;
  });
  return { site: { ...site, obstacles }, moved };
}
