// Gemini client + helpers shared by the server stages (docs/gemini-api-notes.md).
// - uploadVideo: Files API upload + poll, cached per site in runs/<id>/files.json
// - streamInteraction: interactions.create({stream:true}) → SSE thought/status
//   events; returns the final text. Interaction ids land in
//   runs/<id>/interaction_ids.json.

import fs from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import { readRun, writeRun } from './runs.js';

export const MODEL = process.env.FLYME_MODEL ?? 'gemini-4-argon';

let _client;
export function client() {
  _client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return _client;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE_TTL_MS = 46 * 3600_000; // Files API deletes after 48 h

// Upload (or reuse) a local file. Returns { name, uri, mimeType }.
export async function uploadFile(siteId, key, filePath, mimeType, sse) {
  const cache = readRun(siteId, 'files.json') ?? {};
  const mtimeMs = fs.statSync(filePath).mtimeMs;
  const hit = cache[key];
  if (hit && hit.mtimeMs === mtimeMs && Date.now() - hit.uploaded_at < FILE_TTL_MS) {
    try {
      const f = await client().files.get({ name: hit.name });
      if (f.state === 'ACTIVE') return { name: f.name, uri: f.uri, mimeType: f.mimeType };
    } catch { /* expired or deleted → re-upload */ }
  }
  sse?.status(`uploading ${key}`);
  let f = await client().files.upload({ file: filePath, config: { mimeType } });
  while (f.state === 'PROCESSING') {
    await sleep(2000);
    f = await client().files.get({ name: f.name });
  }
  if (f.state !== 'ACTIVE') throw new Error(`upload ${key}: file ${f.name} is ${f.state}`);
  const fresh = readRun(siteId, 'files.json') ?? {}; // re-read: uploads run in parallel
  fresh[key] = { name: f.name, uri: f.uri, mimeType: f.mimeType, mtimeMs, uploaded_at: Date.now() };
  writeRun(siteId, 'files.json', fresh);
  return { name: f.name, uri: f.uri, mimeType: f.mimeType };
}

export function recordInteraction(siteId, label, id) {
  const ids = readRun(siteId, 'interaction_ids.json') ?? {};
  (ids[label] ??= []).push({ id, at: new Date().toISOString() });
  writeRun(siteId, 'interaction_ids.json', ids);
}

// Stream one interaction. Thought summaries → `thought` events; output text is
// accumulated (it's JSON when response_format is set, so it isn't logged
// token by token; a `status` with the char count is sent every ~2 s instead).
export async function streamInteraction(params, { sse, siteId, label, timeoutMs = 15 * 60_000 } = {}) {
  const t0 = Date.now();
  const stream = await client().interactions.create(
    { model: MODEL, ...params, stream: true,
      generation_config: { thinking_summaries: 'auto', ...params.generation_config } },
    { timeout: timeoutMs },
  );
  let id = null, text = '', usage = null, status = null, lastTick = 0, thought = '';
  const flushThought = () => {
    if (thought.trim()) sse?.send('thought', { text: thought.trim() });
    thought = '';
  };
  try {
  for await (const ev of stream) {
    switch (ev.event_type) {
      case 'interaction.created':
        id = ev.interaction?.id ?? id;
        if (id && siteId) recordInteraction(siteId, label, id);
        break;
      case 'step.delta':
        if (ev.delta?.type === 'thought_summary') {
          thought += ev.delta.content?.text ?? '';
          if (thought.length > 400 || /\n\n$/.test(thought)) flushThought();
        } else if (ev.delta?.type === 'text') {
          flushThought();
          text += ev.delta.text ?? '';
          if (Date.now() - lastTick > 2000) {
            lastTick = Date.now();
            sse?.status(`${label}: writing (${text.length} chars)`);
          }
        }
        break;
      case 'step.stop':
        flushThought();
        break;
      case 'interaction.status_update':
        status = ev.status ?? status;
        break;
      case 'interaction.completed':
        usage = ev.interaction?.usage ?? usage;
        status = ev.interaction?.status ?? 'completed';
        break;
      case 'error':
        throw new Error(`${label}: ${ev.error?.message ?? 'stream error'} (${ev.error?.code ?? '?'})`);
      default:
        break;
    }
  }
  } catch (err) {
    // A dropped stream ("terminated", socket reset) doesn't cancel the stored
    // interaction: poll it to completion instead of failing the stage.
    if (!id || /\b(4\d\d)\b/.test(String(err.status ?? ''))) throw err;
    sse?.log(`${label}: stream dropped (${err.message}); recovering stored result`);
    let ix = await client().interactions.get(id);
    while (['in_progress', 'queued'].includes(ix.status)) {
      await sleep(2000);
      ix = await client().interactions.get(id);
    }
    if (ix.status !== 'completed') throw new Error(`${label}: interaction ${ix.status} after stream drop`);
    text = ix.output_text ?? '';
    usage = ix.usage;
    status = ix.status;
  }
  flushThought();
  // Fallback: some streams end without text deltas; fetch the stored result.
  if (!text && id) {
    const ix = await client().interactions.get(id);
    text = ix.output_text ?? '';
    usage ??= ix.usage;
    status = ix.status ?? status;
  }
  const ms = Date.now() - t0;
  sse?.log(`${label}: ${status ?? 'done'} in ${(ms / 1000).toFixed(1)} s`, { usage, interaction_id: id });
  return { id, text, usage, status, ms };
}

// Parse model JSON; tolerate ```json fences or leading prose.
export function parseJson(text, label = 'model') {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text) ?? /(\{[\s\S]*\})/.exec(text);
  if (m) { try { return JSON.parse(m[1]); } catch { /* fall through */ } }
  throw new Error(`${label} returned non-JSON: ${text.slice(0, 300)}`);
}

export function loadPrompt(name) {
  return fs.readFileSync(new URL(`./prompts/${name}`, import.meta.url), 'utf8');
}

// Fill {{key}} placeholders.
export function fill(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : `{{${k}}}`));
}
