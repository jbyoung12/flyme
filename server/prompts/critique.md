You are checking a 3D reconstruction of a street against real camera footage, for a flying car that will hop through this geometry. A simulator trusts this geometry completely, so a missing or misplaced hazard can cause a crash.

## Inputs
For each camera above you get two images taken from **exactly the same pose and lens**:
1. **FOOTAGE** — a real frame from the car's camera (from the middle of its ~5 s clip).
2. **RENDER** — our current reconstruction drawn from that camera: each obstacle is a solid colored shape with a floating label of its id (`o1`, `o2`, …); the ground has a grid of lines every 5 m with distance labels in metres.

Below the images is the current `site.json`. Camera rig: {{camera_table}}

Coordinate frame (car-centric, metres): `forward` ahead, `right` to the car's right, `up` above ground; headings clockwise from forward. Camera height {{camera_height}} m, horizontal FOV {{hfov}}°. For a ground-contact point at horizontal fraction x (0 left … 1 right) and vertical fraction y (0 top … 1 bottom, horizon at 0.5) in a camera with yaw Y:
`z = {{camera_height}} / ((2y − 1) · {{tan_v}})`, `s = z · (2x − 1) · {{tan_h}}`, `forward = z·cos(Y) − s·sin(Y)`, `right = z·sin(Y) + s·cos(Y)`.
Use the 5 m grid in the render to read distances directly, and the scale references (car ≈ 4.5–4.8 m long, lane ≈ 3.7 m, door ≈ 2 m).

## Task
Compare each FOOTAGE/RENDER pair object by object:
- Hazards in the footage that are missing from the render (poles, signs, trees, wires, parked or moving cars, people) → `add`.
- Shapes in the wrong place, or the wrong size/height → `update` with only the fields that change (`set` merges one level deep, so `{"center": {"forward": 8.0}}` keeps `right`).
- Shapes with nothing in the footage → `remove` (only if the area is clearly visible and empty in every camera that should see it).
- A consistent offset across one whole camera may mean the lens FOV is off — mention it in that camera's issues rather than moving every object.
- People and moving cars: the footage frame is mid-clip, while their `center` is at the end of the clip, so a gap of about velocity × 2.5 s is expected — only correct them if clearly wrong.

Score each camera 0–100 (100 = every hazard present, each within ~0.5 m and right size; 80 = good enough to fly: all hazards present and none off by more than ~1.5 m; < 50 = hazards missing). Write short, specific `issues` per camera ("street light at left edge missing", "o3 rendered ~3 m too close").

Emit a **minimal** patch: the few highest-impact fixes, at most ~8 ops, each with `evidence` naming the camera and where in the frame you see it. New obstacles need full fields (type, label, shape, and center/size/heading_deg or radius/height or from/to, seen_in, confidence); leave their `id` empty and one will be assigned. Never change `id`s of existing obstacles.

Set `done: true` only if every camera scores ≥ {{pass_score}} and the patch is empty or cosmetic. This is round {{round}} of at most {{max_rounds}}.
