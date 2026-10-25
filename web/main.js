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
import { buildSpriteJobs, keyOut, loadGround } from './paint.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const MOCK = params.get('mock') === '1';
const VIDEO = params.get('video') === '1'; // photoreal-video stretch (web/video-panel.js), hidden by default
const MOCK_SPEED = Number(params.get('speed') ?? 1) || 1;

const S = {
  siteId: null, rig: DEFAULT_RIG, site: null, media: [],
  target: null,
  rounds: [], cands: new Map(), selectedKey: null, chosenKey: null, result: null,
  // One planner in the UI: "search" = simulator search + Managed Agent. ?mode=quick|agent|local is a hidden dev override.
  busy: null, mode: ['search', 'quick', 'agent', 'local'].includes(params.get('mode')) ? params.get('mode') : 'search', replay: params.get('replay') === '1', usedMock: MOCK,
  statusMsg: '', planError: null, suggestion: null, landed: false,
};

// ---------------------------------------------------------------- modules
const scene = createScene($('view'), { onTap });
const cams = createCams({ tilesEl: $('tiles'), modeEl: $('cam-mode'), blendEl: $('blend'), roundEl: $('recon-round'), lightboxEl: $('lightbox') });
const panel = createPanel({
  cardEl: $('card'), kickerEl: $('card-kicker'), bannerEl: $('plan-banner'), whyEl: $('why'), whyMoreEl: $('why-more'),
  progressEl: $('progress'), activityEl: $('activity'), keynumsEl: $('keynums'), validEl: $('valid-banner'),
  verdictEl: $('verdict'), titleEl: $('arc-title'),
  checklistEl: $('checklist'), airEl: $('air'), roundsEl: $('rounds'), logEl: $('log'),
  onSelect: (key) => select(key, { replay: true }),
});
window.flyme = { state: S, scene, renderCameraViews }; // debugging + T5a hook

// ---------------------------------------------------------------- small helpers
// Progress / outcome line shown above the primary button.
const status = (msg) => { S.statusMsg = msg ?? ''; updateButtons(); };
const siteInfo = () => {
  const ob = S.site?.obstacles ?? [];
  if (!S.site) { $('status').textContent = 'Not scanned yet'; return; }
  const people = ob.filter((o) => o.type === 'person').length;
  const moving = ob.filter((o) => o.velocity && (o.velocity.forward || o.velocity.right)).length;
  const r = S.site.round ?? 0;
  $('status').innerHTML = `${ob.length} obstacles · ${people} ${people === 1 ? 'person' : 'people'} · ${moving} moving${r ? ` · <span class="ok">✓ verified in ${r} round${r === 1 ? '' : 's'}</span>` : ''}`;
};
const lastOf = (events, type) => [...events].reverse().find((e) => e.type === type);
const withReplay = (url) => (S.replay ? `${url}${url.includes('?') ? '&' : '?'}replay=1` : url);

function pills() {
  const p = [];
  if (S.usedMock) p.push('<span class="pill mock">MOCK DATA</span>');
  if (S.replay) p.push('<span class="pill replay">REPLAY</span>');
  $('pills').innerHTML = p.join('');
}

// ---------------------------------------------------------------- guided flow
// One primary action whose label follows the step; small secondary actions.
const canScan = () => !S.busy && Boolean(S.siteId);
const canPlan = () => !S.busy && Boolean(S.site) && Boolean(S.target);
const canHop = () => !S.busy && !S.landed && S.result?.verdict === 'SAFE' && Boolean(S.cands.get(S.chosenKey));

function primaryAction() {
  if (S.busy === 'scan') return { label: 'Scanning street…', busy: true };
  if (S.busy === 'plan') return { label: 'Planning flight…', busy: true };
  if (S.busy === 'hop') return { label: 'Flying…', busy: true };
  if (!S.site) return { label: 'Scan this street', run: scan, kind: 'go' };
  if (S.landed) return { label: 'Replay flight', run: hop, kind: 'go' };
  if (canHop()) return { label: 'Fly!', run: hop, kind: 'hop' };
  if (S.result) return S.suggestion ? { ...S.suggestion, kind: 'suggest' } : { label: 'Pick another spot', run: newSpot, kind: 'neutral' };
  if (!S.target) return { label: 'Tap the ground where you want to land', disabled: true };
  if (S.planError) return { label: 'Try planning again', run: () => plan(), kind: 'go' };
  return { label: 'Plan flight to here', run: () => plan(), kind: 'go' };
}

function hintText() {
  if (S.busy) return S.statusMsg || 'Working…';
  if (!S.site) return 'This street hasn\'t been scanned yet — the car\'s 4 cameras will rebuild it in 3D.';
  if (S.landed) return S.statusMsg;
  if (!S.target) return ''; // the action button already says it
  if (S.result?.verdict === 'SAFE') return 'Our simulator verified this flight path. Fly before the plan goes stale.';
  if (S.result) return S.suggestion ? 'No safe flight path to that exact spot — try the suggestion, or tap a new spot.' : 'No safe flight path to that spot — tap somewhere else.';
  if (S.planError) return 'The planner hit a problem.';
  return '';
}

function stepStates() {
  const st = { scan: 'todo', pick: 'todo', plan: 'todo', hop: 'todo' };
  if (S.busy === 'scan' || !S.site) { st.scan = 'current'; return st; }
  st.scan = 'done';
  if (!S.target) { st.pick = 'current'; return st; }
  st.pick = 'done';
  if (S.landed) return { ...st, plan: 'done', hop: 'done' };
  if (S.busy === 'hop' || canHop()) return { ...st, plan: 'done', hop: 'current' };
  st.plan = S.result && !S.busy ? 'warn' : 'current';
  return st;
}

function idleCard() {
  if (S.busy || S.result || S.planError || S.landed) return;
  if (!S.site) panel.banner('idle', 'Not scanned yet', 'Scan the street: Argon rebuilds it in 3D from the car\'s 4 camera clips, then checks its rebuild against the footage.', { kicker: 'Step 1' });
  else if (!S.target) panel.banner('idle', 'Where to?', 'Tap the ground in the 3D street to choose a landing spot. Green tiles are clear ground.', { kicker: 'Step 2' });
  else panel.banner('idle', 'Ready to plan', 'Our simulator checks every candidate flight path (collisions, people, thrust, air, touchdown). Only a SAFE path can fly.', { kicker: 'Step 3' });
}

function updateButtons() {
  const b = S.busy;
  const a = primaryAction();
  const btn = $('btn-primary');
  btn.querySelector('.txt').textContent = a.label;
  btn.className = `primary-btn ${a.kind ?? ''}${a.busy ? ' busy' : ''}`;
  btn.disabled = Boolean(a.busy || a.disabled || !a.run);
  btn.onclick = a.run ? () => a.run() : null;
  const hint = hintText();
  $('hint').textContent = hint;
  $('hint').hidden = !hint;
  $('hint').classList.toggle('busy', Boolean(b));
  $('hint').classList.toggle('call', !b && Boolean(S.site) && !S.target);
  $('target-readout').hidden = !S.target || Boolean(b) || S.landed || Boolean(S.result);
  $('btn-newspot').hidden = !S.target || Boolean(b) || (S.result && !S.suggestion && S.result.verdict !== 'SAFE');
  $('btn-replan').hidden = !S.result || Boolean(b) || S.landed || S.result.verdict === 'SAFE';
  const safe = S.result?.verdict === 'SAFE' && Boolean(S.cands.get(S.chosenKey));
  $('btn-video').hidden = !VIDEO || !safe || Boolean(b);
  $('btn-video').disabled = !safe || Boolean(b);
  $('site-picker').disabled = Boolean(b);
  const st = stepStates();
  for (const li of $('steps').children) {
    li.className = st[li.dataset.step];
    li.classList.toggle('click', Boolean(stepAction(li.dataset.step)));
  }
  idleCard();
}
const setBusy = (b) => { S.busy = b; updateButtons(); };

// Server status lines → short, friendly progress text.
function prettyStatus(m) {
  return String(m)
    .replace(/^simulator: /, 'Simulator ')
    .replace(/route shapes/g, 'flight paths')
    .replace(/ against the footage \(round \d+\)/, ' against the footage…')
    .replace(/^people are in the way/, 'People are in the way');
}

function logEvent(ev) {
  if (!ev || ev.type === 'done' || ev.type === 'json') return;
  if (ev.replay && !S.replay) { S.replay = true; pills(); }
  const d = ev.data ?? {};
  if (['status', 'log', 'thought', 'tool', 'sim_result', 'error'].includes(ev.type)) {
    panel.log(ev.type === 'status' ? 'log' : ev.type, ev.type === 'sim_result' ? { ...d, ok: true } : d, ev.t_ms);
    if (ev.type === 'status' && d.message) status(prettyStatus(d.message));
    if (S.busy === 'plan' && ['thought', 'tool', 'sim_result'].includes(ev.type)) panel.activity(ev.type, d);
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
  const first = sites.find((s) => s.id === want) ?? sites.find((s) => s.id === 'bike-rack' && s.has_site) ?? sites.find((s) => s.id === 'demo-street') ?? sites[0];
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
  scene.setWorldImage(null);
  scene.setSite(S.site);
  showZones();
  showFootage().then(() => { ensureIllustrated(); ensureWorld(); });
  cams.setCameras(S.rig, S.media);
  cams.clearScores();
  cams.setRound(S.site ? S.site.round ?? 0 : null, { done: (S.site?.round ?? 0) > 0 });
  $('site-name').textContent = S.site?.name ?? info?.name ?? id;
  if (S.site) refreshRenders();
  siteInfo();
  status('');
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
  openCams(true);
  panel.banner('busy', 'Scanning…', 'Argon rebuilds the street in 3D from the 4 camera clips, renders it from each camera, and fixes what doesn\'t match the footage (up to 3 rounds).', { kicker: 'Step 1 · Scan' });
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
          if (j.cameras) { S.media = j.cameras; cams.setMedia(j.cameras); showFootage().then(() => { ensureIllustrated(); ensureWorld(); }); }
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
      showFootage();
      cams.setRound(round, { done: crit.done, busy: !crit.done });
      if (crit.done) { ensureWorld(); break; }
    }
    refreshRenders();
    cams.setRound(S.site.round ?? 0, { done: true });
    siteInfo();
    status('');
  } catch (err) {
    console.error(err);
    panel.log('error', { message: `SCAN failed: ${err.message}` });
    status(`Scan failed: ${err.message}`);
  } finally {
    setBusy(null);
  }
}

// ---------------------------------------------------------------- PLAN
function resetPlan() {
  S.rounds = []; S.cands = new Map(); S.selectedKey = null; S.chosenKey = null; S.result = null;
  S.planError = null; S.suggestion = null; S.landed = false;
  $('details-sub').textContent = 'checks · air · flight paths · agent log';
  scene.clearPlan();
  scene.resetCar();
  panel.showRounds([]);
  panel.showArc(null);
  panel.setCardRoute(null);
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
    panel.banner('busy', 'Planning…', `Round ${d.round} of up to ${MAX_PLAN_ROUNDS} · ${r.candidates.length} flight path${r.candidates.length === 1 ? '' : 's'} simulated`, { kicker: 'Step 3 · Plan' });
    panel.showRounds(S.rounds, { selectedKey: S.selectedKey, chosenKey: S.chosenKey, site: S.site });
    $('details-sub').textContent = `${S.cands.size} flight path${S.cands.size === 1 ? '' : 's'} tried so far`;
  } else if (ev.type === 'plan') finalizePlan(d);
  else if (ev.type === 'error') { S.planError = d.message ?? 'error'; panel.banner('error', 'Planner error', d.message ?? ''); }
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
    select(chosen.key);
    panel.setCardRoute(chosen, S.site);
    const why = S.rounds.find((r) => r.n === chosen.round)?.why ?? (result.rounds ?? []).find((r) => r.chosen_id === chosen.id)?.why;
    const picker = S.mode === 'search' || S.mode === 'agent' ? 'Managed Agent' : 'Argon';
    panel.banner('safe', 'SAFE', why ? `${picker} picked ${chosen.id} because ${why.replace(/^\s*(because\s+)?/i, '').replace(/^./, (c) => c.toLowerCase())}` : `${picker} picked ${chosen.id}; our simulator verified it.`, { kicker: `Flight path ${chosen.id}${chosen.label ? ` · ${chosen.label}` : ''}` });
    panel.startValidity();
  } else {
    const lr = lastRound?.candidates?.[0];
    if (lr) select(lr.key);
    panel.setCardRoute(lr ?? null, S.site);
    const reason = result.reject_reason ?? `No safe route in ${MAX_PLAN_ROUNDS} rounds.`;
    panel.banner('reject', 'REJECTED', reason, { kicker: lr ? `No safe flight path · showing ${lr.id}` : 'No safe flight path' });
    S.suggestion = suggestionFor(result);
  }
  if (dis.size) panel.log('error', { message: `Server sim disagreed with the agent on ${[...dis.keys()].join(', ')} — the server's verdict wins.` });
  panel.showRounds(S.rounds, { selectedKey: S.selectedKey, chosenKey: S.chosenKey, site: S.site });
  $('details-sub').textContent = S.cands.size ? `${S.cands.size} flight path${S.cands.size === 1 ? '' : 's'} tried · checks · agent log` : 'reasons · agent log';
  updateButtons();
}

// REJECT → one concrete next step: a nearby spot, or waiting for people to clear.
function suggestionFor(result) {
  const sug = result.suggested_target;
  if (sug && S.target) {
    const df = sug.forward - S.target.forward, dr = sug.right - S.target.right;
    const dist = sug.offset_m ?? Math.hypot(df, dr);
    const dir = Math.abs(dr) >= Math.abs(df) ? (dr < 0 ? 'left' : 'right') : (df > 0) === (S.target.forward >= 0) ? 'farther' : 'closer';
    return {
      label: `Land ${fmt(dist, 1)} m ${dir} instead`,
      run: () => { setTarget({ forward: sug.forward, right: sug.right }); plan(); },
    };
  }
  if (result.suggested_wait_s) {
    const w = result.suggested_wait_s;
    return { label: `Wait ${w} s, then plan`, run: () => plan({ wait_s: w }) };
  }
  return null;
}

async function plan({ wait_s = 0 } = {}) {
  if (!S.site) return;
  if (!S.target) {
    $('hint').animate([{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 400 });
    return;
  }
  resetPlan();
  S.statusMsg = wait_s ? `Waiting ${wait_s} s for people to clear, then planning…` : ({ agent: 'Starting the Managed Agent…', search: 'Simulator searching 800 flight paths…', quick: 'Simulator searching 800 flight paths…' })[S.mode] ?? 'Argon proposing 4 flight paths…';
  setBusy('plan');
  panel.log('log', { message: `— PLAN → ${fmt(Math.abs(S.target.forward), 1)} m ${S.target.forward < 0 ? 'behind' : 'ahead'}, ${fmt(Math.abs(S.target.right), 1)} m ${S.target.right < 0 ? 'left' : 'right'} (${S.mode}) —` });
  panel.banner('busy', 'Planning…', ({
    agent: 'The Managed Agent proposes every flight path itself and tests them in our simulator (~2 min). Only paths our simulator passes can be picked.',
    search: 'Our simulator searches 800 flight paths (~6 s). Then the Managed Agent looks at the camera photos, tests its own paths in the simulator, and picks one (~90 s).',
    quick: 'Our simulator searches 800 flight paths; Argon picks one of the safe ones (~30 s).',
  })[S.mode] ?? 'Argon proposes 4 flight paths per round; our simulator checks each one.', { kicker: 'Step 3 · Plan' });
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
      S.planError = e?.data?.message ?? 'stream ended without a plan';
      panel.banner('error', 'Planner error', S.planError);
    }
    status('');
  } catch (err) {
    console.error(err);
    S.planError = err.message;
    panel.banner('error', 'Planner error', err.message);
    panel.log('error', { message: `PLAN failed: ${err.message}` });
    status('');
  } finally {
    setBusy(null);
  }
}

// ---------------------------------------------------------------- HOP
async function hop() {
  const chosen = S.cands.get(S.chosenKey);
  if (!chosen) return;
  S.statusMsg = `Flying along flight path ${chosen.id}…`;
  setBusy('hop');
  panel.stopValidity();
  scene.highlight([]);
  await scene.playRoute(chosen.sim, { chase: true, keep: true });
  const td = chosen.sim.touchdown;
  S.landed = true;
  S.statusMsg = td ? `Landed ${fmt(td.miss_m, 2)} m from the spot · ${fmt(td.v_vertical, 1)} m/s touchdown · ${fmt(chosen.sim.air?.remaining_kg, 0)} kg air left` : 'Landed';
  panel.banner('safe', 'Landed', S.statusMsg, { kicker: `Flight path ${chosen.id} · flight complete` });
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
    await open({ siteId: S.siteId, site: S.site, plan: S.result, chosen, carVariant: scene.carVariant, recordHop: () => scene.recordHop(chosen.sim), log: (m) => panel.log('log', { message: m }) });
  } catch (err) {
    console.warn('video panel unavailable', err);
    panel.log('error', { message: 'Photoreal video is not available yet' });
  }
}

// ---------------------------------------------------------------- target
// Look of the 3D world: 'illustrated' (image-model redraw of each camera
// frame, projected), 'photo' (raw footage projected) or 'model'.
// Default Photo: raw footage is pixel-aligned with the rebuild (the illustrated
// redraw shifts things, so outlines drift). ?look= is a hidden override.
let LOOK = ['illustrated', 'photo', 'blend', 'model'].includes(params.get('look')) ? params.get('look') : 'photo';
async function showFootage() {
  const hasIllus = S.media.some((m) => m.illustrated_url);
  const hasPhoto = S.media.some((m) => m.keyframe_url);
  let look = LOOK;
  if (look === 'illustrated' && !hasIllus) look = hasPhoto ? 'photo' : 'model';
  if ((look === 'photo' || look === 'blend') && !hasPhoto) look = 'model';
  // Photo: the full-res keyframe (server/ingest.js hiKeyframe) when there is one.
  const media = S.media.map((m) => ({ id: m.id, keyframe_url: look === 'illustrated' ? m.illustrated_url : m.keyframe_hi_url ?? m.keyframe_url }));
  const ok = look !== 'model' && await scene.setFootage(S.rig, media, S.site?.camera_horizons).catch(() => false);
  const activeLook = ok ? look : 'model';
  scene.setPhoto(Boolean(ok), { look: activeLook });
  if (ok) ensurePainted();
  const lookEl = $('scene-look');
  if (lookEl) {
    for (const b of lookEl.querySelectorAll('button[data-look]')) {
      b.classList.toggle('on', b.dataset.look === activeLook);
      b.disabled = b.dataset.look !== 'model' && !hasPhoto;
    }
  }
}

// AI world (server/paint.js): image-model ground + object cutouts so the
// street looks clean from outside views (Above/Side/Top). Generated in the
// background after footage loads; the "AI world" button flies out to the
// Above view, and again returns to the original Driver look.
// Opt-in (?paint=1): the image model doesn't follow the layout closely enough yet.
const PAINT = params.get('paint') === '1';
let paintOn = false, paintState = 'off'; // off | busy | ready | failed
let paintFor = null;
const paintKey = () => `${S.siteId}|${S.site?.round ?? 0}|${JSON.stringify(S.site?.obstacles ?? []).length}`;
async function ensurePainted() {
  if (!PAINT || !S.site || !S.siteId || !S.media.some((m) => m.keyframe_url) || paintFor === paintKey()) return;
  const key = (paintFor = paintKey());
  const stale = () => paintFor !== key || paintKey() !== key;
  setPaintStatus('busy');
  try {
    const sprites = await buildSpriteJobs(S.site, S.rig, S.media, S.site.camera_horizons);
    const ground = scene.capturePaintGuides();
    panel.log('log', { message: `AI world: painting the ground + ${sprites.length} objects…` });
    const r = await fetch(`/api/sites/${encodeURIComponent(S.siteId)}/paint`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ground, sprites: sprites.map(({ cam, ...s }) => s) }),
    });
    const j = r.ok ? await r.json() : null;
    if (stale()) return;
    if (!j) throw new Error(`HTTP ${r.status}`);
    const [g, cut] = await Promise.all([
      j.ground?.url ? loadGround(j.ground.url).catch(() => null) : null,
      Promise.all((j.sprites ?? []).map(async (s) => {
        const k = s?.url ? await keyOut(s.url).catch(() => null) : null;
        return k && { id: s.id, ...k };
      })),
    ]);
    if (stale()) return;
    const ok = cut.filter(Boolean);
    scene.setPaint({ ground: g, sprites: ok });
    panel.log('log', { message: `AI world ready: ${g ? 'ground' : 'no ground'}, ${ok.length}/${sprites.length} objects` });
    setPaintStatus(g || ok.length ? 'ready' : 'failed');
  } catch (err) {
    if (paintFor === key) paintFor = null;
    console.warn('paint failed', err);
    panel.log('log', { message: `AI world unavailable: ${err.message}` });
    setPaintStatus('failed');
  }
}
function setPaintStatus(st) {
  const was = paintState === 'ready' && paintOn;
  paintState = st;
  const ready = st === 'ready';
  if (paintOn && ready && !was && !scene.playing) scene.setView('overview');
  if (!ready && paintOn) paintOn = st === 'busy';
  if ((!paintOn || !ready) && scene.view !== 'pov' && !scene.playing) scene.setView('pov');
  scene.setPaintEnabled(paintOn);
  for (const b of $('view-controls').querySelectorAll('button[data-outside]')) b.hidden = !(paintOn && ready);
  const t = $('btn-paint');
  if (t) {
    t.hidden = !PAINT;
    t.classList.toggle('on', paintOn);
    t.disabled = st === 'off' || st === 'failed';
    t.textContent = paintOn && st === 'busy' ? 'AI world…' : paintOn ? '✕ AI world' : 'AI world';
    t.title = st === 'busy' ? 'Painting the street for outside views (~1 min the first time)…'
      : paintOn ? 'Back to the original Driver view (real footage)' : 'AI world: fly out and see the street from any angle';
  }
  syncViewButtons();
}
function syncViewButtons() {
  for (const x of $('view-controls').querySelectorAll('button[data-view]')) x.classList.toggle('on', x.dataset.view === scene.view);
}
$('btn-paint')?.addEventListener('click', () => {
  if (scene.playing) return;
  paintOn = !paintOn;
  if (paintOn && paintState === 'ready') scene.setView('overview');
  setPaintStatus(paintState);
});
setPaintStatus('off');

// Ask the server for illustrated frames (cached; ~20 s the first time).
async function ensureIllustrated() {
  if (!S.siteId || !S.media.some((m) => m.keyframe_url) || S.media.every((m) => m.illustrated_url)) return;
  try {
    const r = await fetch(`/api/sites/${encodeURIComponent(S.siteId)}/illustrate`, { method: 'POST' });
    if (!r.ok) return;
    const { cameras } = await r.json();
    for (const c of cameras) { const m = S.media.find((x) => x.id === c.id); if (m && c.url) m.illustrated_url = c.url; }
    showFootage();
  } catch { /* visual only */ }
}

// AI world view: the image model paints a photoreal picture for the fixed
// chase camera from our layout render + the keyframes (server/worldview.js).
// Opt-in (?world=1): the model doesn't follow the layout closely enough yet.
let worldFor = null;
async function ensureWorld() {
  if (params.get('world') !== '1' || !S.site || !S.siteId || !S.media.some((m) => m.keyframe_url) || worldFor === S.siteId) return;
  const id = (worldFor = S.siteId);
  try {
    panel.log('log', { message: 'Generating a realistic view of the street…' });
    const r = await fetch(`/api/sites/${encodeURIComponent(id)}/worldview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ guide: scene.captureGuide() }),
    });
    const j = r.ok ? await r.json() : null;
    if (S.siteId !== id) return;
    if (!j?.url) { worldFor = null; panel.log('log', { message: `Realistic view unavailable${j?.error ? `: ${j.error}` : ''}` }); return; }
    await scene.setWorldImage(j.url);
  } catch (err) { worldFor = null; console.warn('worldview failed', err); }
}

function showZones() {
  try { scene.setZones(S.site ? landableMap(S.site) : null); } catch (err) { console.warn('landable map failed', err); }
}

function setTarget(t) {
  S.target = t;
  scene.setTarget(t);
  const el = $('target-readout');
  if (t) el.innerHTML = `<span class="pin"></span>Landing spot <b>${fmt(Math.abs(t.forward), 1)} m</b> ${t.forward < 0 ? 'behind' : 'ahead'} · <b>${fmt(Math.abs(t.right), 1)} m</b> ${t.right < 0 ? 'left' : 'right'}`;
  updateButtons();
}

function onTap(t) {
  if (S.busy || !S.site) return;
  if (S.rounds.length || S.result || S.landed || S.planError) resetPlan();
  setTarget(t);
}

function newSpot() {
  resetPlan();
  setTarget(null);
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

// Progress steps double as navigation: click one to (re)do that step.
function stepAction(step) {
  if (S.busy) return null;
  if (step === 'scan') return canScan() ? scan : null;
  if (step === 'pick') return S.site && S.target ? newSpot : null;
  if (step === 'plan') return canPlan() ? () => plan() : null;
  if (step === 'hop') return canHop() || S.landed ? hop : null;
  return null;
}
$('steps').addEventListener('click', (e) => {
  const run = stepAction(e.target.closest('li[data-step]')?.dataset.step);
  if (run) run();
});
$('btn-newspot').addEventListener('click', newSpot);
$('btn-replan').addEventListener('click', () => plan());
$('btn-video').addEventListener('click', video);

// Camera drawer (collapsible).
function openCams(open) {
  $('cams').classList.toggle('open', open);
  $('cams-toggle').setAttribute('aria-expanded', String(open));
}
$('cams-toggle').addEventListener('click', () => openCams(!$('cams').classList.contains('open')));
if (window.innerWidth < 1100) openCams(false);

// Specs popover: click outside / Esc closes.
function toggleSpecs(open) {
  const show = open ?? $('specs-pop').hidden;
  $('specs-pop').hidden = !show;
  $('btn-specs').classList.toggle('on', show);
  $('btn-specs').setAttribute('aria-expanded', String(show));
}
$('site-picker').addEventListener('change', (e) => loadSite(e.target.value));
$('btn-specs').addEventListener('click', (e) => { e.stopPropagation(); toggleSpecs(); });
document.addEventListener('click', (e) => { if (!e.target.closest('#specs-pop')) toggleSpecs(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { toggleSpecs(false); $('lightbox').hidden = true; } });
$('view-controls').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b && !scene.playing) { scene.setView(b.dataset.view); syncViewButtons(); }
});
$('car-variant')?.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-car]');
  if (!b) return;
  scene.setCarVariant(b.dataset.car);
  for (const x of $('car-variant').querySelectorAll('button')) x.classList.toggle('on', x === b);
  for (const x of $('view-controls').querySelectorAll('button')) x.classList.toggle('on', x.dataset.view === scene.view);
});
$('scene-look')?.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-look]');
  if (!b || b.disabled) return;
  LOOK = b.dataset.look;
  showFootage();
});
// Keyboard shortcuts for the stage: S scan, P plan, H hop, R recenter.
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (k === 's' && canScan()) scan();
  if (k === 'p' && canPlan()) plan();
  if (k === 'h' && canHop()) hop();
  if (k === 'r' && !scene.playing) scene.setView('pov');
});

renderSpecs();
pills();
updateButtons();
await initSites();
// Footer eval stat removed: scripts/eval.mjs matched objects by scan-specific ids
// and fell back to hard-coded numbers, so the figures were not trustworthy.
// Deep-link a target: ?target=25,0
if (params.get('target')) {
  const [f, r] = params.get('target').split(',').map(Number);
  if (Number.isFinite(f) && Number.isFinite(r)) setTarget({ forward: f, right: r });
}

