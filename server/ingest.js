// Stage A (PLAN.md §4): raw phone clips → 720p H.264 mp4 + sharpest keyframe.
// Outputs sites/<id>/<cam>.mp4 and sites/<id>/frames/<cam>.png (both
// gitignored), served by index.js at /media/<id>/...

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { SITES_DIR, writeRun, readRun } from './runs.js';

const W = 1280, H = 720; // matches the loop-1 render size
const PROBE_W = 320, PROBE_H = 180; // sharpness is measured on a small gray frame

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-y', ...args]);
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${err.slice(-600)}`));
      resolve({ stdout: Buffer.concat(out), stderr: err });
    });
  });
}

async function durationS(file) {
  const { stderr } = await ffmpeg(['-i', file, '-f', 'null', '-t', '0', '-']);
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr);
  if (!m) throw new Error(`no duration for ${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// Variance of the 4-neighbour Laplacian on a gray frame: higher = sharper.
function laplacianVariance(px, w, h) {
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = px[i - 1] + px[i + 1] + px[i - w] + px[i + w] - 4 * px[i];
      sum += l; sum2 += l * l; n++;
    }
  }
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

async function sharpness(file, t) {
  const { stdout } = await ffmpeg([
    '-ss', t.toFixed(3), '-i', file, '-frames:v', '1',
    '-vf', `scale=${PROBE_W}:${PROBE_H}`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-',
  ]);
  return stdout.length >= PROBE_W * PROBE_H ? laplacianVariance(stdout, PROBE_W, PROBE_H) : -1;
}

// iPhone records 10-bit HLG HDR by default; map to SDR bt709 or frames look
// washed out to both the model and the UI.
const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

async function isHdr(file) {
  const { stderr } = await ffmpeg(['-i', file, '-f', 'null', '-t', '0', '-']);
  return /arib-std-b67|smpte2084|bt2020/.test(stderr);
}

const fresh = (out, src) => fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs;

async function ingestCamera(siteId, cam, src) {
  const dir = path.join(SITES_DIR, siteId);
  const mp4 = path.join(dir, `${cam.id}.mp4`);
  const png = path.join(dir, 'frames', `${cam.id}.png`);
  let keyframe_t = readRun(siteId, 'keyframes.json')?.[cam.id] ?? null;
  if (!src && fs.existsSync(mp4) && fs.existsSync(png)) {
    return { id: cam.id, mp4_url: `/media/${siteId}/${cam.id}.mp4`, keyframe_url: `/media/${siteId}/frames/${cam.id}.png`, keyframe_t };
  }
  fs.mkdirSync(path.dirname(png), { recursive: true });

  if (!fresh(mp4, src)) {
    await ffmpeg([
      '-i', src, '-an',
      '-vf', `${(await isHdr(src)) ? `${TONEMAP},` : ''}scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=30`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4,
    ]);
  }

  if (!fresh(png, mp4) || keyframe_t === null) {
    // Sharpest of 9 frames across the middle ±1 s (phone held still; pick the
    // least motion-blurred one).
    const dur = await durationS(mp4);
    const mid = dur / 2;
    const ts = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1].map((d) => Math.min(Math.max(mid + d, 0), Math.max(dur - 0.05, 0)));
    const scores = [];
    for (const t of ts) scores.push(await sharpness(mp4, t));
    keyframe_t = ts[scores.indexOf(Math.max(...scores))];
    await ffmpeg(['-ss', keyframe_t.toFixed(3), '-i', mp4, '-frames:v', '1', png]);
    writeRun(siteId, 'keyframes.json', { ...readRun(siteId, 'keyframes.json'), [cam.id]: keyframe_t });
  }

  return { id: cam.id, mp4_url: `/media/${siteId}/${cam.id}.mp4`, keyframe_url: `/media/${siteId}/frames/${cam.id}.png`, keyframe_t };
}

export async function ingest({ siteId, rig, cameraSource }) {
  const jobs = rig.cameras
    .map((cam) => ({ cam, src: cameraSource(cam) }))
    .filter(({ cam, src }) => {
      const preIngested = fs.existsSync(mp4Path(siteId, cam.id)) && fs.existsSync(keyframePath(siteId, cam.id));
      if (!src && !preIngested && !cam.optional) console.warn(`[ingest] ${siteId}: no footage for ${cam.id}`);
      return src || preIngested;
    });
  if (!jobs.length) throw new Error(`no footage in sites/${siteId}/ (expected front.mov, right.mov, back.mov, left.mov)`);
  const cameras = await Promise.all(jobs.map(({ cam, src }) => ingestCamera(siteId, cam, src)));
  if (jobs.every((j) => j.src)) {
    const timeline = await clipTimeline(jobs);
    const kf = readRun(siteId, 'keyframes.json') ?? {};
    for (const c of timeline.cameras) c.keyframe_t = kf[c.id] ?? null;
    writeRun(siteId, 'clips.json', timeline);
  }
  return { cameras };
}

// Clips are filmed one after another (D22). Recover the order and timing from
// the phone's creation_time so prompts can say which footage is most recent.
// t is seconds relative to the end of the last clip (flight t = 0).
async function clipTimeline(jobs) {
  const rows = [];
  for (const { cam, src } of jobs) {
    const { stderr } = await ffmpeg(['-i', src, '-f', 'null', '-t', '0', '-']);
    const created = /creation_time\s*:\s*(\S+)/.exec(stderr)?.[1];
    const dur = Number(/Duration: (\d+):(\d+):([\d.]+)/.exec(stderr)?.slice(1).reduce((a, x, i) => a + Number(x) * [3600, 60, 1][i], 0));
    rows.push({ id: cam.id, start: created ? Date.parse(created) / 1000 : null, duration_s: dur });
  }
  if (rows.some((r) => r.start === null)) return { cameras: rows.map(({ id, duration_s }) => ({ id, duration_s })) };
  const end = Math.max(...rows.map((r) => r.start + r.duration_s));
  rows.sort((a, b) => a.start - b.start);
  return {
    cameras: rows.map((r) => ({ id: r.id, duration_s: r.duration_s,
      start_t: +(r.start - end).toFixed(1), end_t: +(r.start + r.duration_s - end).toFixed(1) })),
  };
}

// Paths for downstream stages.
export function mp4Path(siteId, camId) { return path.join(SITES_DIR, siteId, `${camId}.mp4`); }
export function keyframePath(siteId, camId) { return path.join(SITES_DIR, siteId, 'frames', `${camId}.png`); }
