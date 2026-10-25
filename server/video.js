// Stretch 1 (T5a): Photoreal hop video generation via `gemini-omni-1.1-flash`
// (PLAN.md §4 G, §6.8, §6.11, §7, §9 T5a; docs/gemini-api-notes.md §F).

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { SITES_DIR, runDir, writeRun } from './runs.js';
import { client, recordInteraction, loadPrompt, fill } from './gemini.js';

const execFileAsync = promisify(execFile);
export const OMNI_MODEL = process.env.FLYME_OMNI_MODEL ?? 'gemini-omni-1.1-flash';

const jobs = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = /^data:([^;,]+)?(?:;[^,]*)?,([\s\S]+)$/.exec(dataUrl.trim());
  if (m) {
    return { mimeType: m[1] || 'video/webm', buffer: Buffer.from(m[2], 'base64') };
  }
  return { mimeType: 'video/webm', buffer: Buffer.from(dataUrl.trim(), 'base64') };
}

function summarizeSceneContext(site) {
  const obs = Array.isArray(site?.obstacles) ? site.obstacles : [];
  if (obs.length === 0) return 'An urban street with parked cars and roadside poles.';
  const items = obs
    .slice(0, 5)
    .map((o) => `${o.label || o.type} (${Math.round(o.center?.forward ?? o.from?.forward ?? 10)}m ahead)`);
  return `Visible street context includes: ${items.join(', ')}.`;
}

async function prepareHopMedia(siteId, job, clipDataUrl) {
  const dir = runDir(siteId);
  const parsed = parseDataUrl(clipDataUrl);
  if (!parsed || parsed.buffer.length === 0) {
    return { mp4Path: null, framePngPath: null };
  }

  const webmPath = path.join(dir, `${job}-hop.webm`);
  const mp4Path = path.join(dir, `${job}-hop.mp4`);
  const framePngPath = path.join(dir, `${job}-hop-frame.png`);
  fs.writeFileSync(webmPath, parsed.buffer);

  if (!ffmpegPath) {
    return { mp4Path: null, framePngPath: null };
  }

  try {
    // Transcode webm render to <=8s 720p H.264 mp4 (docs/gemini-api-notes.md §G.3)
    await execFileAsync(ffmpegPath, [
      '-y',
      '-i', webmPath,
      '-t', '8',
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast',
      '-an',
      mp4Path,
    ]);
    // Extract an early frame as fallback PNG if site has no camera keyframe
    await execFileAsync(ffmpegPath, [
      '-y',
      '-i', mp4Path,
      '-vf', 'select=eq(n\\,0)',
      '-vframes', '1',
      framePngPath,
    ]);
    return {
      mp4Path: fs.existsSync(mp4Path) ? mp4Path : null,
      framePngPath: fs.existsSync(framePngPath) ? framePngPath : null,
    };
  } catch (err) {
    console.warn(`[video] ffmpeg transcode warning: ${err.message}`);
    return { mp4Path: null, framePngPath: null };
  }
}

async function uploadTempVideo(filePath) {
  let f = await client().files.upload({ file: filePath, config: { mimeType: 'video/mp4' } });
  while (f.state === 'PROCESSING') {
    await sleep(3000);
    f = await client().files.get({ name: f.name });
  }
  if (f.state !== 'ACTIVE') throw new Error(`Reference video upload state: ${f.state}`);
  return f;
}

async function saveOutputVideo(outVideo, destPath) {
  if (!outVideo) throw new Error('Omni returned no output_video');
  if (outVideo.data) {
    fs.writeFileSync(destPath, Buffer.from(outVideo.data, 'base64'));
    return;
  }
  if (outVideo.uri) {
    const m = /files\/([a-zA-Z0-9_-]+)/.exec(outVideo.uri);
    const name = m ? `files/${m[1]}` : outVideo.uri;
    let f = await client().files.get({ name });
    while (f.state === 'PROCESSING') {
      await sleep(4000);
      f = await client().files.get({ name });
    }
    if (f.state !== 'ACTIVE') throw new Error(`Omni output file ${name} state: ${f.state}`);
    await client().files.download({ file: name, downloadPath: destPath });
    return;
  }
  throw new Error('Omni output_video contained neither inline data nor uri');
}

async function runVideoJob(jobId, { siteId, clip, keyframeCam = 'front', site, params, label }) {
  const state = jobs.get(jobId);
  const update = (patch) => {
    Object.assign(state, patch, { elapsed_s: Math.round((Date.now() - state.started_at) / 1000) });
    try { writeRun(siteId, `${jobId}.json`, state); } catch { /* ignore */ }
  };

  try {
    update({ status: 'processing', message: 'Preparing rendered hop clip & street keyframe…' });
    const { mp4Path, framePngPath } = await prepareHopMedia(siteId, jobId, clip);

    // Pick keyframe PNG from sites/<siteId>/frames/<cam>.png if available, else rendered hop frame
    const siteFramePath = path.join(SITES_DIR, siteId, 'frames', `${keyframeCam}.png`);
    const fallbackFrontPath = path.join(SITES_DIR, siteId, 'frames', 'front.png');
    const chosenFramePath = [siteFramePath, fallbackFrontPath, framePngPath].find((p) => p && fs.existsSync(p));

    if (!chosenFramePath) {
      throw new Error('No keyframe PNG or rendered clip available to seed Omni video');
    }

    const imgB64 = fs.readFileSync(chosenFramePath, { encoding: 'base64' });
    const apexM = params?.apex_height_m ?? 5.5;
    const targetF = params?.target?.forward ?? 25;
    const targetR = params?.target?.right ?? 0;
    const targetDesc = `${Math.round(targetF)}m ahead${targetR ? ` (${Math.abs(Math.round(targetR))}m ${targetR < 0 ? 'left' : 'right'})` : ''}`;

    const promptTemplate = loadPrompt('omni.md');
    const basePrompt = fill(promptTemplate, {
      site_name: site?.name || siteId,
      scene_context: summarizeSceneContext(site),
      apex_m: String(apexM),
      route_label: label || 'climb-first thruster hop',
      target_desc: targetDesc,
    });

    let ix = null;

    // Strategy 1: If we have a transcoded hop mp4, try uploading it as a motion reference alongside the keyframe
    if (mp4Path) {
      try {
        update({ status: 'processing', message: 'Uploading rendered hop reference to Files API…' });
        const refVid = await uploadTempVideo(mp4Path);
        update({ status: 'processing', message: `Generating photoreal video with ${OMNI_MODEL} (reference + keyframe)…` });
        ix = await client().interactions.create(
          {
            model: OMNI_MODEL,
            input: [
              { type: 'image', data: imgB64, mime_type: 'image/png' },
              { type: 'video', uri: refVid.uri, mime_type: refVid.mimeType ?? 'video/mp4' },
              { type: 'text', text: `${basePrompt} Follow the trajectory arc and camera motion shown in <VIDEO_REF_1>.` },
            ],
            response_format: {
              type: 'video',
              aspect_ratio: '16:9',
              resolution: '720p',
              duration: '8s',
              delivery: 'uri',
            },
          },
          { timeout: 10 * 60_000 },
        );
      } catch (refErr) {
        console.warn(`[video] reference+image mode fallback (${refErr.message}); retrying with image_to_video`);
        ix = null;
      }
    }

    // Strategy 2: Standard <FIRST_FRAME> image_to_video (verified in docs/gemini-api-notes.md §F)
    if (!ix) {
      update({ status: 'processing', message: `Generating photoreal video with ${OMNI_MODEL}…` });
      ix = await client().interactions.create(
        {
          model: OMNI_MODEL,
          input: [
            { type: 'image', data: imgB64, mime_type: 'image/png' },
            { type: 'text', text: basePrompt },
          ],
          response_format: {
            type: 'video',
            aspect_ratio: '16:9',
            resolution: '720p',
            duration: '8s',
            delivery: 'uri',
          },
          generation_config: {
            video_config: { task: 'image_to_video' },
          },
        },
        { timeout: 10 * 60_000 },
      );
    }

    if (ix?.id) recordInteraction(siteId, 'omni-video', ix.id);

    // Poll if interaction returned in_progress/queued
    while (ix && ['in_progress', 'queued'].includes(ix.status)) {
      update({ status: 'processing', message: `${OMNI_MODEL} rendering (${state.elapsed_s}s)…` });
      await sleep(5000);
      ix = await client().interactions.get(ix.id);
    }

    const outVideo =
      ix?.output_video ??
      ix?.steps?.flatMap((s) => s.content ?? [])?.find((c) => c.type === 'video' || c.uri || c.data);

    const siteOutDir = path.join(SITES_DIR, siteId);
    fs.mkdirSync(siteOutDir, { recursive: true });
    const outMp4Path = path.join(siteOutDir, `${jobId}.mp4`);
    const latestMp4Path = path.join(siteOutDir, 'omni-latest.mp4');

    update({ status: 'processing', message: 'Downloading generated MP4 from Files API…' });
    await saveOutputVideo(outVideo, outMp4Path);
    try { fs.copyFileSync(outMp4Path, latestMp4Path); } catch { /* ignore */ }

    const url = `/media/${siteId}/${jobId}.mp4`;
    update({
      status: 'completed',
      url,
      interaction_id: ix?.id ?? null,
      message: 'Photoreal Omni video ready',
    });
  } catch (err) {
    console.error(`[video ${jobId}]`, err);
    update({
      status: 'failed',
      error: err?.message ?? String(err),
      message: `Video generation failed: ${err?.message ?? String(err)}`,
    });
  }
}

/**
 * Start a background Omni video generation job (`POST /api/video`).
 */
export async function startVideo(body = {}) {
  const siteId = body.site_id || body.siteId || body.site?.id || 'demo-street';
  const keyframeCam = body.keyframe_cam || body.keyframeCam || 'front';

  // If replay mode is enabled and a cached omni-latest.mp4 exists for this site, serve it immediately
  const cachedLatest = path.join(SITES_DIR, siteId, 'omni-latest.mp4');
  if ((body.replay || process.env.FLYME_REPLAY === '1') && fs.existsSync(cachedLatest)) {
    const jobId = `omni-replay-${Date.now()}`;
    const state = {
      job: jobId,
      site_id: siteId,
      status: 'completed',
      url: `/media/${siteId}/omni-latest.mp4`,
      started_at: Date.now(),
      elapsed_s: 0,
      replay: true,
      message: 'Loaded cached Omni video',
    };
    jobs.set(jobId, state);
    return { job: jobId, status: state.status, url: state.url };
  }

  const jobId = `omni-${Date.now()}`;
  const state = {
    job: jobId,
    site_id: siteId,
    status: 'queued',
    url: null,
    error: null,
    started_at: Date.now(),
    elapsed_s: 0,
    message: 'Job queued',
  };
  jobs.set(jobId, state);

  // Fire-and-forget background task
  runVideoJob(jobId, {
    siteId,
    clip: body.clip,
    keyframeCam,
    site: body.site,
    params: body.params,
    label: body.label,
  });

  return { job: jobId, status: state.status };
}

/**
 * Poll status of an Omni video job (`GET /api/video/:job`).
 */
export async function getVideo(jobId) {
  const state = jobs.get(jobId);
  if (!state) {
    return { job: jobId, status: 'not_found', error: `Unknown job ${jobId}` };
  }
  if (state.status === 'processing' || state.status === 'queued') {
    state.elapsed_s = Math.round((Date.now() - state.started_at) / 1000);
  }
  return state;
}
