// Managed Agent as the judge of simulator-SAFE routes (search mode). The
// agent sees the real camera frames, gets the SAFE candidates + our simulator
// CLI in its sandbox, may design and *simulate* its own revised routes, and
// writes /workspace/out/decision.json. Steps stream live over SSE. The server
// re-simulates whatever it picks (D8) — see plan-search.js.

import fs from 'node:fs';
import { client, MODEL, recordInteraction, parseJson, loadPrompt, fill } from './gemini.js';
import { AGENT_NAME, buildSimSources } from './plan-agent.js';
import { keyframePath } from './ingest.js';

const TIMEOUT_MS = 6 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(envId, rel) {
  try {
    const bytes = await client().environments.files.download({ environment: envId, path: rel });
    const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes instanceof ArrayBuffer ? bytes : await new Response(bytes).arrayBuffer()).toString('utf8');
    return parseJson(text, rel);
  } catch { return null; }
}

export async function agentJudge({ siteId, site, target, rig, cards }, sse) {
  const sources = [
    ...buildSimSources(site, target),
    { type: 'inline', target: '/workspace/input/candidates.json', content: JSON.stringify(cards, null, 2) },
  ];
  const input = [];
  for (const c of rig.cameras) {
    const kp = keyframePath(siteId, c.id);
    if (!fs.existsSync(kp)) continue;
    input.push({ type: 'text', text: `Camera \`${c.id}\` (yaw ${c.yaw_deg}°):` });
    input.push({ type: 'image', data: fs.readFileSync(kp).toString('base64'), mime_type: 'image/png' });
  }
  input.push({ type: 'text', text: fill(loadPrompt('plan-search-agent.md'), { target: JSON.stringify(target) }) });

  sse.status('Managed Agent: starting sandbox with our simulator');
  const t0 = Date.now();
  let ix = await client().interactions.create({
    agent: AGENT_NAME,
    agent_config: { type: 'antigravity', model: MODEL, max_total_tokens: '400000' },
    background: true,
    input,
    environment: { type: 'remote', sources },
  }, { timeout: 120_000 });
  const envId = ix.environment_id;
  if (siteId && ix.id) recordInteraction(siteId, 'plan-search-agent', ix.id);
  sse.status('Managed Agent: judging the safe routes against the footage');

  let captured = null, thought = '';
  const flush = () => { if (thought.trim()) sse.send('thought', { text: thought.trim() }); thought = ''; };
  const onStep = (st) => {
    if (st.type === 'code_execution_call') {
      sse.send('tool', { name: 'code_execution', code: String(st.arguments?.code ?? '').slice(0, 600) });
    } else if (st.type === 'code_execution_result') {
      const out = String(st.result ?? '');
      const j = out.indexOf('{');
      let batch = null;
      try { batch = JSON.parse(out.slice(j, out.lastIndexOf('}') + 1)); } catch { /* not a sim batch */ }
      if (batch?.schema === 'flyme.sim-batch/1') {
        const list = batch.candidates ?? [];
        sse.send('sim_result', { summary: `agent ran our simulator: ${batch.safe_count ?? list.filter((c) => c.verdict === 'SAFE').length} of ${list.length} of its routes SAFE` });
      }
    } else if (st.type === 'function_call') {
      const file = st.arguments?.TargetFile ?? st.arguments?.path ?? '';
      sse.send('tool', { name: st.name ?? 'tool', code: file ? `${st.name}: ${file}` : st.name });
      if (/decision\.json$/.test(file) && typeof st.arguments?.CodeContent === 'string') captured = st.arguments.CodeContent;
    }
  };
  try {
    const stream = await client().interactions.get(ix.id, { stream: true });
    for await (const ev of stream) {
      if (Date.now() - t0 > TIMEOUT_MS) throw new Error('timeout');
      if (sse.closed) throw new Error('client disconnected');
      if (ev.event_type === 'step.start' && ev.step) { flush(); onStep(ev.step); }
      else if (ev.event_type === 'step.delta' && ev.delta?.type === 'thought_summary') thought += ev.delta.content?.text ?? '';
      else if (ev.event_type === 'step.stop') flush();
      else if (ev.event_type === 'error') throw new Error(ev.error?.message ?? 'agent stream error');
    }
  } catch (err) {
    if (err.message === 'timeout' || err.message === 'client disconnected') {
      try { await client().interactions.cancel(ix.id); } catch { /* ignore */ }
      throw new Error(`Managed Agent judge ${err.message}`);
    }
    sse.log(`agent stream dropped (${err.message}); polling`);
  }
  flush();
  ix = await client().interactions.get(ix.id);
  while (['in_progress', 'queued'].includes(ix.status)) {
    if (Date.now() - t0 > TIMEOUT_MS) throw new Error('Managed Agent judge timeout');
    await sleep(1500);
    ix = await client().interactions.get(ix.id);
  }
  sse.log(`Managed Agent ${ix.status} in ${((Date.now() - t0) / 1000).toFixed(0)} s`, { interaction_id: ix.id, environment_id: envId });
  const decision = (await download(envId, 'workspace/out/decision.json')) ?? (captured ? parseJson(captured, 'decision.json') : null) ?? (ix.output_text ? parseJson(ix.output_text, 'agent output') : null);
  if (!decision?.chosen_id) throw new Error('Managed Agent wrote no decision.json');
  return decision;
}
