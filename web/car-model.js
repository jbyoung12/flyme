// Procedural flying cars:
//   - 'roadster': white wedge coupe
//   - 'waymo':    white 5th-gen Waymo I-PACE SUV with roof rack, spinning 360° LiDAR dome & 4 corner sensor pods
//   - 'ojai':     robin's-egg-blue 6th-gen Waymo Ojai (Zeekr) capsule minivan with wrap-around glass & roof sensor halo
// All share the 10 perimeter cold-gas nozzles that glow with thrust.
import * as THREE from 'three';
import { CAR } from '../shared/constants.js';
import { extrudeProfile } from './site-meshes.js';

const ROADSTER_BODY = [[0.5, 0.2], [0.49, 0.3], [0.4, 0.38], [0.12, 0.5], [-0.3, 0.58], [-0.47, 0.6], [-0.5, 0.55], [-0.5, 0.24], [-0.4, 0.18], [0.4, 0.18]];
const ROADSTER_CANOPY = [[0.16, 0.48], [0.0, 0.88], [-0.12, 0.96], [-0.26, 0.94], [-0.4, 0.57]];

// Waymo 5th-gen (Jaguar I-PACE crossover SUV profile)
const WAYMO_BODY = [[0.5, 0.22], [0.48, 0.44], [0.34, 0.54], [0.12, 0.56], [-0.44, 0.60], [-0.5, 0.52], [-0.5, 0.24], [-0.38, 0.18], [0.38, 0.18]];
const WAYMO_CANOPY = [[0.24, 0.52], [0.08, 0.96], [-0.32, 0.98], [-0.44, 0.58]];

// Waymo 6th-gen "Ojai" (symmetrical rounded-capsule electric minivan)
const OJAI_BODY = [[0.49, 0.22], [0.5, 0.48], [0.44, 0.64], [-0.44, 0.64], [-0.5, 0.48], [-0.49, 0.22], [-0.38, 0.18], [0.38, 0.18]];
const OJAI_CANOPY = [[0.42, 0.60], [0.32, 0.98], [-0.32, 0.98], [-0.42, 0.60]];

export const CAR_VARIANTS = {
  roadster: { id: 'roadster', label: 'Roadster', desc: 'a sleek white aerodynamic cold-gas thruster sports coupe' },
  waymo: { id: 'waymo', label: 'Waymo', desc: 'a white Waymo autonomous Jaguar I-PACE SUV with a spinning black roof LiDAR dome and corner sensor pods' },
  ojai: { id: 'ojai', label: 'Waymo Ojai', desc: 'a powder-blue 6th-generation Waymo Ojai autonomous capsule minivan with wrap-around glass and a roof LiDAR sensor array' },
};

let glowTex = null;
let shadowTex = null;
function shadowTexture() {
  if (shadowTex) return shadowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, '#fff');
  grad.addColorStop(0.45, '#888');
  grad.addColorStop(1, '#000');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  shadowTex = new THREE.CanvasTexture(c);
  return shadowTex;
}

export function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(200,230,255,0.6)');
  grad.addColorStop(1, 'rgba(120,180,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

// Nozzle positions in car-local three coords (x right, y up, z −forward).
export function nozzlePositions() {
  const L = CAR.length, W = CAR.width, y = 0.26;
  const pts = [];
  for (const f of [-1.45, 0, 1.45]) for (const s of [-1, 1]) pts.push(new THREE.Vector3(s * (W / 2 + 0.02), y, -f));
  for (const s of [-1, 1]) {
    pts.push(new THREE.Vector3(s * 0.55, y, -(L / 2 + 0.02)));
    pts.push(new THREE.Vector3(s * 0.55, y, L / 2 + 0.02));
  }
  return pts; // 10
}

function buildWheels(group, L, W, r = 0.34, rimColor = '#8d939c') {
  const tire = new THREE.MeshStandardMaterial({ color: '#111316', roughness: 0.85 });
  const rim = new THREE.MeshStandardMaterial({ color: rimColor, roughness: 0.3, metalness: 0.8 });
  const tireGeo = new THREE.CylinderGeometry(r, r, 0.26, 28).rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(r * 0.62, r * 0.62, 0.27, 20).rotateZ(Math.PI / 2);
  for (const f of [L * 0.33, -L * 0.31]) for (const s of [-1, 1]) {
    const w = new THREE.Group();
    w.add(new THREE.Mesh(tireGeo, tire), new THREE.Mesh(rimGeo, rim));
    w.position.set(s * (W / 2 - 0.1), r, -f);
    group.add(w);
  }
}

function buildLidarDome(roofY, { haloWidth = 0.9, haloLength = 1.25, accentColor = '#00e5ff' } = {}) {
  const rig = new THREE.Group();
  const darkMat = new THREE.MeshStandardMaterial({ color: '#14171c', roughness: 0.35, metalness: 0.5 });
  const cyanMat = new THREE.MeshBasicMaterial({ color: accentColor });

  // Roof sensor base / halo fairing
  const base = new THREE.Mesh(new THREE.BoxGeometry(haloWidth, 0.09, haloLength), darkMat);
  base.position.set(0, roofY + 0.04, 0.08);
  rig.add(base);

  // Spinning 360° roof LiDAR turret
  const spinner = new THREE.Group();
  spinner.position.set(0, roofY + 0.16, 0.05);
  const puck = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.22, 0.18, 24), darkMat);
  spinner.add(puck);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.19, 0.03, 24), new THREE.MeshStandardMaterial({ color: '#eef4ff', roughness: 0.2 }));
  cap.position.y = 0.09;
  spinner.add(cap);
  // Glowing cyan laser window band + directional beam indicator
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.205, 0.205, 0.045, 24), cyanMat);
  spinner.add(band);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, 0.26), cyanMat);
  fin.position.set(0, 0.02, -0.06);
  spinner.add(fin);

  rig.add(spinner);
  return { rig, spinner };
}

function buildBodyVariant(variant) {
  const { length: L, width: W, height: H } = CAR;
  const g = new THREE.Group();
  let spinner = null;

  if (variant === 'waymo') {
    const suvH = H * 1.22;
    const paint = new THREE.MeshPhysicalMaterial({ color: '#f6f8fa', roughness: 0.24, metalness: 0.08, clearcoat: 1, clearcoatRoughness: 0.1 });
    const body = new THREE.Mesh(extrudeProfile(WAYMO_BODY, L, suvH, W, 0.1), paint);
    body.castShadow = true;
    g.add(body);

    const glass = new THREE.MeshPhysicalMaterial({ color: '#162232', roughness: 0.08, metalness: 0.65, transparent: true, opacity: 0.94, clearcoat: 1 });
    const canopy = new THREE.Mesh(extrudeProfile(WAYMO_CANOPY, L, suvH, W * 0.78, 0.12), glass);
    g.add(canopy);

    const trim = new THREE.MeshStandardMaterial({ color: '#16191f', roughness: 0.55 });
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(W + 0.03, 0.08, L * 0.88), trim);
    skirt.position.y = 0.22;
    g.add(skirt);

    // Waymo teal-blue side badge strip
    const badgeMat = new THREE.MeshBasicMaterial({ color: '#00bfa5' });
    const badge = new THREE.Mesh(new THREE.BoxGeometry(W + 0.035, 0.035, 0.75), badgeMat);
    badge.position.set(0, 0.58, -0.15);
    g.add(badge);

    // Headlights + taillights
    const head = new THREE.Mesh(new THREE.BoxGeometry(W * 0.82, 0.045, 0.03), new THREE.MeshBasicMaterial({ color: '#e8f4ff' }));
    head.position.set(0, suvH * 0.42, -L / 2 - 0.005);
    g.add(head);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(W * 0.86, 0.045, 0.03), new THREE.MeshBasicMaterial({ color: '#ff3048' }));
    tail.position.set(0, suvH * 0.52, L / 2 + 0.005);
    g.add(tail);

    // 4 corner Perimeter LiDAR pods (front fenders + rear corners) + front nose radar
    const podGeo = new THREE.CylinderGeometry(0.085, 0.095, 0.11, 16);
    for (const [x, y, z] of [
      [-W * 0.48, 0.66, -L * 0.36],
      [W * 0.48, 0.66, -L * 0.36],
      [-W * 0.46, 0.68, L * 0.42],
      [W * 0.46, 0.68, L * 0.42],
      [0, 0.52, -L * 0.5],
    ]) {
      const pod = new THREE.Mesh(podGeo, trim);
      pod.position.set(x, y, z);
      g.add(pod);
    }

    const dome = buildLidarDome(suvH * 0.96, { haloWidth: 0.88, haloLength: 1.35, accentColor: '#00e5ff' });
    g.add(dome.rig);
    spinner = dome.spinner;
    buildWheels(g, L, W, 0.36);
  } else if (variant === 'ojai') {
    // Waymo 6th-gen "Ojai" (Zeekr boxy robin's-egg-blue robotaxi minivan)
    const vanH = H * 1.32;
    const paint = new THREE.MeshPhysicalMaterial({ color: '#7ab3d4', roughness: 0.25, metalness: 0.12, clearcoat: 1, clearcoatRoughness: 0.12 });
    const body = new THREE.Mesh(extrudeProfile(OJAI_BODY, L, vanH, W * 1.02, 0.08), paint);
    body.castShadow = true;
    g.add(body);

    const glass = new THREE.MeshPhysicalMaterial({ color: '#121b26', roughness: 0.07, metalness: 0.65, transparent: true, opacity: 0.95, clearcoat: 1 });
    const canopy = new THREE.Mesh(extrudeProfile(OJAI_CANOPY, L, vanH, W * 0.88, 0.1), glass);
    g.add(canopy);

    // Dark lower bumper + sliding door track seam
    const trim = new THREE.MeshStandardMaterial({ color: '#14181f', roughness: 0.5 });
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(W + 0.05, 0.1, L * 0.94), trim);
    skirt.position.y = 0.22;
    g.add(skirt);
    const doorTrack = new THREE.Mesh(new THREE.BoxGeometry(W + 0.055, 0.025, L * 0.55), trim);
    doorTrack.position.set(0, 0.62, 0);
    g.add(doorTrack);

    // Full-width LED light bars front and rear
    const head = new THREE.Mesh(new THREE.BoxGeometry(W * 0.9, 0.05, 0.03), new THREE.MeshBasicMaterial({ color: '#eef7ff' }));
    head.position.set(0, vanH * 0.45, -L / 2 - 0.01);
    g.add(head);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(W * 0.9, 0.05, 0.03), new THREE.MeshBasicMaterial({ color: '#ff3048' }));
    tail.position.set(0, vanH * 0.48, L / 2 + 0.01);
    g.add(tail);

    // Corner sensor pods on front/rear roofline & fenders
    const podGeo = new THREE.CylinderGeometry(0.08, 0.09, 0.1, 16);
    for (const [x, y, z] of [
      [-W * 0.49, 0.68, -L * 0.38],
      [W * 0.49, 0.68, -L * 0.38],
      [-W * 0.49, 0.68, L * 0.38],
      [W * 0.49, 0.68, L * 0.38],
    ]) {
      const pod = new THREE.Mesh(podGeo, trim);
      pod.position.set(x, y, z);
      g.add(pod);
    }

    const dome = buildLidarDome(vanH * 0.96, { haloWidth: 1.15, haloLength: 1.9, accentColor: '#38bdf8' });
    g.add(dome.rig);
    spinner = dome.spinner;
    buildWheels(g, L, W, 0.35, '#2b313b');
  } else {
    // Default 'roadster'
    const paint = new THREE.MeshPhysicalMaterial({ color: '#f4f6f8', roughness: 0.28, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.12 });
    const body = new THREE.Mesh(extrudeProfile(ROADSTER_BODY, L, H, W, 0.12), paint);
    body.castShadow = true;
    g.add(body);

    const glass = new THREE.MeshPhysicalMaterial({ color: '#1d2c40', roughness: 0.08, metalness: 0.6, transparent: true, opacity: 0.92, clearcoat: 1 });
    const canopy = new THREE.Mesh(extrudeProfile(ROADSTER_CANOPY, L, H, W * 0.7, 0.16), glass);
    g.add(canopy);

    const trim = new THREE.MeshStandardMaterial({ color: '#1a1d22', roughness: 0.6 });
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(W + 0.02, 0.06, L * 0.86), trim);
    skirt.position.y = 0.22;
    g.add(skirt);
    const lightMat = new THREE.MeshBasicMaterial({ color: '#e8f1ff' });
    const head = new THREE.Mesh(new THREE.BoxGeometry(W * 0.8, 0.035, 0.03), lightMat);
    head.position.set(0, H * 0.36, -L / 2 - 0.005);
    g.add(head);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(W * 0.86, 0.04, 0.03), new THREE.MeshBasicMaterial({ color: '#ff3048' }));
    tail.position.set(0, H * 0.55, L / 2 + 0.005);
    g.add(tail);

    buildWheels(g, L, W, 0.34);
  }

  return { group: g, spinner };
}

export function buildFlyingCar(initialVariant = 'roadster') {
  const { length: L, width: W } = CAR;
  const car = new THREE.Group();
  car.name = 'flying-car';

  let bodyHolder = null;
  let activeSpinner = null;
  let currentVariant = initialVariant;

  function setVariant(v) {
    const next = CAR_VARIANTS[v] ? v : 'roadster';
    currentVariant = next;
    if (bodyHolder) car.remove(bodyHolder);
    const built = buildBodyVariant(next);
    bodyHolder = built.group;
    activeSpinner = built.spinner;
    car.add(bodyHolder);
  }

  setVariant(initialVariant);

  // Nozzles: small dark ports + additive glow sprites driven by setThrust()
  const nozzles = [];
  const portGeo = new THREE.CylinderGeometry(0.07, 0.09, 0.06, 12);
  const portMat = new THREE.MeshStandardMaterial({ color: '#2a2f37', emissive: '#4aa3ff', emissiveIntensity: 0, roughness: 0.4 });
  for (const p of nozzlePositions()) {
    const port = new THREE.Mesh(portGeo, portMat);
    port.position.copy(p);
    car.add(port);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#bfe0ff', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.copy(p).add(new THREE.Vector3(0, -0.08, 0));
    glow.scale.setScalar(0.6);
    car.add(glow);
    nozzles.push({ local: p.clone(), glow });
  }

  // Soft ground shadow blob
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(W * 1.5, L * 1.25).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ alphaMap: shadowTexture(), color: '#000000', transparent: true, opacity: 0.55, depthWrite: false }),
  );
  shadow.renderOrder = 1;

  car.userData = {
    nozzles,
    shadow,
    get variant() { return currentVariant; },
    setVariant,
    step(dt) {
      if (activeSpinner) activeSpinner.rotation.y += dt * 12; // 10 Hz roof LiDAR spin
    },
    // level 0..1 (fraction of max thrust)
    setThrust(level) {
      const k = Math.max(0, Math.min(1, level));
      portMat.emissiveIntensity = k * 2.5;
      for (const n of nozzles) {
        n.glow.material.opacity = k > 0.01 ? 0.35 + 0.65 * k : 0;
        n.glow.scale.setScalar(0.35 + 0.9 * k + Math.random() * 0.15 * k);
      }
    },
  };
  return car;
}
