// Stage B (PLAN.md §4): uploaded camera clips + rig → site.json via one
// streamed gemini-4-argon call (thinking high, JSON schema = §6.3).
// index.js normalizes, validates, and writes site.r0.json.

import fs from 'node:fs';
import { CAR } from '../shared/constants.js';
import { SITE_JSON_SCHEMA, normalizeSite } from '../shared/schema.js';
import { uploadFile, streamInteraction, parseJson, loadPrompt, fill } from './gemini.js';
import { mp4Path, keyframePath } from './ingest.js';
import { applyAnchors } from './anchors.js';
import { readRun } from './runs.js';

const YAW_NAMES = { 0: 'forward', 90: 'right', 180: 'back', 270: 'left' };

// Prompt variables describing the rig, shared with critique.js.
export function rigVars(rig, cams = rig.cameras) {
  const hfov = cams[0]?.hfov_deg ?? 100;
  const aspect = rig.aspect ?? 16 / 9;
  const tanH = Math.tan((hfov / 2) * Math.PI / 180);
  const cameraTable = cams.map((c) =>
    `- \`${c.id}\`: yaw ${c.yaw_deg}° (looking ${YAW_NAMES[c.yaw_deg] ?? `${c.yaw_deg}° clockwise`}), pitch ${c.pitch_deg}°${c.pitch_deg ? ' (tilted up; the ground formula does not apply)' : ''}, HFOV ${c.hfov_deg}°, height ${c.position?.up ?? CAR.cameraHeight} m`,
  ).join('\n');
  return {
    camera_table: cameraTable,
    camera_height: cams[0]?.position?.up ?? CAR.cameraHeight,
    hfov,
    tan_h: tanH.toFixed(4),
    tan_v: (tanH / aspect).toFixed(4),
    car_l: CAR.length,
    car_w: CAR.width,
  };
}

// Clips are treated as simultaneous, like a real car's cameras (D22). The one
// exception is front vs up: both look forward but were filmed at different
// times, so the same person can appear in both at different positions.
function timelineText(cams) {
  const base = 'Treat all clips as filmed at the same moment ("now"), like the simultaneous cameras of a real car.';
  return cams.some((c) => c.id === 'up')
    ? `${base} Exception: \`front\` and \`up\` both look forward and were filmed at different times, so the same person or car may appear in both at different positions — report each real object once, using its position in the \`front\` clip.`
    : base;
}

export function ingestedCameras(siteId, rig) {
  return rig.cameras.filter((c) => fs.existsSync(mp4Path(siteId, c.id)));
}

export async function reconstruct({ siteId, rig }, sse) {
  const cams = ingestedCameras(siteId, rig);
  if (!cams.length) throw new Error(`no ingested clips for ${siteId}; run ingest first`);
  sse.status(`Uploading the ${cams.length} camera clips…`);
  const files = await Promise.all(cams.map((c) => uploadFile(siteId, `${c.id}.mp4`, mp4Path(siteId, c.id), 'video/mp4', sse)));

  const input = [];
  cams.forEach((c, i) => {
    input.push({ type: 'text', text: `Camera \`${c.id}\` (yaw ${c.yaw_deg}°, pitch ${c.pitch_deg}°) — video:` });
    input.push({ type: 'video', uri: files[i].uri, mime_type: files[i].mimeType, resolution: process.env.FLYME_VIDEO_RES ?? 'high' });
    if (fs.existsSync(keyframePath(siteId, c.id))) {
      input.push({ type: 'text', text: `Camera \`${c.id}\` — KEYFRAME (1280×720, from the middle of the clip; use it for anchors and the horizon):` });
      input.push({ type: 'image', data: fs.readFileSync(keyframePath(siteId, c.id)).toString('base64'), mime_type: 'image/png' });
    }
  });
  input.push({ type: 'text', text: fill(loadPrompt('reconstruct.md'), { ...rigVars(rig, cams), site_id: siteId, timeline: timelineText(cams) }) });

  sse.status(`Argon is watching the ${cams.length} clips and rebuilding the street in 3D…`);
  const { text } = await streamInteraction({
    input,
    generation_config: { thinking_level: process.env.FLYME_RECON_THINKING ?? 'medium', max_output_tokens: 65536 },
    response_format: { type: 'text', mime_type: 'application/json', schema: SITE_JSON_SCHEMA },
  }, { sse, siteId, label: 'reconstruct' });

  const raw = parseJson(text, 'reconstruct');
  sse.log(`Argon found ${raw.obstacles?.length ?? 0} objects around the car`);
  const { site, moved } = applyAnchors(normalizeSite(raw), rig, readRun(siteId, 'clips.json'));
  sse.log(`Measured the exact position of ${moved.length} objects from where they touch the ground`, { moved });
  return site;
}
