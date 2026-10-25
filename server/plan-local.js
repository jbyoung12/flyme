// Local server-side Loop 2 flight planner fallback (PLAN.md §4 E, §6.7, §7, §9 T4).
// Uses gemini-4-argon (thinking_level: "medium") + our deterministic simulator in a <=3-round loop.

import { CANDIDATES_PER_ROUND, MAX_PLAN_ROUNDS, DEFAULT_PARAMS } from '../shared/constants.js';
import { normalizeSite, PARAMS_JSON_SCHEMA, validateAgentResult } from '../shared/schema.js';
import { prepareObstacles } from '../shared/geometry.js';
import { simulate } from '../shared/physics.js';
import { streamInteraction, parseJson, loadPrompt, fill } from './gemini.js';

const LOCAL_ROUND_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          params: PARAMS_JSON_SCHEMA,
          why_picked: { type: 'string' },
        },
        required: ['id', 'label', 'params', 'why_picked'],
      },
    },
    preference_order: {
      type: 'array',
      items: { type: 'string' },
    },
    revision_notes: { type: 'string' },
    semantic_notes: {
      type: 'array',
      items: { type: 'string' },
    },
    reject_reason: { type: 'string' },
  },
  required: ['candidates', 'preference_order', 'revision_notes', 'semantic_notes', 'reject_reason'],
};

function ensureFourCandidates(rawCandidates, roundN, target) {
  const letters = ['a', 'b', 'c', 'd'];
  const fallbacks = [
    { label: 'direct low arc', params: { apex_height_m: 2.2, duration_s: 3.3, side_bow_m: 0, climb_bias: 0.45, horizontal_delay: 0.05 } },
    { label: 'climb-first road arc', params: { apex_height_m: 5.5, duration_s: 3.5, side_bow_m: 0, climb_bias: 0.35, horizontal_delay: 0.12 } },
    { label: 'slight left bow arc', params: { apex_height_m: 5.8, duration_s: 3.6, side_bow_m: -1.8, climb_bias: 0.35, horizontal_delay: 0.12 } },
    { label: 'slight right bow arc', params: { apex_height_m: 5.8, duration_s: 3.6, side_bow_m: 1.8, climb_bias: 0.36, horizontal_delay: 0.12 } },
  ];

  const list = Array.isArray(rawCandidates) ? rawCandidates.slice(0, CANDIDATES_PER_ROUND) : [];
  const out = [];
  for (let i = 0; i < CANDIDATES_PER_ROUND; i++) {
    const c = list[i] ?? {};
    const fb = fallbacks[i];
    const id = `r${roundN}${letters[i]}`;
    const p = { ...DEFAULT_PARAMS, ...(c.params ?? fb.params), target: { forward: Number(target.forward), right: Number(target.right) } };
    out.push({
      id,
      label: typeof c.label === 'string' && c.label.trim() ? c.label.trim() : fb.label,
      params: p,
      why_picked: typeof c.why_picked === 'string' ? c.why_picked.trim() : '',
    });
  }
  return out;
}

function formatHistoryForPrompt(rounds) {
  if (rounds.length === 0) return 'None (this is Round 1).';
  return JSON.stringify(
    rounds.map((r) => ({
      round: r.n,
      revision_notes: r.revision_notes,
      candidates: r.candidates.map((c) => ({
        id: c.id,
        label: c.label,
        params: c.params,
        sim_verdict: c.sim_verdict,
        failures: c.failures,
        failed_checks: (c.sim?.checks ?? [])
          .filter((chk) => !chk.pass)
          .map((chk) => ({ id: chk.id, value: chk.value, limit: chk.limit, unit: chk.unit, message: chk.message })),
        margins: c.margins,
      })),
    })),
    null,
    2,
  );
}

function buildWhyExplanation(chosen, safeCands) {
  const m = chosen.margins;
  const marginText = `${m.min_clearance_m} m min clearance, ${Math.round(m.air_remaining_kg)} kg air remaining, ${m.touchdown_v_ms} m/s vertical touchdown`;
  const otherSafe = safeCands.filter((c) => c.id !== chosen.id);
  const baseWhy = chosen.why_picked || `${chosen.label} stays clear of street hazards and over the road corridor.`;
  if (otherSafe.length === 0) {
    return `${chosen.id} (${chosen.label}) is the only SAFE candidate in this round (${marginText}). ${baseWhy}`;
  }
  const otherSummary = otherSafe
    .map((o) => `${o.id} (${o.margins.min_clearance_m} m clearance, ${Math.round(o.margins.air_remaining_kg)} kg air)`)
    .join(', ');
  return `${baseWhy} Certified margins: ${marginText} (vs. other SAFE options: ${otherSummary}).`;
}

function summarizeRoundFailures(cands, modelNotes) {
  const details = cands
    .map((c) => {
      const failedMsgs = (c.sim?.checks ?? [])
        .filter((chk) => !chk.pass)
        .map((chk) => `${chk.id} (${chk.message})`)
        .join(', ');
      return `${c.id} (${c.label}) failed: ${failedMsgs}`;
    })
    .join('; ');
  return modelNotes ? `${modelNotes} — Simulator diagnostics: ${details}` : `All 4 failed simulator checks: ${details}`;
}

/**
 * Run Loop 2 route planning locally using Gemini 4 Argon + local deterministic simulator.
 */
export async function planLocal({ siteId, site, target }, sse) {
  const normSite = normalizeSite(site);
  const preparedObstacles = prepareObstacles(normSite);
  const promptTemplate = loadPrompt('plan-local.md');

  const outRounds = [];
  let semanticNotes = [];
  let lastRejectReason = null;

  for (let n = 1; n <= MAX_PLAN_ROUNDS; n++) {
    sse?.status(`Round ${n}/${MAX_PLAN_ROUNDS}: proposing 4 candidate routes (gemini-4-argon)`);

    const prompt = fill(promptTemplate, {
      round: String(n),
      max_rounds: String(MAX_PLAN_ROUNDS),
      site_json: JSON.stringify(normSite, null, 2),
      target_json: JSON.stringify({ forward: Number(target.forward), right: Number(target.right) }),
      history_json: formatHistoryForPrompt(outRounds),
    });

    const { text } = await streamInteraction(
      {
        input: prompt,
        generation_config: { thinking_level: 'medium' },
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: LOCAL_ROUND_SCHEMA,
        },
      },
      { sse, siteId, label: `plan-local-r${n}` },
    );

    const parsed = parseJson(text, `plan-local-r${n}`);
    if (Array.isArray(parsed.semantic_notes) && parsed.semantic_notes.length > 0) {
      semanticNotes = parsed.semantic_notes;
    }
    if (typeof parsed.reject_reason === 'string' && parsed.reject_reason.trim()) {
      lastRejectReason = parsed.reject_reason.trim();
    }

    const rawCands = ensureFourCandidates(parsed.candidates, n, target);
    const roundCandidates = [];

    for (const c of rawCands) {
      const sim = simulate(normSite, c.params, { preparedObstacles });
      const claim = { sim_verdict: sim.verdict, failures: sim.failures };

      sse?.send('attempt', {
        round: n,
        id: c.id,
        label: c.label,
        params: sim.params,
        sim,
        agent_claim: claim,
        disagrees: false,
      });

      roundCandidates.push({
        id: c.id,
        label: c.label,
        params: sim.params,
        sim_verdict: sim.verdict,
        failures: sim.failures,
        margins: sim.margins,
        why_picked: c.why_picked,
        sim,
      });
    }

    sse?.send('sim_result', {
      round: n,
      summary: roundCandidates
        .map((c) => `${c.id} ${c.sim_verdict}${c.failures.length ? ' (' + c.failures.join(', ') + ')' : ''}`)
        .join(' · '),
    });

    const safeCands = roundCandidates.filter((c) => c.sim_verdict === 'SAFE');

    if (safeCands.length > 0) {
      // Pick the SAFE candidate ranked highest in preference_order (or first SAFE)
      const prefOrder = Array.isArray(parsed.preference_order) ? parsed.preference_order : [];
      let chosen = null;
      for (const prefId of prefOrder) {
        const match = safeCands.find((c) => c.id === prefId);
        if (match) {
          chosen = match;
          break;
        }
      }
      chosen ??= safeCands[0];

      const why = buildWhyExplanation(chosen, safeCands);
      sse?.log(`Picked ${chosen.id}: ${why}`);

      outRounds.push({
        n,
        candidates: roundCandidates.map(({ why_picked, ...rest }) => rest),
        decision: 'pick',
        chosen_id: chosen.id,
        why,
        revision_notes: null,
      });

      const finalResult = {
        verdict: 'SAFE',
        rounds: outRounds,
        final_params: chosen.params,
        chosen_id: chosen.id,
        semantic_notes: semanticNotes,
        reject_reason: null,
        disagreements: [],
      };
      const v = validateAgentResult(finalResult);
      if (!v.ok) sse?.log(`Warning: result validation: ${v.errors.join('; ')}`);
      return finalResult;
    }

    // All 4 failed in this round
    const revNotes = summarizeRoundFailures(roundCandidates, parsed.revision_notes);
    if (n < MAX_PLAN_ROUNDS) {
      sse?.send('thought', { text: `Round ${n} all UNSAFE → revising for Round ${n + 1}: ${revNotes}` });
      outRounds.push({
        n,
        candidates: roundCandidates.map(({ why_picked, ...rest }) => rest),
        decision: 'revise',
        chosen_id: null,
        why: null,
        revision_notes: revNotes,
      });
    } else {
      const rejectReason =
        lastRejectReason ||
        `No safe flight trajectory found after ${MAX_PLAN_ROUNDS} rounds (${MAX_PLAN_ROUNDS * CANDIDATES_PER_ROUND} candidates). ${revNotes}`;
      sse?.log(`REJECTED: ${rejectReason}`);
      outRounds.push({
        n,
        candidates: roundCandidates.map(({ why_picked, ...rest }) => rest),
        decision: 'reject',
        chosen_id: null,
        why: null,
        revision_notes: revNotes,
      });

      return {
        verdict: 'REJECT',
        rounds: outRounds,
        final_params: null,
        chosen_id: null,
        semantic_notes: semanticNotes,
        reject_reason: rejectReason,
        disagreements: [],
      };
    }
  }
}
