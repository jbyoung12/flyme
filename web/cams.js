// Left camera strip (PLAN §8): one tile per rig camera with footage (keyframe
// or mp4), our loop-1 render on top (Footage / Render / Blend + opacity),
// per-tile match score badge and issues, plus a lightbox for a big compare.
import { esc } from './format.js';
import { CRITIQUE_PASS_SCORE, MAX_CRITIQUE_ROUNDS } from '../shared/constants.js';

export function createCams({ tilesEl, modeEl, blendEl, roundEl, lightboxEl }) {
  let cams = []; // [{id, mp4_url, keyframe_url}]
  let renders = {};
  let scores = {}; // id → {match_score, issues}
  let mode = 'footage';
  let opacity = Number(blendEl.value) / 100;
  let lightboxId = null;

  const renderOpacity = () => (mode === 'footage' ? 0 : mode === 'render' ? 1 : opacity);

  function footageHTML(c) {
    if (c.keyframe_url) return `<img class="footage" src="${esc(c.keyframe_url)}" alt="" draggable="false" />`;
    if (c.mp4_url) return `<video class="footage" src="${esc(c.mp4_url)}" muted loop autoplay playsinline></video>`;
    return `<div class="nofeed">no footage</div>`;
  }

  function scoreClass(s) {
    return s >= CRITIQUE_PASS_SCORE ? 'good' : s >= 65 ? 'mid' : 'bad';
  }

  function draw() {
    tilesEl.innerHTML = cams.map((c) => {
      const sc = scores[c.id];
      const hasFootage = c.keyframe_url || c.mp4_url;
      const op = hasFootage ? renderOpacity() : mode === 'footage' ? 0 : 1;
      return `<div class="tile" data-id="${esc(c.id)}">
        <div class="frame">
          ${footageHTML(c)}
          ${renders[c.id] ? `<img class="render" src="${renders[c.id]}" style="opacity:${op}" alt="" draggable="false" />` : ''}
          <span class="cam-id">${esc(c.id)}</span>
          ${sc ? `<span class="score ${scoreClass(sc.match_score)}">${sc.match_score}</span>` : ''}
        </div>
        <ul class="issues">${(sc?.issues ?? []).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
      </div>`;
    }).join('');
    if (lightboxId) openLightbox(lightboxId);
  }

  function applyOpacity() {
    for (const tile of tilesEl.querySelectorAll('.tile')) {
      const c = cams.find((x) => x.id === tile.dataset.id);
      const img = tile.querySelector('.render');
      if (!img) continue;
      const hasFootage = c?.keyframe_url || c?.mp4_url;
      img.style.opacity = hasFootage ? renderOpacity() : mode === 'footage' ? 0 : 1;
    }
    if (lightboxId && !lightboxEl.hidden) openLightbox(lightboxId);
  }

  function openLightbox(id) {
    const c = cams.find((x) => x.id === id);
    if (!c) return;
    lightboxId = id;
    const sc = scores[id];
    const op = c.keyframe_url || c.mp4_url ? renderOpacity() : mode === 'footage' ? 0 : 1;
    lightboxEl.innerHTML = `<div class="frame">${footageHTML(c)}${renders[id] ? `<img class="render" src="${renders[id]}" style="opacity:${op}" alt="" />` : ''}
      <div class="seg mini lb-mode">
        <button data-mode="footage" class="${mode === 'footage' ? 'on' : ''}">Footage</button>
        <button data-mode="blend" class="${mode === 'blend' ? 'on' : ''}">Blend</button>
        <button data-mode="render" class="${mode === 'render' ? 'on' : ''}">Render</button>
      </div>
    </div>
      <div class="cap"><b>${esc(id)}</b>${sc ? ` · match ${sc.match_score}/100` : ''} · ${esc(mode)} — tap outside to close</div>
      ${sc?.issues?.length ? `<ul class="cap-issues">${sc.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}`;
    lightboxEl.hidden = false;
  }

  tilesEl.addEventListener('click', (e) => {
    const tile = e.target.closest('.tile');
    if (tile) openLightbox(tile.dataset.id);
  });
  lightboxEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b) {
      e.stopPropagation();
      modeEl.querySelector(`button[data-mode="${b.dataset.mode}"]`)?.click();
      return;
    }
    lightboxEl.hidden = true;
    lightboxId = null;
  });
  modeEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    mode = b.dataset.mode;
    for (const x of modeEl.querySelectorAll('button')) x.classList.toggle('on', x === b);
    applyOpacity();
  });
  blendEl.addEventListener('input', () => {
    opacity = Number(blendEl.value) / 100;
    if (mode !== 'blend') modeEl.querySelector('[data-mode=blend]').click();
    applyOpacity();
  });

  return {
    // rig cameras + GET /api/sites/:id camera_media (nulls tolerated)
    setCameras(rig, media = []) {
      cams = (rig?.cameras ?? []).map((c) => ({ id: c.id, ...(media.find((m) => m.id === c.id) ?? {}) }));
      draw();
    },
    setMedia(media = []) {
      cams = cams.map((c) => ({ ...c, ...(media.find((m) => m.id === c.id) ?? {}) }));
      draw();
    },
    setRenders(r) { renders = r ?? {}; draw(); },
    setScores(critique) {
      scores = {};
      for (const c of critique?.cameras ?? []) scores[c.id] = c;
      draw();
      for (const t of tilesEl.querySelectorAll('.tile')) { t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); }
    },
    clearScores() { scores = {}; draw(); },
    setRound(n, { done = false, busy = false } = {}) {
      roundEl.hidden = true; // scan progress already shows in the step bar and status line
      roundEl.textContent = n == null ? 'not scanned' : busy ? (n ? `Round ${n}/${MAX_CRITIQUE_ROUNDS}…` : 'Rebuilding…') : done && n > 0 ? `✓ Matches footage` : `Round ${n}/${MAX_CRITIQUE_ROUNDS}`;
      roundEl.title = `Loop 1: Argon compares our renders with the footage and patches the 3D street${done && n > 0 ? ` — verified after ${n} of up to ${MAX_CRITIQUE_ROUNDS} rounds` : ''}`;
      roundEl.className = `pill ${done ? 'ok' : busy ? 'live' : 'dim'}`;
    },
  };
}
