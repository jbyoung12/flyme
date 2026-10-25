// Stretch 1 (T5a): In-car modal for recording the 3D hop render and generating
// a photoreal video via `gemini-omni-1.1-flash` (`POST /api/video`, `GET /api/video/:job`).

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function ensureModal() {
  let modal = document.getElementById('omni-video-modal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'omni-video-modal';
  modal.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:9999',
    'background:rgba(6,8,12,0.82)',
    'backdrop-filter:blur(8px)',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'padding:24px',
    'font-family:Inter,system-ui,-apple-system,sans-serif',
    'color:#f3f4f6',
  ].join(';');

  modal.innerHTML = `
    <div style="background:#111318;border:1px solid #262b36;border-radius:14px;max-width:960px;width:100%;padding:20px 24px;box-shadow:0 24px 64px rgba(0,0,0,0.65)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div>
          <div style="font-size:16px;font-weight:600;letter-spacing:0.01em">Photoreal Hop Synthesis · <span style="color:#60a5fa">gemini-omni-1.1-flash</span></div>
          <div id="omni-sub" style="font-size:12px;color:#9ca3af;margin-top:2px">Captures 3D chase-cam hop render + street keyframe → photoreal MP4</div>
        </div>
        <button id="omni-close" style="background:#1f2430;border:1px solid #32394a;color:#e5e7eb;border-radius:8px;padding:6px 12px;cursor:pointer;font-size:13px">✕ Close</button>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:14px">
        <div style="background:#0b0c0e;border:1px solid #1f242d;border-radius:10px;padding:10px">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#9ca3af;margin-bottom:6px">1. 3D Chase-Cam Render (Input Reference)</div>
          <video id="omni-render-vid" controls loop muted playsinline style="width:100%;aspect-ratio:16/9;background:#07080a;border-radius:6px;display:block"></video>
        </div>
        <div style="background:#0b0c0e;border:1px solid #1f242d;border-radius:10px;padding:10px;position:relative">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#60a5fa;margin-bottom:6px">2. Gemini Omni Photoreal Output (720p MP4)</div>
          <video id="omni-out-vid" controls loop autoplay playsinline style="width:100%;aspect-ratio:16/9;background:#07080a;border-radius:6px;display:none"></video>
          <div id="omni-placeholder" style="width:100%;aspect-ratio:16/9;background:#07080a;border-radius:6px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#9ca3af;font-size:13px;text-align:center;padding:16px">
            <div id="omni-spinner" style="width:28px;height:28px;border:3px solid #262b36;border-top-color:#3b82f6;border-radius:50%;animation:omni-spin 0.9s linear infinite;margin-bottom:10px"></div>
            <div id="omni-status-text">Recording 3D hop from viewport…</div>
          </div>
        </div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;font-size:12px;color:#9ca3af">
        <div id="omni-footer-msg">No Tesla logos · generic white cold-gas thruster coupe</div>
        <div style="display:flex;gap:10px">
          <a id="omni-download" href="#" download="flyme-hop.mp4" style="display:none;background:#1e3a8a;color:#eff6ff;text-decoration:none;padding:6px 12px;border-radius:7px;font-weight:500">Download MP4</a>
        </div>
      </div>
    </div>
    <style>
      @keyframes omni-spin { to { transform: rotate(360deg); } }
    </style>
  `;

  document.body.appendChild(modal);
  modal.querySelector('#omni-close').addEventListener('click', () => {
    modal.style.display = 'none';
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });
  return modal;
}

export async function openVideoPanel({ siteId, site, chosen, recordHop, log } = {}) {
  const modal = ensureModal();
  modal.style.display = 'flex';

  const renderVid = modal.querySelector('#omni-render-vid');
  const outVid = modal.querySelector('#omni-out-vid');
  const placeholder = modal.querySelector('#omni-placeholder');
  const spinner = modal.querySelector('#omni-spinner');
  const statusText = modal.querySelector('#omni-status-text');
  const downloadBtn = modal.querySelector('#omni-download');
  const footerMsg = modal.querySelector('#omni-footer-msg');

  outVid.style.display = 'none';
  placeholder.style.display = 'flex';
  spinner.style.display = 'block';
  downloadBtn.style.display = 'none';

  const setStatus = (msg) => {
    statusText.textContent = msg;
    footerMsg.textContent = msg;
  };

  try {
    setStatus('Recording 3D chase-cam hop from canvas…');
    log?.('video: recording 3D chase-cam hop…');

    let clipDataUrl = null;
    if (typeof recordHop === 'function') {
      const blob = await recordHop();
      if (blob && blob.size > 0) {
        renderVid.src = URL.createObjectURL(blob);
        renderVid.play().catch(() => {});
        clipDataUrl = await blobToDataUrl(blob);
      }
    }

    setStatus('Submitting clip + keyframe toPOST /api/video (gemini-omni-1.1-flash)…');
    log?.('video: starting Gemini Omni photoreal generation job…');

    const startRes = await fetch('/api/video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site_id: siteId,
        clip: clipDataUrl,
        keyframe_cam: 'front',
        site,
        params: chosen?.params ?? chosen?.sim?.params ?? null,
        label: chosen?.label ?? 'climb-first hop',
      }),
    });

    if (!startRes.ok) {
      const errBody = await startRes.json().catch(() => ({}));
      throw new Error(errBody.error || `HTTP ${startRes.status}`);
    }

    const { job, status: initStatus, url: initUrl } = await startRes.json();

    if (initStatus === 'completed' && initUrl) {
      outVid.src = initUrl;
      outVid.style.display = 'block';
      placeholder.style.display = 'none';
      downloadBtn.href = initUrl;
      downloadBtn.style.display = 'inline-block';
      setStatus('Loaded cached photoreal Omni video.');
      log?.(`video: ready (${initUrl})`);
      return;
    }

    // Poll /api/video/:job
    while (true) {
      await new Promise((r) => setTimeout(r, 3000));
      const pollRes = await fetch(`/api/video/${encodeURIComponent(job)}`);
      if (!pollRes.ok) throw new Error(`Poll HTTP ${pollRes.status}`);
      const state = await pollRes.json();

      if (state.status === 'completed' && state.url) {
        outVid.src = state.url;
        outVid.style.display = 'block';
        placeholder.style.display = 'none';
        downloadBtn.href = state.url;
        downloadBtn.style.display = 'inline-block';
        setStatus(`Photoreal video complete in ${state.elapsed_s ?? '?'} s`);
        log?.(`video: completed (${state.url})`);
        return;
      }

      if (state.status === 'failed' || state.status === 'not_found') {
        throw new Error(state.error || state.message || 'Omni job failed');
      }

      setStatus(`${state.message || 'Generating with gemini-omni-1.1-flash…'} (${state.elapsed_s ?? 0}s)`);
    }
  } catch (err) {
    spinner.style.display = 'none';
    setStatus(`Omni video error: ${err?.message ?? String(err)}`);
    log?.(`video failed: ${err?.message ?? String(err)}`);
  }
}

export default openVideoPanel;
