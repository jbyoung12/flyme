// flyme in-car UI entry (T2). Wires the bottom bar flows to the API (§6.8):
//   SCAN  ingest → reconstruct (SSE) → [render views → critique (SSE)] ×≤3
//   PLAN  POST /api/plan (SSE: attempt / thought / tool / log … → plan)
//   HOP   animate the chosen route from sim.samples
// ?mock=1 (or any 501 from a track route) replays web/mock/*.json instead.
import { DEFAULT_RIG, PROVENANCE, MAX_CRITIQUE_ROUNDS, MAX_PLAN_ROUNDS, CAR } from '../shared/constants.js';
import { normalizeSite, applyPatch } from '../shared/schema.js';
import { landableMap } from '../shared/landable.js';
import { createScene } from './scene.js';
import { createCams } from './cams.js';
import { createPanel } from './panel.js';
import { renderCameraViews } from './render-views.js';
import { postSSE, replayEvents, loadMock, HttpError } from './sse.js';
import { esc, fmt, failReason } from './format.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const MOCK = params.get('mock') === '1';
const MOCK_SPEED = Number(params.get('speed') ?? 1) || 1;

const S = {
  siteId: null, rig: DEFAULT_RIG, site: null, media: [],
  target: null,
  rounds: [], cands: new Map(), selectedKey: null, chosenKey: null, result: null,
  busy: null, mode: 'search', replay: params.get('replay') === '1', usedMock: MOCK,
};

// ---------------------------------------------------------------- modules
const scene = createScene($('view'), { onTap });
const cams = createCams({ tilesEl: $('tiles'), modeEl: $('cam-mode'), blendEl: $('blend'), roundEl: $('recon-round'), lightboxEl: $('lightbox') });
const panel = createPanel({
  bannerEl: $('plan-banner'), validEl: $('valid-banner'), verdictEl: $('verdict'), titleEl: $('arc-title'),
  checklistEl: $('checklist'), airEl: $('air'), roundsEl: $('rounds'), logEl: $('log'),
  onSelect: (key) => select(key, { replay: true }),
});
window.flyme = { state: S, scene, renderCameraViews }; // debugging + T5a hook

// ---------------------------------------------------------------- small helpers
const status = (msg) => { $('status').textContent = msg; };
const lastOf = (events, type) => [...events].reverse().find((e) => e.type === type);
const withReplay = (url) => (S.replay ? `${url}${url.includes('?') ? '&' : '?'}replay=1` : url);

function pills() {
  const p = [];
  if (S.usedMock) p.push('<span class="pill mock">MOCK DATA</span>');
  if (S.replay) p.push('<span class="pill replay">REPLAY</span>');
  $('pills').innerHTML = p.join('');
}

function updateButtons() {
  const b = S.busy;
  const chosen = S.cands.get(S.chosenKey);
  $('btn-scan').disabled = Boolean(b) || !S.siteId;
  $('btn-plan').disabled = Boolean(b) || !S.site;
  $('btn-hop').disabled = Boolean(b) || !chosen || S.result?.verdict !== 'SAFE';
  $('btn-video').disabled = Boolean(b) || !chosen || S.result?.verdict !== 'SAFE';
  $('site-picker').disabled = Boolean(b);
  for (const id of ['scan', 'plan', 'hop']) $(`btn-${id}`).classList.toggle('busy', b === id);
}
const setBusy = (b) => { S.busy = b; updateButtons(); };

function logEvent(ev) {
  if (!ev || ev.type === 'done' || ev.type === 'json') return;
  if (ev.replay && !S.replay) { S.replay = true; pills(); }
  const d = ev.data ?? {};
  if (['status', 'log', 'thought', 'tool', 'sim_result', 'error'].includes(ev.type)) {
    panel.log(ev.type === 'status' ? 'log' : ev.type, ev.type === 'sim_result' ? { ...d, ok: true } : d, ev.t_ms);
    if (ev.type === 'status' && d.message) status(d.message);
  }
}

// Run one SSE stage live; on 501 (module not landed) or in ?mock=1, replay
// web/mock/<mock>.json. Returns { events, mocked }.
async function runStage({ url, body, mock, onEvent, onMockData, force = false }) {
  if (!MOCK && !force) {
    try {
      return { events: await postSSE(withReplay(url), body, onEvent), mocked: false };
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 501) || !mock) throw err;
      panel.log('log', { message: `${url.split('?')[0]} not implemented yet (501) — using mock data` });
    }
  }
  if (!mock) throw new Error('no mock for this stage');
  const data = await loadMock(mock);
  S.usedMock = true;
  pills();
  onMockData?.(data);
  const events = Array.isArray(data) ? data : data.events;
  return { events: await replayEvents(events, onEvent, { speed: MOCK_SPEED }), mocked: true };
}

// ---------------------------------------------------------------- sites
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new HttpError(r.status, r.statusText);
  return r.json();
}

async function initSites() {
  let sites = [];
  try { sites = await getJSON('/api/sites'); } catch (err) { console.warn('GET /api/sites failed', err); }
  if (!sites.length) sites = [{ id: 'demo-street', name: 'Demo street (fixture)' }];
  const picker = $('site-picker');
  picker.innerHTML = sites.map((s) => `<option value="${esc(s.id)}">${esc(s.name ?? s.id)}${s.has_site === false ? ' (not scanned)' : ''}</option>`).join('');
  const want = params.get('site');
  const first = sites.find((s) => s.id === want) ?? sites.find((s) => s.id === 'demo-street') ?? sites[0];
  picker.value = first.id;
  await loadSite(first.id);
}

async function loadSite(id) {
  S.siteId = id;
  let info = null;
  try { info = await getJSON(`/api/sites/${encodeURIComponent(id)}`); } catch (err) { console.warn('GET site failed', err); }
  if (!info?.site) {
    try { info = { ...(info ?? {}), site: await getJSON(`/fixtures/sites/${encodeURIComponent(id)}.json`) }; } catch {}
  }
  S.rig = info?.rig ?? DEFAULT_RIG;
  S.media = info?.camera_media ?? [];
  S.site = info?.site ? normalizeSite(info.site) : null;
  resetPlan();
  setTarget(null);
  scene.setSite(S.site);
  showZones();
  cams.setCameras(S.rig, S.media);
  cams.clearScores();
  cams.setRound(S.site ? S.site.round ?? 0 : null, { done: (S.site?.round ?? 0) > 0 });
  $('site-name').textContent = S.site?.name ?? info?.name ?? id;
  if (S.site) refreshRenders();
  panel.banner('idle', S.site ? 'Tap a landing spot, then PLAN' : 'No site yet — press SCAN');
  status(S.site ? `${S.site.obstacles.length} obstacles · ${CAR.name}` : 'Press SCAN to reconstruct this street');
  updateButtons();
}

function refreshRenders() {
  try {
    const r = renderCameraViews(S.site, S.rig);
    cams.setRenders(r);
    return r;
  } catch (err) {
    console.error('renderCameraViews failed', err);
    panel.log('error', { message: `render failed: ${err.message}` });
    return {};
  }
}

// ---------------------------------------------------------------- SCAN
// Mock critique patches are applied locally; skip `add`s that duplicate an
// existing same-type obstacle (so the mock also works on the fixture site).
function mockPatch(site, patch) {
  const near = (a, b) => a?.center && b?.center && Math.hypot(a.center.forward - b.center.forward, a.center.right - b.center.right) < 1.5;
  const ops = (patch ?? []).filter((op) => op.op !== 'add' || !site.obstacles.some((o) => o.type === op.obstacle?.type && near(o, op.obstacle)));
  return applyPatch(site, ops);
}

async function scan() {
  if (!S.siteId) return;
  const id = S.siteId;
  setBusy('scan');
  resetPlan();
  cams.clearScores();
  panel.log('log', { message: `— SCAN ${id} —` });
  status('Scanning…');
  if (!MOCK) fetch('/api/plan/prewarm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ site_id: id }) }).catch(() => {});
  try {
    // A. ingest (plain JSON)
    if (!MOCK) {
      try {
        const r = await fetch(`/api/sites/${id}/ingest`, { method: 'POST' });
        if (r.ok) {
          const j = await r.json();
          if (j.cameras) { S.media = j.cameras; cams.setMedia(j.cameras); }
          panel.log('log', { message: `ingest: ${j.cameras?.length ?? 0} cameras transcoded` });
        } else panel.log('log', { message: `ingest: HTTP ${r.status}${r.status === 501 ? ' (not implemented yet)' : ''}` });
      } catch (err) { panel.log('log', { message: `ingest failed: ${err.message}` }); }
    }

    // B. reconstruct
    cams.setRound(0, { busy: true });
    status('Reconstructing the street with Argon…');
    let site = null;
    const existing = S.site;
    try {
      const { events } = await runStage({ url: `/api/sites/${id}/reconstruct`, body: {}, mock: existing && !MOCK ? null : 'reconstruct', onEvent: logEvent });
      site = lastOf(events, 'site')?.data ?? null;
      if (!site) throw new Error(lastOf(events, 'error')?.data?.message ?? 'reconstruct returned no site');
    } catch (err) {
      panel.log('log', { message: `reconstruct: ${err.message}${existing ? ' — using the existing site.json' : ''}` });
      if (existing) site = existing;
      else {
        const { events } = await runStage({ mock: 'reconstruct', onEvent: logEvent, force: true }).catch(() => ({ events: [] }));
        site = lastOf(events, 'site')?.data ?? null;
      }
    }
    if (!site) throw new Error('no site');
    S.site = normalizeSite(site);
    scene.setSite(S.site);
    $('site-name').textContent = S.site.name ?? id;
    cams.setRound(0, { busy: true });

    // C. loop 1: render → critique → patch, until done or 3 rounds
    let critMocked = false;
    for (let round = 1; round <= MAX_CRITIQUE_ROUNDS; round++) {
      status(`Loop 1 · round ${round}: rendering ${S.rig.cameras.length} camera views`);
      const renders = refreshRenders();
      await new Promise((r) => requestAnimationFrame(r));
      status(`Loop 1 · round ${round}: Argon compares renders with footage`);
      let events, mocked;
      try {
        const onEvent = (ev) => {
          logEvent(ev);
          if (ev.type === 'critique') cams.setScores(ev.data);
        };
        const mockName = `critique-r${round}`;
        if (critMocked) ({ events, mocked } = await runStage({ mock: mockName, onEvent, force: true }));
        else ({ events, mocked } = await runStage({ url: `/api/sites/${id}/critique`, body: { round, renders, site: S.site }, mock: mockName, onEvent }));
        critMocked ||= mocked;
      } catch (err) {
        panel.log('log', { message: `critique round ${round}: ${err.message}` });
        break;
      }
      const crit = lastOf(events, 'critique')?.data;
      if (!crit) { panel.log('error', { message: lastOf(events, 'error')?.data?.message ?? `critique round ${round}: no result` }); break; }
      let patched = lastOf(events, 'site')?.data;
      let patchLog = crit.patch_log;
      if (mocked || !patched) ({ site: patched, log: patchLog } = mockPatch(S.site, crit.patch));
      patched.round = round;
      for (const p of patchLog ?? []) {
        panel.log('log', { message: `patch ${p.op} ${p.id ?? ''} ${p.applied ? '✓' : `✕ ${p.error ?? ''}`} — ${p.evidence ?? ''}` });
      }
      const flash = (patchLog ?? []).filter((p) => p.applied && p.op !== 'remove').map((p) => p.id);
      S.site = normalizeSite(patched);
      scene.setSite(S.site, { flash });
      showZones();
      cams.setRound(round, { done: crit.done, busy: !crit.done });
      if (crit.done) break;
    }
    refreshRenders();
    cams.setRound(S.site.round ?? 0, { done: true });
    panel.banner('idle', 'Street verified — tap a landing spot, then PLAN');
    status(`Site ready · ${S.site.obstacles.length} obstacles · reconstruction round ${S.site.round ?? 0}`);
  } catch (err) {
    console.error(err);
    panel.log('error', { message: `SCAN failed: ${err.message}` });
    status(`SCAN failed: ${err.message}`);
  } finally {
    setBusy(null);
  }
}

// ---------------------------------------------------------------- PLAN
function resetPlan() {
  S.rounds = []; S.cands = new Map(); S.selectedKey = null; S.chosenKey = null; S.result = null;
  scene.clearPlan();
  scene.resetCar();
  panel.showRounds([]);
  panel.showArc(null);
  panel.stopValidity();
  updateButtons();
}

function roundObj(n) {
  let r = S.rounds.find((x) => x.n === n);
  if (!r) { r = { n, candidates: [] }; S.rounds.push(r); S.rounds.sort((a, b) => a.n - b.n); }
  return r;
}

function addCandidate({ round, id, label, params: p, sim, agent_claim, disagrees }) {
  const key = `${round}:${id}`;
  const existing = S.cands.get(key);
  const cand = {
    ...(existing ?? {}), key, round, id, label, params: p ?? sim?.params, sim,
    agent_claim, disagrees: Boolean(disagrees),
    status: sim?.verdict === 'SAFE' ? 'safe' : 'unsafe',
    reason: sim?.verdict === 'SAFE' ? null : failReason(sim, S.site),
  };
  S.cands.set(key, cand);
  const r = roundObj(round);
  const i = r.candidates.findIndex((c) => c.key === key);
  if (i >= 0) r.candidates[i] = cand; else r.candidates.push(cand);
  if (existing) scene.updateCandidate(cand); else scene.addCandidate(cand);
  return cand;
}

function failingObstacles(cand) {
  return (cand?.sim?.checks ?? []).filter((c) => !c.pass && c.obstacle_id).map((c) => c.obstacle_id);
}

function select(key, { replay = false } = {}) {
  const cand = S.cands.get(key);
  if (!cand) return;
  S.selectedKey = key;
  panel.showArc(cand, S.site);
  scene.setPlanView({ selectedKey: key, visibleRound: cand.round });
  scene.highlight(failingObstacles(cand));
  panel.showRounds(S.rounds, { selectedKey: key, chosenKey: S.chosenKey, site: S.site });
  if (replay && !S.busy) scene.playRoute(cand.sim, { speed: 1.3 });
}

function onPlanEvent(ev) {
  logEvent(ev);
  const d = ev.data ?? {};
  if (ev.type === 'attempt' && d.sim) {
    const cand = addCandidate(d);
    const ok = d.sim.verdict === 'SAFE';
    panel.log('attempt', { ok, message: `${d.id} ${d.label ?? ''}: ${d.sim.verdict}${ok ? ` · ${fmt(d.sim.air?.remaining_kg, 0)} kg air left` : ` — ${cand.reason}`}${d.disagrees ? ` (agent claimed ${d.agent_claim?.sim_verdict})` : ''}` }, ev.t_ms);
    select(cand.key);
    const r = roundObj(d.round);
    panel.banner('busy', `Planning — round ${d.round}/${MAX_PLAN_ROUNDS}`, `${r.candidates.length}/4 routes simulated`);
  } else if (ev.type === 'plan') finalizePlan(d);
  else if (ev.type === 'error') panel.banner('reject', 'Planner error', d.message ?? '');
}

function finalizePlan(result) {
  S.result = result;
  const dis = new Map((result.disagreements ?? []).map((x) => [x.id, x]));
  for (const r of result.rounds ?? []) {
    const ro = roundObj(r.n);
    Object.assign(ro, { decision: r.decision, chosen_id: r.chosen_id, why: r.why, revision_notes: r.revision_notes });
    for (const c of r.candidates ?? []) {
      const key = `${r.n}:${c.id}`;
      const sim = c.sim ?? S.cands.get(key)?.sim;
      if (!sim) continue;
      const prev = S.cands.get(key);
      addCandidate({ round: r.n, id: c.id, label: c.label, params: c.params, sim, agent_claim: prev?.agent_claim ?? { sim_verdict: c.sim_verdict, failures: c.failures }, disagrees: prev?.disagrees || dis.has(c.id) });
    }
  }
  const lastRound = S.rounds.at(-1);
  let chosen = null;
  if (result.verdict === 'SAFE' && result.chosen_id) {
    for (const r of [...S.rounds].reverse()) { chosen = r.candidates.find((c) => c.id === result.chosen_id); if (chosen) break; }
  }
  S.chosenKey = chosen?.key ?? null;
  scene.setPlanView({ visibleRound: chosen?.round ?? lastRound?.n ?? 1, chosenKey: S.chosenKey, selectedKey: S.chosenKey });
  if (chosen) {
    const clr = chosen.sim.checks?.find((c) => c.id === 'clearance')?.value;
    panel.banner('safe', `SAFE — ${chosen.id} ${chosen.label ?? ''}`, `clears by ${fmt(clr, 2)} m · ${fmt(chosen.sim.air?.remaining_kg, 0)} kg air left · picked by the agent, verified by our simulator`);
    select(chosen.key);
    panel.startValidity();
  } else {
    const reason = result.reject_reason ?? 'no safe route in 3 rounds';
    panel.banner('reject', 'REJECTED', reason);
    const sug = result.suggested_target;
    if (sug) {
      const b = $('suggest');
      b.hidden = false;
      b.textContent = `Land ${fmt(sug.offset_m, 1)} m away instead? (${fmt(sug.forward, 1)}, ${fmt(sug.right, 1)}) → PLAN`;
      b.onclick = () => { b.hidden = true; setTarget({ forward: sug.forward, right: sug.right }); plan(); };
    } else if (result.suggested_wait_s) {
      const b = $('suggest');
      b.hidden = false;
      b.textContent = `Wait ${result.suggested_wait_s} s for people to clear, then hop → PLAN`;
      b.onclick = () => { b.hidden = true; plan({ wait_s: result.suggested_wait_s }); };
    }
    const lr = lastRound?.candidates?.[0];
    if (lr) select(lr.key);
  }
  if (dis.size) panel.log('error', { message: `Server sim disagreed with the agent on ${[...dis.keys()].join(', ')} — the server's verdict wins.` });
  panel.showRounds(S.rounds, { selectedKey: S.selectedKey, chosenKey: S.chosenKey, site: S.site });
  updateButtons();
}

async function plan({ wait_s = 0 } = {}) {
  if (!S.site) return;
  if (!S.target) {
    const h = $('hint');
    h.hidden = false;
    h.animate([{ transform: 'translateX(-50%) scale(1)' }, { transform: 'translateX(-50%) scale(1.08)' }, { transform: 'translateX(-50%) scale(1)' }], { duration: 400 });
    return;
  }
  resetPlan();
  $('suggest').hidden = true;
  setBusy('plan');
  panel.log('log', { message: `— PLAN → ${fmt(Math.abs(S.target.forward), 1)} m ${S.target.forward < 0 ? 'behind' : 'ahead'}, ${fmt(Math.abs(S.target.right), 1)} m ${S.target.right < 0 ? 'left' : 'right'} (${S.mode}) —` });
  panel.banner('busy', `Planning — round 1/${MAX_PLAN_ROUNDS}`, ({ agent: 'Managed Agent running our simulator in its sandbox', search: 'Simulator searching 400 routes · Argon judging them against the footage' })[S.mode] ?? 'Local planner + our simulator');
  status('Planning…');
  const mock = S.target.forward > 35 ? 'plan-reject' : 'plan';
  try {
    const { events } = await runStage({
      url: '/api/plan',
      body: { site_id: S.siteId, site: S.site, target: S.target, mode: S.mode, wait_s },
      mock,
      onEvent: onPlanEvent,
      onMockData: (data) => {
        if (data.target && (data.target.forward !== S.target.forward || data.target.right !== S.target.right)) {
          panel.log('log', { message: `mock plan: target snapped to (${data.target.forward}, ${data.target.right})` });
          setTarget(data.target);
        }
      },
    });
    if (!lastOf(events, 'plan')) {
      const e = lastOf(events, 'error');
      panel.banner('reject', 'Planner error', e?.data?.message ?? 'stream ended without a plan');
    }
    status(S.result ? (S.result.verdict === 'SAFE' ? 'Plan ready — press HOP' : 'Plan rejected') : 'Planner error');
  } catch (err) {
    console.error(err);
    panel.banner('reject', 'Planner error', err.message);
    panel.log('error', { message: `PLAN failed: ${err.message}` });
    status(`PLAN failed: ${err.message}`);
  } finally {
    setBusy(null);
  }
}

// ---------------------------------------------------------------- HOP
async function hop() {
  const chosen = S.cands.get(S.chosenKey);
  if (!chosen) return;
  setBusy('hop');
  scene.highlight([]);
  status(`HOP · ${chosen.id} ${chosen.label ?? ''}`);
  await scene.playRoute(chosen.sim, { chase: true, keep: true });
  const td = chosen.sim.touchdown;
  status(td ? `Landed ${fmt(td.miss_m, 2)} m from target · ${fmt(td.v_vertical, 1)} m/s touchdown · ${fmt(chosen.sim.air?.remaining_kg, 0)} kg air left` : 'Landed');
  setBusy(null);
}

// ---------------------------------------------------------------- VIDEO (stretch, web/video-panel.js owned by T5a)
async function video() {
  const chosen = S.cands.get(S.chosenKey);
  try {
    const path = './video-panel.js';
    const mod = await import(/* @vite-ignore */ path);
    const open = mod.openVideoPanel ?? mod.default;
    if (typeof open !== 'function') throw new Error('video-panel.js has no openVideoPanel()');
    await open({ siteId: S.siteId, site: S.site, plan: S.result, chosen, recordHop: () => scene.recordHop(chosen.sim), log: (m) => panel.log('log', { message: m }) });
  } catch (err) {
    console.warn('video panel unavailable', err);
    status('Photoreal video is not available yet');
  }
}

// ---------------------------------------------------------------- target
function showZones() {
  try { scene.setZones(S.site ? landableMap(S.site) : null); } catch (err) { console.warn('landable map failed', err); }
}

function setTarget(t) {
  S.target = t;
  scene.setTarget(t);
  const el = $('target-readout');
  el.hidden = !t;
  if (t) el.innerHTML = `Landing spot <b>${fmt(Math.abs(t.forward), 1)} m</b> ${t.forward < 0 ? 'behind' : 'ahead'} · <b>${fmt(Math.abs(t.right), 1)} m</b> ${t.right < 0 ? 'left' : 'right'}`;
  $('hint').hidden = Boolean(t);
}

function onTap(t) {
  if (S.busy) return;
  if (S.rounds.length) { resetPlan(); panel.banner('idle', 'New landing spot — press PLAN'); }
  setTarget(t);
  if (!S.rounds.length) panel.banner('idle', 'Landing spot set — press PLAN');
}

// ---------------------------------------------------------------- bar extras
function renderSpecs() {
  $('specs-pop').innerHTML = `<h3>Flying car specs</h3><div class="dim small" style="margin-bottom:8px">What's public vs. what we estimated. Safety verdicts use these numbers.</div>
    <table>${PROVENANCE.map((p) => `<tr><td>${esc(p.label)}</td><td>${esc(p.value)}<div class="note">${esc(p.note ?? '')}</div></td><td><span class="badge ${esc(p.source)}">${esc(p.source)}</span></td></tr>`).join('')}</table>`;
}

const pct = (v) => (typeof v !== 'number' ? null : v <= 1 ? Math.round(v * 100) : Math.round(v));
async function loadEval() {
  try {
    const r = await fetch('/api/eval');
    if (!r.ok) return;
    const e = await r.json();
    const s = e.summary ?? e;
    const first = pct(s.first_try_safe_pct ?? s.first_try_pass_rate ?? s.first_try?.pass_rate ?? s.single_shot?.pass_rate);
    const after = pct(s.after_loop_safe_pct ?? s.after_loop_pass_rate ?? s.after_loop?.pass_rate ?? s.full_loop?.pass_rate);
    const rec = s.recon_error_m ?? s.reconstruction_error_m ?? null;
    const lines = [];
    if (first != null && after != null) lines.push(`First-try plans safe: <b>${first}%</b> → after loop: <b>${after}%</b>`);
    if (Array.isArray(rec) && rec.length >= 2) lines.push(`Reconstruction error: ${fmt(rec[0], 1)} m → <b>${fmt(rec.at(-1), 1)} m</b>`);
    else if (rec && typeof rec === 'object' && rec.before != null) lines.push(`Reconstruction error: ${fmt(rec.before, 1)} m → <b>${fmt(rec.after, 1)} m</b>`);
    if (!lines.length) return;
    $('eval-stat').innerHTML = lines.join('<br>');
    $('eval-stat').hidden = false;
  } catch {}
}

$('btn-scan').addEventListener('click', scan);
$('btn-plan').addEventListener('click', () => plan());
$('btn-hop').addEventListener('click', hop);
$('btn-video').addEventListener('click', video);
$('site-picker').addEventListener('change', (e) => loadSite(e.target.value));
$('plan-mode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  S.mode = b.dataset.mode;
  for (const x of $('plan-mode').querySelectorAll('button')) x.classList.toggle('on', x === b);
});
$('btn-replay').addEventListener('click', () => {
  S.replay = !S.replay;
  $('btn-replay').classList.toggle('on', S.replay);
  pills();
});
$('btn-specs').addEventListener('click', (e) => {
  e.stopPropagation();
  $('specs-pop').hidden = !$('specs-pop').hidden;
  $('btn-specs').classList.toggle('on', !$('specs-pop').hidden);
});
document.addEventListener('click', (e) => {
  if (!$('specs-pop').hidden && !e.target.closest('#specs-pop')) { $('specs-pop').hidden = true; $('btn-specs').classList.remove('on'); }
});
$('view-controls').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b && !scene.playing) scene.setView(b.dataset.view);
});
// Keyboard shortcuts for the stage: S scan, P plan, H hop.
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (k === 's' && !$('btn-scan').disabled) scan();
  if (k === 'p' && !$('btn-plan').disabled) plan();
  if (k === 'h' && !$('btn-hop').disabled) hop();
});

$('btn-replay').classList.toggle('on', S.replay);
renderSpecs();
pills();
updateButtons();
await initSites();
loadEval();
// Deep-link a target: ?target=25,0
if (params.get('target')) {
  const [f, r] = params.get('target').split(',').map(Number);
  if (Number.isFinite(f) && Number.isFinite(r)) setTarget({ forward: f, right: r });
}
