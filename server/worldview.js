// AI world view: the image model turns our clean 3D layout render (seen from
// the chase camera behind the car) into a photorealistic picture of the real
// street, using the four camera keyframes as reference. The browser shows it
// as the backdrop of that fixed camera and draws tiles, flight paths and the
// car on top. Visual only — the simulator never sees it.
// Output: sites/<id>/frames/worldview.png (gitignored, cached).

import fs from 'node:fs';
import path from 'node:path';
import { client } from './gemini.js';
import { keyframePath } from './ingest.js';
import { IMAGE_MODEL } from './illustrate.js';

const PROMPT = (ids) => `The FIRST image is a plain 3D layout render of a street, seen from a camera raised behind a small white car. The other images are real photos of that same street taken from the car itself (${ids.join(', ')} cameras).

Generate one photorealistic photograph from EXACTLY the first image's camera: same framing, same perspective, same horizon, and every object in exactly the same place and size as its box in the layout (bike racks, kiosks, poles, vehicles, trees, shelters, buildings, people). Make every surface look like the real street in the photos: real pavement, real bikes, real buildings, real trees and sky, natural daylight. Keep the white car in the same spot and size, as a sleek white futuristic flying car seen from behind. Ignore any grid lines. No text, no labels, no logos, no watermark. Same aspect ratio as the first image.`;

const outPath = (siteId) => path.join(path.dirname(keyframePath(siteId, 'front')), 'worldview.png');
const running = new Map(); // siteId → Promise

// guide: PNG/JPEG data URL of the layout render. Returns {url} or {url: null, error}.
export async function worldview({ siteId, rig, guide, force = false }) {
  const out = outPath(siteId);
  const url = `/media/${siteId}/frames/worldview.png?v=`;
  if (!force && fs.existsSync(out)) return { url: url + Math.round(fs.statSync(out).mtimeMs) };
  if (!running.has(siteId)) running.set(siteId, generate(siteId, rig, guide, out).finally(() => running.delete(siteId)));
  try {
    await running.get(siteId);
    return { url: url + Math.round(fs.statSync(out).mtimeMs) };
  } catch (err) {
    return { url: null, error: err.message };
  }
}

async function generate(siteId, rig, guide, out) {
  const m = /^data:(image\/\w+);base64,(.+)$/.exec(guide ?? '');
  if (!m) throw new Error('guide must be an image data URL');
  const cams = rig.cameras.filter((c) => fs.existsSync(keyframePath(siteId, c.id)));
  const ix = await client().interactions.create({
    model: IMAGE_MODEL,
    input: [
      { type: 'image', data: m[2], mime_type: m[1] },
      ...cams.map((c) => ({ type: 'image', data: fs.readFileSync(keyframePath(siteId, c.id)).toString('base64'), mime_type: 'image/png' })),
      { type: 'text', text: PROMPT(cams.map((c) => c.id)) },
    ],
  }, { timeout: 300_000 });
  const img = ix.output_image ?? ix.steps?.flatMap((s) => s.content ?? []).find((x) => x.type === 'image');
  if (!img?.data) throw new Error(`${IMAGE_MODEL} returned no image`);
  fs.writeFileSync(out, Buffer.from(img.data, 'base64'));
}
