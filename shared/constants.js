// Vehicle, safety, and simulator constants (PLAN.md §3, §5). Shared by the
// browser, the server, and the Managed Agent sandbox (Node 22), so this file
// must stay dependency-free.
//
// Provenance matters for the demo: anything Tesla has said publicly is marked
// "public"; everything else is reported by press, third-party, or our estimate.

export const G = 9.81;

export const CAR = {
  name: 'Flying car (Roadster-class)',
  dryMassKg: 1900, // estimate from "4000+ lb"
  airKg: 250, // reported: 600 L COPVs @ ~400 bar
  length: 4.3, // m (forward)
  width: 2.0, // m (right)
  height: 1.15, // m (up)
  thrusterCount: 10,
  maxThrustN: 80000, // third-party analysis
  maxHorizontalThrustN: 40000, // our estimate
  exhaustVelocityMs: 500, // cold-gas blowdown, Isp ≈ 51 s (D23)
  cameraHeight: 1.3, // m, the phone rig at chest height
};

export const SAFETY = {
  maxTouchdownVerticalMs: 3.0,
  maxTouchdownHorizontalMs: 1.0,
  minClearanceM: 0.5,
  pedestrianKeepOutM: 5.0, // thruster blast radius around people (3D distance: above counts)
  landingToleranceM: 1.5,
  airReserveKg: 25, // 10% of air
};

// Simulator tuning (§5). Implement exactly; tests depend on these.
export const SIM = {
  dt: 0.01, // s, semi-implicit Euler step
  sampleEvery: 0.05, // s, emitted trace spacing
  refDiffH: 1e-4, // s, central-difference step on the reference path
  kp: 36, // 1/s², position gain
  kd: 10.8, // 1/s, velocity gain
  saturationTol: 0.01, // clamp reduced ‖T‖ by > 1% → saturated
  trackingErrorM: 0.3, // thrust_limit fails if saturated while error > this
  settleRateMs: 0.5, // up_ref = −0.5·(t − T) after the path ends
  touchdownMinFrac: 0.85, // touchdown allowed once t ≥ 0.85·T and up ≤ eps
  touchdownEpsM: 0.02,
  touchdownMinT: 0.2, // or t > 0.2 s and up ≤ 0
  hardCapExtraS: 5, // stop at T + 5 s
  sampleSpacingM: 0.25, // collision sample spacing upper bound
  wireRadiusM: 0.05,
  takeoffGraceS: 0.8, // near-but-clear obstacles: only `collision` while t < this
  overlapIgnoreS: 0.5, // obstacles overlapping at t=0 are ignored while t < this
};

export const DRAG = {
  rho: 1.2, // kg/m³
  cd: 1.0,
  areaHorizontal: 2.3, // m², W×H, for forward/right motion
  areaVertical: 8.6, // m², L×W, for up/down motion
};

// Check ids are a contract (§5): UI, prompts, and the agent reference them.
export const CHECKS = [
  { id: 'collision', label: 'No collision', unit: 'm' },
  { id: 'clearance', label: 'Clearance ≥ 0.5 m', unit: 'm' },
  { id: 'pedestrian', label: 'People ≥ 5 m away', unit: 'm' },
  { id: 'thrust_limit', label: 'Within thrust limits', unit: 'm' },
  { id: 'touchdown_vertical', label: 'Touchdown vertical < 3 m/s', unit: 'm/s' },
  { id: 'touchdown_horizontal', label: 'Touchdown horizontal < 1 m/s', unit: 'm/s' },
  { id: 'landing_accuracy', label: 'Lands within 1.5 m', unit: 'm' },
  { id: 'air_reserve', label: 'Air left ≥ 25 kg', unit: 'kg' },
  { id: 'landing_zone', label: 'Landing zone clear', unit: 'm' },
];
export const CHECK_IDS = CHECKS.map((c) => c.id);

// Bounds the planner may choose from (§6.4). Keeping them explicit means the
// agent can't "fix" a plan by leaving the physical envelope.
export const PARAM_BOUNDS = {
  apex_height_m: [0.5, 20],
  duration_s: [1.0, 8.0],
  side_bow_m: [-15, 15],
  climb_bias: [0.25, 0.75],
  horizontal_delay: [0, 0.4],
  vertical_drop: [0, 0.4], // optional, default 0: final fraction spent descending straight down
};

// Naive baseline params (eval mode (c)); target filled in by the caller.
export const DEFAULT_PARAMS = {
  apex_height_m: 5,
  duration_s: 3.2,
  side_bow_m: 0,
  climb_bias: 0.4,
  horizontal_delay: 0.1,
  vertical_drop: 0,
};

// Default camera rig when sites/<id>/rig.json is absent (§6.2).
export const DEFAULT_RIG = {
  cameras: [
    { id: 'front', file: 'front.mov', position: { forward: 0, right: 0, up: 1.3 }, yaw_deg: 0, pitch_deg: 0, hfov_deg: 104 },
    { id: 'right', file: 'right.mov', position: { forward: 0, right: 0, up: 1.3 }, yaw_deg: 90, pitch_deg: 0, hfov_deg: 104 },
    { id: 'back', file: 'back.mov', position: { forward: 0, right: 0, up: 1.3 }, yaw_deg: 180, pitch_deg: 0, hfov_deg: 104 },
    { id: 'left', file: 'left.mov', position: { forward: 0, right: 0, up: 1.3 }, yaw_deg: 270, pitch_deg: 0, hfov_deg: 104 },
    { id: 'up', file: 'up.mov', position: { forward: 0, right: 0, up: 1.3 }, yaw_deg: 0, pitch_deg: 60, hfov_deg: 104, optional: true },
  ],
  aspect: 1.7778,
};

// Loop 1 stops when every camera scores ≥ this, or after MAX_CRITIQUE_ROUNDS.
export const CRITIQUE_PASS_SCORE = 80;
export const MAX_CRITIQUE_ROUNDS = 3;
// Loop 2: exactly 4 candidates per round, at most 3 rounds (D7).
export const CANDIDATES_PER_ROUND = 4;
export const MAX_PLAN_ROUNDS = 3;
export const PLAN_VALID_S = 10; // D22 banner

// Specs popover (§3). source ∈ public | reported | third-party | estimate.
export const PROVENANCE = [
  { label: 'Thrusters', value: '10 cold-gas, around the perimeter', source: 'public', note: 'Oct 15 2026 reveal, "Rocket" trim (TechCrunch, Teslarati)' },
  { label: 'Air', value: '600 L compressed air in COPVs', source: 'public', note: 'Lars Moravy, VP Eng (TechCrunch)' },
  { label: 'Air mass', value: `${CAR.airKg} kg (reserve ${SAFETY.airReserveKg} kg)`, source: 'reported', note: 'Space.com; consistent with 600 L @ ~400 bar' },
  { label: 'Dry mass', value: `${CAR.dryMassKg.toLocaleString('en-US')} kg`, source: 'estimate', note: 'from "4000+ lb"' },
  { label: 'Max thrust', value: `${CAR.maxThrustN / 1000} kN`, source: 'third-party', note: 'Tech Insider analysis' },
  { label: 'Max horizontal thrust', value: `${CAR.maxHorizontalThrustN / 1000} kN`, source: 'estimate', note: 'ours' },
  { label: 'Exhaust velocity', value: `${CAR.exhaustVelocityMs} m/s (Isp ≈ 51 s)`, source: 'estimate', note: 'cold-gas blowdown + nozzle cant, per Google mentors' },
  { label: 'Dimensions', value: `${CAR.length} × ${CAR.width} × ${CAR.height} m`, source: 'estimate', note: 'from photos' },
  { label: '0–60 mph', value: '< 0.59 s', source: 'public', note: 'Teslarati' },
  { label: 'Camera height', value: `${CAR.cameraHeight} m`, source: 'estimate', note: 'our phone rig' },
];
