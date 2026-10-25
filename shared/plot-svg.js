// Dual-panel (side view + top view) SVG plot generator for flight candidates (PLAN.md §6.5).
// Zero dependencies: runs in Node 22 (Managed Agent sandbox), server, and browser.

import { CAR, SAFETY } from './constants.js';
import { normalizeSite } from './schema.js';

const PALETTE = ['#3b82f6', '#a855f7', '#ec4899', '#eab308', '#06b6d4', '#f97316'];

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generate a readable SVG with Side View (forward vs up) and Top View (forward vs right)
 * for one or more simulated candidates.
 * @param {object} site - site.json
 * @param {Array<{id?: string, label?: string, params: object, sim: object}>} candidates
 * @returns {string} SVG markup
 */
export function plotSvg(site, candidates = []) {
  const normSite = site?.schema === 'flyme.site/1' ? site : normalizeSite(site ?? {});
  const items = Array.isArray(candidates) ? candidates : [candidates];

  // Determine coordinate bounds across origin, target(s), obstacles, and samples
  let minF = -6;
  let maxF = 35;
  let minR = -12;
  let maxR = 12;
  let maxU = 12;

  for (const o of normSite.obstacles ?? []) {
    if (o.shape === 'wire') {
      minF = Math.min(minF, o.from.forward - 2, o.to.forward - 2);
      maxF = Math.max(maxF, o.from.forward + 2, o.to.forward + 2);
      minR = Math.min(minR, o.from.right - 2, o.to.right - 2);
      maxR = Math.max(maxR, o.from.right + 2, o.to.right + 2);
      maxU = Math.max(maxU, o.from.up + 2, o.to.up + 2);
    } else if (o.center) {
      const ext = o.shape === 'box' ? Math.max(o.size.length, o.size.width) : (o.radius ?? 1) * 2;
      const top = (o.base_up ?? 0) + (o.shape === 'box' ? o.size.height : o.height ?? 2);
      minF = Math.min(minF, o.center.forward - ext - 2);
      maxF = Math.max(maxF, o.center.forward + ext + 2);
      minR = Math.min(minR, o.center.right - ext - 2);
      maxR = Math.max(maxR, o.center.right + ext + 2);
      maxU = Math.max(maxU, top + 2);
    }
  }

  for (const item of items) {
    const t = item?.params?.target ?? item?.sim?.params?.target;
    if (t) {
      minF = Math.min(minF, t.forward - 4);
      maxF = Math.max(maxF, t.forward + 4);
      minR = Math.min(minR, t.right - 4);
      maxR = Math.max(maxR, t.right + 4);
    }
    for (const s of item?.sim?.samples ?? []) {
      minF = Math.min(minF, s.forward - 2);
      maxF = Math.max(maxF, s.forward + 2);
      minR = Math.min(minR, s.right - 2);
      maxR = Math.max(maxR, s.right + 2);
      maxU = Math.max(maxU, s.up + 2);
    }
  }

  const width = 900;
  const height = 680;
  const padL = 60;
  const padR = 40;
  const plotW = width - padL - padR;

  // Panel 1: Side view (forward vs up) y: [45..265]
  const sideTop = 45;
  const sideH = 220;
  const sideBottom = sideTop + sideH;

  // Panel 2: Top view (forward vs right) y: [320..600]
  const topTop = 320;
  const topH = 280;
  const topMidY = topTop + topH / 2;

  const spanF = Math.max(10, maxF - minF);
  const spanU = Math.max(8, maxU);
  const maxAbsR = Math.max(8, Math.abs(minR), Math.abs(maxR));

  const xOfF = (f) => (padL + ((f - minF) / spanF) * plotW).toFixed(1);
  const yOfU = (u) => (sideBottom - (u / spanU) * sideH).toFixed(1);
  // In Top View: +right is plotted downward so forward is rightwards and right is downwards (clockwise)
  const yOfR = (r) => (topMidY + (r / maxAbsR) * (topH / 2)).toFixed(1);
  const scaleF = plotW / spanF;
  const scaleR = (topH / 2) / maxAbsR;
  const scaleU = sideH / spanU;

  const lines = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="background:#0b0c0e;font-family:monospace;color:#e5e7eb">`);

  // Text summary inside <desc> so the LLM reading raw SVG gets exact metrics
  const descLines = items.map((c, idx) => {
    const id = c.id ?? `c${idx + 1}`;
    const sim = c.sim ?? c;
    return `${id} (${c.label ?? ''}): verdict=${sim.verdict} failures=[${(sim.failures ?? []).join(',')}] min_clearance=${sim.margins?.min_clearance_m ?? '?'}m air_rem=${sim.air?.remaining_kg ?? '?'}kg td_v=${sim.touchdown?.v_vertical ?? '?'}m/s`;
  });
  lines.push(`  <desc>${esc(descLines.join(' | '))}</desc>`);

  // Title
  lines.push(`  <text x="${padL}" y="26" fill="#f3f4f6" font-size="14" font-weight="bold">flyme trajectory plot — site: ${esc(normSite.id ?? 'site')}</text>`);

  // ---------------- SIDE VIEW (forward vs up) ----------------
  lines.push(`  <rect x="${padL}" y="${sideTop}" width="${plotW}" height="${sideH}" fill="#111318" stroke="#272a30"/>`);
  lines.push(`  <text x="${padL + 8}" y="${sideTop + 18}" fill="#9ca3af" font-size="12">SIDE VIEW (forward m vs up m)</text>`);
  // Ground line u=0
  lines.push(`  <line x1="${padL}" y1="${yOfU(0)}" x2="${padL + plotW}" y2="${yOfU(0)}" stroke="#4b5563" stroke-width="1.5"/>`);

  // Grid ticks in forward
  for (let f = Math.ceil(minF / 5) * 5; f <= maxF; f += 5) {
    const x = xOfF(f);
    lines.push(`  <line x1="${x}" y1="${sideTop}" x2="${x}" y2="${sideBottom}" stroke="#1f242d" stroke-width="1"/>`);
    lines.push(`  <text x="${x}" y="${sideBottom + 14}" fill="#6b7280" font-size="10" text-anchor="middle">${f}m</text>`);
  }

  // Obstacles in side view
  for (const o of normSite.obstacles ?? []) {
    const base = o.base_up ?? 0;
    if (o.shape === 'box') {
      const f0 = o.center.forward - o.size.length / 2;
      const w = o.size.length * scaleF;
      const h = o.size.height * scaleU;
      const y = yOfU(base + o.size.height);
      lines.push(`  <rect x="${xOfF(f0)}" y="${y}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#374151" fill-opacity="0.7" stroke="#9ca3af" stroke-width="1"/>`);
      lines.push(`  <text x="${xOfF(o.center.forward)}" y="${(Number(y) - 4).toFixed(1)}" fill="#d1d5db" font-size="10" text-anchor="middle">${esc(o.id)}:${esc(o.type)}</text>`);
    } else if (o.shape === 'cylinder') {
      const f0 = o.center.forward - o.radius;
      const w = Math.max(3, o.radius * 2 * scaleF);
      const h = o.height * scaleU;
      const y = yOfU(base + o.height);
      const color = o.type === 'person' ? '#f59e0b' : '#4b5563';
      lines.push(`  <rect x="${xOfF(f0)}" y="${y}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" fill-opacity="0.7" stroke="${color}" stroke-width="1"/>`);
      lines.push(`  <text x="${xOfF(o.center.forward)}" y="${(Number(y) - 4).toFixed(1)}" fill="${color}" font-size="10" text-anchor="middle">${esc(o.id)}</text>`);
    } else if (o.shape === 'wire') {
      lines.push(`  <line x1="${xOfF(o.from.forward)}" y1="${yOfU(o.from.up)}" x2="${xOfF(o.to.forward)}" y2="${yOfU(o.to.up)}" stroke="#ef4444" stroke-width="2" stroke-dasharray="4,2"/>`);
      lines.push(`  <text x="${xOfF(0.5 * (o.from.forward + o.to.forward))}" y="${(Number(yOfU(0.5 * (o.from.up + o.to.up))) - 5).toFixed(1)}" fill="#f87171" font-size="10" text-anchor="middle">${esc(o.id)}:wire(${o.from.up}m)</text>`);
    }
  }

  // ---------------- TOP VIEW (forward vs right) ----------------
  lines.push(`  <rect x="${padL}" y="${topTop}" width="${plotW}" height="${topH}" fill="#111318" stroke="#272a30"/>`);
  lines.push(`  <text x="${padL + 8}" y="${topTop + 18}" fill="#9ca3af" font-size="12">TOP VIEW (forward m vs right m; +right is down)</text>`);
  lines.push(`  <line x1="${padL}" y1="${yOfR(0)}" x2="${padL + plotW}" y2="${yOfR(0)}" stroke="#2d3340" stroke-width="1" stroke-dasharray="3,3"/>`);

  // Origin car box in top view
  lines.push(`  <rect x="${xOfF(-CAR.length / 2)}" y="${yOfR(-CAR.width / 2)}" width="${(CAR.length * scaleF).toFixed(1)}" height="${(CAR.width * scaleR).toFixed(1)}" fill="none" stroke="#ffffff" stroke-width="1.5"/>`);

  // Obstacles in top view
  for (const o of normSite.obstacles ?? []) {
    if (o.shape === 'box') {
      const w = o.size.length * scaleF;
      const h = o.size.width * scaleR;
      const cx = xOfF(o.center.forward);
      const cy = yOfR(o.center.right);
      const rot = o.heading_deg ?? 0;
      lines.push(`  <g transform="translate(${cx},${cy}) rotate(${rot})">`);
      lines.push(`    <rect x="${(-w / 2).toFixed(1)}" y="${(-h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#374151" fill-opacity="0.7" stroke="#9ca3af"/>`);
      lines.push(`  </g>`);
      lines.push(`  <text x="${cx}" y="${cy}" fill="#e5e7eb" font-size="10" text-anchor="middle" dy="3">${esc(o.id)}</text>`);
    } else if (o.shape === 'cylinder') {
      const cx = xOfF(o.center.forward);
      const cy = yOfR(o.center.right);
      const rx = Math.max(3, o.radius * scaleF);
      const ry = Math.max(3, o.radius * scaleR);
      const isPerson = o.type === 'person';
      const color = isPerson ? '#f59e0b' : '#6b7280';
      lines.push(`  <ellipse cx="${cx}" cy="${cy}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="${color}" fill-opacity="0.8"/>`);
      if (isPerson) {
        const krx = (SAFETY.pedestrianKeepOutM * scaleF).toFixed(1);
        const kry = (SAFETY.pedestrianKeepOutM * scaleR).toFixed(1);
        lines.push(`  <ellipse cx="${cx}" cy="${cy}" rx="${krx}" ry="${kry}" fill="none" stroke="#f59e0b" stroke-dasharray="4,3" stroke-width="1"/>`);
      }
      lines.push(`  <text x="${cx}" y="${(Number(cy) - ry - 3).toFixed(1)}" fill="${color}" font-size="10" text-anchor="middle">${esc(o.id)}</text>`);
    } else if (o.shape === 'wire') {
      lines.push(`  <line x1="${xOfF(o.from.forward)}" y1="${yOfR(o.from.right)}" x2="${xOfF(o.to.forward)}" y2="${yOfR(o.to.right)}" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="4,2"/>`);
    }
  }

  // Target marker
  const firstTarget = items[0]?.params?.target ?? items[0]?.sim?.params?.target;
  if (firstTarget) {
    const tx = xOfF(firstTarget.forward);
    const ty = yOfR(firstTarget.right);
    const trx = (SAFETY.landingToleranceM * scaleF).toFixed(1);
    const tryR = (SAFETY.landingToleranceM * scaleR).toFixed(1);
    lines.push(`  <ellipse cx="${tx}" cy="${ty}" rx="${trx}" ry="${tryR}" fill="none" stroke="#22c55e" stroke-width="1.5" stroke-dasharray="3,2"/>`);
    lines.push(`  <circle cx="${tx}" cy="${yOfU(0)}" r="4" fill="#22c55e"/>`);
  }

  // Candidate paths + legend
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const sim = item?.sim ?? item;
    const id = item?.id ?? `c${i + 1}`;
    const safe = sim?.verdict === 'SAFE';
    const color = safe ? '#22c55e' : PALETTE[i % PALETTE.length];
    const dash = safe ? '' : ' stroke-dasharray="5,3"';
    const samples = sim?.samples ?? [];

    if (samples.length > 1) {
      const sidePts = samples.map((s) => `${xOfF(s.forward)},${yOfU(s.up)}`).join(' ');
      const topPts = samples.map((s) => `${xOfF(s.forward)},${yOfR(s.right)}`).join(' ');
      lines.push(`  <polyline points="${sidePts}" fill="none" stroke="${color}" stroke-width="2"${dash}/>`);
      lines.push(`  <polyline points="${topPts}" fill="none" stroke="${color}" stroke-width="2"${dash}/>`);
    }

    const legX = padL + (i % 2) * 410;
    const legY = 630 + Math.floor(i / 2) * 20;
    const failTxt = safe ? 'SAFE' : `UNSAFE (${(sim?.failures ?? []).join(', ')})`;
    lines.push(`  <text x="${legX}" y="${legY}" fill="${color}" font-size="11">${esc(id)}: ${esc(item?.label ?? '')} — ${esc(failTxt)} [clr=${sim?.margins?.min_clearance_m ?? '?'}m, air=${sim?.air?.remaining_kg ?? '?'}kg]</text>`);
  }

  lines.push('</svg>');
  return lines.join('\n');
}
