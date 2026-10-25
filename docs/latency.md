# Latency (T0 smoke test, 2026-10-25 ~11:33 PT, Shack15 Wi-Fi)

Run: `node scripts/smoke.mjs [argon|agent|all]` (results also land in `runs/smoke.json`).

| Call | Result | Time |
|---|---|---|
| `gemini-4-argon`, text → JSON schema, `thinking_level: "low"` | `completed`, `{"ok":true,"model":"Gemini 4 Argon"}`, 173 tokens | **5.2 s** |
| Antigravity agent (`antigravity-preview-09-2026`, model `gemini-4-argon`), `background: true`, 1 inline source, "run `node` + write a file" | `completed`; sandbox **Node v22.23.4**; ran our inline `.mjs`, wrote `/workspace/out/hello.txt` | create call returned in **8.3 s** (env provisioned, `environment_id` set); **26.0 s** total to `completed` (2 s polling) |
| `environments.files.download` (`workspace/out/hello.txt`) | bytes OK | **2.6 s** |
| `environments.create({ sources })` (pre-warm probe) | `status: "active"` | **1.5 s** |

Takeaways for T4:
- A trivial one-tool agent turn is ~26 s end to end; ~18k input tokens of agent overhead per turn (7k cached). A 3-round × 4-candidate plan with one batched `sim-cli` call per round should land well under the 90 s "go local" threshold — measure it.
- `client.environments.create / get / delete` all work with the API key (create takes `{ sources }`, returns `{ id, status }`). Pre-warm at SCAN = `environments.create` with the sim sources, then pass `environment: envId` on PLAN.
- Agent usage of a trivial turn: ~18k tokens ≈ $0.04.
