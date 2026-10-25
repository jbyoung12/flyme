# Gemini Interactions API notes (verified 2026-10-25)

Sources: `google-gemini/gemini-skills` (`gemini-api-dev`, `gemini-omni-flash-api` skills), `@google/genai@2.31.0` type defs (`dist/node/node.d.ts`), ai.google.dev docs (`*.md.txt`).
Legend: **[V]** docs + types · **[D]** docs only · **[T]** types only · **[I]** inference.

SDK must be ≥ 2.29.1. **All request fields are snake_case**, except `files.upload` / `files.get` (`config.mimeType`, `file.mimeType`).

## A. Basic call + JSON output
```js
import { GoogleGenAI } from "@google/genai";
const client = new GoogleGenAI({}); // reads GEMINI_API_KEY
const ix = await client.interactions.create({
  model: "gemini-4-argon",
  input: "Extract ...",
  generation_config: { thinking_level: "medium", max_output_tokens: 65536 }, // low|medium(default)|high
  response_format: { type: "text", mime_type: "application/json",
    schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
}, { timeout: 15 * 60_000 }); // RequestOptions.timeout in ms
const data = JSON.parse(ix.output_text);
```
- [V] `thinking_level` lives in `generation_config`; `response_format` is top-level. Top-level `response_mime_type` is deprecated [T].
- [D] Accessors: `ix.output_text`, `ix.output_image`, `ix.output_audio`, `ix.output_video`, `ix.steps[]` (`model_output` step has `content[]`).

## B. Multimodal input (uploaded videos + inline PNG)
```js
async function uploadVideo(path, mimeType) {
  let f = await client.files.upload({ file: path, config: { mimeType } });
  while (f.state === "PROCESSING") { await new Promise(r => setTimeout(r, 5000)); f = await client.files.get({ name: f.name }); }
  if (f.state !== "ACTIVE") throw new Error(`file ${f.name} ${f.state}`);
  return f;
}
const vids = await Promise.all([uploadVideo("front.mp4", "video/mp4")]);
const png = fs.readFileSync("render.png", { encoding: "base64" });
const ix = await client.interactions.create({
  model: "gemini-4-argon",
  input: [
    ...vids.map(v => ({ type: "video", uri: v.uri, mime_type: v.mimeType })), // optional: resolution: "low"|"medium"|"high"|"ultra_high", processing: "agentic"
    { type: "image", data: png, mime_type: "image/png" },
    { type: "text", text: "..." },
  ],
});
```
- [V] `file.state` is a plain string: `"PROCESSING" | "ACTIVE" | "FAILED"`.
- [D] For a single video, put the text part after the video.
- [I] `processing: "agentic"` is documented for Flash models; unconfirmed on Argon — test before relying on it.

## C. Multi-turn
```js
const t2 = await client.interactions.create({
  model: "gemini-4-argon", previous_interaction_id: t1.id, input: "Now ...",
  generation_config: { thinking_level: "medium" }, // re-send every turn
});
```
- [D] `generation_config`, `tools`, `system_instruction` are per-interaction → re-send each turn. `store: false` disables `previous_interaction_id` and `background`.

## D. Background + streaming
```js
let ix = await client.interactions.create({ model: "gemini-4-argon", input, background: true });
while (["in_progress", "queued"].includes(ix.status)) { await new Promise(r => setTimeout(r, 5000)); ix = await client.interactions.get(ix.id); }
// terminal: completed | failed | cancelled | incomplete | requires_action

const stream = await client.interactions.create({ model: "gemini-4-argon", input, stream: true,
  generation_config: { thinking_summaries: "auto" } });
for await (const ev of stream) {
  switch (ev.event_type) {
    case "interaction.created": /* ev.interaction.id */ break;
    case "step.start": /* ev.step.type, ev.index */ break;
    case "step.delta":
      if (ev.delta.type === "text") process.stdout.write(ev.delta.text);
      else if (ev.delta.type === "thought_summary") process.stdout.write(ev.delta.content?.text ?? "");
      break;
    case "step.stop": /* ev.usage, ev.step_usage */ break;
    case "interaction.status_update": /* ev.status */ break;
    case "interaction.completed": /* ev.interaction.usage */ break;
    case "error": /* ev.error.message, ev.error.code */ break;
    default: break; // ignore unknown event types
  }
}
const s = await client.interactions.get(id, { stream: true, last_event_id: lastEventId }); // attach/resume
await client.interactions.cancel(id);
```
- [D] Long decode (> 65,536 output tokens) requires `background: true`; concatenate text across all `model_output` steps.
- `background: true` requires `store: true` (default).

## E. Antigravity Managed Agent
```js
const base = { agent: "antigravity-preview-09-2026",
  agent_config: { type: "antigravity", model: "gemini-4-argon", max_total_tokens: "2000000" } }; // string!
let ix = await client.interactions.create({ ...base, background: true,
  input: [{ type: "text", text: "..." }, { type: "image", data: pngB64, mime_type: "image/png" }], // ONLY text + inline images
  environment: { type: "remote",
    sources: [
      { type: "inline", target: "/workspace/flyme/sim-cli.mjs", content: codeText }, // ≤1 MB/file, 2 MB total
      { type: "repository", source: "https://github.com/org/repo", target: "/workspace/repo" }, // ≤500 MB
    ],
    env: { MY_FLAG: "1" } } });
const envId = ix.environment_id;
await client.environments.files.upload({ environment: envId, path: "workspace/data/x.bin", file: buf, mime_type: "application/octet-stream", overwrite: true });
const { files } = await client.environments.files.list({ environment: envId, path: "workspace/out", recursive: true });
const bytes = await client.environments.files.download({ environment: envId, path: "workspace/out/result.json" }); // dir → tar bytes
const next = await client.interactions.create({ ...base, previous_interaction_id: ix.id, environment: envId, input: "Now ..." }, { timeout: 300_000 });
```
- [D] Agent input: **text + inline images only** (video/audio/docs → error). Sandbox reads text & image files.
- [D] **Not supported on the agent:** `response_format`, `temperature`, `top_p`, `top_k`, `stop_sequences`, `max_output_tokens` (400), `file_search`. → have it write JSON files and download them.
- [D] Default tools: `code_execution`, `google_search`, `url_context`, filesystem. Pass `tools` only to restrict/add.
- [D] Sandbox: Ubuntu, Python 3.12 (numpy, pandas, google-genai), **Node 22**, 4 CPU / 16 GB. Compute free during preview.
- [D] Env provisioning ~5 s; tasks take minutes (use `background: true` or ≥300 s timeout). Idle 15 min → snapshotted; resumable by ID for 7 days.
- [D] Context compaction at ~135k tokens; token budget hit → `status: "incomplete"` → send `input: "continue"` with `previous_interaction_id` + env. Typical run $0.25–5.
- [T] `client.environments.create({ sources, network, from_environment })`, `.get`, `.list`, `.delete` exist (only get/list/delete documented) — use for pre-warming.
- [D] Don't use raw `fetch` to `/v1beta/files/environment-{id}:download` (deprecated); use `environments.files.download`.
- [I] Upload paths are relative (`workspace/...`), source targets absolute (`/workspace/...`); both = `/workspace`.
- [T] In 2.31.0 `AgentOption` lists only the deprecated 05 version as a literal; `"antigravity-preview-09-2026"` works as a string.

## F. Omni video (`gemini-omni-1.1-flash`)
```js
const ix = await client.interactions.create({
  model: "gemini-omni-1.1-flash",
  input: [
    { type: "image", data: imgB64, mime_type: "image/png" },
    // { type: "video", uri: vid.uri, mime_type: vid.mimeType }, // reference/edit source, ≤10 s
    { type: "text", text: "<FIRST_FRAME> ... Single continuous shot. No dialogue." },
  ],
  response_format: { type: "video", aspect_ratio: "16:9", resolution: "720p", duration: "8s", delivery: "uri" },
  // generation_config: { video_config: { task: "image_to_video" } }, // text_to_video|image_to_video|reference_to_video|edit|extend
}, { timeout: 10 * 60_000 });
const out = ix.output_video; // {data?, uri?, mime_type}
if (out?.data) fs.writeFileSync("out.mp4", Buffer.from(out.data, "base64"));
else {
  const name = `files/${out.uri.match(/files\/([a-zA-Z0-9]+)/)[1]}`;
  let f; do { await new Promise(r => setTimeout(r, 5000)); f = await client.files.get({ name }); } while (f.state === "PROCESSING");
  await client.files.download({ file: name, downloadPath: "out.mp4" });
}
```
- [V] resolution `360p|720p|1080p|4k`; aspect `16:9|9:16`; delivery `inline|uri` (use `uri` > 4 MB); duration `"3s"`–`"10s"`.
- [D] Prompt tags: `<FIRST_FRAME>`, `<LAST_FRAME>`, `<IMAGE_REF_N>`, `<VIDEO_REF_N>`. Edit/extend input video ≤ 10 s; ≤3 reference clips (~3 s each); no multi-video reasoning; no system instructions.
- [D] Docs' JS example bugs: use `f.state` (string), and snake_case `generation_config.video_config`.
- [I] Background mode untested for Omni — plan for a 10–15 min sync timeout or background + poll.

## G. Gotchas
1. `gemini-4-argon` is **not on the free tier**. Pricing $2 / $10 per 1M in/out until Nov 30 2026.
2. Argon: no `cached_content` (implicit caching automatic); `temperature/top_p/top_k` ignored; `thinking_budget` → `thinking_level`; sync output cap 64K; `max_output_tokens > 65536` without `background` → 400. Use 15+ min HTTP timeouts for `high`.
3. `.mov` MIME is inconsistent across docs (`video/mov` vs `video/quicktime`) → **always transcode to mp4** (`video/mp4`).
4. Files API: 2 GB/file, 20 GB/project, deleted after 48 h. ~300 tokens/s of video at default res (1 fps sampling).
5. Long synchronous video calls can 401/timeout → prefer stream or background.
6. Stored interactions kept 55 days (paid) / 1 day (free).
7. Ignore unknown SSE event/delta types.
