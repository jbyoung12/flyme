// AI world (visual only): makes the 3D street look clean from any angle, not
// just the rig's own camera point. Two kinds of image-model jobs, both built
// by the browser (web/paint.js) from the reconstruction + keyframes:
//   ground  — a top-down render of the projected footage (+ layout map) is
//             repainted as a clean overhead photo of the ground only;
//   sprites — each obstacle's crop from its best keyframe is redrawn as an
//             isolated, complete object on a flat key colour (browser keys
//             it out and stands it up at the reconstructed position).
// The simulator never sees any of this. Cached by input hash:
// sites/<id>/frames/paint/*.png (gitignored with the rest of sites/).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { client } from './gemini.js';
import { keyframePath } from './ingest.js';
import { IMAGE_MODEL } from './illustrate.js';

const CONCURRENCY = 6;

const GROUND_PROMPT = (ids) => `The FIRST image is a straight-down (orthographic, overhead) view of a street's ground, made by projecting real car-camera photos onto a flat plane from one point at the image centre; the top of the image is the direction the car faces. It is full of projection artifacts:
- every standing object (cars, buses, trains, bikes, kiosks, poles, people, trees, walls) appears as a long stretched STREAK radiating outward from the image centre — these are NOT on the ground;
- areas the cameras could not see are flat grey.
The SECOND image is a simple map of the same area at the same scale and position (surface types as flat colours, standing objects as coloured footprints). The other images are the original photos (${ids.join(', ')} cameras), for what the ground really looks like.

Generate a clean, photorealistic overhead photo of ONLY the ground surface at the same scale, pixel-aligned with the FIRST image. Keep the real flat ground features that are clearly visible in the first image (road paint, curbs, rail tracks, paving pattern) where they are. Replace every radial streak, every footprint from the map and every grey area with plain ground that continues its surroundings (asphalt, sidewalk, paving). Do not invent road markings, crosswalks or intersections that are not visible in the first image. Absolutely nothing standing: no vehicles, people, bikes, poles, trees, kiosks, streaks or shadows. No text. Same square framing as the first image.`;

const SPRITE_PROMPT = ({ what, w, h, key }) => `This is a crop from a street photo. In the middle is ${what} (about ${w} m wide and ${h} m tall).

Redraw ONLY that one object as a clean, photorealistic cutout: the whole object, complete (fill in any part hidden behind other things or cut off by the crop edge), seen from the same angle, upright, centred, filling most of the frame. Background: one perfectly flat, uniform ${key.name} (${key.hex}) colour everywhere else. No ground, no shadow, no other objects, no text, no logos.`;

const KEYS = { green: { name: 'pure green', hex: '#00FF00' }, magenta: { name: 'pure magenta', hex: '#FF00FF' } };

const dirFor = (siteId) => path.join(path.dirname(keyframePath(siteId, 'front')), 'paint');
const urlFor = (siteId, file) => `/media/${siteId}/frames/paint/${file}`;
const hash = (...parts) => crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);

function dataUrl(s) {
  const m = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(s ?? '');
  if (!m) throw new Error('expected an image data URL');
  return { type: 'image', mime_type: m[1], data: m[2] };
}

async function generate(input) {
  const ix = await client().interactions.create({ model: IMAGE_MODEL, input }, { timeout: 300_000 });
  const img = ix.output_image ?? ix.steps?.flatMap((s) => s.content ?? []).find((x) => x.type === 'image');
  if (!img?.data) throw new Error(`${IMAGE_MODEL} returned no image`);
  return Buffer.from(img.data, 'base64');
}

// Simple promise pool so a 25-obstacle site doesn't fire 26 calls at once.
async function pool(jobs, n) {
  const out = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
  }));
  return out;
}

const running = new Map(); // file → Promise (dedupes concurrent identical requests)

async function cached(siteId, file, make) {
  const out = path.join(dirFor(siteId), file);
  if (fs.existsSync(out)) return urlFor(siteId, file);
  if (!running.has(out)) {
    running.set(out, (async () => {
      const buf = await make();
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, buf);
    })().finally(() => running.delete(out)));
  }
  await running.get(out);
  return urlFor(siteId, file);
}

// body: { ground?: {photo, layout}, sprites?: [{id, crop, what, w, h, key}] }
// → { ground: {url}|{url:null,error}, sprites: [{id, url}|{id, url:null, error}] }
export async function paint({ siteId, rig, ground, sprites = [] }) {
  const cams = rig.cameras.filter((c) => !c.pitch_deg && fs.existsSync(keyframePath(siteId, c.id)));
  const jobs = [];
  let groundOut = null;
  if (ground?.photo) {
    jobs.push(async () => {
      try {
        const file = `ground-${hash(ground.photo, ground.layout ?? '', GROUND_PROMPT(cams.map((c) => c.id)))}.png`;
        // Keep the guides next to the result, to compare what went in.
        fs.mkdirSync(dirFor(siteId), { recursive: true });
        fs.writeFileSync(path.join(dirFor(siteId), file.replace('.png', '.guide.jpg')), Buffer.from(dataUrl(ground.photo).data, 'base64'));
        const url = await cached(siteId, file, () => generate([
          dataUrl(ground.photo),
          ...(ground.layout ? [dataUrl(ground.layout)] : []),
          ...cams.map((c) => ({ type: 'image', data: fs.readFileSync(keyframePath(siteId, c.id)).toString('base64'), mime_type: 'image/png' })),
          { type: 'text', text: GROUND_PROMPT(cams.map((c) => c.id)) },
        ]));
        groundOut = { url };
      } catch (err) {
        console.warn(`[paint] ${siteId} ground:`, err.message);
        groundOut = { url: null, error: err.message };
      }
    });
  }
  const spriteOut = new Array(sprites.length);
  sprites.forEach((s, i) => jobs.push(async () => {
    try {
      const key = KEYS[s.key] ?? KEYS.green;
      const prompt = SPRITE_PROMPT({ what: s.what ?? 'an object', w: s.w ?? '?', h: s.h ?? '?', key });
      const url = await cached(siteId, `sprite-${String(s.id).replace(/[^\w-]/g, '_')}-${hash(s.crop, prompt)}.png`, () => generate([
        dataUrl(s.crop), { type: 'text', text: prompt },
      ]));
      spriteOut[i] = { id: s.id, url };
    } catch (err) {
      console.warn(`[paint] ${siteId} sprite ${s.id}:`, err.message);
      spriteOut[i] = { id: s.id, url: null, error: err.message };
    }
  }));
  // Ground first in the queue: it's the slowest and matters most.
  await pool(jobs, CONCURRENCY);
  return { ground: groundOut, sprites: spriteOut };
}
