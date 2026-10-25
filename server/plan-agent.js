// Managed Agent Loop 2 flight planner (PLAN.md §4 E, §6.7, §6.9, §7, §9 T4).
// Runs `antigravity-preview-09-2026` (model `gemini-4-argon`) in a remote Node 22
// sandbox seeded with `shared/*.{js,mjs}`, `site.json`, and `target.json`.
// Every candidate is re-simulated locally on the server (D8: only our sim judges safety).

import fs from 'node:fs';
import path from 'node:path';
import { CANDIDATES_PER_ROUND, MAX_PLAN_ROUNDS, DEFAULT_PARAMS } from '../shared/constants.js';
import { normalizeSite, validateAgentResult } from '../shared/schema.js';
import { prepareObstacles } from '../shared/geometry.js';
import { simulate } from '../shared/physics.js';
import { ROOT, writeRun, readRun } from './runs.js';
import { client, MODEL, recordInteraction, parseJson, loadPrompt, fill } from './gemini.js';
import { planLocal } from './plan-local.js';

export const AGENT_NAME = 'antigravity-preview-09-2026';
const ENV_TTL_MS = 12 * 60_000; // Sandbox snapshots after 15 min idle; refresh after 12 min
const POLL_INTERVAL_MS = 1500;
const AGENT_TIMEOUT_MS = 180_000;

const SHARED_FILES = [
  'constants.js',
  'schema.js',
  'geometry.js',
  'checks.js',
  'physics.js',
  'plot-svg.js',
  'sim-cli.mjs',
];

// In-memory cache of pre-warmed environments keyed by siteId (or '_default')
const warmEnvs = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function buildSimSources(site = null, target = null) {
  const sources = SHARED_FILES.map((name) => ({
    type: 'inline',
    target: `/workspace/flyme/${name}`,
    content: fs.readFileSync(path.join(ROOT, 'shared', name), 'utf8'),
  }));
  if (site) {
    sources.push({
      type: 'inline',
      target: '/workspace/input/site.json',
      content: JSON.stringify(site, null, 2),
    });
  }
  if (target) {
    sources.push({
      type: 'inline',
      target: '/workspace/input/target.json',
      content: JSON.stringify(target, null, 2),
    });
  }
  return sources;
}

async function decodeDownloadedBytes(bytes) {
  if (typeof bytes === 'string') return bytes;
  if (Buffer.isBuffer(bytes)) return bytes.toString('utf8');
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes).toString('utf8');
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
  if (bytes && typeof bytes.arrayBuffer === 'function') {
    return Buffer.from(await bytes.arrayBuffer()).toString('utf8');
  }
  return Buffer.from(await new Response(bytes).arrayBuffer()).toString('utf8');
}

async function downloadEnvJson(envId, relPath) {
  if (!envId) return null;
  try {
    const bytes = await client().environments.files.download({
      environment: envId,
      path: relPath.replace(/^\/+/, ''),
    });
    const text = await decodeDownloadedBytes(bytes);
    return parseJson(text, relPath);
  } catch {
    return null;
  }
}

async function uploadEnvJson(envId, relPath, obj) {
  const buf = Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
  await client().environments.files.upload({
    environment: envId,
    path: relPath.replace(/^\/+/, ''),
    file: buf,
    mime_type: 'application/json',
    overwrite: true,
  });
}

/**
 * Pre-warm a Managed Agent sandbox environment at SCAN time with all `shared/` simulator files.
 * Writes `runs/<siteId>/env_id` when `siteId` is provided (§6.10).
 */
export async function prewarm({ siteId } = {}) {
  const key = siteId || '_default';
  const existing = warmEnvs.get(key);
  if (existing && Date.now() - existing.createdAt < ENV_TTL_MS) {
    return { ok: true, env_id: existing.envId, environment_id: existing.envId, cached: true, ms: 0 };
  }

  const t0 = Date.now();
  const envs = client().environments;
  const createFn = envs.create?.bind(envs) ?? envs.createEnvironment?.bind(envs);
  if (!createFn) {
    return { ok: false, env_id: null, error: 'environments.create not available on SDK client' };
  }

  const env = await createFn({ sources: buildSimSources() });
  const envId = env?.id ?? env?.environment_id ?? null;
  const ms = Date.now() - t0;

  if (envId) {
    warmEnvs.set(key, { envId, createdAt: Date.now() });
    if (siteId) {
      try { writeRun(siteId, 'env_id', envId); } catch { /* ignore invalid siteId */ }
    }
  }
  return { ok: Boolean(envId), env_id: envId, environment_id: envId, cached: false, ms };
}

function getWarmEnvId(siteId) {
  for (const key of [siteId, '_default'].filter(Boolean)) {
    const entry = warmEnvs.get(key);
    if (entry && Date.now() - entry.createdAt < ENV_TTL_MS) {
      warmEnvs.delete(key); // Consume once so concurrent/subsequent runs get clean state
      return entry.envId;
    }
  }
  if (siteId) {
    try {
      const saved = readRun(siteId, 'env_id')?.trim();
      if (saved) return saved;
    } catch { /* ignore */ }
  }
  return null;
}

// Try to parse a batch sim output from a code_execution_result stdout block
function extractBatchFromStdout(resultStr) {
  if (typeof resultStr !== 'string' || !resultStr.includes('"flyme.sim-batch/1"')) return null;
  const m = /(\{[\s\S]*"schema"\s*:\s*"flyme\.sim-batch\/1"[\s\S]*\})/.exec(resultStr);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * Run Loop 2 route planning in the Antigravity Managed Agent sandbox,
 * streaming steps over SSE and re-verifying every candidate locally on the server.
 */
export async function planAgent({ siteId, site, target }, sse) {
  const normSite = normalizeSite(site);
  const cleanTarget = { forward: Number(target.forward), right: Number(target.right) };
  const preparedObstacles = prepareObstacles(normSite);

  const promptTemplate = loadPrompt('plan-agent.md');
  const promptText = fill(promptTemplate, {
    site_json: JSON.stringify(normSite, null, 2),
    target_json: JSON.stringify(cleanTarget),
  });

  const baseConfig = {
    agent: AGENT_NAME,
    agent_config: {
      type: 'antigravity',
      model: MODEL,
      max_total_tokens: '500000',
    },
  };

  let envId = getWarmEnvId(siteId);
  let ix = null;

  // Try using pre-warmed environment first if available
  if (envId) {
    try {
      sse?.status(`Using pre-warmed agent sandbox (${envId.slice(0, 8)}…)`);
      await Promise.all([
        uploadEnvJson(envId, 'workspace/input/site.json', normSite),
        uploadEnvJson(envId, 'workspace/input/target.json', cleanTarget),
      ]);
      ix = await client().interactions.create(
        {
          ...baseConfig,
          background: true,
          environment: envId,
          input: [{ type: 'text', text: promptText }],
        },
        { timeout: AGENT_TIMEOUT_MS },
      );
    } catch (err) {
      sse?.log(`Pre-warmed sandbox reuse failed (${err.message}); provisioning fresh sandbox`);
      envId = null;
      ix = null;
    }
  }

  if (!ix) {
    sse?.status('Starting Antigravity Managed Agent sandbox (Node 22 + shared/sim-cli.mjs)');
    try {
      ix = await client().interactions.create(
        {
          ...baseConfig,
          background: true,
          input: [{ type: 'text', text: promptText }],
          environment: {
            type: 'remote',
            sources: buildSimSources(normSite, cleanTarget),
          },
        },
        { timeout: AGENT_TIMEOUT_MS },
      );
    } catch (err) {
      sse?.log(`Managed Agent startup failed (${err.message}); falling back to local planner`);
      return planLocal({ siteId, site: normSite, target: cleanTarget }, sse);
    }
  }

  envId = ix.environment_id ?? envId;
  if (siteId && ix.id) recordInteraction(siteId, 'plan-agent', ix.id);
  if (siteId && envId) writeRun(siteId, 'env_id', envId);

  const tStart = Date.now();
  let seenSteps = 0;
  let liveRoundEmitted = 0;
  let capturedResultText = null;
  const capturedRoundTexts = new Map();

  // Stream steps and live sim results while the agent executes in the background
  const emitLiveRound = (batchCandidates, roundNum) => {
    if (!Array.isArray(batchCandidates) || batchCandidates.length === 0 || roundNum > MAX_PLAN_ROUNDS) return;
    liveRoundEmitted = roundNum;
    const cands = [];
    for (const c of batchCandidates.slice(0, CANDIDATES_PER_ROUND)) {
      const p = { ...DEFAULT_PARAMS, ...(c.params ?? c), target: cleanTarget };
      const sim = simulate(normSite, p, { preparedObstacles });
      const claim = { sim_verdict: c.sim_verdict ?? c.verdict ?? sim.verdict, failures: c.failures ?? sim.failures };
      const disagrees = claim.sim_verdict !== sim.verdict;
      sse?.send('attempt', {
        round: roundNum,
        id: c.id,
        label: c.label,
        params: sim.params,
        sim,
        agent_claim: claim,
        disagrees,
      });
      cands.push({ id: c.id, sim_verdict: sim.verdict, failures: sim.failures });
    }
    sse?.send('sim_result', {
      round: roundNum,
      summary: cands
        .map((c) => `${c.id} ${c.sim_verdict}${c.failures.length ? ' (' + c.failures.join(', ') + ')' : ''}`)
        .join(' · '),
    });
  };

  const processNewSteps = async (steps = []) => {
    while (seenSteps < steps.length) {
      const step = steps[seenSteps++];
      if (!step) continue;

      if (step.type === 'code_execution_call') {
        const code = step.arguments?.code ?? '';
        sse?.send('tool', { name: 'code_execution', code: code.slice(0, 600) });
      } else if (step.type === 'code_execution_result') {
        const nextRound = liveRoundEmitted + 1;
        let batch = extractBatchFromStdout(step.result);
        if (!batch && envId && nextRound <= MAX_PLAN_ROUNDS) {
          batch =
            (await downloadEnvJson(envId, `workspace/out/r${nextRound}-sim.json`)) ??
            (await downloadEnvJson(envId, `workspace/out/round-${nextRound}.json`));
        }
        const candList = Array.isArray(batch?.candidates) ? batch.candidates : (Array.isArray(batch) ? batch : null);
        if (candList && candList.length > 0) {
          emitLiveRound(candList, nextRound);
        }
      } else if (step.type === 'thought') {
        const text = (step.summary ?? []).map((s) => s.text ?? '').join('').trim();
        if (text) sse?.send('thought', { text });
      } else if (step.type === 'function_call') {
        const targetFile = step.arguments?.TargetFile ?? step.arguments?.path ?? '';
        sse?.send('tool', {
          name: step.name ?? 'function_call',
          code: targetFile ? `${step.name}: ${targetFile}` : (step.name ?? 'tool'),
        });
        const content = step.arguments?.CodeContent ?? step.arguments?.content;
        if (typeof content === 'string') {
          if (targetFile.endsWith('result.json')) {
            capturedResultText = content;
          } else {
            const m = /round-(\d+)\.json$/.exec(targetFile);
            if (m) capturedRoundTexts.set(Number(m[1]), content);
          }
        }
      } else if (step.type === 'model_output') {
        const text = (step.content ?? []).map((c) => c.text ?? '').join('').trim();
        if (text && !text.startsWith('{')) {
          sse?.log(text.slice(0, 300));
        }
      }
    }
  };

  await processNewSteps(ix.steps);

  while (['in_progress', 'queued'].includes(ix.status)) {
    if (Date.now() - tStart > AGENT_TIMEOUT_MS) {
      try { await client().interactions.cancel(ix.id); } catch { /* ignore */ }
      throw new Error(`Managed Agent timed out after ${(AGENT_TIMEOUT_MS / 1000).toFixed(0)} s`);
    }
    await sleep(POLL_INTERVAL_MS);
    ix = await client().interactions.get(ix.id);
    envId = ix.environment_id ?? envId;
    await processNewSteps(ix.steps);

    // Handle token-budget incomplete status (docs/gemini-api-notes.md §E)
    if (ix.status === 'incomplete') {
      sse?.status('Agent hit token step boundary; resuming to finalize result.json');
      ix = await client().interactions.create(
        {
          ...baseConfig,
          background: true,
          previous_interaction_id: ix.id,
          environment: envId,
          input: [{ type: 'text', text: 'Continue and immediately write /workspace/out/result.json.' }],
        },
        { timeout: 90_000 },
      );
      if (siteId && ix.id) recordInteraction(siteId, 'plan-agent-continue', ix.id);
      seenSteps = 0;
    }
  }

  await processNewSteps(ix.steps);
  const totalSec = ((Date.now() - tStart) / 1000).toFixed(1);
  sse?.log(`Managed Agent ${ix.status} in ${totalSec} s`, { interaction_id: ix.id, environment_id: envId, usage: ix.usage });

  // Download /workspace/out/result.json (or fall back to captured file write / output_text)
  let rawAgentResult = await downloadEnvJson(envId, 'workspace/out/result.json');
  if (!rawAgentResult && capturedResultText) {
    try { rawAgentResult = parseJson(capturedResultText, 'captured result.json'); } catch { /* ignore */ }
  }
  if (!rawAgentResult && ix.output_text) {
    try { rawAgentResult = parseJson(ix.output_text, 'agent output_text'); } catch { /* ignore */ }
  }

  // If result.json wasn't found directly, assemble from round-<n>.json files if present
  if (!rawAgentResult || !Array.isArray(rawAgentResult.rounds)) {
    const downloadedRounds = [];
    for (let n = 1; n <= MAX_PLAN_ROUNDS; n++) {
      let rd = await downloadEnvJson(envId, `workspace/out/round-${n}.json`);
      if (!rd && capturedRoundTexts.has(n)) {
        try { rd = parseJson(capturedRoundTexts.get(n), `round-${n}.json`); } catch { /* ignore */ }
      }
      if (rd) downloadedRounds.push({ n, ...rd });
    }
    if (downloadedRounds.length > 0) {
      rawAgentResult = {
        verdict: 'REJECT',
        rounds: downloadedRounds,
        semantic_notes: [],
        reject_reason: 'Assembled from sandbox round files.',
      };
    }
  }

  if (!rawAgentResult || !Array.isArray(rawAgentResult.rounds) || rawAgentResult.rounds.length === 0) {
    sse?.log('Agent did not produce structured rounds; falling back to local planner');
    return planLocal({ siteId, site: normSite, target: cleanTarget }, sse);
  }

  // Server re-simulation & verification of every candidate in every round (D8)
  const outRounds = [];
  const disagreements = [];
  const letters = ['a', 'b', 'c', 'd'];

  for (let ri = 0; ri < Math.min(rawAgentResult.rounds.length, MAX_PLAN_ROUNDS); ri++) {
    const rd = rawAgentResult.rounds[ri] ?? {};
    const n = ri + 1;
    const rawCands = Array.isArray(rd.candidates) ? rd.candidates.slice(0, CANDIDATES_PER_ROUND) : [];
    const cands = [];

    for (let ci = 0; ci < CANDIDATES_PER_ROUND; ci++) {
      const c = rawCands[ci] ?? {};
      const id = typeof c.id === 'string' && c.id ? c.id : `r${n}${letters[ci]}`;
      const label = typeof c.label === 'string' && c.label ? c.label : `candidate ${id}`;
      const p = { ...DEFAULT_PARAMS, ...(c.params ?? {}), target: cleanTarget };

      const sim = simulate(normSite, p, { preparedObstacles });
      const agentVerdict = c.sim_verdict ?? c.verdict ?? sim.verdict;
      const agentFailures = Array.isArray(c.failures) ? c.failures : sim.failures;
      const claim = { sim_verdict: agentVerdict, failures: agentFailures };
      const disagrees = agentVerdict !== sim.verdict;

      if (disagrees) {
        disagreements.push({ id, agent: agentVerdict, server: sim.verdict });
      }

      if (n > liveRoundEmitted) {
        sse?.send('attempt', {
          round: n,
          id,
          label,
          params: sim.params,
          sim,
          agent_claim: claim,
          disagrees,
        });
      }

      cands.push({
        id,
        label,
        params: sim.params,
        sim_verdict: sim.verdict, // Server simulator always wins (D8)
        failures: sim.failures,
        margins: sim.margins,
        sim,
      });
    }

    if (n > liveRoundEmitted) {
      sse?.send('sim_result', {
        round: n,
        summary: cands
          .map((c) => `${c.id} ${c.sim_verdict}${c.failures.length ? ' (' + c.failures.join(', ') + ')' : ''}`)
          .join(' · '),
      });
    }

    const safeInRound = cands.filter((c) => c.sim_verdict === 'SAFE');
    let decision = rd.decision;
    let chosenId = rd.chosen_id ?? null;
    let why = rd.why ?? null;
    let revisionNotes = rd.revision_notes ?? null;

    if (safeInRound.length > 0) {
      decision = 'pick';
      const pickedCand = safeInRound.find((c) => c.id === chosenId) ?? safeInRound[0];
      if (chosenId && pickedCand.id !== chosenId) {
        why = `Server simulator overrode agent pick ${chosenId} (UNSAFE) with certified SAFE route ${pickedCand.id}. ${why ?? ''}`.trim();
      }
      chosenId = pickedCand.id;
      why ??= `${pickedCand.id} (${pickedCand.label}) certified SAFE with ${pickedCand.margins.min_clearance_m} m clearance and ${Math.round(pickedCand.margins.air_remaining_kg)} kg air remaining.`;
      sse?.log(`Picked ${chosenId}: ${why}`);
    } else {
      chosenId = null;
      why = null;
      decision = ri < Math.min(rawAgentResult.rounds.length, MAX_PLAN_ROUNDS) - 1 ? 'revise' : 'reject';
      revisionNotes ??= `All 4 candidates failed server simulation in Round ${n}.`;
    }

    outRounds.push({
      n,
      candidates: cands,
      decision,
      chosen_id: chosenId,
      why,
      revision_notes: revisionNotes,
    });

    if (decision === 'pick') break;
  }

  const lastRound = outRounds.at(-1);
  const chosenCand =
    lastRound?.decision === 'pick'
      ? lastRound.candidates.find((c) => c.id === lastRound.chosen_id && c.sim_verdict === 'SAFE')
      : null;

  const semanticNotes = Array.isArray(rawAgentResult.semantic_notes) ? [...rawAgentResult.semantic_notes] : [];
  for (const d of disagreements) {
    semanticNotes.push(`${d.id}: agent claimed ${d.agent}; server simulator ruled ${d.server}`);
  }

  const finalResult = {
    verdict: chosenCand ? 'SAFE' : 'REJECT',
    rounds: outRounds,
    final_params: chosenCand?.params ?? null,
    chosen_id: chosenCand?.id ?? null,
    semantic_notes: semanticNotes,
    reject_reason: chosenCand
      ? null
      : rawAgentResult.reject_reason ||
        `No safe flight trajectory found after ${outRounds.length} round(s); all candidates failed deterministic simulator checks.`,
    disagreements,
  };

  const v = validateAgentResult(finalResult);
  if (!v.ok) sse?.log(`Warning: agent result validation: ${v.errors.join('; ')}`);

  return finalResult;
}
