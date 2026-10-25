// Loop-1 renders (PLAN §4 C, §8): one 1280×720 PNG per rig camera in the
// "reconstruction critique" style — type-colored solids, big floating obstacle
// ids (o1, o2…), and a 5 m ground grid with distance labels. No HUD, no car.
// Argon compares these against the footage keyframes, so legibility > beauty.
import * as THREE from 'three';
import { obstacleObject, surfaceObjects, toThree, disposeTree, TYPE_COLORS } from './site-meshes.js';
import { DEFAULT_RIG } from '../shared/constants.js';

const W = 1280, H = 720;
let renderer = null;

function getRenderer() {
  if (renderer) return renderer;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

// Canvas-text sprite with a constant on-screen size (sizeAttenuation off).
// `h` = fraction of the image height.
function textSprite(text, { h = 0.07, fg = '#ffffff', bg = 'rgba(0,0,0,0.78)', border = null, depthTest = false } = {}) {
  const px = 96;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `800 ${px}px Inter, system-ui, sans-serif`;
  const tw = Math.ceil(ctx.measureText(text).width);
  c.width = tw + px * 0.7; c.height = px * 1.35;
  ctx.font = `800 ${px}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = bg;
  const r = c.height * 0.28;
  ctx.beginPath(); ctx.roundRect(0, 0, c.width, c.height, r); ctx.fill();
  if (border) { ctx.lineWidth = 10; ctx.strokeStyle = border; ctx.beginPath(); ctx.roundRect(5, 5, c.width - 10, c.height - 10, r); ctx.stroke(); }
  ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width / 2, c.height / 2 + px * 0.04);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest, depthWrite: false }));
  sp.scale.set((h * c.width) / c.height, h, 1);
  sp.renderOrder = depthTest ? 5 : 10;
  return sp;
}

function topOf(o) {
  if (o.shape === 'wire') {
    const a = o.from, b = o.to;
    return { forward: (a.forward + b.forward) / 2, right: (a.right + b.right) / 2, up: Math.max(a.up, b.up) + 0.6 };
  }
  const h = o.shape === 'box' ? o.size.height : o.height;
  return { ...o.center, up: (o.base_up ?? 0) + h + 0.6 };
}

// Points along a wire, so its id stays visible from side cameras too.
function wireLabelPoints(o) {
  const pts = [];
  for (const f of [0.3, 0.7]) pts.push({
    forward: o.from.forward + (o.to.forward - o.from.forward) * f,
    right: o.from.right + (o.to.right - o.from.right) * f,
    up: o.from.up + (o.to.up - o.from.up) * f + 0.6,
  });
  return pts;
}

function buildScene(site) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#9db3c9');
  scene.add(new THREE.HemisphereLight('#ffffff', '#5a5a5a', 1.6));
  const sun = new THREE.DirectionalLight('#ffffff', 1.4);
  sun.position.set(-20, 40, 10);
  scene.add(sun);

  // Ground + surfaces
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#2b2c2f' }));
  scene.add(ground);
  for (const s of surfaceObjects(site, 'critique')) scene.add(s);

  // 5 m grid (10 m lines brighter) out to 60 m; drawn just above surfaces.
  const R = 60, minor = [], major = [];
  for (let d = -R; d <= R; d += 5) {
    const arr = d % 10 === 0 ? major : minor;
    arr.push(-R, 0, d, R, 0, d, d, 0, -R, d, 0, R);
  }
  for (const [arr, color, opacity] of [[minor, '#d8d8d8', 0.45], [major, '#ffffff', 0.8]]) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    lines.position.y = 0.03;
    scene.add(lines);
  }
  // Distance labels along the forward/back and left/right axes, plus ±10 m rows.
  for (let d = 5; d <= 50; d += 5) {
    const h = d <= 20 ? 0.042 : 0.034;
    for (const p of [{ forward: d, right: 0 }, { forward: -d, right: 0 }, { forward: 0, right: d }, { forward: 0, right: -d }]) {
      // ground labels sit on the ground (anchored at their bottom) and are occluded by obstacles
      const s = textSprite(`${d} m`, { h, fg: '#111', bg: 'rgba(255,255,255,0.85)', depthTest: true });
      s.center.set(0.5, 0);
      s.position.copy(toThree(p, 0.05));
      scene.add(s);
    }
    if (d % 10 === 0 && d <= 30) for (const side of [-10, 10]) for (const f of [d, -d]) {
      const s = textSprite(`${f} m`, { h: 0.03, fg: '#111', bg: 'rgba(255,255,255,0.7)', depthTest: true });
      s.center.set(0.5, 0);
      s.position.copy(toThree({ forward: f, right: side }, 0.05));
      scene.add(s);
    }
  }

  // Obstacles + id labels
  for (const o of site.obstacles ?? []) {
    try {
      scene.add(obstacleObject(o, 'critique'));
      const color = TYPE_COLORS[o.type] ?? TYPE_COLORS.other;
      const pts = o.shape === 'wire' ? wireLabelPoints(o) : [topOf(o)];
      for (const p of pts) {
        const s = textSprite(o.id, { h: 0.085, fg: '#fff', bg: 'rgba(0,0,0,0.8)', border: color });
        s.position.copy(toThree(p, p.up));
        scene.add(s);
      }
    } catch (err) {
      console.warn('render-views: skipped obstacle', o?.id, err);
    }
  }
  return scene;
}

function cameraFor(cam, aspect) {
  const hfov = ((cam.hfov_deg ?? 100) * Math.PI) / 180;
  const vfov = (2 * Math.atan(Math.tan(hfov / 2) / aspect) * 180) / Math.PI;
  const c = new THREE.PerspectiveCamera(vfov, aspect, 0.1, 400);
  const p = cam.position ?? { forward: 0, right: 0, up: 1.3 };
  c.position.copy(toThree(p, p.up ?? 1.3));
  c.rotation.order = 'YXZ';
  c.rotation.y = (-(cam.yaw_deg ?? 0) * Math.PI) / 180;
  c.rotation.x = ((cam.pitch_deg ?? 0) * Math.PI) / 180;
  c.updateMatrixWorld();
  return c;
}

// renderCameraViews(site, rig) → { camId: 'data:image/png;base64,…' }
export function renderCameraViews(site, rig = DEFAULT_RIG) {
  const r = getRenderer();
  const scene = buildScene(site);
  const aspect = W / H; // renders are 16:9 regardless of rig.aspect
  const out = {};
  for (const cam of rig?.cameras ?? DEFAULT_RIG.cameras) {
    r.render(scene, cameraFor(cam, aspect));
    out[cam.id] = r.domElement.toDataURL('image/png');
  }
  disposeTree(scene);
  return out;
}
