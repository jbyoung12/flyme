// Illustrated textures for the 3D world: each footage keyframe is redrawn by
// an image model as a clean illustration from the *same* viewpoint, so the
// browser can project it onto the scene exactly like the raw footage
// (web/footage-projection.js). Visual only — the simulator never sees it.
// Output: sites/<id>/frames/<cam>.illustrated.png (gitignored, cached).

import fs from 'node:fs';
import { client } from './gemini.js';
import { keyframePath } from './ingest.js';

export const IMAGE_MODEL = process.env.FLYME_IMAGE_MODEL ?? 'gemini-3-pro-image';

const PROMPT = `Redraw this exact photo as a clean, beautiful architectural illustration: same camera, same framing, same perspective and horizon, every object in exactly the same place and size (vehicles, poles, signs, trees, wires, bike racks, shelters, buildings, and people as simple faceless figures). Soft daylight, flat clean colors with light shading, crisp edges, uncluttered surfaces. No text, no labels, no logos, no watermark. Keep the same aspect ratio.`;

export function illustratedPath(siteId, camId) {
  return keyframePath(siteId, camId).replace(/\.png$/, '.illustrated.png');
}

async function illustrateOne(siteId, cam) {
  const src = keyframePath(siteId, cam.id);
  const out = illustratedPath(siteId, cam.id);
  if (!fs.existsSync(src)) return null;
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) return out;
  const ix = await client().interactions.create({
    model: IMAGE_MODEL,
    input: [
      { type: 'image', data: fs.readFileSync(src).toString('base64'), mime_type: 'image/png' },
      { type: 'text', text: PROMPT },
    ],
  }, { timeout: 300_000 });
  const img = ix.output_image ?? ix.steps?.flatMap((s) => s.content ?? []).find((x) => x.type === 'image');
  if (!img?.data) throw new Error(`${IMAGE_MODEL} returned no image for ${cam.id}`);
  fs.writeFileSync(out, Buffer.from(img.data, 'base64'));
  return out;
}

const running = new Map(); // siteId → Promise

// Illustrate every camera keyframe (parallel, cached). Returns [{id, url}].
export async function illustrate({ siteId, rig }) {
  if (!running.has(siteId)) {
    running.set(siteId, Promise.all(rig.cameras.map((c) => illustrateOne(siteId, c).then(
      (p) => ({ id: c.id, url: p ? `/media/${siteId}/frames/${c.id}.illustrated.png` : null }),
      (err) => ({ id: c.id, url: null, error: err.message }),
    ))).finally(() => running.delete(siteId)));
  }
  return { cameras: await running.get(siteId) };
}

export function illustratedMedia(siteId, rig) {
  return rig.cameras.map((c) => ({ id: c.id, url: fs.existsSync(illustratedPath(siteId, c.id)) ? `/media/${siteId}/frames/${c.id}.illustrated.png` : null }));
}
