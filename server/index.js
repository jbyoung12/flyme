// flyme server: Express 5 + Vite middleware in one process (PLAN.md §6.8).
//
// This file owns routing, SSE framing, run caching, replay, and the
// deterministic parts of each stage (validation, applyPatch, writing
// site.r<N>.json). Track modules only do the work; see the "Server module
// contract" in PLAN.md §6.11. Missing track modules answer 501, so the shell
// runs before any track lands.

import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { DEFAULT_RIG, CRITIQUE_PASS_SCORE, MAX_CRITIQUE_ROUNDS } from '../shared/constants.js';
import { validateSite, normalizeSite, validateCritique, applyPatch } from '../shared/schema.js';
import {
  ROOT, SITES_DIR, FIXTURES_DIR, RUNS_DIR,
  openSSE, replaySSE, isReplay, writeRun, readRun, latestRun, bestPlanReplay, latestSite,
} from './runs.js';

const PORT = Number(process.env.PORT ?? 5173);
const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '80mb' })); // loop-1 renders are 5× 1280×720 PNG data URLs

// ---------------------------------------------------------------- track loading

// Import server/<name>.js on demand. Returns null if the file doesn't exist yet.
async function track(name) {
  const file = path.join(ROOT, 'server', `${name}.js`);
  if (!fs.existsSync(file)) return null;
  return import(pathToFileURL(file).href);
}

async function need(res, name, fn) {
  const mod = await track(name);
  if (!mod || typeof mod[fn] !== 'function') {
    res.status(501).json({ error: `server/${name}.js does not export ${fn}() yet` });
    return null;
  }
  return mod[fn];
}

// Run a stage as an SSE stream. `work(sse)` returns nothing; it sends its own
// final events. Errors become an `error` event, then `done`.
async function stream(req, res, { stage, siteId, eventsName }, work) {
  const sse = openSSE(res, { stage, siteId, eventsName });
  try {
    await work(sse);
  } catch (err) {
    sse.error(err);
  } finally {
    if (!sse.closed) sse.end();
  }
}

// ---------------------------------------------------------------- sites

const VIDEO_EXT = ['.mov', '.MOV', '.mp4', '.MP4'];

function readRig(siteId) {
  const p = path.join(SITES_DIR, siteId, 'rig.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : DEFAULT_RIG;
}

// Raw footage for a camera: the rig's file name, or <cam>.<any video ext>.
function cameraSource(siteId, cam) {
  const dir = path.join(SITES_DIR, siteId);
  const base = path.parse(cam.file ?? cam.id).name;
  const names = [cam.file, ...VIDEO_EXT.map((e) => base + e)].filter(Boolean);
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p) && !p.endsWith('.mp4')) return p;
  }
  return null;
}

function hasIngested(siteId, cam) {
  const dir = path.join(SITES_DIR, siteId);
  return fs.existsSync(path.join(dir, `${cam.id}.mp4`)) && fs.existsSync(path.join(dir, 'frames', `${cam.id}.png`));
}

function siteInfo(siteId) {
  const dir = path.join(SITES_DIR, siteId);
  const rig = readRig(siteId);
  const present = fs.existsSync(dir) ? rig.cameras.filter((c) => cameraSource(siteId, c) || hasIngested(siteId, c)) : [];
  const ingested = present.length > 0 && present.every((c) => hasIngested(siteId, c));
  const site = latestSite(siteId);
  return {
    id: siteId,
    name: site?.name ?? siteId,
    cameras: present.map((c) => c.id),
    ingested,
    has_site: Boolean(site),
    has_truth: fs.existsSync(path.join(dir, 'truth.json')),
  };
}

function listSiteIds() {
  const ids = new Set();
  if (fs.existsSync(SITES_DIR)) {
    for (const d of fs.readdirSync(SITES_DIR, { withFileTypes: true })) if (d.isDirectory()) ids.add(d.name);
  }
  if (fs.existsSync(FIXTURES_DIR)) {
    for (const f of fs.readdirSync(FIXTURES_DIR)) if (f.endsWith('.json')) ids.add(f.slice(0, -5));
  }
  return [...ids].sort();
}

const SITE_ID = /^[A-Za-z0-9._-]+$/;
app.param('id', (req, res, next, id) => (SITE_ID.test(id) ? next() : res.status(400).json({ error: 'bad site id' })));

app.get('/api/sites', (req, res) => res.json(listSiteIds().map(siteInfo)));

// Convenience for the UI: everything needed to open a site.
app.get('/api/sites/:id', (req, res) => {
  const id = req.params.id;
  const info = siteInfo(id);
  const dir = path.join(SITES_DIR, id);
  const cameras = readRig(id).cameras.map((c) => ({
    id: c.id,
    mp4_url: fs.existsSync(path.join(dir, `${c.id}.mp4`)) ? `/media/${id}/${c.id}.mp4` : null,
    keyframe_url: fs.existsSync(path.join(dir, 'frames', `${c.id}.png`)) ? `/media/${id}/frames/${c.id}.png` : null,
    illustrated_url: fs.existsSync(path.join(dir, 'frames', `${c.id}.illustrated.png`)) ? `/media/${id}/frames/${c.id}.illustrated.png` : null,
  }));
  res.json({ ...info, rig: readRig(id), site: latestSite(id), camera_media: cameras });
});

// Illustrated textures (visual only) for the 3D world; cached per keyframe.
app.post('/api/sites/:id/illustrate', async (req, res) => {
  const illustrate = await need(res, 'illustrate', 'illustrate');
  if (illustrate) res.json(await illustrate({ siteId: req.params.id, rig: readRig(req.params.id) }));
});

// AI world view (visual only): photoreal picture from the chase camera, made
// from our layout render (body.guide) + the camera keyframes; cached.
app.post('/api/sites/:id/worldview', async (req, res) => {
  const worldview = await need(res, 'worldview', 'worldview');
  if (worldview) res.json(await worldview({ siteId: req.params.id, rig: readRig(req.params.id), guide: req.body?.guide, force: Boolean(req.body?.force) }));
});

// AI world (visual only): clean ground + object cutouts for outside views,
// built from crops/renders the browser sends; cached by input hash.
app.post('/api/sites/:id/paint', async (req, res) => {
  const paint = await need(res, 'paint', 'paint');
  if (paint) res.json(await paint({ siteId: req.params.id, rig: readRig(req.params.id), ground: req.body?.ground, sprites: req.body?.sprites }));
});

// ---------------------------------------------------------------- A. ingest

app.post('/api/sites/:id/ingest', async (req, res) => {
  const ingest = await need(res, 'ingest', 'ingest');
  if (!ingest) return;
  const id = req.params.id;
  res.json(await ingest({ siteId: id, rig: readRig(id), cameraSource: (cam) => cameraSource(id, cam) }));
});

// ---------------------------------------------------------------- B. reconstruct

app.post('/api/sites/:id/reconstruct', async (req, res) => {
  const id = req.params.id;
  if (isReplay(req)) return replaySSE(res, id, 'reconstruct.events.jsonl');
  const reconstruct = await need(res, 'reconstruct', 'reconstruct');
  if (!reconstruct) return;
  await stream(req, res, { stage: 'reconstruct', siteId: id, eventsName: 'reconstruct.events.jsonl' }, async (sse) => {
    const raw = await reconstruct({ siteId: id, rig: readRig(id) }, sse);
    const site = normalizeSite({ ...raw, id, round: 0 });
    const v = validateSite(site);
    if (!v.ok) sse.send('log', { message: 'site.json failed validation', errors: v.errors });
    writeRun(id, 'site.r0.json', site);
    sse.send('site', site);
  });
});

// ---------------------------------------------------------------- C. critique (loop 1)

app.post('/api/sites/:id/critique', async (req, res) => {
  const id = req.params.id;
  const round = Number(req.body?.round ?? 1);
  if (isReplay(req)) return replaySSE(res, id, `critique.r${round}.events.jsonl`);
  const critique = await need(res, 'critique', 'critique');
  if (!critique) return;
  const { renders, site: inSite } = req.body ?? {};
  await stream(req, res, { stage: 'critique', siteId: id, eventsName: `critique.r${round}.events.jsonl` }, async (sse) => {
    const site = normalizeSite({ ...(inSite ?? latestSite(id)), id });
    const c = await critique({ siteId: id, round, renders, site, rig: readRig(id) }, sse);
    const v = validateCritique(c);
    if (!v.ok) throw new Error(`critique failed validation: ${v.errors.join('; ')}`);
    const allPass = c.cameras.every((cam) => cam.match_score >= CRITIQUE_PASS_SCORE);
    const critiqueOut = { ...c, round, done: c.done || allPass || round >= MAX_CRITIQUE_ROUNDS };
    const { site: patched, log } = applyPatch(site, c.patch);
    patched.round = round;
    writeRun(id, `critique.r${round}.json`, { ...critiqueOut, patch_log: log });
    writeRun(id, `site.r${round}.json`, patched);
    sse.send('critique', { ...critiqueOut, patch_log: log });
    sse.send('site', patched);
  });
});

// ---------------------------------------------------------------- E. plan (loop 2)

app.post('/api/plan', async (req, res) => {
  const { site_id: siteId, site: inSite, target, mode = 'agent' } = req.body ?? {};
  if (!SITE_ID.test(siteId ?? '')) return res.status(400).json({ error: 'site_id required' });
  if (isReplay(req)) return replaySSE(res, siteId, bestPlanReplay(siteId, target));
  // search (default): simulator search + Managed Agent judge; quick: same search with a direct Argon judge;
  // agent: Managed Agent proposes routes itself; local: Argon proposes, server simulates.
  const [modName, fn] = { local: ['plan-local', 'planLocal'], search: ['plan-search', 'planSearch'], quick: ['plan-search', 'planSearch'] }[mode] ?? ['plan-agent', 'planAgent'];
  const plan = await need(res, modName, fn);
  if (!plan) return;
  const ts = Date.now();
  await stream(req, res, { stage: 'plan', siteId, eventsName: `plan-${ts}.events.jsonl` }, async (sse) => {
    const site = normalizeSite(inSite ?? latestSite(siteId));
    const result = await plan({ siteId, site, target, ts, rig: readRig(siteId), wait_s: Number(req.body?.wait_s) || 0, judgeWith: mode === 'quick' ? 'argon' : 'agent' }, sse);
    writeRun(siteId, `plan-${ts}.result.json`, result);
    sse.send('plan', result);
  });
});

// Pre-warm the agent sandbox at SCAN time. Fire-and-forget from the UI.
app.post('/api/plan/prewarm', async (req, res) => {
  const prewarm = await need(res, 'plan-agent', 'prewarm');
  if (!prewarm) return;
  res.json(await prewarm({ siteId: req.body?.site_id }));
});

// ---------------------------------------------------------------- G/H. stretch

app.post('/api/video', async (req, res) => {
  const startVideo = await need(res, 'video', 'startVideo');
  if (startVideo) res.json(await startVideo(req.body ?? {}));
});

app.get('/api/video/:job', async (req, res) => {
  const getVideo = await need(res, 'video', 'getVideo');
  if (getVideo) res.json(await getVideo(req.params.job));
});

app.post('/api/resolve-destination', async (req, res) => {
  const resolve = await need(res, 'resolve', 'resolveDestination');
  if (resolve) res.json(await resolve(req.body ?? {}));
});

app.get('/api/eval', (req, res) => {
  const p = path.join(RUNS_DIR, 'eval.json');
  if (!fs.existsSync(p)) return res.json({}); // UI hides the footer until eval runs
  res.type('json').send(fs.readFileSync(p, 'utf8'));
});

app.get('/api/runs/:id/:name', (req, res) => {
  const data = readRun(req.params.id, req.params.name);
  if (data === null) return res.status(404).json({ error: 'not found' });
  typeof data === 'string' ? res.type('text').send(data) : res.json(data);
});

// ---------------------------------------------------------------- static + Vite

// Transcoded mp4s and keyframes (sites/<id>/<cam>.mp4, sites/<id>/frames/<cam>.png).
// Raw .mov footage is never served.
app.use('/media', (req, res, next) => (/\.mov$/i.test(req.path) ? res.status(404).end() : next()), express.static(SITES_DIR));
app.use('/fixtures', express.static(path.join(ROOT, 'fixtures')));

app.use('/api', (req, res) => res.status(404).json({ error: `no route ${req.method} ${req.originalUrl}` }));

const { createServer: createVite } = await import('vite');
const vite = await createVite({
  root: path.join(ROOT, 'web'),
  appType: 'spa',
  // allowedHosts: Cloud Run serves us on *.run.app; Vite's dev host check would 403 it.
  // No live reload by default: with several people editing web/, HMR reloads wiped in-flight
  // plans in open pages. FLYME_HMR=1 turns it back on.
  server: { middlewareMode: true, hmr: process.env.FLYME_HMR === '1' ? { server } : false, fs: { allow: [ROOT] }, allowedHosts: true },
  logLevel: 'info',
});
app.use(vite.middlewares);

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: err.message ?? String(err) });
});

server.listen(PORT, () => {
  console.log(`flyme on http://localhost:${PORT}  (replay: ${process.env.FLYME_REPLAY === '1' ? 'ON' : 'off'})`);
});
