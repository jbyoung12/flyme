# flyme

Hackathon project (Gemini 4 Argon SF, 2026-10-25, submit by 16:40 PT). Flying-car hop planner: Argon reconstructs a street from car-camera clips, verifies the rebuild against footage, and a Managed Agent plans a thruster hop that our deterministic simulator must certify.

**Read `PLAN.md` before doing anything.** All decisions there are locked with the user — build to its contracts (§6) and tracks (§9); don't re-ask. Gemini API shapes: `docs/gemini-api-notes.md` (trust it over memory).

Conventions:
- Plain JS, ESM, no TypeScript. `shared/` is zero-dependency and must run on Node 22 (Managed Agent sandbox) and in the browser.
- Gemini request fields are snake_case (`generation_config`, `previous_interaction_id`); only `files.upload/get` use camelCase.
- The simulator is the only judge of safety; never trust model text for a verdict.
- Never commit `.env`, raw footage (`sites/*/*.mov|mp4`), or `runs/`.
- No Tesla logos or trademarks in assets; say "flying car" in UI.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
