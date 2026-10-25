// Sandbox tool: pixel (ground-contact point) → car-frame metres.
//   node ground.mjs <camera> <x> <y> [horizon_y]      (x, y in 0..1 of the frame, y down)
import fs from 'node:fs';
import { groundPoint } from './anchors.js';
const rig = JSON.parse(fs.readFileSync(new URL('./rig.json', import.meta.url)));
const [camId, x, y, hz] = process.argv.slice(2);
const cam = rig.cameras.find((c) => c.id === camId);
if (!cam) { console.log(JSON.stringify({ error: `unknown camera ${camId}` })); process.exit(0); }
const g = groundPoint(cam, rig.aspect ?? 16 / 9, Number(x), Number(y), hz === undefined ? undefined : Number(hz));
console.log(JSON.stringify(g ? { forward: +g.forward.toFixed(2), right: +g.right.toFixed(2), dist_m: +g.dist.toFixed(2) } : { error: 'point is at/above the horizon or beyond 40 m — not measurable' }));
