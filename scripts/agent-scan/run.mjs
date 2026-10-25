// Offline experiment: reconstruct a site with the Antigravity Managed Agent
// instead of a direct Argon video call. The agent gets the clips in its
// sandbox (ffmpeg), our pixel→metre geometry, and an overlay tool to check its
// boxes against frames. Writes runs/<id>/site.agent.json (not used by the app).
//   node --env-file=.env scripts/agent-scan/run.mjs <site-id>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import { normalizeSite, validateSite } from '../../shared/schema.js';
import { rigVars } from '../../server/reconstruct.js';
import { loadPrompt, fill } from '../../server/gemini.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const siteId = process.argv[2];
const c = new GoogleGenAI({});
const rig = JSON.parse(fs.readFileSync(path.join(ROOT, 'sites', siteId, 'rig.json')));
const read = (p) => fs.readFileSync(p, 'utf8');
const sources = [
  { type: 'inline', target: '/workspace/flyme/anchors.js', content: read(path.join(ROOT, 'server/anchors.js')) },
  { type: 'inline', target: '/workspace/flyme/ground.mjs', content: read(path.join(HERE, 'ground.mjs')) },
  { type: 'inline', target: '/workspace/flyme/overlay.mjs', content: read(path.join(HERE, 'overlay.mjs')) },
  { type: 'inline', target: '/workspace/flyme/rig.json', content: JSON.stringify(rig) },
];
const base = fill(loadPrompt('reconstruct.md'), { ...rigVars(rig, rig.cameras), site_id: siteId, timeline: 'Treat all clips as filmed at the same moment ("now"), like the simultaneous cameras of a real car.' });
const prompt = `${base}

## How you work (you are an agent with a sandbox — this overrides the KEYFRAME/anchor instructions above)
The clips are in your sandbox: ${rig.cameras.map((k) => `/workspace/in/${k.id}.mp4`).join(', ')} (1280×720, ~6.5 s each). You cannot see video directly — extract frames:
  ffmpeg -y -loglevel error -ss 3 -i /workspace/in/front.mp4 -frames:v 1 /workspace/frames/front_3s.png   (then view the PNG)
Tools:
- Measure: \`node /workspace/flyme/ground.mjs <camera> <x> <y> <horizon_y>\` → {forward, right} metres for the pixel where an object touches the ground (x, y = fractions 0..1 of the frame, y down; horizon_y = where the far ground meets the sky in that camera's frame). Use it for every ground-touching object instead of guessing distances; add the object's half-depth along the view direction to get its centre.
- Check: \`node /workspace/flyme/overlay.mjs /workspace/out/site.json <camera> <frame.png> <out.png> <horizon_y>\` draws your obstacles as coloured rectangles on a frame and prints which colour is which id. View the result and fix anything misplaced or missing.
Procedure: (1) extract ~2 frames per clip (e.g. 1.5 s and 5 s) and view them; (2) estimate horizon_y per camera; (3) list every hazard, measure positions with ground.mjs; for moving people/cars compare the two frames to estimate velocity (m/s) and report the position at the last frame; (4) write /workspace/out/site.json (the JSON described above, "schema": "flyme.site/1", include "camera_horizons"); (5) run overlay.mjs for each camera, view, fix, rewrite site.json once. Be efficient. Finish with site.json written.`;

const t0 = Date.now();
const env = await c.environments.create({ sources });
console.log('env', env.id, Date.now() - t0, 'ms');
for (const k of rig.cameras) {
  await c.environments.files.upload({ environment: env.id, path: `workspace/in/${k.id}.mp4`, file: fs.readFileSync(path.join(ROOT, 'sites', siteId, `${k.id}.mp4`)), mime_type: 'video/mp4', overwrite: true });
}
console.log('uploaded clips', Date.now() - t0, 'ms');
const ix = await c.interactions.create({
  agent: 'antigravity-preview-09-2026', agent_config: { type: 'antigravity', model: 'gemini-4-argon', max_total_tokens: '1500000' },
  background: true, environment: env.id, input: [{ type: 'text', text: prompt }],
});
console.log('interaction', ix.id);
const stream = await c.interactions.get(ix.id, { stream: true });
let tools = 0;
try {
  for await (const ev of stream) {
    if (ev.event_type === 'step.start' && ev.step?.type === 'code_execution_call') { tools++; console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s $ ${String(ev.step.arguments?.code ?? '').split('\n')[0].slice(0, 110)}`); }
    else if (ev.event_type === 'step.start' && ev.step?.type === 'function_call') { tools++; console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s ${ev.step.name} ${ev.step.arguments?.TargetFile ?? ev.step.arguments?.AbsolutePath ?? ''}`); }
  }
} catch (e) { console.log('stream dropped', e.message); }
let fin = await c.interactions.get(ix.id);
while (['in_progress', 'queued'].includes(fin.status)) { await new Promise((r) => setTimeout(r, 3000)); fin = await c.interactions.get(ix.id); }
console.log('status', fin.status, 'tools', tools, 'total', ((Date.now() - t0) / 1000).toFixed(0), 's', JSON.stringify(fin.usage?.total_tokens));
const bytes = await c.environments.files.download({ environment: env.id, path: 'workspace/out/site.json' });
const text = typeof bytes === 'string' ? bytes : Buffer.from(await new Response(bytes).arrayBuffer()).toString('utf8');
const site = normalizeSite({ ...JSON.parse(text), id: siteId, round: 0 });
console.log('valid', validateSite(site).ok, 'obstacles', site.obstacles.length);
fs.writeFileSync(path.join(ROOT, 'runs', siteId, 'site.agent.json'), JSON.stringify(site, null, 2));
