// Run cache (PLAN.md §6.10) + SSE helper (§6.9) + replay. Every SSE event is
// appended to runs/<site_id>/<name>.events.jsonl as it is sent, so any live run
// can later be replayed with ?replay=1 / FLYME_REPLAY=1.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUNS_DIR = path.join(ROOT, 'runs');
export const SITES_DIR = path.join(ROOT, 'sites');
export const FIXTURES_DIR = path.join(ROOT, 'fixtures', 'sites');

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export function runDir(siteId) {
  if (!SAFE_NAME.test(siteId)) throw new Error(`bad site id "${siteId}"`);
  const dir = path.join(RUNS_DIR, siteId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function runPath(siteId, name) {
  if (!SAFE_NAME.test(name)) throw new Error(`bad run file name "${name}"`);
  return path.join(runDir(siteId), name);
}

export function writeRun(siteId, name, data) {
  const p = runPath(siteId, name);
  fs.writeFileSync(p, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2));
  return p;
}

export function readRun(siteId, name) {
  const p = runPath(siteId, name);
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, 'utf8');
  return name.endsWith('.json') ? JSON.parse(text) : text;
}

// Latest file in runs/<siteId>/ matching a regex (by name sort; names embed
// round numbers or timestamps so lexical order = chronological).
export function latestRun(siteId, re) {
  const dir = runDir(siteId);
  const names = fs.readdirSync(dir).filter((n) => re.test(n)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return names.at(-1) ?? null;
}

// Latest known site.json for a site: newest runs/<id>/site.r<N>.json, else the
// fixture with that id, else null.
export function latestSite(siteId) {
  const name = latestRun(siteId, /^site\.r\d+\.json$/);
  if (name) return readRun(siteId, name);
  const fx = path.join(FIXTURES_DIR, `${siteId}.json`);
  return fs.existsSync(fx) ? JSON.parse(fs.readFileSync(fx, 'utf8')) : null;
}

export function isReplay(req) {
  return req.query?.replay === '1' || process.env.FLYME_REPLAY === '1';
}

// Open an SSE stream on `res`. If siteId + eventsName are given, every event
// is also appended to runs/<siteId>/<eventsName>.
//   const sse = openSSE(res, { stage: 'reconstruct', siteId, eventsName: 'reconstruct.events.jsonl' });
//   sse.send('status', { message: 'uploading' }); sse.log('...'); sse.end();
export function openSSE(res, { stage, siteId, eventsName } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const t0 = Date.now();
  let file = null;
  if (siteId && eventsName) {
    file = runPath(siteId, eventsName);
    fs.writeFileSync(file, '');
  }
  let closed = false;
  res.on('close', () => { closed = true; clearInterval(ping); });
  const ping = setInterval(() => !closed && res.write(': ping\n\n'), 15000);

  const sse = {
    t0,
    get closed() { return closed; },
    send(type, data = {}) {
      const ev = { type, stage, t_ms: Date.now() - t0, data };
      const line = JSON.stringify(ev);
      if (file) fs.appendFileSync(file, line + '\n');
      if (!closed) res.write(`data: ${line}\n\n`);
      return ev;
    },
    status: (message, extra) => sse.send('status', { message, ...extra }),
    log: (message, extra) => sse.send('log', { message, ...extra }),
    error(err) {
      const message = err?.message ?? String(err);
      console.error(`[${stage}]`, err);
      return sse.send('error', { message });
    },
    end(data = {}) {
      sse.send('done', data);
      clearInterval(ping);
      if (!closed) res.end();
      closed = true;
    },
  };
  return sse;
}

// Replay a cached events file at `speed`× (t_ms / speed). Ends the response.
export async function replaySSE(res, siteId, eventsName, { speed = 2 } = {}) {
  const sse = openSSE(res, { stage: 'replay' });
  const text = eventsName && readRun(siteId, eventsName);
  if (!text) {
    sse.send('error', { message: `no cached run ${siteId}/${eventsName ?? '?'}` });
    return sse.end({ replay: true });
  }
  const start = Date.now();
  for (const line of text.split('\n').filter(Boolean)) {
    if (sse.closed) return;
    const ev = JSON.parse(line);
    const wait = ev.t_ms / speed - (Date.now() - start);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    res.write(`data: ${JSON.stringify({ ...ev, replay: true })}\n\n`);
  }
  if (!sse.closed) res.end();
}
