// Vehicle + safety constants. Shared by the browser, the server, and the
// Managed Agent sandbox, so this file must stay dependency-free.
//
// Provenance matters for the demo: anything Tesla has said publicly is marked
// "public"; everything else is our estimate, chosen to be physically
// self-consistent (rocket equation, cold-gas Isp), not to match a spec sheet.

export const G = 9.81;

export const CAR = {
  name: 'Flying car (Roadster-class)',
  dryMassKg: 2000, // estimate: Roadster-class EV with a thruster package
  length: 4.3, // m, approx from public photos
  width: 2.0,
  height: 1.2,
  thrusterCount: 10, // public: "~10 small rocket thrusters arranged seamlessly around car"
  maxThrustN: 80000, // estimate: ~4x weight, enough for a brisk hop
  maxLateralThrustN: 40000, // estimate: horizontal component limit
  airKg: 180, // estimate: usable air in composite-overwrapped pressure vessels
  exhaustVelocityMs: 700, // estimate: cold-gas compressed air, Isp ~ 71 s
  cameraHeight: 1.3, // m, where the "car cameras" (the phone) sit
};

export const SAFETY = {
  maxTouchdownVerticalMs: 3.0,
  maxTouchdownHorizontalMs: 1.0,
  minClearanceM: 0.5,
  pedestrianKeepOutM: 5.0, // thruster blast radius around people
  landingToleranceM: 1.5,
  airReserveKg: 10,
};

export const PROVENANCE = [
  { label: 'Thrusters', value: '~10 cold-gas', source: 'public' },
  { label: 'Air tanks', value: 'COPV (composite overwrapped)', source: 'public' },
  { label: 'Flight', value: '"short hops"', source: 'public' },
  { label: 'Mass', value: `${CAR.dryMassKg} kg`, source: 'estimate' },
  { label: 'Max thrust', value: `${CAR.maxThrustN / 1000} kN`, source: 'estimate' },
  { label: 'Usable air', value: `${CAR.airKg} kg`, source: 'estimate' },
  { label: 'Exhaust velocity', value: `${CAR.exhaustVelocityMs} m/s (Isp ~71 s)`, source: 'estimate' },
];

// Bounds the planner is allowed to choose from. Keeping them explicit means the
// agent can't "fix" a plan by leaving the physical envelope.
export const PARAM_BOUNDS = {
  apex_height_m: [0.5, 20],
  duration_s: [1.0, 8.0],
  side_bow_m: [-15, 15],
  climb_bias: [0.25, 0.75],
  horizontal_delay: [0, 0.4],
};
