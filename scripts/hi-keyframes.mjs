// Backfill full-res 3D-view keyframes (frames/<cam>.hi.jpg) for sites that
// were ingested before hiKeyframe existed. Same instant as the 720p keyframe.
// Usage: node scripts/hi-keyframes.mjs [siteId…]
import fs from 'node:fs';
import path from 'node:path';
import { hiKeyframe } from '../server/ingest.js';
import { readRun } from '../server/runs.js';

const SITES = path.resolve('sites');
const ids = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(SITES).filter((d) => fs.existsSync(path.join(SITES, d, 'rig.json')));
for (const id of ids) {
  const rig = JSON.parse(fs.readFileSync(path.join(SITES, id, 'rig.json'), 'utf8'));
  const kf = readRun(id, 'keyframes.json') ?? {};
  for (const cam of rig.cameras) {
    const src = ['mov', 'MOV'].map((e) => path.join(SITES, id, `${cam.id}.${e}`)).find((f) => fs.existsSync(f)) ?? null;
    if (!src || !Number.isFinite(kf[cam.id])) { console.log(`${id}/${cam.id}: skipped (${src ? 'no keyframe_t' : 'no source clip'})`); continue; }
    const out = await hiKeyframe(id, cam, src, kf[cam.id]);
    console.log(`${id}/${cam.id}: ${out}`);
  }
}
