// T0 smoke test: one gemini-4-argon call + one Antigravity Managed Agent hello.
// Prints timings as JSON; docs/latency.md records the results.
//   node scripts/smoke.mjs [argon|agent|all]
import 'dotenv/config';
import fs from 'node:fs';
import { GoogleGenAI } from '@google/genai';

const client = new GoogleGenAI({});
const which = process.argv[2] ?? 'all';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};

if (which === 'argon' || which === 'all') {
  const t0 = Date.now();
  const ix = await client.interactions.create({
    model: 'gemini-4-argon',
    input: 'Reply with JSON: {"ok": true, "model": "<your model name>"}',
    generation_config: { thinking_level: 'low' },
    response_format: { type: 'text', mime_type: 'application/json',
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, model: { type: 'string' } }, required: ['ok', 'model'] } },
  }, { timeout: 120_000 });
  out.argon = { ms: Date.now() - t0, status: ix.status, output: JSON.parse(ix.output_text), usage: ix.usage };
  console.log(JSON.stringify({ argon: out.argon }, null, 2));
}

if (which === 'agent' || which === 'all') {
  const base = { agent: 'antigravity-preview-09-2026',
    agent_config: { type: 'antigravity', model: 'gemini-4-argon', max_total_tokens: '200000' } };
  const t0 = Date.now();
  let ix = await client.interactions.create({
    ...base,
    background: true,
    input: [{ type: 'text', text:
      'Run this shell command and nothing else: `node --version && node /workspace/flyme/hello.mjs`. ' +
      'Then write its stdout to /workspace/out/hello.txt and reply with that stdout verbatim.' }],
    environment: { type: 'remote', sources: [
      { type: 'inline', target: '/workspace/flyme/hello.mjs', content: 'console.log("hello from flyme sandbox", 6 * 7);\n' },
    ] },
  }, { timeout: 120_000 });
  const tCreated = Date.now() - t0;
  const envId = ix.environment_id;
  let polls = 0;
  while (['in_progress', 'queued'].includes(ix.status)) {
    await sleep(2000); polls++;
    ix = await client.interactions.get(ix.id);
  }
  const tDone = Date.now() - t0;
  let fileText = null, tDownload = null;
  try {
    const t1 = Date.now();
    const bytes = await client.environments.files.download({ environment: envId, path: 'workspace/out/hello.txt' });
    fileText = typeof bytes === 'string' ? bytes : Buffer.from(bytes instanceof ArrayBuffer ? bytes : await new Response(bytes).arrayBuffer()).toString('utf8');
    tDownload = Date.now() - t1;
  } catch (e) { fileText = `download failed: ${e.message}`; }
  out.agent = { create_ms: tCreated, total_ms: tDone, download_ms: tDownload, polls, status: ix.status,
    interaction_id: ix.id, environment_id: envId, output_text: ix.output_text, file: fileText, usage: ix.usage };
  console.log(JSON.stringify({ agent: out.agent }, null, 2));

  // Pre-warm probe: how long does creating a bare environment take?
  try {
    const t2 = Date.now();
    const envs = client.environments;
    const create = envs.create?.bind(envs) ?? envs.createEnvironment?.bind(envs);
    const env = await create({ sources: [{ type: 'inline', target: '/workspace/flyme/hello.mjs', content: 'console.log(1)\n' }] });
    out.prewarm = { ms: Date.now() - t2, env };
  } catch (e) { out.prewarm = { error: e.message }; }
  console.log(JSON.stringify({ prewarm: out.prewarm }, null, 2));
}

fs.mkdirSync('runs', { recursive: true });
fs.writeFileSync('runs/smoke.json', JSON.stringify(out, null, 2));
