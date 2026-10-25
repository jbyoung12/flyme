// Procedural white flying car (no logos): wedge body, glass canopy, 4 wheels,
// 10 perimeter cold-gas nozzles that glow with thrust. Group origin = center
// of the footprint on the ground, nose toward −z (forward). Sized from CAR.
import * as THREE from 'three';
import { CAR } from '../shared/constants.js';
import { extrudeProfile } from './site-meshes.js';

const BODY = [[0.5, 0.2], [0.49, 0.3], [0.4, 0.38], [0.12, 0.5], [-0.3, 0.58], [-0.47, 0.6], [-0.5, 0.55], [-0.5, 0.24], [-0.4, 0.18], [0.4, 0.18]];
const CANOPY = [[0.16, 0.48], [0.0, 0.88], [-0.12, 0.96], [-0.26, 0.94], [-0.4, 0.57]];

let glowTex = null;
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

export function buildFlyingCar() {
  const { length: L, width: W, height: H } = CAR;
  const car = new THREE.Group();
  car.name = 'flying-car';

  const paint = new THREE.MeshPhysicalMaterial({ color: '#f4f6f8', roughness: 0.28, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.12 });
  const body = new THREE.Mesh(extrudeProfile(BODY, L, H, W, 0.12), paint);
  body.castShadow = true;
  car.add(body);

  const glass = new THREE.MeshPhysicalMaterial({ color: '#1d2c40', roughness: 0.08, metalness: 0.6, transparent: true, opacity: 0.92, clearcoat: 1 });
  const canopy = new THREE.Mesh(extrudeProfile(CANOPY, L, H, W * 0.7, 0.16), glass);
  car.add(canopy);

  // Dark side skirt line + light bars (no branding)
  const trim = new THREE.MeshStandardMaterial({ color: '#1a1d22', roughness: 0.6 });
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(W + 0.02, 0.06, L * 0.86), trim);
  skirt.position.y = 0.22;
  car.add(skirt);
  const lightMat = new THREE.MeshBasicMaterial({ color: '#e8f1ff' });
  const head = new THREE.Mesh(new THREE.BoxGeometry(W * 0.8, 0.035, 0.03), lightMat);
  head.position.set(0, H * 0.36, -L / 2 - 0.005);
  car.add(head);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(W * 0.86, 0.04, 0.03), new THREE.MeshBasicMaterial({ color: '#ff3048' }));
  tail.position.set(0, H * 0.55, L / 2 + 0.005);
  car.add(tail);

  // Wheels
  const r = 0.34;
  const tire = new THREE.MeshStandardMaterial({ color: '#111316', roughness: 0.85 });
  const rim = new THREE.MeshStandardMaterial({ color: '#8d939c', roughness: 0.3, metalness: 0.8 });
  const tireGeo = new THREE.CylinderGeometry(r, r, 0.26, 28).rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(r * 0.62, r * 0.62, 0.27, 20).rotateZ(Math.PI / 2);
  for (const f of [L * 0.33, -L * 0.31]) for (const s of [-1, 1]) {
    const w = new THREE.Group();
    w.add(new THREE.Mesh(tireGeo, tire), new THREE.Mesh(rimGeo, rim));
    w.position.set(s * (W / 2 - 0.1), r, -f);
    car.add(w);
  }

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

  // Soft ground shadow blob (cheaper than shadow maps, reads well on dark ground)
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(W * 1.5, L * 1.25).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: glowTexture(), color: '#000000', transparent: true, opacity: 0.55, depthWrite: false }),
  );
  shadow.renderOrder = 1;

  car.userData = {
    nozzles,
    shadow,
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
