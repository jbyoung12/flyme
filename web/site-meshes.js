// Site → Three.js meshes. Two styles:
//   'fsd'      main view: FSD-like gray models, amber people (scene.js)
//   'critique' loop-1 renders: one flat color per obstacle type (render-views.js)
// Frame (PLAN §6.1): three x = right, y = up, z = −forward; headings clockwise
// from forward → rotation.y = −heading.
import * as THREE from 'three';

export const toThree = (p, up = p.up ?? 0) => new THREE.Vector3(p.right, up, -p.forward);
export const fromThree = (v) => ({ forward: -v.z, right: v.x, up: v.y });
export const headingRotY = (deg) => (-(deg ?? 0) * Math.PI) / 180;

export const TYPE_COLORS = {
  vehicle: '#2f7bff',
  pole: '#ff9a1f',
  sign: '#ffe03a',
  tree_trunk: '#8b5a2b',
  tree_canopy: '#22c55e',
  wire: '#ff2d55',
  person: '#ff3df2',
  building: '#b9bec8',
  barrier: '#14d8c4',
  other: '#a855f7',
};

const SURFACE_FSD = { road: '#15181d', sidewalk: '#22252b', parking: '#1a1d22', grass: '#131c16', plaza: '#1f1e24', water: '#0e1824', other: '#191a1d' };
const SURFACE_CRITIQUE = { road: '#3a3d42', sidewalk: '#6d6f73', parking: '#4a4c52', grass: '#3c5a3a', plaza: '#5f5a66', water: '#2f4f6f', other: '#55565a' };

// Side profile of a generic car (x = forward fraction, y = height fraction),
// extruded across the width. Nose at +x.
const CAR_PROFILE = [[0.5, 0.14], [0.5, 0.44], [0.3, 0.55], [0.12, 0.93], [-0.3, 0.97], [-0.46, 0.62], [-0.5, 0.55], [-0.5, 0.14]];

export function extrudeProfile(profile, length, height, width, bevel = 0.06) {
  const shape = new THREE.Shape(profile.map(([x, y]) => new THREE.Vector2(x * length, y * height)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: width - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 4 });
  geo.rotateY(Math.PI / 2); // shape x → −z (forward), extrusion → +x (right)
  geo.translate(-(width - 2 * bevel) / 2, 0, 0);
  geo.computeVertexNormals();
  return geo;
}

function vehicleMesh(o, mat, style) {
  const { length, width, height } = o.size;
  const g = new THREE.Group();
  if (style === 'critique') {
    g.add(new THREE.Mesh(extrudeProfile(CAR_PROFILE, length, height, width, 0.04), mat));
  } else {
    const body = new THREE.Mesh(extrudeProfile(CAR_PROFILE, length, height, width), mat);
    body.castShadow = true;
    g.add(body);
    const tire = new THREE.MeshStandardMaterial({ color: '#16181b', roughness: 0.9 });
    const r = Math.min(0.36, height * 0.2);
    const wheel = new THREE.CylinderGeometry(r, r, 0.22, 18).rotateZ(Math.PI / 2);
    for (const f of [0.33, -0.33]) for (const s of [-1, 1]) {
      const w = new THREE.Mesh(wheel, tire);
      w.position.set(s * (width / 2 - 0.08), r, -f * length);
      g.add(w);
    }
  }
  return g;
}

// One obstacle → Object3D at its static pose (base). Moving obstacles are
// translated later by the caller.
export function obstacleObject(o, style = 'fsd') {
  const critique = style === 'critique';
  const color = critique ? TYPE_COLORS[o.type] ?? TYPE_COLORS.other : fsdColor(o.type);
  const mat = critique
    ? new THREE.MeshLambertMaterial({ color })
    : new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.15, transparent: o.type === 'tree_canopy', opacity: o.type === 'tree_canopy' ? 0.82 : 1 });
  const base = o.base_up ?? 0;
  let obj;
  if (o.shape === 'wire') {
    const a = toThree(o.from), b = toThree(o.to);
    const r = critique ? 0.14 : 0.035;
    const geo = new THREE.TubeGeometry(new THREE.LineCurve3(a, b), 8, r, 6, false);
    obj = new THREE.Mesh(geo, critique ? mat : new THREE.MeshBasicMaterial({ color: '#d7dbe2', transparent: true, opacity: 0.85 }));
  } else if (o.shape === 'box') {
    if (o.type === 'vehicle') obj = vehicleMesh(o, mat, style);
    else {
      const { length, width, height } = o.size;
      const geo = new THREE.BoxGeometry(width, height, length).translate(0, height / 2, 0);
      obj = new THREE.Mesh(geo, mat);
    }
    obj.position.set(o.center.right, base, -o.center.forward);
    obj.rotation.y = headingRotY(o.heading_deg);
  } else {
    // cylinder
    const { radius: r, height: h } = o;
    let geo;
    if (o.type === 'person') geo = new THREE.CapsuleGeometry(Math.max(0.18, r * 0.8), Math.max(0.2, h - 2 * r * 0.8), 6, 14).translate(0, h / 2, 0);
    else if (o.type === 'tree_canopy' && !critique) geo = new THREE.SphereGeometry(1, 24, 16).scale(r, h / 2, r).translate(0, h / 2, 0);
    else geo = new THREE.CylinderGeometry(r, r, h, Math.max(12, Math.round(r * 40))).translate(0, h / 2, 0);
    if (o.type === 'person' && !critique) {
      mat.color.set('#ffb020');
      mat.emissive = new THREE.Color('#ff9800');
      mat.emissiveIntensity = 0.35;
    }
    obj = new THREE.Mesh(geo, mat);
    obj.position.set(o.center.right, base, -o.center.forward);
  }
  obj.userData.obstacle = o;
  return obj;
}

function fsdColor(type) {
  return { vehicle: '#8a9099', pole: '#7a8088', sign: '#9aa0a8', tree_trunk: '#6b6056', tree_canopy: '#56705e', person: '#ffb020', building: '#3a3f47', barrier: '#6c727b', other: '#7d838c' }[type] ?? '#7d838c';
}

// Surface polygons as flat tinted ground patches.
export function surfaceObjects(site, style = 'fsd') {
  const colors = style === 'critique' ? SURFACE_CRITIQUE : SURFACE_FSD;
  return (site.surfaces ?? []).map((s, i) => {
    const shape = new THREE.Shape(s.polygon.map((p) => new THREE.Vector2(p.right, p.forward)));
    const geo = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2); // (right, forward) → (x, −z)
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: colors[s.type] ?? colors.other }));
    mesh.position.y = 0.002 + i * 0.001;
    mesh.receiveShadow = true;
    return mesh;
  });
}

// Recursively dispose geometries/materials/textures under an object.
export function disposeTree(root) {
  root.traverse((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) { m.map?.dispose?.(); m.dispose?.(); }
  });
}
