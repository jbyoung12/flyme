// AI world (visual only, server/paint.js): the inputs and outputs of the
// image-model repaint that makes outside views look clean.
//   buildSpriteJobs  — per obstacle, crop it from the keyframe that sees it
//                      best (same camera math as footage-projection.js);
//   renderTopDown    — orthographic straight-down render → JPEG data URL;
//   keyOut           — strip the flat key-colour background of a sprite and
//                      trim it to the object.
import * as THREE from 'three';

export const PAINT_EXTENT = 45; // painted ground covers ±45 m
const CROP_MAX = 512;

const WHAT = {
  vehicle: 'a parked vehicle',
  pole: 'a pole',
  sign: 'a street sign',
  tree_trunk: 'a tree',
  tree_canopy: 'a tree (the whole tree, trunk and canopy)',
  person: 'a person (draw as a simple faceless figure)',
  building: 'a building facade',
  barrier: 'a barrier',
  other: 'a street object',
};
const VEGETATION = new Set(['tree_trunk', 'tree_canopy']);
// Big things stay facing the rig (a turning building reads wrong); small
// things turn to face the viewer.
export const FIXED_TYPES = new Set(['building']);

const loadImage = (url) => new Promise((resolve, reject) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error(`could not load ${url}`));
  img.src = url;
});

// Sprite bottom/top (m). A canopy's sprite is the whole tree from the ground.
export function spriteSpan(o) {
  const base = o.base_up ?? 0;
  const top = base + (o.shape === 'box' ? o.size.height : o.height);
  return { bottom: o.type === 'tree_canopy' ? 0 : base, top };
}

function corners(o) {
  const { bottom, top } = spriteSpan(o);
  const foot = [];
  if (o.shape === 'box') {
    const h = ((o.heading_deg ?? 0) * Math.PI) / 180, c = Math.cos(h), s = Math.sin(h);
    for (const a of [-1, 1]) for (const b of [-1, 1]) {
      const la = (a * o.size.length) / 2, lb = (b * o.size.width) / 2;
      foot.push([o.center.forward + la * c - lb * s, o.center.right + la * s + lb * c]);
    }
  } else {
    for (const [a, b] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) foot.push([o.center.forward + a * o.radius, o.center.right + b * o.radius]);
  }
  return foot.flatMap(([f, r]) => [[f, r, bottom], [f, r, top]]);
}

// Car-frame point → normalised image coords (u right, y down) for one camera.
function project(cam, hz, tanH, tanV, camH, [f, r, up]) {
  const yaw = ((cam.yaw_deg ?? 0) * Math.PI) / 180;
  const zc = f * Math.cos(yaw) + r * Math.sin(yaw);
  if (zc < 0.2) return null;
  const s = -f * Math.sin(yaw) + r * Math.cos(yaw);
  return { u: 0.5 + (0.5 * s) / (zc * tanH), y: hz + (0.5 * (-(up - camH) / zc)) / tanV };
}

function bestView(o, cams, horizons, rig) {
  let best = null;
  for (const cam of cams) {
    const tanH = Math.tan((((cam.hfov_deg ?? 104) / 2) * Math.PI) / 180);
    const tanV = tanH / (rig?.aspect ?? 16 / 9);
    const camH = cam.position?.up ?? 1.3;
    const hz = Number.isFinite(horizons[cam.id]) ? horizons[cam.id] : 0.5;
    const pts = corners(o).map((p) => project(cam, hz, tanH, tanV, camH, p));
    if (pts.some((p) => !p)) continue;
    const u0 = Math.min(...pts.map((p) => p.u)), u1 = Math.max(...pts.map((p) => p.u));
    const y0 = Math.min(...pts.map((p) => p.y)), y1 = Math.max(...pts.map((p) => p.y));
    const area = (u1 - u0) * (y1 - y0);
    if (!(area > 0)) continue;
    const vis = (Math.max(0, Math.min(1, u1) - Math.max(0, u0)) * Math.max(0, Math.min(1, y1) - Math.max(0, y0))) / area;
    const score = vis - 0.6 * Math.abs((u0 + u1) / 2 - 0.5);
    if (vis > 0.3 && (!best || score > best.score)) best = { cam, score, box: [u0, y0, u1, y1] };
  }
  return best;
}

// → [{id, crop, what, w, h, key, cam}] for every obstacle a keyframe shows.
export async function buildSpriteJobs(site, rig, media, horizonsList = []) {
  const cams = (rig?.cameras ?? []).filter((c) => !c.pitch_deg && media.some((m) => m.id === c.id && m.keyframe_url));
  const horizons = Object.fromEntries((horizonsList ?? []).map((h) => [h.id, h.horizon_y]));
  const images = Object.fromEntries(await Promise.all(cams.map(async (c) => [c.id, await loadImage(media.find((m) => m.id === c.id).keyframe_url).catch(() => null)])));
  const obstacles = (site?.obstacles ?? []).filter((o) => o.shape === 'box' || o.shape === 'cylinder');
  const canopies = obstacles.filter((o) => o.type === 'tree_canopy');
  const jobs = [];
  for (const o of obstacles) {
    // A trunk under a canopy is drawn as part of the canopy's tree sprite.
    if (o.type === 'tree_trunk' && canopies.some((c) => Math.hypot(c.center.forward - o.center.forward, c.center.right - o.center.right) < 2.5)) continue;
    const v = bestView(o, cams, horizons, rig);
    const img = v && images[v.cam.id];
    if (!img) continue;
    const W = img.naturalWidth, H = img.naturalHeight;
    const [u0, y0, u1, y1] = v.box;
    const pu = (u1 - u0) * 0.15, py = (y1 - y0) * 0.15;
    const x0 = Math.max(0, (u0 - pu) * W), x1 = Math.min(W, (u1 + pu) * W);
    const yy0 = Math.max(0, (y0 - py) * H), yy1 = Math.min(H, (y1 + py) * H);
    const cw = x1 - x0, ch = yy1 - yy0;
    if (cw < 24 || ch < 24) continue;
    const k = Math.min(CROP_MAX / Math.max(cw, ch), 3);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(cw * k); canvas.height = Math.round(ch * k);
    canvas.getContext('2d').drawImage(img, x0, yy0, cw, ch, 0, 0, canvas.width, canvas.height);
    const { bottom, top } = spriteSpan(o);
    const w = o.shape === 'box' ? Math.max(o.size.length, o.size.width) : 2 * o.radius;
    jobs.push({
      id: o.id,
      crop: canvas.toDataURL('image/jpeg', 0.9),
      what: o.label ? `${WHAT[o.type] ?? WHAT.other} (${o.label})` : WHAT[o.type] ?? WHAT.other,
      w: Number(w.toFixed(1)),
      h: Number((top - bottom).toFixed(1)),
      key: VEGETATION.has(o.type) ? 'magenta' : 'green',
      cam: v.cam.id,
    });
  }
  return jobs;
}

// Straight-down orthographic render of `scene`, top of image = forward.
export function renderTopDown(renderer, scene, size = 1024, extent = PAINT_EXTENT) {
  const cam = new THREE.OrthographicCamera(-extent, extent, extent, -extent, 1, 400);
  cam.position.set(0, 200, 0);
  cam.up.set(0, 0, -1);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  const rt = new THREE.WebGLRenderTarget(size, size, { colorSpace: THREE.SRGBColorSpace, samples: 4 });
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  const px = new Uint8Array(size * size * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, size, size, px);
  renderer.setRenderTarget(prev);
  rt.dispose();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const out = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) out.data.set(px.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4); // GL rows are bottom-up
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
  ctx.putImageData(out, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.9);
}

// Sprite PNG → {texture, aspect} with the background keyed out and the image
// trimmed to the object; null if nothing is left. The key colour is read from
// the image corners (models rarely hit #00FF00 exactly).
export async function keyOut(url) {
  const img = await loadImage(url);
  const W = img.naturalWidth, H = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const im = ctx.getImageData(0, 0, W, H), d = im.data;
  const samples = [];
  const n = Math.max(4, Math.round(Math.min(W, H) * 0.03));
  for (const [cx, cy] of [[0, 0], [W - n, 0], [0, H - n], [W - n, H - n]]) {
    for (let y = cy; y < cy + n; y++) for (let x = cx; x < cx + n; x++) { const i = (y * W + x) * 4; samples.push([d[i], d[i + 1], d[i + 2]]); }
  }
  const key = [0, 1, 2].map((c) => samples.map((s) => s[c]).sort((a, b) => a - b)[samples.length >> 1]);
  const dominant = key.indexOf(Math.max(...key));
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const dist = Math.hypot(d[i] - key[0], d[i + 1] - key[1], d[i + 2] - key[2]);
    const a = Math.max(0, Math.min(1, (dist - 70) / 70));
    if (a < 1) {
      // Despill: pull the key channel down to its neighbours on soft edges.
      const others = [0, 1, 2].filter((c) => c !== dominant && !(key[c] > 200 && key[dominant] > 200));
      const lim = Math.max(...others.map((c) => d[i + c]));
      if (d[i + dominant] > lim) d[i + dominant] = lim;
    }
    d[i + 3] = Math.round(a * 255);
    if (a > 0.5) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxX < 0 || (maxX - minX) * (maxY - minY) < W * H * 0.01) return null;
  ctx.putImageData(im, 0, 0);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1; out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  const texture = new THREE.CanvasTexture(out);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return { texture, aspect: out.width / out.height };
}

// Painted ground image → texture + its mean colour (used for the ground
// beyond the painted square so the edge fades into matching pavement).
export async function loadGround(url) {
  const img = await loadImage(url);
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, 32, 32);
  const d = ctx.getImageData(0, 0, 32, 32).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const k = d.length / 4;
  const texture = new THREE.Texture(img);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return { texture, color: new THREE.Color(`rgb(${Math.round(r / k)}, ${Math.round(g / k)}, ${Math.round(b / k)})`) };
}
