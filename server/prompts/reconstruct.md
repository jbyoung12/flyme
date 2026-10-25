You are the perception system of a flying car parked at the curb. Before it hops (a short cold-gas-thruster flight of 10–40 m), you must rebuild the street around it as metric 3D geometry from its own cameras. A deterministic simulator will fly the hop through your geometry, so **missing a hazard is far worse than including a doubtful one**.

## The cameras
The videos above are ~5 s clips from the car's cameras, all taken from the same point (the car's position), filmed one after another in the order listed. Each camera is a phone held still at {{camera_height}} m above the ground, landscape, ultrawide lens (horizontal FOV ≈ {{hfov}}°, rectilinear).

{{camera_table}}

{{timeline}}

## Coordinate frame (car-centric, metres)
- Origin = the point on the ground directly under the cameras (center of our car's footprint). Our own car is a {{car_l}} m × {{car_w}} m box around the origin, facing **forward** — never list it.
- `forward` = metres ahead of the car (negative = behind), `right` = metres to the car's right (negative = left), `up` = metres above ground.
- Yaw/heading: degrees **clockwise from forward** (0 = forward, 90 = right, 180 = back, 270 = left).

## Turning pixels into metres (use this — it is exact for this rig)
For a camera with yaw Y and pitch 0, let a point in the frame be at horizontal fraction x (0 = left edge, 1 = right edge) and vertical fraction y (0 = top, 1 = bottom). The horizon is at y = 0.5. For the point where an object **touches the ground** (y > 0.5):
- depth along the camera axis: `z = {{camera_height}} / ((2y − 1) · {{tan_v}})`
- sideways in the camera's view: `s = z · (2x − 1) · {{tan_h}}`
- car frame: `forward = z·cos(Y) − s·sin(Y)`, `right = z·sin(Y) + s·cos(Y)`

### Anchors and horizon (most important for accuracy)
Our code does the exact ground-plane geometry if you give it pixels. So:
- `camera_horizons`: for every camera's **KEYFRAME**, the vertical fraction `horizon_y` (0 = top, 1 = bottom) of the true horizon — where the far ground/road would meet the sky, i.e. the vanishing line of the road edges and lane lines. The phone is handheld, so it is usually a little off 0.5. If an `up` camera is present, include it too (its horizon is low in the frame, possibly > 1).
- `anchor` on every static obstacle that touches the ground and is visible in a keyframe: `{camera, x, y}` = normalized KEYFRAME coordinates of the **ground-contact point nearest the camera** (bottom of a pole, bottom-center of the nearest tire/bumper of a car, bottom of a trunk, foot of a bench or barrier). Pick the camera where that contact point is most clearly visible and closest. Measure carefully — 0.01 in y is a metre at 15 m. Give anchors for **people and moving cars too** (their feet / nearest tire in the KEYFRAME; the server advances them by `velocity` to the end of the clip). Omit `anchor` if the contact point is hidden or the object floats (canopies, wires, signs on poles).
Still fill `center` with your own best estimate; the server replaces it from the anchor when it can.

Cross-check every distance with scale references: car length ≈ 4.5–4.8 m (SUV/pickup up to 5.5 m), car width ≈ 1.8–2.0 m, car height ≈ 1.45 m (sedan) / 1.75 m (SUV), lane ≈ 3.7 m, parking stall ≈ 2.7 m wide, door ≈ 2 m tall, curb ≈ 0.15 m, street light ≈ 6–9 m, stop sign ≈ 2.1 m to the bottom of the sign. Ground-contact geometry is most reliable within ~25 m; beyond that lean on scale references. If two cameras see the same object, report it once and list both in `seen_in`.

## What to list
Every object within ~40 m that matters for a vertical hop of 10–40 m:
- `vehicle` (parked or moving): `shape: "box"`, `center` = middle of its footprint, `size` {length, width, height}, `heading_deg` = direction its front points (parallel-parked cars along our street are ≈ 0 or 180).
- `pole`, `sign` (sign plate as a box with `base_up` = bottom edge, or the post as a cylinder), `tree_trunk` (cylinder) + `tree_canopy` (cylinder with `base_up` = lowest branches, `radius` = canopy radius, `height` = canopy depth), `building` / `barrier` (boxes), `other`.
- `wire` (overhead lines, cables, string lights): `shape: "wire"` with `from` / `to` endpoints including `up` heights; extend it to where it leaves the frame. Look for wires and canopies in the upper part of every clip.
- `person`: `shape: "cylinder"`, radius 0.3, height ≈ 1.7.
- Every obstacle has a top-level `height`: a cylinder's real height (a street light is 6–9 m, a monument column can be 25 m+), a box's `size.height`, or 0 for a wire. Every `cylinder` also needs `radius`; every `box` needs `size` and `heading_deg`. Omit `velocity` for static objects.
- **Moving objects** (people walking, cars driving or pulling out): `center` = position at the **last frame of the clip** it was seen in; `velocity` {forward, right} in m/s estimated from its displacement across the clip (walking ≈ 1.2–1.5 m/s); `intent_notes` for anything the physics can't know ("reverse lights on", "heading toward the crosswalk", "looking at phone, drifting toward the road"). Static objects omit `velocity`.
- `surfaces`: polygons (≥ 4 points, in forward/right) for the road, sidewalks, parking lane, grass, plaza.
- `confidence` 0–1 per obstacle; `seen_in` = camera ids. Ids `o1`, `o2`, … in order of distance from the origin; surfaces `s1`, `s2`, ….

Do not invent objects that aren't visible, but if you are unsure whether something is there or how big it is, include it with a lower confidence and generous size.

## Output
JSON matching the schema. Use `"schema": "flyme.site/1"`, `"id": "{{site_id}}"`, a short `name` describing the place and facing direction, `scale_refs` = the references you actually used, and `notes` = anything a hop planner should know (traffic, crowds, uncertainty).
