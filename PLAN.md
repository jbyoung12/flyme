# flyme — hackathon plan (single source of truth)

> **Fresh session? Read this whole file first.** Every decision below is **locked** with the user (Q&A on 2026-10-25, 10:30–10:55 PT). Do not re-ask locked decisions; build to the contracts in §6. API specifics live in `docs/gemini-api-notes.md` (verified against `@google/genai` 2.31.0 type defs + official docs) — use them instead of memory.

---

## 0. Event context

- **Event:** Gemini 4 Argon SF Hackathon, Shack15, **Sunday 2026-10-25**. Hacking 10:30 → **submissions due 17:00 PT**. Judging 17:00–19:00 (3-min live demo + 1–2 min Q&A, no slides).
- **Track:** Problem Statement 2, "More Dimensions" — *"Build a system that renders what it made, watches the result, critiques it against the goal, and fixes it in a loop."* Also targeting **Best use of Managed Agents ($5k)**.
- **Judging:** working live demo w/ real verification loop **50%** · problem & usefulness 25% · originality / only-possible-with-Argon 15% · pitch clarity 10%.
- **Rules that bite:** repo **public**; demo must show only what was built today; no assets we lack rights to (→ **no Tesla logos/trademarks**, generic white car); submission includes a **1-minute demo video**; team members added on the submission page.
- **Team:** the user (films footage, measures ground truth, tests merges in browser, owns pitch) + **Claude** (T0 contracts/shell, T2 Three.js UI, T3 ingest + Loop 1 critique, T5b eval/NL destination, main integrator) + **Antigravity** (T1 physics + CLI, T4 Managed Agent Loop 2, T5a Omni video, T5c docs) (§9).

## 1. Product

**One-liner:** *Your flying car looks around with its own cameras, rebuilds the street in 3D, checks the rebuild against the footage, and won't hop until a simulation proves the landing is safe.*

- **User (playful):** a Roadster "Rocket" owner. UI says "flying car"; the pitch names the Roadster verbally.
- **Pitch hook:** "On Oct 15 Tesla's Roadster jumped five vehicles on a closed course. We check *your* hop on a real street."
- **Why only Argon (say this in the pitch):** (1) long-video understanding turns raw car-camera clips into 3D geometry; (2) multimodal critique of our own renders vs. real footage is the PS2 loop; (3) a Managed Agent runs a real simulate→read→revise loop in a sandbox; (4) semantic hazards (pedestrians, wires, moving cars) that a numeric solver cannot see.

## 2. Locked decisions

| # | Decision | Locked value |
|---|---|---|
| D1 | Framing | Playful. Generic "flying car" with Roadster-matching specs & proportions; **no logos**. |
| D2 | Input | Car "cameras" = **4 static ~5 s clips** F/R/B/L (+ optional `up`), phone at chest height, 0.5× ultrawide, landscape, 1080p (protocol §13). |
| D3 | Demo footage | **Pre-recorded outdoor road**, run **live** on stage. Cached replay is **emergency only**. |
| D4 | Reconstruction | Direct `gemini-4-argon` call (video input) → `site.json`. |
| D5 | Loop 1 (PS2 visual loop) | Browser renders scene from each known camera pose → Argon compares render vs. footage keyframe → JSON patch → re-render. ≤3 rounds. |
| D6 | Destination | **Tap on 3D ground first.** Natural-language destination ("by the tree") is stretch. |
| D7 | Loop 2 (flight plan) | **Antigravity Managed Agent** (`antigravity-preview-09-2026`, model `gemini-4-argon`) runs our simulator CLI in its sandbox. **Each round it proposes 4 diverse candidate routes; the sim checks all 4; if any are SAFE the agent picks one and explains why (margins + street context); if none, it revises all 4 from the failure reasons. Max 3 rounds (≤12 routes), then REJECT.** Local server-side loop = fallback with the same shape. |
| D7b | Picking among SAFE routes | **Agent picks + explains** (not a fixed score). Sim supplies margins (clearance, air left, touchdown speed); agent weighs semantics the sim can't (flying over sidewalk/people, moving cars, landing near a pedestrian's path). |
| D8 | Who judges safety | **Only our deterministic simulator/checker.** Server re-runs every attempt locally; UI verdict comes from our sim, never from model text. |
| D9 | Argon's jobs | Reconstruct scene, critique render-vs-footage, choose route params, flag semantic risks, explain rejections. |
| D10 | Hazards (v1) | **Core set:** vehicles (parked/moving), poles/signs, trees (trunk + canopy), overhead wires, pedestrians (5 m blast keep-out). Add surfaces/curbs/buildings only if time. |
| D11 | UI | In-car touchscreen look (dark, FSD-style gray models, glowing arc, big buttons). §8. |
| D12 | Renderer | Three.js **WebGLRenderer** (WebGPU not worth the risk). |
| D13 | Stack | Node (ESM, plain JS, no TS) · Express + Vite middleware in **one process** · `@google/genai` 2.31.0 Interactions API · `ffmpeg-static` for transcode/keyframes. |
| D14 | Stretch 1 | Photoreal video via `gemini-omni-1.1-flash` from **our rendered hop clip** (not compositing into real footage). |
| D15 | Stretch 2 | Natural-language destination. |
| D16 | Specs | §3, labeled public vs. estimate in UI. |
| D17 | Ground truth | **L-shaped pacing** from the stand point (forward steps, then 90° turn and sideways steps), stride calibrated with iPhone Measure (§13). No Google Maps. Never sent to the model. |
| D18 | Repo | `github.com/jbyoung12/flyme`, **public now**. Raw footage & `.env` gitignored. |
| D19 | Parallelism | **Tight-Seam Split (§9):** Track 0 (contracts) serial first, then disjoint parallel tracks: **Claude** owns T2 (UI) + T3 (Loop 1 pipeline) + T5b + integration; **Antigravity** owns T1 (Physics/CLI) + T4 (Managed Agent Loop 2) + T5a (Omni) + T5c (Docs). |
| D20 | Moving objects | **Required in v1.** Argon estimates each moving person/car's position at the **last frame of its clip** + velocity (m/s, car frame) + intent notes (reverse lights, heading to crosswalk). Sim moves them at constant velocity during the flight; agent judges intent the sim can't. |
| D21 | Air resistance / wind | Simple quadratic **drag in the sim** (effect < 1%, shown if asked). **Wind not modeled** — covered by the 0.5 m clearance margin. |
| D22 | "Now" | Flight `t = 0` = end of the clips (latest footage). Clips are sequential (not simultaneous like a real car's cameras) — accepted for the demo. UI shows **"plan valid ~10 s — rescan before HOP"**. |
| D23 | Exhaust velocity | **500 m/s** (changed from 700 on Google mentors' advice: more accurate for cold-gas blowdown). |

## 3. Vehicle specs (locked)

| Spec | Value | Provenance (show in UI) |
|---|---|---|
| Thrusters | 10 cold-gas, around the perimeter | **Public** — Tesla Oct 15 2026 reveal, "Rocket" trim (TechCrunch, Teslarati) |
| Air | 600 L compressed air in COPVs | **Public** — Lars Moravy, Tesla VP Eng (TechCrunch) |
| Air mass | **250 kg**; reserve 10% (**25 kg**) | Reported (Space.com); consistent w/ 600 L @ ~400 bar |
| Dry mass | **1,900 kg** | Estimate from "4000+ lb" (MKBHD relaying Tesla) |
| Max thrust | **80 kN** total | Third-party analysis, not Tesla |
| Max horizontal thrust | **40 kN** | Our estimate |
| Exhaust velocity (effective) | **500 m/s** (Isp ≈ 51 s) | Physics estimate for cold-gas blowdown + perimeter nozzle cant (per Google mentors on-site) |
| Dimensions (L×W×H) | **4.3 × 2.0 × 1.15 m** | Estimate from photos |
| 0–60 | < 0.59 s (Rocket) | Public (Teslarati) — UI flavor only |
| Camera height | 1.3 m | Our rig (phone at chest height) |

Safety limits: touchdown vertical < **3 m/s**, horizontal < **1 m/s**; clearance ≥ **0.5 m**; pedestrian keep-out ≥ **5 m**; landing within **1.5 m** of target; air remaining ≥ **25 kg**.
Sanity target for Track 1 calibration (at 500 m/s): a ~20 m hop over a parked car is feasible; a ~45 m hop fails on air. Track 1 reports the actual max feasible range.

Sources: [TechCrunch](https://techcrunch.com/2026/10/15/tesla-reveals-spacex-powered-roadster-that-flies-and-falls-with-style/) · [Teslarati](https://www.teslarati.com/tesla-roadster-specs-configurations/) · [Space.com](https://www.space.com/technology/spacex-thrusters-just-made-a-tesla-roadster-fly-and-elon-musks-car-is-still-out-there-in-space) · [Tech Insider (80 kN)](https://tech-insider.org/tesla-roadster-flight-tech-80kn-thrust-explained-2026/)

## 4. Pipeline

| Stage | What | Who | Endpoint |
|---|---|---|---|
| A. Ingest | `.mov` → 720p H.264 mp4; pick sharpest keyframe per clip (middle ±1 s, highest Laplacian variance or just middle frame) | server, ffmpeg | `POST /api/sites/:id/ingest` |
| B. Reconstruct | Upload mp4s (Files API) + rig + schema → `site.json` (JSON schema output, thinking `high`) | Argon | `POST /api/sites/:id/reconstruct` (SSE) |
| C. Loop 1 | Browser renders each camera view (type-colored solids + obstacle ID labels + 5 m ground grid) → POST renders → Argon (fast image-pair call with keyframes + renders + `site.json`, thinking `medium`, no video re-chaining) returns per-camera match score + issues + patch → `applyPatch` → re-render. Stop when all cams ≥ 80 or 3 rounds. | browser + Argon | `POST /api/sites/:id/critique` (SSE) |
| D. Destination | Tap ground → `target {forward,right}` | browser | — |
| E. Loop 2 | Managed Agent: seeded with sim code + site + target. Per round: propose **4 diverse candidates** → run `sim-cli` on each → if ≥1 SAFE, pick one + explain; else revise all 4 from failures. **Max 3 rounds.** Writes `/workspace/out/round-<n>.json` as it goes + `/workspace/out/result.json`. Server streams agent steps, downloads results, **re-runs every candidate locally**. Sandbox pre-warmed at SCAN time. | Managed Agent | `POST /api/plan` (SSE) |
| F. Playback | Per round, a **fan of 4 arcs**: red (with failure reason label), green (SAFE), chosen one glowing blue; checklist + air gauge for the selected arc; log; HOP animates the chosen route with thruster puffs | browser | — |
| G. Stretch 1 | Record rendered hop (canvas → webm ≤10 s) + site keyframe → Omni → mp4 | server bg job | `POST /api/video`, `GET /api/video/:job` |
| H. Stretch 2 | "land by the tree" → Argon resolves to target using site.json + keyframes | Argon | `POST /api/resolve-destination` |

## 5. Physics model (deterministic; implement exactly)

All in `shared/` — **zero dependencies, ESM, must run on Node 22** (sandbox) and in the browser.

**Path (reference trajectory)** from flight params (§6.4). Let `T = duration_s`, `τ = t/T ∈ [0,1]`.
- Horizontal progress: `d = horizontal_delay`; `s(τ) = 0` if `τ < d`, else `q((τ−d)/(1−d))`, with `q(x) = 10x³ − 15x⁴ + 6x⁵`.
- Direction `ĥ = target / |target|` in (forward,right); right-perpendicular `n̂ = (−ĥ.right, ĥ.forward)`.
- Bow: `b(τ) = side_bow_m · 64 τ³ (1−τ)³`.
- Horizontal position: `s(τ)·target + b(τ)·n̂`.
- Vertical: `p = climb_bias`; Mobius time-warp `τ̃ = (1−p)τ / ((1−p)τ + p(1−τ))` (peaks at `τ = p`, `τ̃ = 0.5`, smooth `C^∞` on `[0,1]`); `up(τ) = apex · 16 τ̃² (1−τ̃)²`.
- Velocity/acceleration of the reference: central differences (h = 1e-4 s) on the analytic position.

**Dynamics:** dt = 0.01 s, semi-implicit Euler, mass `m = dry + air`.
- `a_cmd = a_ref + 36·(p_ref − p) + 10.8·(v_ref − v)`; `T_req = m·(a_cmd + g·ŷ)`.
- Clamp: first `T_req.up ≥ 0` (no downward thrust), then horizontal component ≤ 40 kN (scale horizontal only), then ‖T‖ ≤ 80 kN (scale vector). If air ≤ 0 → T = 0 (ballistic).
- Saturation flag when horizontal/total clamping reduced ‖T‖ by > 1%.
- `air −= ‖T‖ / 500 · dt`.
- Drag (D21): `F = −½ ρ C_d A |v| v` per axis, ρ = 1.2 kg/m³, C_d = 1.0, A_horizontal = 2.3 m² (W×H), A_vertical = 8.6 m² (L×W). Added to the dynamics (not the reference). Report `peak.drag_N` in the summary. No wind.
- Before liftoff: clamp `up ≥ 0`. After `t > T` the reference holds target horizontally with `up_ref = −0.5·(t − T)` (gentle settle). Touchdown: (`t ≥ 0.85·T` and `up ≤ 0.02 m`) or (`t > 0.2 s` and `up ≤ 0`) → clamp `up = 0`, record velocities, stop. Hard cap `T + 5 s`.
- Emit a sample every 0.05 s.

**Collision/clearance:** car = axis-aligned box (car never yaws; ignore tilt) centered at `(pos.forward, pos.right, pos.up + H/2)` with half-extents `(L/2, W/2, H/2)`.
- Obstacles: `box` (oriented by `heading_deg`), `cylinder`, `wire` (segment, radius 0.05 m).
- Distance = min over (car surface sample points → obstacle signed distance) ∪ (obstacle sample points → car-box signed distance). Sample spacing ≤ 0.25 m. Precompute obstacle samples once.
- Takeoff grace at `t = 0`: if an obstacle starts with `0 < clearance(0) < 0.5 m` (or a `person` starts `< 5 m`), require only `collision` (`clearance > 0`) during liftoff (`t < 0.8 s`) while distance is non-decreasing; if an obstacle already overlaps at `t = 0` (`clearance(0) ≤ 0`, e.g. noisy parked-neighbor box), ignore it for `t < 0.5 s`.
- Moving obstacles (`velocity` set) — **required (D20)**: position at time `t` = `center + velocity·t` (t = 0 is the end of the footage, D22). Applies to clearance, `pedestrian`, and `landing_zone` checks. Obstacle samples are translated, not recomputed.

**Checks** (ids are a contract — UI and prompts reference them):

| id | pass when |
|---|---|
| `collision` | min clearance > 0 |
| `clearance` | min clearance ≥ 0.5 m (excluding people) |
| `pedestrian` | min horizontal distance car-box → any `person` ≥ 5 m |
| `thrust_limit` | no saturation where tracking error > 0.3 m |
| `touchdown_vertical` | \|v_up\| < 3 m/s |
| `touchdown_horizontal` | \|v_horizontal\| < 1 m/s |
| `landing_accuracy` | miss distance ≤ 1.5 m |
| `air_reserve` | air remaining ≥ 25 kg |
| `landing_zone` | final-pose clearance ≥ 0.5 m |

Verdict `SAFE` iff all pass, else `UNSAFE` with `failures: [ids]`.

## 6. Contracts

### 6.1 Coordinate frame
Car-centric. Origin = center of the car footprint on the ground at takeoff; car faces **forward**. JSON uses named fields: `forward` (m, ahead), `right` (m, to the car's right), `up` (m). Three.js mapping: `x = right`, `y = up`, `z = −forward`. Headings/yaws: degrees **clockwise from forward** (0 = forward, 90 = right).

### 6.2 Camera rig — `sites/<id>/rig.json` (default if absent)
```json
{
  "cameras": [
    { "id": "front", "file": "front.mov", "position": {"forward": 0, "right": 0, "up": 1.3}, "yaw_deg": 0,   "pitch_deg": 0,  "hfov_deg": 100 },
    { "id": "right", "file": "right.mov", "position": {"forward": 0, "right": 0, "up": 1.3}, "yaw_deg": 90,  "pitch_deg": 0,  "hfov_deg": 100 },
    { "id": "back",  "file": "back.mov",  "position": {"forward": 0, "right": 0, "up": 1.3}, "yaw_deg": 180, "pitch_deg": 0,  "hfov_deg": 100 },
    { "id": "left",  "file": "left.mov",  "position": {"forward": 0, "right": 0, "up": 1.3}, "yaw_deg": 270, "pitch_deg": 0,  "hfov_deg": 100 },
    { "id": "up",    "file": "up.mov",    "position": {"forward": 0, "right": 0, "up": 1.3}, "yaw_deg": 0,   "pitch_deg": 60, "hfov_deg": 100, "optional": true }
  ],
  "aspect": 1.7778
}
```
iPhone 0.5× ultrawide in video mode ≈ 95–105° HFOV; 100 is the default; loop 1 may flag a FOV mismatch.

### 6.3 Site — `site.json` (`schema: "flyme.site/1"`)
```json
{
  "schema": "flyme.site/1",
  "id": "embarcadero-1",
  "name": "Embarcadero curb, facing north",
  "round": 0,
  "surfaces": [
    { "id": "s1", "type": "road", "polygon": [{"forward": -10, "right": -2}, {"forward": 40, "right": -2}, {"forward": 40, "right": 8}, {"forward": -10, "right": 8}] }
  ],
  "obstacles": [
    { "id": "o1", "type": "vehicle", "label": "parked white SUV", "shape": "box",
      "center": {"forward": 6.5, "right": 0.2}, "base_up": 0,
      "size": {"length": 4.7, "width": 1.9, "height": 1.7}, "heading_deg": 0,
      "seen_in": ["front"], "confidence": 0.8 },
    { "id": "o2", "type": "pole", "label": "street light", "shape": "cylinder",
      "center": {"forward": 12, "right": -2.5}, "base_up": 0, "radius": 0.15, "height": 7,
      "seen_in": ["front", "left"], "confidence": 0.7 },
    { "id": "o3", "type": "wire", "label": "overhead line", "shape": "wire",
      "from": {"forward": 20, "right": -15, "up": 7}, "to": {"forward": 20, "right": 15, "up": 7},
      "seen_in": ["up"], "confidence": 0.5 },
    { "id": "o4", "type": "person", "label": "pedestrian on sidewalk", "shape": "cylinder",
      "center": {"forward": 18, "right": -4}, "base_up": 0, "radius": 0.3, "height": 1.75,
      "velocity": {"forward": 0.8, "right": 0}, "seen_in": ["left"], "confidence": 0.9 }
  ],
  "scale_refs": ["parked sedan ≈ 4.7 m", "lane ≈ 3.7 m"],
  "notes": "free text from Argon"
}
```
- `type` ∈ `vehicle | pole | sign | tree_trunk | tree_canopy | wire | person | building | barrier | other`.
- `shape` ∈ `box` (needs `size`, `heading_deg`), `cylinder` (`radius`, `height`), `wire` (`from`, `to`). `base_up` = height of the shape's bottom (canopies, signs).
- `surfaces[].type` ∈ `road | sidewalk | parking | grass | plaza | water | other` (surface rules are post-v1).
- Moving objects: `center` = position at the **last frame of the clip it was seen in** (D22); `velocity` `{forward, right}` m/s; optional `intent_notes` string (e.g. "reverse lights on", "heading to crosswalk"). Static objects omit `velocity`.
- Ground truth lives in a separate file `sites/<id>/truth.json`: `{ "<label or id>": {"forward":…, "right":…}, "stand_point": "…" }` — **never sent to the model**.

### 6.4 Flight params (`schema: "flyme.params/1"`)
```json
{ "target": {"forward": 24, "right": -3}, "apex_height_m": 5, "duration_s": 3.2,
  "side_bow_m": 0, "climb_bias": 0.4, "horizontal_delay": 0.1 }
```
Bounds (clamp + report if violated): apex 0.5–20 · duration 1–8 · side_bow −15…15 · climb_bias 0.25–0.75 · horizontal_delay 0–0.4. `target` comes from the user tap and the agent must not change it (it may REJECT instead).

### 6.5 Simulator API
- JS: `simulate(site, params, opts?) → SimResult` in `shared/physics.js`; `runChecks(site, simTrace) → checks[]` in `shared/checks.js`.
- CLI (used by the agent): `node sim-cli.mjs --site site.json --params params.json [--out result.json] [--svg plot.svg]` → prints **summary** JSON (no samples) to stdout; exit 0 always. `params.json` may be a single §6.4 object or an array/batch of 4 candidates `[{id, label, params}]` so the agent can evaluate a whole round in one tool call. `--svg` writes a top view + side view plot (text SVG the agent can read; plots all candidates when given a batch).
```json
{
  "schema": "flyme.sim/1",
  "params": { },
  "verdict": "UNSAFE",
  "failures": ["clearance"],
  "checks": [ {"id": "clearance", "pass": false, "value": 0.21, "limit": 0.5, "unit": "m", "t": 1.12, "obstacle_id": "o1", "message": "0.21 m from parked white SUV at t=1.12 s"} ],
  "touchdown": {"t": 3.21, "forward": 23.6, "right": -2.9, "v_vertical": 1.4, "v_horizontal": 0.3, "miss_m": 0.41},
  "air": {"start_kg": 250, "used_kg": 141.2, "remaining_kg": 108.8},
  "peak": {"thrust_kN": 74.1, "up_m": 5.0, "drag_N": 182.4},
  "samples": [ {"t": 0, "forward": 0, "right": 0, "up": 0, "thrust_kN": 20.6, "air_kg": 250, "clearance_m": 0.9} ]
}
```

### 6.6 Loop-1 critique response (Argon JSON schema output)
```json
{
  "cameras": [ {"id": "front", "match_score": 62, "issues": ["street light at left edge missing in render"]} ],
  "patch": [
    {"op": "add", "obstacle": { }, "evidence": "front: pole at x≈15% of frame"},
    {"op": "update", "id": "o1", "set": {"center": {"forward": 8.0, "right": 0.2}}, "evidence": "SUV appears farther in footage"},
    {"op": "remove", "id": "o7", "evidence": "no object there in back cam"}
  ],
  "done": false
}
```

### 6.7 Agent result — `/workspace/out/result.json`
```json
{
  "verdict": "SAFE",
  "rounds": [
    {
      "n": 1,
      "candidates": [
        {"id": "r1a", "label": "high arc over sedan", "params": { }, "sim_verdict": "UNSAFE", "failures": ["air_reserve"]},
        {"id": "r1b", "label": "low swerve right", "params": { }, "sim_verdict": "SAFE", "failures": [], "margins": {"min_clearance_m": 1.4, "air_remaining_kg": 96, "touchdown_v_ms": 1.2}},
        {"id": "r1c", "label": "climb-first glide", "params": { }, "sim_verdict": "SAFE", "failures": [], "margins": { }},
        {"id": "r1d", "label": "long gentle arc", "params": { }, "sim_verdict": "UNSAFE", "failures": ["clearance"]}
      ],
      "decision": "pick",
      "chosen_id": "r1c",
      "why": "r1b has more clearance but passes over the sidewalk where a pedestrian is walking; r1c stays over the road",
      "revision_notes": null
    }
  ],
  "final_params": { },
  "chosen_id": "r1c",
  "semantic_notes": ["pedestrian walking toward landing zone in left cam"],
  "reject_reason": null
}
```
- `verdict` ∈ `SAFE | REJECT`. `decision` ∈ `pick | revise | reject`. On `revise`, `revision_notes` explains what each new candidate changes and why.
- Exactly 4 candidates per round, deliberately diverse (different apex / bow side / climb_bias); max 3 rounds.
- Server re-simulates every candidate; if its result disagrees with the agent's claim, the server's result wins and the UI says so. The agent may only pick a candidate the server sim also rates SAFE.

### 6.8 Server HTTP API (Express, single process with Vite middleware, port 5173)
| Method & path | Body → Response |
|---|---|
| `GET /api/sites` | → `[{id, name, cameras: [..], ingested, has_site, has_truth}]` |
| `POST /api/sites/:id/ingest` | → `{cameras: [{id, mp4_url, keyframe_url}]}` |
| `POST /api/sites/:id/reconstruct` | SSE → final `site` event with `site.json` |
| `POST /api/sites/:id/critique` | `{round, renders: {front: dataURL, …}, site}` → SSE, final `critique` event (§6.6) + patched `site` |
| `POST /api/plan` | `{site_id, site, target, mode: "agent" \| "local"}` → SSE, `attempt` events, final `plan` event |
| `POST /api/video` | `{site_id, clip: dataURL(webm), keyframe_cam}` → `{job}`; `GET /api/video/:job` → `{status, url}` |
| `POST /api/resolve-destination` | `{site, text}` → `{target, explanation}` (stretch) |
| `GET /api/eval` | → latest `runs/eval.json` |

Add `?replay=1` (or env `FLYME_REPLAY=1`) to any SSE route → replays cached events from `runs/` at 2× speed.

### 6.9 SSE events
Each `data:` line is JSON: `{ "type", "stage", "t_ms", "data" }`.
- `type` ∈ `status | log | thought | tool | sim_result | attempt | site | critique | plan | done | error`.
- `stage` ∈ `ingest | reconstruct | critique | plan | video`.
- Agent steps map: `step.start` with `code_execution_call` → `tool`; `thought_summary` deltas → `thought`; text deltas → `log`.

### 6.10 Run cache — `runs/<site_id>/`
`reconstruct.events.jsonl`, `site.r0.json`, `site.r<N>.json`, `critique.r<N>.events.jsonl`, `critique.r<N>.json`, `plan-<ts>.events.jsonl`, `plan-<ts>.result.json`, `interaction_ids.json`, `env_id`. Everything is written as it happens, so replay is automatic.

## 7. Prompts (outline; files in `server/prompts/*.md`)

- **reconstruct.md** (thinking high, JSON schema = §6.3): explain the rig (camera poses, HFOV, height 1.3 m, car-centric frame, clockwise yaw); ask to list every obstacle within ~40 m relevant to a vertical hop, estimate distances using scale references (car ≈ 4.5–4.8 m, lane ≈ 3.7 m, stall ≈ 2.7 m wide, door ≈ 2 m tall), for moving objects report position at the **last frame** of their clip + velocity (estimate from displacement across the clip) + `intent_notes`, and give confidence; prefer over-including hazards; put overhead hazards from the `up` clip.
- **critique.md** (thinking medium, standalone image-pair call without video chaining for low latency; inputs: for each camera the footage keyframe PNG + our labeled 3D render PNG + current `site.json`): compare object by object using the rendered obstacle IDs (`o1`, `o2`…) and 5 m ground grid, score each camera 0–100, emit a minimal patch (§6.6) with evidence, `done: true` when all ≥ 80.
- **plan-agent.md** (Managed Agent): files at `/workspace/flyme/` (all `shared/*.{js,mjs}`: `sim-cli.mjs`, `physics.js`, `checks.js`, `constants.js`, `geometry.js`, `schema.js`, `plot-svg.js`), `/workspace/input/site.json`, `/workspace/input/target.json`. Rules: only the simulator decides safety; each round propose **4 deliberately different** candidates and run the sim on all 4; read failures + SVG; if any SAFE → pick one and explain the choice using margins **and** street context the sim doesn't model (people heading toward the zone, flying over sidewalk, moving cars); if none → revise all 4 from the failure reasons; **max 3 rounds**; never change target; write `/workspace/out/round-<n>.json` after each round + `/workspace/out/result.json` (§6.7); REJECT with a plain-English reason if no SAFE plan after round 3.
- **plan-local.md** (fallback, `gemini-4-argon` thinking medium, JSON schema = 4 × §6.4 + decision): same rules and shape; server runs the sim on the 4 candidates and sends results back; max 3 rounds.
- **omni.md** (stretch): `<FIRST_FRAME>` = photoreal-ized keyframe; reference video = our render; "white sports car lifts off on cold-gas thrusters with white vapor puffs, arcs over the parked car, lands softly; single continuous shot; no logos; no text".

## 8. UI spec (in-car screen)

- Dark (`#0b0c0e`), 16:10 desktop / projector; big touch-sized controls; one font (Inter or system).
- **Main 3D view (center):** dark ground, surfaces faintly tinted; vehicles as gray simplified car shapes (FSD-style), poles as cylinders, wires as thin lines, trees as trunk + sphere, **people as amber capsules with a 5 m keep-out ring**. White procedural car (wedge body, glass canopy, 4 wheels, 10 nozzle points that glow/puff when thrusting). Target = pulsing ring. Attempts = red dashed arcs; final = glowing blue tube. Collision point = red marker. Orbit controls + preset camera (chase cam during HOP).
- **Left strip:** 4–5 camera tiles; toggle **Footage / Render / Blend** (opacity slider); per-tile match score badge from loop 1; issues listed under the tiles; round counter "Reconstruction round 2/3".
- **Right panel:** verdict banner (`SAFE` / `UNSAFE — reason` / `REJECTED — reason`); checklist of the 9 checks with values (for the selected arc); air gauge (250 kg bar with 25 kg reserve line, used/remaining); **rounds list: each round shows its 4 candidates as chips (red/green/blue) — click any to see its checks + replay it; the agent's "why I picked this" shown under the chosen one**; live agent log (monospace, icons for thought / sim run / result).
- **Bottom bar:** site picker · **SCAN** · **PLAN** · **HOP** · **VIDEO** (stretch) · "ⓘ Specs" popover (§3 table with public/estimate badges) · replay indicator when cached.
- **Footer stat (from eval):** "First-try plans safe: X% → after loop: Y%" and, if truth exists, "Reconstruction error: A m → B m".
- Moving people/cars drawn with a short velocity arrow and their predicted path during the hop; banner shows **"plan valid ~10 s — rescan before HOP"** (D22).
- Browser must implement `renderCameraViews(site, rig) → {camId: dataURL(1280×720 PNG)}` using the rig pose + HFOV, with a "reconstruction critique" style (type-colored solids, floating obstacle `id` labels `o1`/`o2`…, and a 5 m ground distance grid; no HUD chrome) — this is loop 1's render so Argon can map visual errors directly to obstacle IDs and metric distances.

## 9. Tracks, ownership, acceptance

**Tight-Seam Split:** Branches `track/<n>-<name>` (or isolated worktrees); **file ownership is strictly disjoint** across Claude and Antigravity so neither steps on the other's files.
- **T1 ↔ T4 seam (Antigravity):** T4 runs T1's `sim-cli.mjs` inside the Managed Agent sandbox, so Antigravity owns both (`shared/{physics,checks,geometry,sim-cli,plot-svg,*.test}.*` and `server/plan-{agent,local}.js`).
- **T2 ↔ T3 seam (Claude):** T2 (`renderCameraViews`) and T3 (`reconstruct` + `critique`) form Loop 1, so Claude owns both (`web/**` and `server/{ingest,gemini,reconstruct,critique}.js`) plus T0 (`server/index.js`, `shared/{constants,schema}.js`, fixtures) and merges to `main`.

| Track | Owner | Files | Acceptance |
|---|---|---|---|
| **0. Contracts** (serial, first, ~20 min) | **Claude** (Integrator) | `shared/constants.js` (rewrite from §3), `shared/schema.js` (validators for §6.3/6.4/6.6/6.7 + bounds clamp + deterministic `applyPatch(site, patch)`), `fixtures/sites/demo-street.json` (hand-made: parked car between start and a target ~25 m ahead, a pole, a wire, a pedestrian >5 m from origin), `server/index.js` (Express 5 + Vite middleware — avoid `*` wildcards, mounts track routers, SSE helper, cache helper), `web/index.html` shell, `CLAUDE.md` | `npm run dev` serves a page; `GET /api/sites` works; smoke test: one `gemini-4-argon` call + one Antigravity hello (record env provisioning time & total latency in `docs/latency.md`) |
| **1. Physics** | **Antigravity** | `shared/physics.js`, `shared/checks.js`, `shared/geometry.js`, `shared/sim-cli.mjs`, `shared/plot-svg.js`, `shared/*.test.js` | `npm test` green; fixture: direct low hop clips the parked car (UNSAFE: collision/clearance), climb-early hop SAFE, ~45 m hop fails air, pedestrian walking into the landing zone fails `pedestrian`, drag changes touchdown point by < 1%; deterministic; runs on Node 22 with zero deps; < 50 ms per sim |
| **2. In-car UI** | **Claude** (subagent) | `web/**` (except shell from T0 and `web/video-panel.js`), `web/mock/*.json` | Works fully on mock SSE + fixture; tap target; playback of mocked attempts; `renderCameraViews` returns 5 PNGs; looks like §8 |
| **3. Gemini pipeline** | **Claude** (subagent) | `server/ingest.js`, `server/gemini.js` (client, upload+poll, SSE adapters), `server/reconstruct.js`, `server/critique.js`, `server/prompts/reconstruct.md`, `server/prompts/critique.md` | On a real site folder: ingest produces mp4s + keyframes; reconstruct returns schema-valid site.json; critique round returns schema-valid patch; everything cached in `runs/` and replayable |
| **4. Agent loop** | **Antigravity** | `server/plan-agent.js`, `server/plan-local.js`, `server/prompts/plan-agent.md`, `server/prompts/plan-local.md` | With fixture site + target: agent run streams steps, downloads result.json, server re-sim agrees; local fallback finds SAFE plan in ≤3 rounds (4 candidates/round); env pre-warm function exported for SCAN |
| **5a. Omni video** (stretch) | **Antigravity** | `server/video.js`, `server/prompts/omni.md`, `web/video-panel.js` | POST a ≤10 s webm + keyframe → mp4 URL playable in UI |
| **5b. NL destination + eval** (stretch) | **Claude** | `server/resolve.js`, `scripts/eval.mjs` | "land by the tree" → target; `runs/eval.json` with first-try vs after-loop pass rates over ≥10 targets/site |
| **5c. Docs** | **Antigravity** | `README.md`, `docs/architecture.html` | README: what/why, architecture, specs table w/ provenance, how to run, **"built today" section**, credits |

**Dependencies:** T1–T4 start once T0 is merged. Antigravity builds T1 + T4 together against T1's real `sim-cli.mjs` (zero stub drift). T2 needs nothing but fixtures. T3 needs real clips (user films during T0/T1).

## 10. Timeline (PT)

| Time | Work |
|---|---|
| 10:55–11:35 | T0 contracts + public repo + API/agent smoke test & latency. **User films** (§13). |
| 11:35–13:15 | **Parallel build:** Claude on **T2 + T3**; Antigravity on **T1 + T4** (then **T5a/T5c**). User measures ground truth, writes `truth.json` notes, copies clips into `sites/`. |
| 13:00 | Lunch (integrator keeps merging) |
| 13:15–13:45 | **Merge 1:** footage → site → loop 1 → tap → loop 2 → playback, end to end |
| 13:45–15:00 | Tune prompts on real footage; second site; 5a/5b |
| **15:00** | **Feature freeze** |
| 15:00–16:00 | Eval numbers, polish, cache a full replay per site, rehearse 3-min demo ×3 |
| 16:00–16:40 | README final, record **1-min video**, verify repo public |
| **16:40** | **Submit** (20-min buffer) |

## 11. Demo script (3:00)

| t | Beat |
|---|---|
| 0:00–0:20 | Hook: Tesla's Oct 15 jump on a closed course → "before *your* Roadster hops on a real street, it should check." |
| 0:20–1:10 | **SCAN**: camera tiles of the real street → 3D scene appears → Blend view shows mismatch → Argon: "missed the street light / SUV is 2 m farther" → patched → scores rise. (Sandbox pre-warms meanwhile.) |
| 1:10–2:10 | Tap a **tricky** spot (tall vehicle close to the path) → **PLAN** → round 1: fan of 4 arcs, red ones labeled "clips SUV" / "air reserve" → agent revises → round 2: some green → agent picks one and says why ("more clearance one flies over the sidewalk where someone's walking") → glowing blue, air left shown. "The verdict is our simulator's; the choice is the AI's." |
| 2:10–2:40 | **HOP** chase-cam animation (+ Omni clip if ready) |
| 2:40–3:00 | Tap under the wires → **REJECTED: overhead line at 7 m** · footer numbers (first-try X% → Y%, reconstruction error A → B m) |

## 12. Measurement (baseline)

- `scripts/eval.mjs`: per site, ≥10 targets sampled on open ground at 10–35 m. Compare **(a)** Argon single-shot (one candidate, no feedback), **(b)** full loop (4 candidates × ≤3 rounds; local mode for cost/speed), **(c)** naive default params. Report pass rates + mean rounds.
- Reconstruction: per loop-1 round, mean position error vs. `truth.json` (matched by label), plus mismatch count.

## 13. Filming + ground-truth protocol (user)

1. Stand where a parked car would be (curb/parking spot); **mark the stand point** (photo your feet / note a landmark) so you can pace from it. Front = direction the car faces.
2. iPhone **0.5×**, landscape, 1080p 30fps, **chest height (~1.3 m)**, level, **still**, ~5 s each: front → right → back → left (turn 90° clockwise). Optional `up`: face front, tilt ~60° up.
3. Sites: (a) hop over parked cars to a clear spot 10–30 m away; (b) overhead wires or tree canopy; (c) pedestrians.
4. AirDrop to `sites/<site-id>/front.mov`, `right.mov`, `back.mov`, `left.mov`, `up.mov` (gitignored).
5. Ground truth for site (a), **L-shaped pacing**:
   - Calibrate stride once: iPhone Measure app on a ~4 m stretch, count steps (or US lane dashes: dash + gap = 40 ft = 12.2 m).
   - For 4–5 objects (parked cars — measure to their center, poles, trees, the landing spot): from the stand point walk straight along "front" (backward for things behind) until level with the object → `forward` steps; turn 90° and pace to it → `right` steps (negative = left).
   - Skip anything that would require walking into traffic.
   - Record in `sites/<id>/truth.json` as `{"<label>": {"forward": m, "right": m}, "stride_m": …}`. Expected accuracy ±5% (~±1 m at 20 m).

## 14. Risks & fallbacks

| Risk | Mitigation |
|---|---|
| Agent latency too long for stage | Pre-warm env at SCAN; batch all 4 candidates per round in one `sim-cli` call (≤3 rounds); stream steps so the wait is the show; if > ~90 s in smoke test → demo uses `mode: "local"` live and agent runs the eval batch (still counts for Managed Agents) |
| Distances off from monocular video | Scale refs in prompt; loop 1 corrects; tolerant thresholds |
| `.mov` / HEVC issues | Always transcode to H.264 mp4 |
| Argon key lacks credits (not free tier) | Smoke test at T0; ask Google mentors |
| Wi-Fi / API outage on stage | `?replay=1` cached runs |
| Agent claims SAFE wrongly | Server re-sim wins (D8) |
| Model numeric flailing | Bounds clamp; physics controller handles burns; agent only chooses route shape |

## 15. Submission checklist

- [ ] Repo public, README with "built today" section, no `.env`/footage committed
- [ ] 1-min demo video recorded (screen capture of a full run)
- [ ] Submission form: repo URL, video, team members
- [ ] Specs popover shows provenance; no Tesla logos anywhere
- [ ] Replay caches for each demo site
- [ ] Rotate the Gemini API key after the event (it was pasted in chat)

## 16. Repo state at plan lock (10:55)

- `git init` done; deps installed: `three@0.186.1`, `express`, `@google/genai@2.31.0`, `dotenv`, `multer`, `ffmpeg-static` (binary works), dev `vite@8.3.5`.
- `.env` holds `GEMINI_API_KEY` (gitignored). `.gitignore` excludes footage, `runs/`, `.env`.
- `shared/constants.js`: **early draft with outdated values** — Track 0 rewrites it from §3.
- `docs/gemini-api-notes.md`: verified Interactions API / Managed Agent / Omni snippets.
- Nothing else is implemented yet.
