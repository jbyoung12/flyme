// Stage C (PLAN.md §4): one loop-1 round. Footage keyframe + our render per
// camera + current site.json → per-camera scores, issues, and a patch (§6.6).
// Standalone image call (no video chaining) for latency. index.js validates,
// applies the patch, and writes critique.r<N>.json + site.r<N>.json.

import fs from 'node:fs';
import { CRITIQUE_PASS_SCORE, MAX_CRITIQUE_ROUNDS } from '../shared/constants.js';
import { CRITIQUE_JSON_SCHEMA } from '../shared/schema.js';
import { streamInteraction, parseJson, loadPrompt, fill } from './gemini.js';
import { keyframePath } from './ingest.js';
import { rigVars } from './reconstruct.js';
import { writeRun, readRun } from './runs.js';
import { anchorObstacle, horizonMap } from './anchors.js';
import { normalizeObstacle } from '../shared/schema.js';

const DATA_URL = /^data:(image\/[a-z]+);base64,(.+)$/s;

export async function critique({ siteId, round, renders = {}, site, rig }, sse) {
  const cams = rig.cameras.filter((c) => renders[c.id] && fs.existsSync(keyframePath(siteId, c.id)));
  if (!cams.length) throw new Error('critique needs at least one camera with both a footage keyframe and a render');

  const input = [];
  for (const c of cams) {
    const m = DATA_URL.exec(renders[c.id]);
    if (!m) throw new Error(`render for ${c.id} is not an image data URL`);
    writeRun(siteId, `render.r${round}.${c.id}.png`, Buffer.from(m[2], 'base64'));
    input.push({ type: 'text', text: `Camera \`${c.id}\` (yaw ${c.yaw_deg}°, pitch ${c.pitch_deg}°) — FOOTAGE:` });
    input.push({ type: 'image', data: fs.readFileSync(keyframePath(siteId, c.id)).toString('base64'), mime_type: 'image/png' });
    input.push({ type: 'text', text: `Camera \`${c.id}\` — RENDER of our reconstruction:` });
    input.push({ type: 'image', data: m[2], mime_type: m[1] });
  }
  input.push({ type: 'text', text: `Current site.json:\n\`\`\`json\n${JSON.stringify(site)}\n\`\`\`` });
  input.push({ type: 'text', text: fill(loadPrompt('critique.md'), {
    ...rigVars(rig, cams), round, max_rounds: MAX_CRITIQUE_ROUNDS, pass_score: CRITIQUE_PASS_SCORE,
  }) });

  sse.status(`Argon is checking the 3D street against each camera (check ${round} of up to 3)…`);
  const { text } = await streamInteraction({
    input,
    generation_config: { thinking_level: 'medium' },
    response_format: { type: 'text', mime_type: 'application/json', schema: CRITIQUE_JSON_SCHEMA },
  }, { sse, siteId, label: `critique.r${round}` });

  const c = parseJson(text, 'critique');
  // Drop empty ids on adds so applyPatch assigns the next o<N>.
  for (const op of c.patch ?? []) if (op.op === 'add' && op.obstacle && !op.obstacle.id) delete op.obstacle.id;
  anchorPatch(c.patch ?? [], site, rig, readRun(siteId, 'clips.json'), sse);
  for (const cam of c.cameras ?? []) sse.log(`${cam.id[0].toUpperCase()}${cam.id.slice(1)} camera matches ${cam.match_score}%${cam.issues?.length ? ` — ${cam.issues.join('; ')}` : ''}`);
  return c;
}

// Ops that carry an `anchor` get their center from ground-plane geometry
// instead of the model's estimate (same as reconstruct).
function anchorPatch(patch, site, rig, clips, sse) {
  const horizons = horizonMap(site);
  let n = 0;
  for (const op of patch) {
    if (op.op === 'add' && op.obstacle?.anchor) {
      const o = anchorObstacle(normalizeObstacle(op.obstacle), rig, horizons, clips);
      if (o.center_source === 'anchor') { op.obstacle = o; n++; }
    } else if (op.op === 'update' && op.set?.anchor) {
      const cur = site.obstacles.find((x) => x.id === op.id);
      if (!cur) continue;
      const merged = normalizeObstacle({ ...cur, ...op.set, size: { ...cur.size, ...op.set.size } });
      if (!op.set.size && !cur.size) delete merged.size;
      const o = anchorObstacle(merged, rig, horizons, clips);
      if (o.center_source === 'anchor') { op.set = { ...op.set, center: o.center, center_source: 'anchor' }; n++; }
    }
  }
  if (n) sse.log(`Measured ${n} corrected positions from the photos`);
}
