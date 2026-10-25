// Right column (PLAN §8): a simple result card (big verdict, one-sentence why,
// three key numbers, D22 validity countdown) and a "Details" disclosure with
// everything technical: 9-check list + air gauge for the selected route,
// rounds with candidate chips (tap to replay), and the live agent log.
import { CHECKS, CAR, SAFETY, PLAN_VALID_S, CANDIDATES_PER_ROUND } from '../shared/constants.js';
import { esc, fmt, failReason, checkValue } from './format.js';

const ICONS = {
  thought: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 11.5c-1-.8-1.5-2-1.5-3.3C1.5 5.3 4.4 3 8 3s6.5 2.3 6.5 5.2S11.6 13.4 8 13.4c-.8 0-1.6-.1-2.3-.3L3 14z"/></svg>',
  tool: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6.5l2 1.8-2 1.8M8.5 10.5h3"/></svg>',
  result: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6.5"/><path d="M5 8.3l2 2 4-4.3"/></svg>',
  bad: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/></svg>',
  log: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="2"/></svg>',
  error: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 1.8l6.5 12H1.5z"/><path d="M8 6.5v3.2M8 11.6v.4"/></svg>',
};

export function createPanel({ cardEl, kickerEl, bannerEl, whyEl, whyMoreEl, progressEl, activityEl, keynumsEl, validEl, verdictEl, titleEl, checklistEl, airEl, roundsEl, logEl, onSelect }) {
  let validTimer = null;
  let kind = 'idle';
  let current = null; // the card's route (chosen one, or the closest try on REJECT)

  // ---------------------------------------------------------------- card
  // kind: idle | busy | safe | reject | error. text = big verdict, sub = the "why".
  function banner(k, text, sub = '', { kicker } = {}) {
    kind = k;
    cardEl.className = `card ${k}`;
    bannerEl.textContent = text;
    kickerEl.textContent = kicker ?? ({ idle: 'Result', busy: 'Working', safe: 'Plan', reject: 'Plan', error: 'Problem' })[k] ?? 'Result';
    setWhy(sub);
    progressEl.hidden = k !== 'busy';
    if (k !== 'busy') resetActivity();
    drawKeyNums();
  }

  // ---------------------------------------------------------------- live agent activity (planning)
  // The wait is the show: latest thought, what the agent is running, and what
  // our simulator told it — in the card, not only in the hidden log.
  let act = null;
  let actTimer = null;
  function resetActivity() {
    act = null;
    if (actTimer) clearInterval(actTimer);
    actTimer = null;
    activityEl.hidden = true;
    activityEl.innerHTML = '';
  }
  function describeTool(d) {
    const code = `${d.name ?? ''} ${d.code ?? d.command ?? d.message ?? ''}`;
    if (/view_file|read_file/.test(code) && !/\.(jpe?g|png)\b/i.test(code)) return { text: 'Managed Agent reading the 3D street model…', code: '' };
    if (/sim-cli|simulat/i.test(code)) return { text: 'Managed Agent testing its own paths in the simulator…', code: '' };
    if (/result\.json|> ?\/workspace\/out|writeFile|cat\s*>/.test(code)) return { text: 'Managed Agent writing its decision…', code: '' };
    if (/\.(jpe?g|png)\b|frames?/i.test(code)) return { text: 'Managed Agent looking at the camera photos…', code: '' };
    if (/site\.json|cat |head |jq |less /.test(code)) return { text: 'Managed Agent reading the 3D street model…', code: '' };
    return { text: 'Running', code: code.split('\n')[0].slice(0, 80) };
  }
  function activity(type, d = {}) {
    if (kind !== 'busy') return;
    act ??= { t0: performance.now(), thought: '', tool: null, sim: '', n: 0 };
    if (type === 'thought') act.thought = String(d.text ?? d.message ?? d.delta ?? '').replace(/\*\*([^*]+)\*\*/g, '$1 — ').replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim().slice(0, 400) || act.thought;
    else if (type === 'tool') { act.tool = describeTool(d); act.n++; }
    else if (type === 'sim_result') act.sim = String(d.summary ?? d.message ?? '');
    if (!actTimer) actTimer = setInterval(drawActivity, 1000);
    drawActivity();
  }
  function drawActivity() {
    if (!act) return;
    const secs = Math.round((performance.now() - act.t0) / 1000);
    activityEl.hidden = false;
    activityEl.innerHTML = [
      act.thought ? `<div class="act-thought"><div class="act-lbl">Managed Agent is thinking</div><div class="act-tx">${esc(act.thought)}</div></div>` : '',
      act.tool ? `<div class="act-row tool live"><span class="ic">›_</span><span class="tx">${esc(act.tool.text)}${act.tool.code ? ` <code>${esc(act.tool.code)}</code>` : ''}</span></div>` : '',
      act.sim ? `<div class="act-row sim"><span class="ic">✓</span><span class="tx" title="${esc(act.sim)}">${esc(act.sim)}</span></div>` : '',
      `<div class="act-meta">Managed Agent · ${act.n} step${act.n === 1 ? '' : 's'} · ${secs} s</div>`,
    ].join('');
  }

  function setWhy(text) {
    whyEl.textContent = text ?? '';
    whyEl.classList.remove('open');
    whyEl.hidden = !text;
    whyMoreEl.hidden = true;
    whyMoreEl.textContent = 'more';
    // show "more" only when the clamp actually truncates
    requestAnimationFrame(() => { whyMoreEl.hidden = !text || whyEl.scrollHeight <= whyEl.clientHeight + 2; });
  }
  whyMoreEl.addEventListener('click', () => {
    const open = whyEl.classList.toggle('open');
    whyMoreEl.textContent = open ? 'less' : 'more';
  });

  function busyText(text) { progressEl.dataset.text = text ?? ''; drawProgress(); }

  // ---------------------------------------------------------------- key numbers
  function num(label, value, unit, sub, state) {
    return `<div class="kn ${state ?? ''}"><div class="kn-lbl">${esc(label)}</div><div class="kn-val">${value}<small>${esc(unit)}</small></div><div class="kn-sub">${sub}</div></div>`;
  }

  function drawKeyNums() {
    const sim = current?.sim;
    const show = sim && (kind === 'safe' || kind === 'reject');
    keynumsEl.hidden = !show;
    if (!show) { keynumsEl.innerHTML = ''; return; }
    const chk = (id) => sim.checks?.find((c) => c.id === id);
    const clr = chk('clearance');
    const air = sim.air ?? {};
    const start = air.start_kg ?? CAR.airKg;
    const left = air.remaining_kg;
    const td = sim.touchdown;
    const tdv = chk('touchdown_vertical');
    const st = (c) => (!c ? '' : c.pass ? 'ok' : 'bad');
    const airPct = left == null ? 0 : Math.max(0, Math.min(100, (left / start) * 100));
    const resPct = (SAFETY.airReserveKg / start) * 100;
    const airBar = `<div class="kn-bar"><i style="width:${airPct}%"></i><b style="left:${resPct}%"></b></div>`;
    const fails = (sim.checks ?? []).filter((c) => !c.pass);
    const failLine = sim.verdict === 'SAFE' || !fails.length ? '' : `<div class="kn-fail"><span class="x">✕</span><span><b>${esc(current.id)}</b> fails: ${esc(failReason(sim, cardSite) ?? fails[0].id)}${fails.length > 1 ? ` <span class="faint">+${fails.length - 1} more check${fails.length > 2 ? 's' : ''}</span>` : ''}</span></div>`;
    keynumsEl.innerHTML = failLine + [
      num('Clearance', fmt(clr?.value, 2), 'm', `need ≥ ${clr?.limit ?? SAFETY.minClearanceM} m`, st(clr)),
      num('Air left', fmt(left, 0), 'kg', `${airBar}reserve ${SAFETY.airReserveKg} kg`, left == null ? '' : left >= SAFETY.airReserveKg ? 'ok' : 'bad'),
      num('Touchdown', fmt(td?.v_vertical ?? tdv?.value, 1), 'm/s', `need < ${tdv?.limit ?? SAFETY.maxTouchdownVerticalMs} m/s`, st(tdv)),
    ].join('');
  }

  // ---------------------------------------------------------------- selected arc (Details)
  let cardSite = null;
  function setCardRoute(c, site) { current = c ?? null; cardSite = site ?? cardSite; drawKeyNums(); }

  function showArc(c, site) {
    if (!c) {
      verdictEl.className = 'verdict none';
      verdictEl.textContent = 'No flight path selected';
      titleEl.textContent = '';
      checklistEl.innerHTML = CHECKS.map((k) => `<li class="na"><span class="ic">·</span><span class="lbl">${esc(k.label)}</span><span class="val">—</span></li>`).join('');
      airEl.innerHTML = gaugeHTML(null);
      return;
    }
    const sim = c.sim ?? {};
    const safe = sim.verdict === 'SAFE';
    const reason = safe ? '' : failReason(sim, site);
    verdictEl.className = `verdict ${safe ? 'safe' : 'unsafe'}`;
    verdictEl.innerHTML = `${esc(c.id)} · ${safe ? 'SAFE' : `UNSAFE <span class="reason">— ${esc(reason ?? 'see checks')}</span>`}`;
    const p = c.params ?? sim.params ?? {};
    const disagree = c.disagrees
      ? `<div class="note disagree">Agent claimed ${esc(c.agent_claim?.sim_verdict ?? '?')}; our simulator says ${esc(sim.verdict)} — the simulator wins.</div>`
      : '';
    titleEl.innerHTML = `${esc(c.label ?? '')}<br><span class="small">apex ${fmt(p.apex_height_m, 1)} m · ${fmt(p.duration_s, 1)} s · bow ${fmt(p.side_bow_m, 1)} m · climb ${fmt(p.climb_bias, 2)}${p.vertical_drop ? ` · drop ${fmt(p.vertical_drop, 2)}` : ''}</span>${disagree}`;
    checklistEl.innerHTML = CHECKS.map((k) => {
      const ch = sim.checks?.find((x) => x.id === k.id);
      const cls = !ch ? 'na' : ch.pass ? 'pass' : 'fail';
      const ic = !ch ? '·' : ch.pass ? '✓' : '✕';
      return `<li class="${cls}" title="${esc(ch?.message ?? '')}"><span class="ic">${ic}</span><span class="lbl">${esc(k.label)}</span><span class="val">${checkValue(ch)}</span></li>`;
    }).join('');
    airEl.innerHTML = gaugeHTML(sim);
  }

  function gaugeHTML(sim) {
    const start = sim?.air?.start_kg ?? CAR.airKg;
    const left = sim?.air?.remaining_kg;
    const used = sim?.air?.used_kg;
    const pct = left == null ? 0 : Math.max(0, Math.min(100, (left / start) * 100));
    const low = left != null && left < SAFETY.airReserveKg;
    const td = sim?.touchdown;
    return `<div class="gauge-head"><span>Air</span><span>${left == null ? '—' : `used <b>${fmt(used, 0)} kg</b> · left <b>${fmt(left, 0)} kg</b>`}</span></div>
      <div class="gauge"><div class="left${low ? ' low' : ''}" style="width:${pct}%"></div><div class="reserve" style="left:${(SAFETY.airReserveKg / start) * 100}%"></div></div>
      <div class="gauge-foot"><span>0</span><span>reserve ${SAFETY.airReserveKg} kg</span><span>${start} kg</span></div>
      <div class="stats">
        <div>Peak thrust<b>${sim?.peak ? fmt(sim.peak.thrust_kN, 1) + ' kN' : '—'}</b></div>
        <div>Apex<b>${sim?.peak ? fmt(sim.peak.up_m, 1) + ' m' : '—'}</b></div>
        <div>Touchdown<b>${td ? fmt(td.v_vertical, 1) + ' m/s' : '—'}</b></div>
      </div>`;
  }

  // ---------------------------------------------------------------- rounds
  // rounds: [{n, candidates: [cand], decision, chosen_id, why, revision_notes}]
  let lastRounds = [];
  function showRounds(rounds, { selectedKey, chosenKey, site } = {}) {
    lastRounds = rounds;
    drawProgress();
    if (!rounds.length) {
      roundsEl.innerHTML = '<div class="dim small">Each round proposes 4 flight paths; our simulator checks every one. None yet.</div>';
      return;
    }
    roundsEl.innerHTML = rounds.map((r) => {
      const chips = [];
      const n = Math.max(CANDIDATES_PER_ROUND, r.candidates.length);
      for (let i = 0; i < n; i++) {
        const c = r.candidates[i];
        if (!c) { chips.push('<div class="chip pending"><span class="cid">…</span><span class="why">simulating</span></div>'); continue; }
        const chosen = c.key === chosenKey;
        const cls = chosen ? 'chosen' : c.sim?.verdict === 'SAFE' ? 'safe' : 'unsafe';
        const sub = chosen ? 'chosen' : c.sim?.verdict === 'SAFE' ? 'SAFE' : failReason(c.sim, site) ?? 'UNSAFE';
        chips.push(`<button class="chip ${cls}${c.key === selectedKey ? ' sel' : ''}" data-key="${esc(c.key)}" title="${esc(`${c.label ?? ''} — ${sub}`)}">
          <span class="cid">${esc(c.id)}${c.disagrees ? ' <span class="warn" title="server disagreed with the agent">!</span>' : ''}</span><span class="why">${esc(sub)}</span></button>`);
      }
      const nSafe = r.candidates.filter((c) => c.sim?.verdict === 'SAFE').length;
      const dec = r.decision === 'pick' ? 'picked' : r.decision === 'revise' ? 'revised' : r.decision === 'reject' ? 'rejected' : '';
      const why = r.decision === 'pick' && r.why ? `<div class="whytext"><b>Why ${esc(r.chosen_id)}:</b> ${esc(r.why)}</div>` : '';
      const rev = r.decision === 'revise' && r.revision_notes ? `<div class="revtext" title="${esc(r.revision_notes)}">${esc(r.revision_notes)}</div>` : '';
      return `<div class="round"><div class="round-head"><span><b>Round ${r.n}</b> · ${nSafe}/${r.candidates.length} safe</span><span>${dec}</span></div>
        <div class="chips">${chips.join('')}</div>${why}${rev}</div>`;
    }).join('');
    // keep the selected (or newest) round in view
    const wrap = roundsEl;
    const sel = roundsEl.querySelector('.chip.sel')?.closest('.round');
    wrap.scrollTop = sel ? sel.offsetTop - wrap.offsetTop - 4 : wrap.scrollHeight;
  }

  // Card progress while planning: status text + one dot per simulated route.
  function drawProgress() {
    const text = progressEl.dataset.text ?? '';
    const rows = lastRounds.map((r) => {
      const dots = r.candidates.map((c) => `<i class="${c.sim?.verdict === 'SAFE' ? 'ok' : 'bad'}"></i>`).join('');
      const pend = Math.max(0, CANDIDATES_PER_ROUND - r.candidates.length);
      return `<div class="pr-row"><span>Round ${r.n}</span><span class="dots">${dots}${'<i></i>'.repeat(pend)}</span></div>`;
    }).join('');
    progressEl.innerHTML = `${text ? `<div class="pr-text">${esc(text)}</div>` : ''}${rows}`;
  }

  roundsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.chip[data-key]');
    if (b) onSelect?.(b.dataset.key);
  });

  // ---------------------------------------------------------------- log
  function log(type, data = {}, t_ms) {
    const near = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    const row = document.createElement('div');
    let cls = 'log', icon = ICONS.log, html;
    const t = typeof t_ms === 'number' ? `<span class="t">${(t_ms / 1000).toFixed(1)}s</span>` : '';
    if (type === 'thought') { cls = 'thought'; icon = ICONS.thought; html = esc(data.text ?? data.message ?? data.delta ?? ''); }
    else if (type === 'tool') { cls = 'tool'; icon = ICONS.tool; html = `<code>${esc(data.code ?? data.command ?? data.message ?? data.name ?? JSON.stringify(data))}</code>`; }
    else if (type === 'attempt' || type === 'sim_result' || type === 'result') {
      const ok = data.ok ?? data.sim?.verdict === 'SAFE';
      cls = `result${ok ? '' : ' bad'}`; icon = ok ? ICONS.result : ICONS.bad;
      html = esc(data.message ?? data.summary ?? '');
    } else if (type === 'error') { cls = 'error'; icon = ICONS.error; html = esc(data.message ?? String(data)); }
    else html = esc(data.message ?? data.text ?? (typeof data === 'string' ? data : JSON.stringify(data)));
    if (!html) return;
    row.className = `row ${cls}`;
    row.innerHTML = `${icon}<div>${t}${html}</div>`;
    logEl.append(row);
    while (logEl.childElementCount > 400) logEl.firstElementChild.remove();
    if (near) logEl.scrollTop = logEl.scrollHeight;
  }

  // ---------------------------------------------------------------- D22 countdown
  function startValidity() {
    stopValidity();
    const t0 = performance.now();
    validEl.hidden = false;
    const tick = () => {
      const left = PLAN_VALID_S - (performance.now() - t0) / 1000;
      if (left > 0) {
        validEl.className = 'valid';
        validEl.innerHTML = `<span>Plan valid ~${PLAN_VALID_S} s — rescan before flying</span><b>${Math.ceil(left)} s</b>`;
      } else {
        validEl.className = 'valid stale';
        validEl.innerHTML = `<span>Plan older than ${PLAN_VALID_S} s — rescan before flying</span>`;
        clearInterval(validTimer);
        validTimer = null;
      }
    };
    tick();
    validTimer = setInterval(tick, 250);
  }
  function stopValidity() {
    if (validTimer) clearInterval(validTimer);
    validTimer = null;
    validEl.hidden = true;
  }

  showArc(null);
  showRounds([]);
  return { banner, busyText, activity, setCardRoute, showArc, showRounds, log, clearLog: () => (logEl.innerHTML = ''), startValidity, stopValidity, get kind() { return kind; } };
}
