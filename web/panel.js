// Right panel (PLAN §8): plan banner, D22 validity banner, verdict + 9-check
// list + air gauge for the selected arc, rounds with 4 candidate chips each,
// the agent's "why", and the live agent log.
import { CHECKS, CAR, SAFETY, PLAN_VALID_S } from '../shared/constants.js';
import { esc, fmt, failReason, checkValue } from './format.js';

const ICONS = {
  thought: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 11.5c-1-.8-1.5-2-1.5-3.3C1.5 5.3 4.4 3 8 3s6.5 2.3 6.5 5.2S11.6 13.4 8 13.4c-.8 0-1.6-.1-2.3-.3L3 14z"/></svg>',
  tool: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6.5l2 1.8-2 1.8M8.5 10.5h3"/></svg>',
  result: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6.5"/><path d="M5 8.3l2 2 4-4.3"/></svg>',
  bad: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/></svg>',
  log: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="2"/></svg>',
  error: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 1.8l6.5 12H1.5z"/><path d="M8 6.5v3.2M8 11.6v.4"/></svg>',
};

export function createPanel({ bannerEl, validEl, verdictEl, titleEl, checklistEl, airEl, roundsEl, logEl, onSelect }) {
  let validTimer = null;

  function banner(kind, text, sub = '') {
    bannerEl.className = `banner ${kind}`;
    bannerEl.innerHTML = `${esc(text)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}`;
  }

  // ---------------------------------------------------------------- selected arc
  function showArc(c, site) {
    if (!c) {
      verdictEl.className = 'verdict none';
      verdictEl.textContent = 'No route selected';
      titleEl.textContent = '';
      checklistEl.innerHTML = CHECKS.map((k) => `<li class="na"><span class="ic">·</span><span class="lbl">${esc(k.label)}</span><span class="val">—</span></li>`).join('');
      airEl.innerHTML = gaugeHTML(null);
      return;
    }
    const sim = c.sim ?? {};
    const safe = sim.verdict === 'SAFE';
    const reason = safe ? '' : failReason(sim, site);
    verdictEl.className = `verdict ${safe ? 'safe' : 'unsafe'}`;
    verdictEl.innerHTML = safe ? 'SAFE' : `UNSAFE <span class="reason">— ${esc(reason ?? 'see checks')}</span>`;
    const p = c.params ?? sim.params ?? {};
    const disagree = c.disagrees
      ? `<div class="note disagree">Agent claimed ${esc(c.agent_claim?.sim_verdict ?? '?')}; our simulator says ${esc(sim.verdict)} — the simulator wins.</div>`
      : '';
    titleEl.innerHTML = `<b>${esc(c.id)}</b> · ${esc(c.label ?? '')}<br><span class="small">apex ${fmt(p.apex_height_m, 1)} m · ${fmt(p.duration_s, 1)} s · bow ${fmt(p.side_bow_m, 1)} m · climb ${fmt(p.climb_bias, 2)}</span>${disagree}`;
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
  function showRounds(rounds, { selectedKey, chosenKey, site } = {}) {
    if (!rounds.length) {
      roundsEl.innerHTML = '<div class="dim small">Each round the agent proposes 4 routes; our simulator checks all 4.</div>';
      return;
    }
    roundsEl.innerHTML = rounds.map((r) => {
      const chips = [];
      for (let i = 0; i < 4; i++) {
        const c = r.candidates[i];
        if (!c) { chips.push('<div class="chip pending"><span class="cid">…</span><span class="why">simulating</span></div>'); continue; }
        const chosen = c.key === chosenKey;
        const cls = chosen ? 'chosen' : c.sim?.verdict === 'SAFE' ? 'safe' : 'unsafe';
        const sub = chosen ? 'chosen' : c.sim?.verdict === 'SAFE' ? 'SAFE' : failReason(c.sim, site) ?? 'UNSAFE';
        chips.push(`<button class="chip ${cls}${c.key === selectedKey ? ' sel' : ''}" data-key="${esc(c.key)}" title="${esc(c.label ?? '')}">
          <span class="cid">${esc(c.id)}${c.disagrees ? ' <span class="warn" title="server disagreed with the agent">!</span>' : ''}</span><span class="why">${esc(sub)}</span></button>`);
      }
      const nSafe = r.candidates.filter((c) => c.sim?.verdict === 'SAFE').length;
      const dec = r.decision === 'pick' ? 'picked' : r.decision === 'revise' ? 'revised' : r.decision === 'reject' ? 'rejected' : '';
      const why = r.decision === 'pick' && r.why ? `<div class="whytext"><b>Why ${esc(r.chosen_id)}:</b> ${esc(r.why)}</div>` : '';
      const rev = r.decision === 'revise' && r.revision_notes ? `<div class="revtext" title="${esc(r.revision_notes)}">${esc(r.revision_notes)}</div>` : '';
      return `<div class="round"><div class="round-head"><span><b>Round ${r.n}</b> · ${nSafe}/${r.candidates.length} safe</span><span>${dec}</span></div>
        <div class="chips">${chips.join('')}</div>${why}${rev}</div>`;
    }).join('');
    // keep the newest round in view
    const wrap = roundsEl.parentElement;
    const sel = roundsEl.querySelector('.chip.sel')?.closest('.round');
    wrap.scrollTop = sel ? sel.offsetTop - 8 : wrap.scrollHeight;
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

  // ---------------------------------------------------------------- D22 banner
  function startValidity() {
    stopValidity();
    const t0 = performance.now();
    validEl.hidden = false;
    const tick = () => {
      const left = PLAN_VALID_S - (performance.now() - t0) / 1000;
      if (left > 0) {
        validEl.className = 'valid';
        validEl.textContent = `Plan valid ~${PLAN_VALID_S} s — rescan before HOP · ${Math.ceil(left)} s`;
      } else {
        validEl.className = 'valid stale';
        validEl.textContent = 'Plan older than 10 s — rescan before HOP';
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
  return { banner, showArc, showRounds, log, clearLog: () => (logEl.innerHTML = ''), startValidity, stopValidity };
}
