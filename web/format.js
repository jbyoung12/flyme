// Text helpers shared by the panel and the 3D labels.
import { CHECKS } from '../shared/constants.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const fmt = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');

const labelOf = (site, id) => site?.obstacles?.find((o) => o.id === id)?.label ?? id ?? 'obstacle';

// First failing check (in contract order) → short human reason, e.g.
// "clips parked white SUV", "air reserve".
export function firstFailure(sim) {
  if (!sim?.checks) return null;
  const failed = new Set(sim.failures ?? sim.checks.filter((c) => !c.pass).map((c) => c.id));
  for (const { id } of CHECKS) if (failed.has(id)) return sim.checks.find((c) => c.id === id) ?? { id };
  return null;
}

export function failReason(sim, site) {
  const c = firstFailure(sim);
  if (!c) return null;
  switch (c.id) {
    case 'collision': return `clips ${labelOf(site, c.obstacle_id)}`;
    case 'clearance': return `too close to ${labelOf(site, c.obstacle_id)}`;
    case 'pedestrian': return `within 5 m of ${c.obstacle_id ? labelOf(site, c.obstacle_id) : 'a pedestrian'}`;
    case 'thrust_limit': return 'thrust limit';
    case 'touchdown_vertical': return 'hard landing';
    case 'touchdown_horizontal': return 'sliding touchdown';
    case 'landing_accuracy': return 'misses the spot';
    case 'air_reserve': return 'air reserve';
    case 'landing_zone': return 'landing zone blocked';
    default: return c.id;
  }
}

// Value column of the checklist: "0.21 m (≥ 0.5)".
export function checkValue(c) {
  if (!c) return '—';
  const unit = c.unit ?? '';
  const d = unit === 'kg' ? 0 : 2;
  const op = { collision: '>', clearance: '≥', pedestrian: '≥', thrust_limit: '≤', touchdown_vertical: '<', touchdown_horizontal: '<', landing_accuracy: '≤', air_reserve: '≥', landing_zone: '≥' }[c.id] ?? '';
  const lim = typeof c.limit === 'number' ? ` <span class="faint">${op} ${c.limit}</span>` : '';
  return `${fmt(c.value, d)} ${unit}${lim}`;
}

// Very short reason for the 3D arc label: "hits o1", "near person o5".
export function shortReason(sim) {
  const c = firstFailure(sim);
  if (!c) return null;
  const o = c.obstacle_id ? ` ${c.obstacle_id}` : '';
  return ({
    collision: `hits${o}`, clearance: `too close to${o}`, pedestrian: `near person${o}`, thrust_limit: 'thrust limit',
    touchdown_vertical: 'hard landing', touchdown_horizontal: 'sliding landing', landing_accuracy: 'misses spot',
    air_reserve: 'low air', landing_zone: 'zone blocked',
  })[c.id] ?? c.id;
}
