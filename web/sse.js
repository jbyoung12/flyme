// SSE over POST (fetch + ReadableStream). Each `data:` line is JSON
// {type, stage, t_ms, data} (PLAN §6.9). Mock streams replay web/mock/*.json.

export class HttpError extends Error {
  constructor(status, message) {
    super(message || `HTTP ${status}`);
    this.status = status;
  }
}

function parseBlock(block) {
  const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
  if (!data) return null;
  try { return JSON.parse(data); } catch { return null; }
}

// POST `body` to `url`, call onEvent(ev) per event, resolve with all events.
// Throws HttpError on non-2xx (501 = track module not landed yet).
export async function postSSE(url, body, onEvent, { signal } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error ?? msg; } catch {}
    throw new HttpError(res.status, msg);
  }
  const events = [];
  const emit = (ev) => { if (!ev) return; events.push(ev); onEvent?.(ev); };
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    emit({ type: 'json', data: await res.json() });
    return events;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      emit(parseBlock(block));
    }
  }
  if (buf.trim()) emit(parseBlock(buf));
  return events;
}

const sleep = (ms, signal) => new Promise((r, j) => {
  const id = setTimeout(r, ms);
  signal?.addEventListener('abort', () => { clearTimeout(id); j(new DOMException('aborted', 'AbortError')); }, { once: true });
});

// Replay a recorded event array with its t_ms spacing (÷ speed).
export async function replayEvents(events, onEvent, { speed = 1, signal, transform } = {}) {
  const out = [];
  let last = 0;
  for (const raw of events) {
    const wait = Math.max(0, (raw.t_ms - last) / speed);
    last = raw.t_ms;
    if (wait) await sleep(wait, signal);
    const ev = transform ? transform(raw) : raw;
    if (!ev) continue;
    out.push(ev);
    onEvent?.(ev);
  }
  return out;
}

const mockCache = new Map();
export async function loadMock(name) {
  if (!mockCache.has(name)) {
    mockCache.set(name, fetch(`/mock/${name}.json`).then((r) => {
      if (!r.ok) throw new Error(`mock ${name} missing`);
      return r.json();
    }));
  }
  return mockCache.get(name);
}
