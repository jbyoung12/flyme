// Main 3D view (PLAN §8): dark street, FSD-style obstacles, white flying car,
// tap-to-target, candidate arc fans, collision markers, HOP playback with
// chase cam + thruster puffs, and moving obstacles at center + velocity·t.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { CAR, SAFETY, PLAN_VALID_S } from '../shared/constants.js';
import { obstacleObject, surfaceObjects, toThree, disposeTree } from './site-meshes.js';
import { buildFlyingCar, glowTexture } from './car-model.js';
import { esc, fmt, shortReason } from './format.js';
import { createFootageProjection, PAVEMENT } from './footage-projection.js';

const BG = '#0b0c0e';
const COLORS = { unsafe: '#ff4d4f', safe: '#2fd27a', chosen: '#3d8bff', amber: '#ffb020' };
// pov: at the rig's own camera point — the only place the projected footage
// is undistorted (any other pose warps it onto our rough boxes).
const EYE = 1.3;
const POV_BACK = 0, POV_UP = EYE, POV_AHEAD = 0.6;
const VIEWS = {
  pov: { pos: [0, POV_UP, POV_BACK], target: [0, EYE - 0.03, -POV_AHEAD] },
  overview: { pos: [3, 22, 19], target: [0, 0, -15] },
  top: { pos: [0, 58, -13.99], target: [0, 0, -14] },
  side: { pos: [32, 7, -12], target: [0, 2.5, -12] },
};
const MARKER_CHECKS = ['collision', 'clearance', 'pedestrian', 'landing_zone'];

function label(html, cls) {
  const el = document.createElement('div');
  el.className = `label3d ${cls}`;
  el.innerHTML = html;
  return new CSS2DObject(el);
}

export function createScene(container, { onTap } = {}) {
  // ---------------------------------------------------------------- renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const labels = new CSS2DRenderer();
  Object.assign(labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '1' });
  container.prepend(labels.domElement);
  container.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 55, 150);

  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 500);
  camera.position.set(...VIEWS.pov.pos);
  camera.lookAt(...VIEWS.pov.target);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...VIEWS.pov.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 4;
  controls.maxDistance = 140;
  let viewName = 'pov';
  function applyViewMode() {
    const pov = viewName === 'pov';
    controls.minDistance = pov ? 0.1 : 4;
    controls.enableZoom = !pov;
    controls.enablePan = !pov;
    // POV pitch limits: down far enough to see the landing spot, never so far
    // the unfilmed ground under the car fills the view; up only ~9° so the
    // top of the 360° backdrop stays out of frame.
    controls.minPolarAngle = pov ? Math.PI * 0.433 : 0;
    controls.maxPolarAngle = pov ? Math.PI * 0.55 : Math.PI * 0.49;
    photo.setPov(pov);
  }

  scene.add(new THREE.HemisphereLight('#c9d6ff', '#0b0c0e', 0.9));
  const key = new THREE.DirectionalLight('#ffffff', 2.2);
  key.position.set(-14, 26, 12);
  scene.add(key);
  const rim = new THREE.DirectionalLight('#7aa7ff', 0.8);
  rim.position.set(18, 10, -30);
  scene.add(rim);

  // Ground + faint 5 m grid
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#0d0f12', roughness: 1 }));
  scene.add(ground);
  const grid = new THREE.GridHelper(200, 40, '#1d2128', '#15181d');
  grid.position.y = 0.012;
  grid.material.transparent = true;
  grid.material.opacity = 0.7;
  scene.add(grid);
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  // Photo mode: real footage projected onto the ground + a 360° backdrop.
  const photo = createFootageProjection(scene, { bg: BG });
  let photoLook = 'model';
  const groundCol = new THREE.Color('#0d0f12');
  function setPhoto(on, { look = 'photo' } = {}) {
    photo.setVisible(on && !world);
    // The picture already shows every real object: hide our boxes, people's
    // keep-out rings and motion arrows. Only an obstacle a flight path fails
    // on is drawn (red) on top.
    for (const c of siteGroup?.children ?? []) c.userData.lookHidden = on && Boolean(c.userData.obstacle);
    siteGroup?.traverse((o) => { if (o.userData.surface) o.visible = !on; });
    for (const e of obstacles) for (const x of [e.ring, e.arrow, e.path]) if (x) x.visible = !on;
    ground.material.color.copy(on ? new THREE.Color(PAVEMENT) : groundCol);
    // The backdrop doesn't write depth, so the 600 m ground plane and grid
    // beyond it would paint a grey band (and lines) across the horizon.
    ground.visible = grid.visible = !on;
    photoLook = on ? look : 'model';
    scene.fog.near = on ? 120 : 55;
    scene.fog.far = on ? 400 : 150;
    if (siteGroup) styleLabels();
  }

  const lineMats = new Set();
  const lineMat = (opts) => {
    const m = new LineMaterial({ worldUnits: false, transparent: true, depthWrite: false, ...opts });
    m.resolution.set(container.clientWidth, container.clientHeight);
    lineMats.add(m);
    return m;
  };
  const freeLineMat = (m) => { lineMats.delete(m); m.dispose(); };

  // ---------------------------------------------------------------- car
  const car = buildFlyingCar();
  scene.add(car);
  const shadow = car.userData.shadow;
  const youTag = label('You', 'you');
  youTag.position.set(0, 1.9, 0);
  car.add(youTag);
  scene.add(shadow);

  // ---------------------------------------------------------------- particles (thruster vapor)
  const N = 900;
  const pPos = new Float32Array(N * 3), pAlpha = new Float32Array(N), pSize = new Float32Array(N);
  const pVel = new Float32Array(N * 3), pAge = new Float32Array(N).fill(1), pLife = new Float32Array(N).fill(1);
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
  pGeo.setAttribute('aAlpha', new THREE.BufferAttribute(pAlpha, 1).setUsage(THREE.DynamicDrawUsage));
  pGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1).setUsage(THREE.DynamicDrawUsage));
  const pMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: glowTexture() }, uScale: { value: 400 } },
    vertexShader: `attribute float aAlpha; attribute float aSize; uniform float uScale; varying float vA;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize * uScale / -mv.z; gl_Position = projectionMatrix * mv; vA = aAlpha; }`,
    fragmentShader: `uniform sampler2D map; varying float vA;
      void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(0.9, 0.94, 1.0, t.a * vA); }`,
    transparent: true, depthWrite: false,
  });
  const particles = new THREE.Points(pGeo, pMat);
  particles.frustumCulled = false;
  scene.add(particles);
  let pNext = 0;
  const tmpV = new THREE.Vector3();

  function emit(level, dt) {
    if (level <= 0.02) return;
    const count = Math.min(30, Math.round(level * 160 * dt * 10)) || 1;
    for (const n of car.userData.nozzles) {
      for (let k = 0; k < Math.max(1, Math.round(count / 10)); k++) {
        const i = pNext; pNext = (pNext + 1) % N;
        car.localToWorld(tmpV.copy(n.local));
        pPos[i * 3] = tmpV.x; pPos[i * 3 + 1] = tmpV.y - 0.05; pPos[i * 3 + 2] = tmpV.z;
        const out = new THREE.Vector2(n.local.x, n.local.z).normalize();
        pVel[i * 3] = out.x * 1.5 + (Math.random() - 0.5) * 1.2;
        pVel[i * 3 + 1] = -(6 + 10 * level) * (0.7 + Math.random() * 0.5);
        pVel[i * 3 + 2] = out.y * 1.5 + (Math.random() - 0.5) * 1.2;
        pAge[i] = 0; pLife[i] = 0.7 + Math.random() * 0.7;
      }
    }
  }

  function stepParticles(dt) {
    for (let i = 0; i < N; i++) {
      if (pAge[i] >= pLife[i]) { pAlpha[i] = 0; continue; }
      pAge[i] += dt;
      const j = i * 3;
      pPos[j] += pVel[j] * dt; pPos[j + 1] += pVel[j + 1] * dt; pPos[j + 2] += pVel[j + 2] * dt;
      if (pPos[j + 1] < 0.08) { // hit the ground: spread out
        pPos[j + 1] = 0.08;
        const sp = Math.abs(pVel[j + 1]) * 0.35;
        pVel[j + 1] = 0.3;
        const ang = Math.atan2(pVel[j + 2], pVel[j]) + (Math.random() - 0.5);
        pVel[j] += Math.cos(ang) * sp; pVel[j + 2] += Math.sin(ang) * sp;
      }
      pVel[j] *= 0.97; pVel[j + 1] *= 0.95; pVel[j + 2] *= 0.97;
      const f = pAge[i] / pLife[i];
      pAlpha[i] = (1 - f) * (1 - f) * 0.3;
      pSize[i] = 0.4 + f * 2.2;
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.aAlpha.needsUpdate = true;
    pGeo.attributes.aSize.needsUpdate = true;
  }

  // ---------------------------------------------------------------- site
  const siteGroup = new THREE.Group();
  scene.add(siteGroup);
  let site = null;
  let obstacles = []; // {o, obj, mats, ring, arrow, path, label, flashT}
  let highlightIds = new Set();

  function clearSite() {
    for (const e of obstacles) {
      if (e.path) freeLineMat(e.path.material);
      if (e.wireLine) freeLineMat(e.wireLine.material);
    }
    for (const c of [...siteGroup.children]) { siteGroup.remove(c); disposeTree(c); }
    for (const e of obstacles) e.label && e.label.element.remove();
    obstacles = [];
  }

  function setSite(next, { flash = [] } = {}) {
    photo.setOcclusion(next);
    clearSite();
    site = next;
    if (!site) return;
    for (const s of surfaceObjects(site, 'fsd')) { s.userData.surface = true; s.visible = !photo.visible; siteGroup.add(s); }
    const flashSet = new Set(flash);
    for (const o of site.obstacles ?? []) {
      let obj;
      try { obj = obstacleObject(o, 'fsd'); } catch (err) { console.warn('scene: bad obstacle', o?.id, err); continue; }
      siteGroup.add(obj);
      obj.userData.box = new THREE.Box3().setFromObject(obj).expandByScalar(0.6);
      const e = { o, obj, mats: [], flashT: flashSet.has(o.id) ? 0 : null };
      obj.traverse((m) => {
        if (m.material?.emissive) e.mats.push({ m: m.material, base: m.material.emissive.clone(), baseI: m.material.emissiveIntensity });
      });
      if (o.type === 'person') {
        const ring = new THREE.Group();
        const edge = new THREE.Mesh(new THREE.RingGeometry(SAFETY.pedestrianKeepOutM - 0.06, SAFETY.pedestrianKeepOutM, 72).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: COLORS.amber, transparent: true, opacity: 0.6, depthWrite: false }));
        const disc = new THREE.Mesh(new THREE.CircleGeometry(SAFETY.pedestrianKeepOutM, 72).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: COLORS.amber, transparent: true, opacity: 0.06, depthWrite: false }));
        ring.add(edge, disc);
        ring.position.copy(toThree(o.center, 0.03));
        siteGroup.add(ring);
        e.ring = ring;
        e.ringMat = edge.material;
      }
      if (o.velocity && (o.velocity.forward || o.velocity.right)) {
        const v = toThree(o.velocity, 0);
        const speed = v.length();
        const arrow = new THREE.ArrowHelper(v.clone().normalize(), toThree(o.center, 0.15), Math.max(1.2, speed * 2.2), COLORS.amber, 0.45, 0.32);
        siteGroup.add(arrow);
        e.arrow = arrow;
        const end = { forward: o.center.forward + o.velocity.forward * PLAN_VALID_S, right: o.center.right + o.velocity.right * PLAN_VALID_S };
        const geo = new LineGeometry().setPositions([...toThree(o.center, 0.06).toArray(), ...toThree(end, 0.06).toArray()]);
        const path = new Line2(geo, lineMat({ color: COLORS.amber, linewidth: 2, dashed: true, dashSize: 0.5, gapSize: 0.4, opacity: 0.35 }));
        path.computeLineDistances();
        siteGroup.add(path);
        e.path = path;
      }
      const top = o.shape === 'wire'
        ? toThree({ forward: (o.from.forward + o.to.forward) / 2, right: (o.from.right + o.to.right) / 2 }, Math.max(o.from.up, o.to.up) + 0.4)
        : toThree(o.center, (o.base_up ?? 0) + (o.shape === 'box' ? o.size.height : o.height) + 0.3);
      if (o.type !== 'tree_trunk') {
        // Hidden by default; shown on hover or when the obstacle matters (styleLabels).
        const l = label(`<b>${esc(o.id)}</b> ${esc(o.label ?? o.type)}`, 'obj');
        l.center.set(0.5, 1);
        l.visible = false;
        if (o.shape === 'wire') { l.position.copy(top); siteGroup.add(l); } else { l.position.set(0, top.y - obj.position.y, 0); obj.add(l); }
        e.label = l;
      }
      obstacles.push(e);
    }
    setObstacleTime(0);
    if (photo.visible) setPhoto(true, { look: photoLook });
    styleLabels();
  }

  function setObstacleTime(t) {
    for (const e of obstacles) {
      const { o } = e;
      if (!o.velocity || !o.center) continue;
      const p = { forward: o.center.forward + o.velocity.forward * t, right: o.center.right + o.velocity.right * t };
      const base = toThree(p, o.base_up ?? 0);
      e.obj.position.copy(base);
      if (e.ring) e.ring.position.set(base.x, 0.03, base.z);
      if (e.arrow) e.arrow.position.set(base.x, 0.15, base.z);
    }
  }

  function highlight(ids) { highlightIds = new Set(ids ?? []); styleLabels(); }

  // Obstacle labels: only the hovered one, the ones a selected/failed route
  // hits, and people whose keep-out reaches the landing spot.
  let hoverId = null;
  let targetPt = null;
  function styleLabels() {
    for (const e of obstacles) {
      if (!e.label) continue;
      const { o } = e;
      const hot = highlightIds.has(o.id);
      const nearPerson = o.type === 'person' && Boolean(targetPt) && Boolean(o.center)
        && Math.hypot(o.center.forward - targetPt.forward, o.center.right - targetPt.right) < SAFETY.pedestrianKeepOutM + 1.5;
      const hidden = e.obj.userData.lookHidden && !hot;
      e.label.visible = Boolean(!view.hop && !hidden && (hot || o.id === hoverId || nearPerson));
      e.label.element.className = `label3d obj${hot ? ' hot' : nearPerson ? ' person' : ''}`;
    }
  }

  function updateObstacleFx(dt, time) {
    for (const e of obstacles) {
      const hot = highlightIds.has(e.o.id);
      let flashK = 0;
      if (e.flashT !== null) { e.flashT += dt; flashK = Math.max(0, 1 - e.flashT / 2.2) * (0.6 + 0.4 * Math.sin(time * 12)); if (e.flashT > 2.2) e.flashT = null; }
      for (const { m, base, baseI } of e.mats) {
        if (hot) { m.emissive.set(COLORS.unsafe); m.emissiveIntensity = 0.55 + 0.25 * Math.sin(time * 6); }
        else if (flashK > 0) { m.emissive.set(COLORS.chosen); m.emissiveIntensity = flashK * 1.2; }
        else { m.emissive.copy(base); m.emissiveIntensity = baseI; }
      }
      if (e.ringMat) e.ringMat.color.set(hot ? COLORS.unsafe : COLORS.amber);
      if (e.ring && photoLook !== 'model') e.ring.visible = hot;
    }
  }

  // ---------------------------------------------------------------- target
  const targetGroup = new THREE.Group();
  const tRing = new THREE.Mesh(new THREE.RingGeometry(SAFETY.landingToleranceM - 0.12, SAFETY.landingToleranceM, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: COLORS.chosen, transparent: true, depthWrite: false }));
  const tPulse = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: COLORS.chosen, transparent: true, depthWrite: false }));
  const tDisc = new THREE.Mesh(new THREE.CircleGeometry(SAFETY.landingToleranceM, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: COLORS.chosen, transparent: true, opacity: 0.1, depthWrite: false }));
  // No vertical beam: from the driver's seat a 4 m pole reads as a giant line.
  targetGroup.add(tRing, tPulse, tDisc);
  targetGroup.position.y = 0.04;
  const tLabel = label('', 'target');
  tLabel.position.set(0, 0.6, 0);
  targetGroup.add(tLabel);
  targetGroup.visible = false;
  scene.add(targetGroup);

  // ---------------------------------------------------------------- landing zones
  // Instant landable-ground overlay (shared/landable.js): green tiles where the
  // parked car would clear every obstacle and person.
  let zoneMesh = null;
  function setZones(map) {
    if (zoneMesh) { scene.remove(zoneMesh); zoneMesh.geometry.dispose(); zoneMesh.material.dispose(); zoneMesh = null; }
    const ok = (map?.cells ?? []).filter((c) => c.ok);
    if (!ok.length) return;
    const size = map.step_m * 0.9;
    const geo = new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: '#2fd27a', transparent: true, opacity: 0.09, depthWrite: false });
    zoneMesh = new THREE.InstancedMesh(geo, mat, ok.length);
    const m = new THREE.Matrix4();
    ok.forEach((c, i) => { m.makeTranslation(c.right, 0.02, -c.forward); zoneMesh.setMatrixAt(i, m); });
    zoneMesh.renderOrder = -1;
    scene.add(zoneMesh);
  }

  function setTarget(t) {
    targetGroup.visible = Boolean(t);
    targetPt = t ?? null;
    styleLabels();
    if (!t) return;
    targetGroup.position.set(t.right, 0.04, -t.forward);
    tLabel.element.innerHTML = `${fmt(Math.hypot(t.forward, t.right), 1)} m`;
  }

  // ---------------------------------------------------------------- arcs
  const arcGroup = new THREE.Group();
  scene.add(arcGroup);
  const arcs = new Map(); // key → arc
  let view = { visibleRound: 1, selectedKey: null, chosenKey: null, hop: false };

  const pathPoints = (sim) => (sim?.samples ?? []).map((s) => toThree(s, s.up + CAR.height / 2));

  function markerFor(sim) {
    const c = (sim?.checks ?? []).find((x) => !x.pass && MARKER_CHECKS.includes(x.id) && typeof x.t === 'number');
    if (!c || !sim.samples?.length) return null;
    let best = sim.samples[0];
    for (const s of sim.samples) if (Math.abs(s.t - c.t) < Math.abs(best.t - c.t)) best = s;
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.28, 20, 14), new THREE.MeshBasicMaterial({ color: COLORS.unsafe })));
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: COLORS.unsafe, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.setScalar(2.2);
    g.add(glow);
    g.position.copy(toThree(best, best.up + CAR.height / 2));
    g.userData.obstacleId = c.obstacle_id;
    return g;
  }

  function addCandidate(c) {
    if (!c?.sim?.samples?.length || arcs.has(c.key)) return;
    const pts = pathPoints(c.sim);
    const geo = new LineGeometry().setPositions(pts.flatMap((p) => p.toArray()));
    const mat = lineMat({ color: c.status === 'unsafe' ? COLORS.unsafe : COLORS.safe, linewidth: 3, dashed: c.status === 'unsafe', dashSize: 0.6, gapSize: 0.35, opacity: 0.95 });
    const line = new Line2(geo, mat);
    line.computeLineDistances();
    geo.instanceCount = 0;
    arcGroup.add(line);
    const marker = markerFor(c.sim);
    // Spread labels along the arc (or at the failure point) so a fan stays readable.
    const slot = [0.42, 0.62, 0.32, 0.72][(arcs.size) % 4];
    const at = marker ? marker.position : pts[Math.round(slot * (pts.length - 1))];
    const lab = label('', c.status);
    lab.position.copy(at).add(new THREE.Vector3(0, 0.7, 0));
    arcGroup.add(lab);
    if (marker) arcGroup.add(marker);
    const arc = { ...c, line, mat, label: lab, marker, tube: null, grow: 0, segs: pts.length - 1, pts };
    arcs.set(c.key, arc);
    styleArcs();
  }

  function updateCandidate(c) {
    const a = arcs.get(c.key);
    if (!a) return addCandidate(c);
    Object.assign(a, { status: c.status, reason: c.reason, label_text: c.label_text, sim: c.sim ?? a.sim });
    styleArcs();
  }

  function ensureTube(a) {
    if (a.tube) return;
    const curve = new THREE.CatmullRomCurve3(a.pts);
    const segs = Math.max(40, a.pts.length * 2);
    const core = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 0.07, 10, false), new THREE.MeshBasicMaterial({ color: '#9cc7ff' }));
    const glow = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 0.3, 14, false), new THREE.MeshBasicMaterial({ color: COLORS.chosen, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false }));
    a.tube = new THREE.Group();
    a.tube.add(core, glow);
    a.tubeGlow = glow;
    arcGroup.add(a.tube);
  }

  function styleArcs() {
    const { visibleRound, selectedKey, chosenKey, hop } = view;
    for (const a of arcs.values()) {
      const current = a.round === visibleRound;
      const visible = a.round <= visibleRound;
      const chosen = a.key === chosenKey;
      const sel = a.key === selectedKey;
      const anySel = selectedKey && arcs.get(selectedKey)?.round === visibleRound;
      a.line.visible = visible && !chosen && !hop;
      a.mat.color.set(a.status === 'unsafe' ? COLORS.unsafe : COLORS.safe);
      a.mat.dashed = a.status === 'unsafe';
      a.mat.linewidth = sel ? 5 : 3;
      a.mat.opacity = !current ? 0.12 : anySel && !sel ? 0.45 : 0.95;
      if (chosen) ensureTube(a);
      if (a.tube) { a.tube.visible = chosen && visible; a.tubeGlow.visible = !hop; }
      if (a.marker) a.marker.visible = !hop && current && a.status === 'unsafe' && (!anySel || sel);
      // Only the selected / chosen arc carries a text label (no overlapping fan of labels).
      a.label.visible = current && !hop && (sel || chosen);
      const cls = chosen ? 'chosen' : a.status;
      const text = chosen ? `${a.id} · chosen` : a.status === 'unsafe' ? `${a.id} · ${shortReason(a.sim) ?? a.reason ?? 'unsafe'}` : `${a.id} · SAFE`;
      a.label.element.className = `label3d ${cls}`;
      a.label.element.textContent = text;
    }
    styleLabels();
  }

  function setPlanView(v) {
    view = { ...view, ...v };
    styleArcs();
  }

  function clearPlan() {
    for (const a of arcs.values()) {
      freeLineMat(a.mat);
      a.label.element.remove();
    }
    for (const c of [...arcGroup.children]) { arcGroup.remove(c); disposeTree(c); }
    arcs.clear();
    view = { visibleRound: 1, selectedKey: null, chosenKey: null, hop: false };
    highlight([]);
  }

  // ---------------------------------------------------------------- playback
  let play = null; // {sim, t, speed, chase, resolve, hold, keep}
  const camTween = { active: false, fromP: new THREE.Vector3(), toP: new THREE.Vector3(), fromT: new THREE.Vector3(), toT: new THREE.Vector3(), k: 0 };

  function sampleAt(samples, t) {
    if (t <= samples[0].t) return samples[0];
    const last = samples[samples.length - 1];
    if (t >= last.t) return last;
    let lo = 0, hi = samples.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; (samples[mid].t <= t ? (lo = mid) : (hi = mid)); }
    const a = samples[lo], b = samples[hi], f = (t - a.t) / (b.t - a.t || 1);
    const out = {};
    for (const k of ['t', 'forward', 'right', 'up', 'thrust_kN', 'air_kg']) out[k] = a[k] + ((b[k] ?? a[k]) - a[k]) * f;
    return out;
  }

  function placeCar(s, level = 0) {
    car.position.set(s.right, Math.max(0, s.up), -s.forward);
    car.userData.setThrust(level);
    shadow.position.set(car.position.x, 0.02, car.position.z);
    shadow.material.opacity = 0.55 * Math.max(0.15, 1 - car.position.y / 12);
    shadow.scale.setScalar(1 + car.position.y * 0.05);
  }

  function resetCar() {
    play = null;
    car.rotation.set(0, 0, 0);
    placeCar({ forward: 0, right: 0, up: 0 });
    setObstacleTime(0);
  }

  // Animate a route from sim.samples. chase: camera follows. keep: leave the
  // car where it landed (HOP); otherwise return to the start (replays).
  function playRoute(sim, { chase = false, speed = 1, keep = false, onTick } = {}) {
    if (!sim?.samples?.length) return Promise.resolve();
    if (play?.resolve) play.resolve();
    controls.enabled = !chase;
    if (chase) setPlanView({ hop: true });
    return new Promise((resolve) => {
      play = { sim, t: 0, speed, chase, resolve, hold: 0, keep, onTick, end: sim.samples[sim.samples.length - 1].t };
    });
  }

  function stepPlay(dt) {
    if (!play) return;
    const p = play;
    p.t += dt * p.speed;
    const s = sampleAt(p.sim.samples, Math.min(p.t, p.end));
    const flying = p.t < p.end;
    const level = flying ? (s.thrust_kN ?? 20) / (CAR.maxThrustN / 1000) : 0;
    placeCar(s, level);
    // Small visual pitch from forward acceleration (sim ignores tilt).
    const ahead = sampleAt(p.sim.samples, Math.min(p.t + 0.1, p.end));
    const vF = (ahead.forward - s.forward) / 0.1;
    car.rotation.x = THREE.MathUtils.lerp(car.rotation.x, flying ? THREE.MathUtils.clamp(-vF * 0.006, -0.08, 0.08) : 0, 0.1);
    if (flying) emit(level, dt);
    setObstacleTime(Math.min(p.t, p.end));
    p.onTick?.(s, p.t);
    if (p.chase && world) {
      // fixed camera: the generated picture only matches this pose
    } else if (p.chase && viewName === 'pov') {
      // Tripod shot: stay at the rig point (footage undistorted) and pan to
      // follow the car; moving the eye would smear the projection.
      const k = 1 - Math.exp(-dt * 4);
      camera.position.lerp(new THREE.Vector3(...VIEWS.pov.pos), k);
      const away = car.position.clone().setY(0).length();
      const look = away < 3 ? new THREE.Vector3(...VIEWS.pov.target) : car.position.clone().add(new THREE.Vector3(0, 0.4, 0));
      controls.target.lerp(look, k);
    } else if (p.chase) {
      const desired = car.position.clone().add(new THREE.Vector3(2.5, 3.6 + car.position.y * 0.15, 10.5));
      const k = 1 - Math.exp(-dt * 3.5);
      camera.position.lerp(desired, k);
      controls.target.lerp(car.position.clone().add(new THREE.Vector3(0, 0.8, -7)), k);
    }
    if (!flying) {
      p.hold += dt;
      if (p.hold > 0.9) {
        play = null;
        controls.enabled = !world;
        if (p.chase) setPlanView({ hop: false });
        if (p.chase && viewName !== 'pov') controls.target.copy(car.position).add(new THREE.Vector3(0, 0.6, 0));
        if (!p.keep) {
          car.rotation.set(0, 0, 0); placeCar({ forward: 0, right: 0, up: 0 }); setObstacleTime(0);
          if (p.chase && viewName === 'pov') setView('pov');
        }
        p.resolve();
      }
    }
  }

  function setView(name) {
    viewName = VIEWS[name] ? name : 'overview';
    const v = VIEWS[viewName];
    applyViewMode();
    camTween.active = true;
    camTween.k = 0;
    // POV stays at the rig point: the only pose where the footage lines up.
    const off = new THREE.Vector3();
    camTween.fromP.copy(camera.position); camTween.toP.set(...v.pos).add(off);
    camTween.fromT.copy(controls.target); camTween.toT.set(...v.target).add(off);
  }

  // Record the chase-cam hop as webm (for the Omni stretch, web/video-panel.js).
  async function recordHop(sim) {
    const stream = renderer.domElement.captureStream(30);
    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6e6 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    resetCar();
    if (viewName === 'pov') { camera.position.set(...VIEWS.pov.pos); controls.target.set(...VIEWS.pov.target); }
    else { camera.position.set(2.5, 3.6, 10.5); controls.target.set(0, 0.8, -7); }
    rec.start();
    await playRoute(sim, { chase: true, keep: true });
    rec.stop();
    await stopped;
    return new Blob(chunks, { type: 'video/webm' });
  }

  // ---------------------------------------------------------------- AI world view
  // A photoreal picture generated for the fixed chase camera (server/worldview.js)
  // replaces the projected footage as the backdrop; tiles, flight paths, the
  // target and the car are still drawn in 3D on top, from the same camera.
  let world = null; // {tex, fog}
  const poseCamera = () => {
    camera.position.set(...VIEWS.pov.pos);
    controls.target.set(...VIEWS.pov.target);
    camera.lookAt(controls.target);
    camTween.active = false;
  };
  // Layout render for the image model: plain model look, only the street + car.
  function captureGuide() {
    const wasPhoto = photo.visible, look = photoLook;
    if (wasPhoto) setPhoto(false);
    const hidden = scene.children.filter((c) => c.visible && !c.isLight && c !== siteGroup && c !== ground && c !== car);
    for (const c of hidden) c.visible = false;
    const carWas = car.visible;
    car.visible = true;
    poseCamera();
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/jpeg', 0.92);
    for (const c of hidden) c.visible = true;
    car.visible = carWas;
    if (wasPhoto) setPhoto(true, { look });
    return url;
  }
  async function setWorldImage(url) {
    if (!url) {
      if (!world) return;
      scene.background = new THREE.Color(BG);
      scene.fog = world.fog;
      world.tex.dispose();
      world = null;
      siteGroup.visible = ground.visible = grid.visible = true;
      controls.enabled = !play;
      return;
    }
    const tex = await new THREE.TextureLoader().loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    if (world) world.tex.dispose();
    world = { tex, fog: world?.fog ?? scene.fog };
    scene.background = tex;
    scene.fog = null;
    photo.setVisible(false);
    siteGroup.visible = ground.visible = grid.visible = false;
    controls.enabled = false;
    poseCamera();
  }

  // ---------------------------------------------------------------- input
  const ray = new THREE.Raycaster();
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || play) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 600;
    down = null;
    if (moved > 7 || !quick) return;
    const r = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(groundPlane, hit)) return;
    const t = { forward: Math.round(-hit.z * 10) / 10, right: Math.round(hit.x * 10) / 10 };
    if (Math.hypot(t.forward, t.right) < 3 || Math.abs(t.forward) > 80 || Math.abs(t.right) > 40) return;
    onTap?.(t);
  });

  // Hover an obstacle to see its label.
  let hoverQueued = null;
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (e.buttons || play) return;
    if (!hoverQueued) requestAnimationFrame(() => { pickHover(hoverQueued); hoverQueued = null; });
    hoverQueued = { x: e.clientX, y: e.clientY };
  });
  renderer.domElement.addEventListener('pointerleave', () => { if (hoverId) { hoverId = null; styleLabels(); } });
  function pickHover(pt) {
    if (!pt) return;
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((pt.x - r.left) / r.width) * 2 - 1, -((pt.y - r.top) / r.height) * 2 + 1), camera);
    const objs = obstacles.filter((e) => e.label && e.obj.visible).map((e) => e.obj);
    const hit = ray.intersectObjects(objs, true)[0];
    let o = hit?.object;
    while (o && !o.userData.obstacle) o = o.parent;
    const id = o?.userData.obstacle?.id ?? null;
    if (id !== hoverId) { hoverId = id; styleLabels(); }
  }

  // ---------------------------------------------------------------- loop
  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    labels.setSize(w, h);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    for (const m of lineMats) m.resolution.set(w, h);
    pMat.uniforms.uScale.value = (h * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov * Math.PI) / 360));
  }
  new ResizeObserver(resize).observe(container);
  resize();

  const timer = new THREE.Timer();
  let time = 0;
  renderer.setAnimationLoop((ts) => {
    timer.update(ts);
    const dt = Math.min(0.05, timer.getDelta());
    time += dt;
    // pulse target
    const ph = (time * 0.9) % 1;
    tPulse.scale.setScalar(0.3 + ph * 1.4);
    tPulse.material.opacity = (1 - ph) * 0.8;
    tRing.material.opacity = 0.75 + 0.25 * Math.sin(time * 3);
    // grow arcs in
    for (const a of arcs.values()) {
      if (a.grow < 1) { a.grow = Math.min(1, a.grow + dt / 0.7); a.line.geometry.instanceCount = Math.ceil(a.segs * a.grow); }
      if (a.tubeGlow?.visible) a.tubeGlow.material.opacity = 0.2 + 0.12 * Math.sin(time * 3);
      if (a.marker?.visible) a.marker.children[1].scale.setScalar(1.8 + 0.5 * Math.sin(time * 6));
    }
    if (camTween.active && !play?.chase) {
      camTween.k = Math.min(1, camTween.k + dt / 0.8);
      const e = 1 - (1 - camTween.k) ** 3;
      camera.position.lerpVectors(camTween.fromP, camTween.toP, e);
      controls.target.lerpVectors(camTween.fromT, camTween.toT, e);
      if (camTween.k >= 1) camTween.active = false;
    }
    stepPlay(dt);
    stepParticles(dt);
    car.userData.step?.(dt);
    updateObstacleFx(dt, time);
    if (!play) car.userData.setThrust(0);
    // The AI picture already shows the parked car; draw ours once it moves.
    // and in the cabin POV we're sitting in it.
    if (world) car.visible = shadow.visible = Boolean(play) || car.position.lengthSq() > 0.01;
    else car.visible = shadow.visible = viewName !== 'pov' || car.position.distanceTo(camera.position) > 2.5;
    controls.update();
    // Hide any obstacle the camera is inside (e.g. a tree canopy behind the car).
    for (const c of siteGroup.children) {
      if (!c.userData.box) continue;
      const shown = !c.userData.lookHidden || highlightIds.has(c.userData.obstacle?.id);
      c.visible = shown && !c.userData.box.containsPoint(camera.position);
    }
    renderer.render(scene, camera);
    labels.render(scene, camera);
  });

  placeCar({ forward: 0, right: 0, up: 0 });
  applyViewMode();

  return {
    setFootage: photo.setFootage, setPhoto, captureGuide, setWorldImage, get world() { return Boolean(world); }, get photo() { return photo.visible; },
    setSite, setTarget, setZones, addCandidate, updateCandidate, setPlanView, clearPlan,
    playRoute, resetCar, setView, highlight, recordHop, setObstacleTime,
    setCarVariant(v) {
      car.userData.setVariant(v);
      if (viewName === 'pov') setView('overview');
    },
    get carVariant() { return car.userData.variant; },
    get playing() { return Boolean(play); },
    get view() { return viewName; },
    canvas: renderer.domElement,
  };
}
