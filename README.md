# flyme — 3D Street Reconstruction & Verified Thruster-Hop Planner

> **Your flying car looks around with its own cameras, rebuilds the street in 3D, checks the rebuild against the footage, and won't hop until a simulation proves the landing is safe.**

Built live at the **Gemini 4 Argon SF Hackathon (Shack15, Sunday 2026-10-25)** for **Problem Statement 2: "More Dimensions"** (*"Build a system that renders what it made, watches the result, critiques it against the goal, and fixes it in a loop"*) and **Best Use of Managed Agents**.

---

## Why Only Possible with Gemini 4 Argon + Antigravity Managed Agents

On October 15, 2026, a cold-gas thruster sports car hopped over five vehicles on a closed course. Doing that on a **real city street**—with parked SUVs, street lights, tree canopies, overhead catenary wires, and moving pedestrians—requires combining spatial perception, semantic judgment, and deterministic physics verification:

1. **Multimodal Video + Ground-Anchor Ranging → 3D Metric Scene (`gemini-4-argon`):** Ingests 4–5 car-camera video clips (`front`, `right`, `back`, `left`, optional `up`) with HDR-to-SDR tonemapping and sharpest-keyframe extraction. Argon identifies every static and moving hazard, estimates horizon lines (`camera_horizons`) and ground-contact pixel coordinates (`anchor`), and [`server/anchors.js`](server/anchors.js) deterministically intersects those rays with the ground plane (`groundPoint` + `anchorFace` for long structures) to produce a metric 3D `site.json` (`flyme.site/1`).
2. **Loop 1 — Render → Watch → Critique → Patch (PS2 Visual Loop):** The browser renders the reconstructed 3D scene from each calibrated camera pose (`104°` HFOV, `1.3 m` height) with floating obstacle IDs (`o1`, `o2`…) and a `5 m` ground distance grid. `gemini-4-argon` compares our synthetic renders against the real footage keyframes, scores each camera (`0–100`), and emits structured JSON patches (`add`, `update`, `remove` with updated ground anchors) in a closed loop (up to 3 rounds or until all cameras score $\ge 80$).
3. **Loop 2 — Simulate → Read → Revise → Certify (3 Planner Modes):** When the driver taps a landing spot on the 3D ground (guided by an instant green landable-ground overlay from [`shared/landable.js`](shared/landable.js)):
   - **Agent Mode (`server/plan-agent.js`):** An **Antigravity Managed Agent** (`antigravity-preview-09-2026`, model `gemini-4-argon`, pre-warmed at SCAN time) runs our zero-dependency 3D physics and collision simulator ([`shared/sim-cli.mjs`](shared/sim-cli.mjs)) inside its remote Node 22 sandbox. Each round it proposes **4 deliberately diverse candidate trajectories** (varying apex height, lateral bow, climb bias, duration, liftoff delay, and vertical drop), inspects the simulator's 9 safety checks + dual-view SVG plot, revises on failure (up to 3 rounds), or picks the best `SAFE` route using both numeric margins and street semantics.
   - **Search Mode (`server/plan-search.js`):** A parallel `worker_threads` pool ([`server/search-pool.js`](server/search-pool.js)) sweeps 400 route shapes through the deterministic simulator, extracts the 4 most diverse `SAFE` trajectories, and sends them with real camera keyframes to `gemini-4-argon` to judge street semantics (or suggests a nearby reachable landing spot if all 400 fail).
   - **Local Mode (`server/plan-local.js`):** Server-side `gemini-4-argon` + deterministic simulator loop with the same 4-candidates × ≤3-rounds contract.
4. **Deterministic Safety Sovereignty:** The AI never self-certifies safety. The Express server independently re-simulates every candidate using [`shared/physics.js`](shared/physics.js); if an agent claim ever disagrees with the server simulator, the server simulator wins and flags the disagreement in the UI.
5. **Photoreal Hop Synthesis (`gemini-omni-1.1-flash`):** Records the certified 3D chase-cam hop from the WebGL canvas and combines it with the real street keyframe to synthesize a photorealistic 720p MP4 of the cold-gas hop.

---

## Architecture Overview

See [`docs/architecture.html`](docs/architecture.html) for the full visual architecture diagram.

```text
┌───────────────────────────────────────────────────────────────────────────────────┐
│                              STAGE A & B: SCAN                                    │
│  sites/<id>/*.mov ──(ffmpeg HDR→SDR)──► 720p MP4s + Sharpest Keyframe PNGs        │
│       │                                                                           │
│       └──(Files API)──► gemini-4-argon + anchors.js ──► site.r0.json              │
└───────────────────────────────────────┬───────────────────────────────────────────┘
                                        ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                    STAGE C: LOOP 1 — VISUAL SELF-CRITIQUE (≤3 rounds)             │
│  Browser Three.js renderCameraViews(site, rig) ──► 4–5 labeled 1280×720 PNGs      │
│       │                                                                           │
│       └──► gemini-4-argon (Render PNG + Footage Keyframe PNG + site.json)         │
│                  │                                                                │
│                  └──► per-cam match_score (0–100) + patch[] ──► applyPatch(site)  │
└───────────────────────────────────────┬───────────────────────────────────────────┘
                                        ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│              STAGE D & E: LOOP 2 — VERIFIED FLIGHT PLANNER (≤3 rounds)            │
│  User taps target {forward, right} on 3D street (with instant landable overlay)   │
│       │                                                                           │
│       ├──► [Agent Mode] Antigravity Managed Agent (Node 22 sandbox + sim-cli.mjs) │
│       ├──► [Search Mode] 400-shape worker pool sweep + Argon visual judge         │
│       └──► [Local Mode] Server-side Argon 4-candidate × ≤3-round loop             │
│       │                                                                           │
│       └──► Server re-simulates all candidates locally (shared/physics.js)         │
│            ──► Streams SSE `attempt` arcs + final `plan` verdict to UI            │
└───────────────────────────────────────────────────────────────────────────────────┘
```

---

## Vehicle Specifications & Provenance

All vehicle parameters live in [`shared/constants.js`](shared/constants.js) and are inspectable in the in-car UI via the **ⓘ Specs** popover:

| Spec | Value | Provenance | Source / Note |
|---|---|---|---|
| **Thrusters** | 10 cold-gas, around the perimeter | `public` | Oct 15, 2026 reveal, "Rocket" trim (TechCrunch, Teslarati) |
| **Air tank** | 600 L compressed air in COPVs | `public` | Lars Moravy, VP Vehicle Engineering (TechCrunch) |
| **Air mass** | **250 kg** (reserve **25 kg** / 10%) | `reported` | Space.com; consistent with 600 L @ ~400 bar |
| **Dry mass** | **1,900 kg** | `estimate` | Estimated from "4,000+ lb" curb weight report |
| **Max total thrust** | **80 kN** | `third-party` | Tech Insider analysis (~3.8× loaded weight) |
| **Max horizontal thrust** | **40 kN** | `estimate` | Perimeter thruster lateral authority estimate |
| **Exhaust velocity ($v_e$)** | **500 m/s** ($I_{sp} \approx 51\text{ s}$) | `estimate` | Cold-gas blowdown + perimeter nozzle cant (calibrated with Google mentors on-site) |
| **Dimensions ($L \times W \times H$)** | **4.3 × 2.0 × 1.15 m** | `estimate` | Proportions from reveal photos (generic white car, no logos) |
| **Camera rig height** | **1.3 m** (`104°` HFOV) | `estimate` | iPhone 0.5× ultrawide held at chest height |

### Deterministic Safety Envelope (9 Checks in `shared/checks.js`)

A candidate trajectory is rated `SAFE` if and only if all 9 checks pass across the entire 100 Hz (`dt = 0.01 s`) semi-implicit Euler simulation:

| Check ID | Requirement |
|---|---|
| `collision` | Minimum 3D signed distance car-box $\leftrightarrow$ any obstacle $> 0\text{ m}$ |
| `clearance` | Minimum 3D clearance to all non-person obstacles $\ge 0.5\text{ m}$ |
| `pedestrian` | Minimum 2D horizontal distance from car footprint to any `person` $\ge 5.0\text{ m}$ (cold-gas blast keep-out) |
| `thrust_limit` | No thrust clamping saturation ($>1\%$) while 3D trajectory tracking error $> 0.3\text{ m}$ |
| `touchdown_vertical` | Vertical touchdown speed $|v_{\text{up}}| < 3.0\text{ m/s}$ |
| `touchdown_horizontal` | Horizontal touchdown speed $\|v_{\text{horiz}}\| < 1.0\text{ m/s}$ |
| `landing_accuracy` | Touchdown miss distance from target $\le 1.5\text{ m}$ |
| `air_reserve` | Remaining COPV air mass $\ge 25.0\text{ kg}$ (10% reserve) |
| `landing_zone` | Final touchdown pose 3D clearance $\ge 0.5\text{ m}$ |

*(At $v_e = 500\text{ m/s}$, a $20\text{–}30\text{ m}$ hop over a parked SUV is feasible with $50\text{–}100\text{ kg}$ of air remaining; hops beyond $39\text{ m}$ exhaust the $225\text{ kg}$ usable air budget and fail `air_reserve`.)*

---

## How to Run

### Prerequisites
- **Node.js 22+**
- A `GEMINI_API_KEY` with access to `gemini-4-argon`, `antigravity-preview-09-2026`, and `gemini-omni-1.1-flash`

### Setup & Start
```bash
npm install
echo "GEMINI_API_KEY=your_key_here" > .env
npm run dev
```
Open **[http://localhost:5173](http://localhost:5173)**:
- **Keyboard shortcuts:** `S` (**SCAN** — Loop 1 reconstruct + visual critique), click/tap on the 3D street to set a landing target, `P` (**PLAN** — Loop 2 route verification), `H` (**HOP** — chase-cam flight animation).
- **Planner modes:** Toggle **Search** (400-shape simulator sweep + Argon visual judge), **Agent** (Antigravity Managed Agent sandbox), or **Local** (`gemini-4-argon` server-side loop) in the bottom bar.
- **Stage Replay Mode:** Append `?replay=1` to the URL (or toggle **Replay** in the bottom bar / set `FLYME_REPLAY=1`) to replay cached SSE event streams from `runs/<site_id>/` at $2\times$ speed, automatically matching the closest cached target.
- **Mock UI Mode:** Open `http://localhost:5173/?mock=1` to run the entire UI offline against pre-generated mock trajectories.

### Run Physics Tests & Evaluation Benchmarks
```bash
npm test
npm run eval

# Run the standalone simulator CLI (same CLI executed by the Managed Agent in its sandbox):
node shared/sim-cli.mjs \
  --site fixtures/sites/demo-street.json \
  --params '{"target":{"forward":25,"right":0},"apex_height_m":5.5,"duration_s":3.5,"side_bow_m":0,"climb_bias":0.35,"horizontal_delay":0.1}' \
  --svg /tmp/plot.svg
```

---

## Built Today (Sunday, October 25, 2026 @ Shack15)

Everything in this repository was designed, filmed, and implemented from scratch today during the hackathon (10:30 – 17:00 PT):
- **Zero-dependency 3D flight dynamics, collision & route-search engine** (`shared/physics.js`, `shared/geometry.js`, `shared/checks.js`, `shared/search.js`, `shared/landable.js`, `shared/sim-cli.mjs`, `shared/plot-svg.js`) running identically in the browser, on the Express server, and inside the Antigravity Managed Agent Node 22 sandbox.
- **Loop 1 visual reconstruction, ground-anchor ranging & render-critique-patch pipeline** (`server/ingest.js`, `server/reconstruct.js`, `server/anchors.js`, `server/critique.js`, `web/render-views.js`, `shared/schema.js`).
- **Loop 2 flight planners** (`server/plan-agent.js`, `server/plan-search.js`, `server/search-pool.js`, `server/plan-local.js`) with environment pre-warming at SCAN time, parallel worker-thread shape search, nearby target snap suggestions, and deterministic server re-verification.
- **In-car Three.js WebGL touchscreen UI** (`web/main.js`, `web/scene.js`, `web/car-model.js`, `web/site-meshes.js`, `web/cams.js`, `web/panel.js`, `web/video-panel.js`) with procedural generic white sports car geometry (no third-party logos or trademarks), 10 cold-gas thruster vapor emitters, instant landable-zone overlays, Footage/Render/Blend camera comparison tiles, and interactive 4-candidate round fans.
- **Real SF street footage & L-shaped paced ground truth** (`sites/bike-rack/`, `sites/crosswalk/`) filmed on-site around Shack15 / Embarcadero.

---

## Team & Credits

- **Joshua Young** — Street filming, ground-truth calibration, system design, live pitch
- Built with **Google Gemini 4 Argon** (`gemini-4-argon`), **Antigravity Managed Agents** (`antigravity-preview-09-2026`), and **Gemini Omni Flash** (`gemini-omni-1.1-flash`) via `@google/genai`.
