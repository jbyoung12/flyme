// "Photo" mode: project the real footage keyframes back onto the 3D scene.
// All car cameras sit at one point with known yaw, HFOV and (per keyframe)
// horizon line, so any world point can be coloured from the camera that sees
// it — the ground gets the real road paint, tracks and tiles, and a cylinder
// around the car becomes a 360° photo backdrop of the street.
import * as THREE from 'three';

const MAX_CAMS = 4;
const GROUND_RADIUS = 74.5; // meets the backdrop: no gap at the horizon
const BACKDROP_RADIUS = 75;
const BACKDROP_HEIGHT = 45;
const OCC_HALF = 64; // occlusion mask covers ±64 m
const OCC_N = 512;
// Ground the cameras can't see (out of range, or behind an obstacle) is
// filled with pavement grey, never a black hole.
export const PAVEMENT = '#77756f';
const FADE = [40, 60];

const vertexShader = `
  varying vec3 vW;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

// cam[i] = (yaw rad, horizon_y, enabled, 0). World: x = right, y = up, z = −forward.
const fragmentShader = `
  uniform sampler2D t0; uniform sampler2D t1; uniform sampler2D t2; uniform sampler2D t3;
  uniform vec4 cam[${MAX_CAMS}];
  uniform float tanH; uniform float tanV; uniform float camH;
  uniform float fadeStart; uniform float fadeEnd; uniform vec3 bg; uniform float opacity;
  uniform sampler2D occ; uniform float occHalf; uniform float useOcc;
  varying vec3 vW;

  vec4 proj(sampler2D t, vec4 c, vec3 rel, out float w) {
    w = 0.0;
    if (c.z < 0.5) return vec4(0.0);
    float fwd = -rel.z, rgt = rel.x, up = rel.y;
    float zc = fwd * cos(c.x) + rgt * sin(c.x);
    if (zc < 0.05) return vec4(0.0);
    float s = -fwd * sin(c.x) + rgt * cos(c.x);
    float u = 0.5 + 0.5 * s / (zc * tanH);
    float y = c.y + 0.5 * (-up / zc) / tanV;
    // Ground just below the frame (the ~2 m around the car no lens sees):
    // extend the bottom rows so it reads as ground instead of a hole.
    float below = 0.0;
    if (y > 1.0 && y < 2.2 && up < 0.0) { below = y - 1.0; y = 0.985; }
    if (u < 0.0 || u > 1.0 || y < 0.0 || y > 1.0) return vec4(0.0);
    // Prefer the camera that sees the point nearest its image centre.
    w = smoothstep(0.0, 0.12, u) * smoothstep(1.0, 0.88, u) * smoothstep(0.0, 0.04, y) * (below > 0.0 ? 0.35 : smoothstep(1.0, 0.96, y)) + 1e-4;
    return texture2D(t, vec2(u, 1.0 - y));
  }

  void main() {
    vec3 rel = vW - vec3(0.0, camH, 0.0);
    float w0, w1, w2, w3;
    vec4 c0 = proj(t0, cam[0], rel, w0);
    vec4 c1 = proj(t1, cam[1], rel, w1);
    vec4 c2 = proj(t2, cam[2], rel, w2);
    vec4 c3 = proj(t3, cam[3], rel, w3);
    float ws = w0 + w1 + w2 + w3;
    vec3 col = ws > 0.0 ? (c0.rgb * w0 + c1.rgb * w1 + c2.rgb * w2 + c3.rgb * w3) / ws : bg;
    float d = length(vW.xz);
    // Ground the cameras could not actually see (line of sight blocked by a
    // reconstructed obstacle) would show that obstacle smeared flat: dim it.
    if (useOcc > 0.5) {
      float vis = texture2D(occ, vec2((vW.x + occHalf) / (2.0 * occHalf), (vW.z + occHalf) / (2.0 * occHalf))).r;
      col = mix(bg, col, smoothstep(0.35, 0.9, vis));
    }
    col = mix(col, bg, smoothstep(fadeStart, fadeEnd, d));
    gl_FragColor = vec4(col * 0.92, opacity);
    #include <colorspace_fragment>
  }`;

export function createFootageProjection(scene, { bg = '#0b0c0e' } = {}) {
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blank.needsUpdate = true;
  const base = () => ({
    t0: { value: blank }, t1: { value: blank }, t2: { value: blank }, t3: { value: blank },
    cam: { value: Array.from({ length: MAX_CAMS }, () => new THREE.Vector4(0, 0.5, 0, 0)) },
    tanH: { value: Math.tan((104 / 2) * Math.PI / 180) },
    tanV: { value: Math.tan((104 / 2) * Math.PI / 180) / (16 / 9) },
    camH: { value: 1.3 },
    bg: { value: new THREE.Color(bg) },
    opacity: { value: 1 },
    occ: { value: null }, occHalf: { value: OCC_HALF }, useOcc: { value: 0 },
  });
  const groundMat = new THREE.ShaderMaterial({
    uniforms: { ...base(), bg: { value: new THREE.Color(PAVEMENT) }, fadeStart: { value: FADE[0] }, fadeEnd: { value: FADE[1] } },
    vertexShader, fragmentShader,
  });
  const backMat = new THREE.ShaderMaterial({
    uniforms: { ...base(), fadeStart: { value: 1e4 }, fadeEnd: { value: 2e4 } },
    vertexShader, fragmentShader, side: THREE.BackSide, depthWrite: false,
  });
  // Obstacle boxes get the footage too, so a bike rack shows the bikes on its
  // box instead of smeared flat across the ground behind it.
  const objMat = new THREE.ShaderMaterial({
    uniforms: { ...base(), bg: { value: new THREE.Color(PAVEMENT) }, fadeStart: { value: 1e4 }, fadeEnd: { value: 2e4 } },
    vertexShader, fragmentShader,
  });
  // All materials share the same texture/camera uniforms.
  for (const k of ['t0', 't1', 't2', 't3', 'cam', 'tanH', 'tanV', 'camH']) backMat.uniforms[k] = objMat.uniforms[k] = groundMat.uniforms[k];

  const ground = new THREE.Mesh(new THREE.CircleGeometry(GROUND_RADIUS, 96).rotateX(-Math.PI / 2), groundMat);
  ground.position.y = 0.006;
  ground.renderOrder = -2;
  const backdrop = new THREE.Mesh(new THREE.CylinderGeometry(BACKDROP_RADIUS, BACKDROP_RADIUS, BACKDROP_HEIGHT, 128, 1, true), backMat);
  backdrop.position.y = BACKDROP_HEIGHT / 2 - 0.5;
  backdrop.renderOrder = -3;
  const group = new THREE.Group();
  group.add(ground, backdrop);
  group.visible = false;
  scene.add(group);

  const loader = new THREE.TextureLoader();
  let token = 0;

  // rig: §6.2; media: [{id, keyframe_url}]; horizons: site.camera_horizons.
  async function setFootage(rig, media = [], horizons = []) {
    const my = ++token;
    const cams = (rig?.cameras ?? []).filter((c) => !c.pitch_deg).slice(0, MAX_CAMS);
    const hfov = cams[0]?.hfov_deg ?? 104;
    const tanH = Math.tan((hfov / 2) * Math.PI / 180);
    groundMat.uniforms.tanH.value = tanH;
    groundMat.uniforms.tanV.value = tanH / (rig?.aspect ?? 16 / 9);
    groundMat.uniforms.camH.value = cams[0]?.position?.up ?? 1.3;
    const hz = Object.fromEntries((horizons ?? []).map((h) => [h.id, h.horizon_y]));
    const textures = await Promise.all(cams.map((c) => {
      const url = media.find((m) => m.id === c.id)?.keyframe_url;
      if (!url) return null;
      return new Promise((resolve) => loader.load(url, (t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; resolve(t); }, undefined, () => resolve(null)));
    }));
    if (my !== token) return false;
    let any = false;
    for (let i = 0; i < MAX_CAMS; i++) {
      const c = cams[i], t = textures[i];
      const old = groundMat.uniforms[`t${i}`].value;
      if (old !== blank) old.dispose();
      groundMat.uniforms[`t${i}`].value = t ?? blank;
      groundMat.uniforms.cam.value[i].set(c ? (c.yaw_deg * Math.PI) / 180 : 0, Number.isFinite(hz[c?.id]) ? hz[c.id] : 0.5, t ? 1 : 0, 0);
      any ||= Boolean(t);
    }
    return any;
  }

  // Visibility mask of the ground from the camera point, from site obstacles.
  const occTex = new THREE.DataTexture(new Uint8Array(OCC_N * OCC_N).fill(255), OCC_N, OCC_N, THREE.RedFormat);
  occTex.magFilter = THREE.LinearFilter;
  occTex.minFilter = THREE.LinearFilter;
  occTex.needsUpdate = true;
  groundMat.uniforms.occ.value = occTex;
  function setOcclusion(site, camH = groundMat.uniforms.camH.value) {
    const data = occTex.image.data;
    data.fill(255);
    const blockers = (site?.obstacles ?? []).filter((o) => o.shape !== 'wire');
    if (blockers.length) {
      const cell = (2 * OCC_HALF) / OCC_N;
      for (let j = 0; j < OCC_N; j++) {
        const z = -OCC_HALF + (j + 0.5) * cell;
        for (let i = 0; i < OCC_N; i++) {
          const x = -OCC_HALF + (i + 0.5) * cell;
          if (x * x + z * z > GROUND_RADIUS * GROUND_RADIUS) continue;
          // ground point in car frame
          const f = -z, r = x;
          for (const o of blockers) if (blocks(o, f, r, camH)) { data[j * OCC_N + i] = 0; break; }
        }
      }
    }
    occTex.needsUpdate = true;
    hasOcc = blockers.length > 0;
    groundMat.uniforms.useOcc.value = hasOcc && !pov ? 1 : 0;
  }

  // From the rig's own camera point every pixel maps straight back to the
  // camera that shot it: no occlusion dimming, no distance fade.
  let hasOcc = false, pov = false;
  function setPov(on) {
    pov = on;
    groundMat.uniforms.useOcc.value = hasOcc && !pov ? 1 : 0;
    groundMat.uniforms.fadeStart.value = pov ? 1e4 : FADE[0];
    groundMat.uniforms.fadeEnd.value = pov ? 2e4 : FADE[1];
  }

  return {
    setFootage,
    setOcclusion,
    setPov,
    objMat,
    ground,
    backdrop,
    setVisible(on) { group.visible = on; },
    get visible() { return group.visible; },
  };
}

// Does obstacle `o` block the segment from the camera (0, 0, camH) to the
// ground point (f, r, 0)? Box: slab test in the box frame; cylinder: closest
// approach of the 2D segment to the axis, with the height at that point.
function blocks(o, f, r, camH) {
  const base = o.base_up ?? 0;
  if (o.shape === 'box') {
    const h = ((o.heading_deg ?? 0) * Math.PI) / 180, c = Math.cos(h), s = Math.sin(h);
    const toLocal = (pf, pr) => { const df = pf - o.center.forward, dr = pr - o.center.right; return [df * c + dr * s, -df * s + dr * c]; };
    const [a0, b0] = toLocal(0, 0), [a1, b1] = toLocal(f, r);
    const ext = [o.size.length / 2, o.size.width / 2];
    let t0 = 0, t1 = 1;
    const p0 = [a0, b0, camH], d = [a1 - a0, b1 - b0, -camH];
    const lo = [-ext[0], -ext[1], base], hi = [ext[0], ext[1], base + o.size.height];
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]) < 1e-9) { if (p0[k] < lo[k] || p0[k] > hi[k]) return false; continue; }
      let ta = (lo[k] - p0[k]) / d[k], tb = (hi[k] - p0[k]) / d[k];
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return false;
    }
    return t0 < 0.985; // a hit right at the ground point is the obstacle's own footprint
  }
  if (o.shape === 'cylinder') {
    const cf = o.center.forward, cr = o.center.right, rad = o.radius;
    const L2 = f * f + r * r;
    const t = L2 > 0 ? Math.max(0, Math.min(1, (cf * f + cr * r) / L2)) : 0;
    const df = t * f - cf, dr = t * r - cr;
    if (df * df + dr * dr > rad * rad) return false;
    const up = camH * (1 - t);
    return t < 0.985 && up >= base && up <= base + o.height;
  }
  return false;
}
