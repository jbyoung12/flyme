// Sandbox tool: draw the current site.json onto a camera frame so you can
// check it against the footage.
//   node overlay.mjs <site.json> <camera> <frame.png> <out.png> [horizon_y]
// Prints each obstacle's projected rectangle (fractions of the frame) and its colour.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const rig = JSON.parse(fs.readFileSync(new URL('./rig.json', import.meta.url)));
const [sitePath, camId, frame, out, hzArg] = process.argv.slice(2);
const site = JSON.parse(fs.readFileSync(sitePath));
const cam = rig.cameras.find((c) => c.id === camId);
const aspect = rig.aspect ?? 16 / 9, tanH = Math.tan((cam.hfov_deg / 2) * Math.PI / 180), tanV = tanH / aspect;
const h = cam.position?.up ?? 1.3, yaw = (cam.yaw_deg * Math.PI) / 180, hz = hzArg === undefined ? 0.5 : Number(hzArg);
const W = 1280, H = 720;
function project(f, r, u) {
  const zc = f * Math.cos(yaw) + r * Math.sin(yaw), s = -f * Math.sin(yaw) + r * Math.cos(yaw);
  if (zc < 0.3) return null;
  return [0.5 + 0.5 * s / (zc * tanH), hz + 0.5 * (-(u - h) / zc) / tanV];
}
function corners(o) {
  const base = o.base_up ?? 0;
  if (o.shape === 'wire') return [[o.from.forward, o.from.right, o.from.up], [o.to.forward, o.to.right, o.to.up]];
  if (o.shape === 'cylinder') {
    const pts = [];
    for (let a = 0; a < 8; a++) for (const u of [base, base + o.height]) pts.push([o.center.forward + o.radius * Math.cos(a * Math.PI / 4), o.center.right + o.radius * Math.sin(a * Math.PI / 4), u]);
    return pts;
  }
  const hd = ((o.heading_deg ?? 0) * Math.PI) / 180, c = Math.cos(hd), sn = Math.sin(hd), L = o.size.length / 2, Wd = o.size.width / 2;
  const pts = [];
  for (const a of [-L, L]) for (const b of [-Wd, Wd]) for (const u of [base, base + o.size.height]) pts.push([o.center.forward + a * c - b * sn, o.center.right + a * sn + b * c, u]);
  return pts;
}
const COLORS = ['red', 'yellow', 'cyan', 'magenta', 'lime', 'orange', 'blue', 'white', 'pink', 'violet'];
const rows = [], boxes = [];
site.obstacles.forEach((o, i) => {
  const p = corners(o).map((q) => project(...q)).filter(Boolean);
  if (!p.length) return;
  let x0 = Math.min(...p.map((q) => q[0])), x1 = Math.max(...p.map((q) => q[0])), y0 = Math.min(...p.map((q) => q[1])), y1 = Math.max(...p.map((q) => q[1]));
  if (x1 < 0 || x0 > 1 || y1 < 0 || y0 > 1) return;
  [x0, x1, y0, y1] = [Math.max(0, x0), Math.min(1, x1), Math.max(0, y0), Math.min(1, y1)];
  const color = COLORS[i % COLORS.length];
  rows.push({ id: o.id, label: o.label, color, rect: [x0, y0, x1, y1].map((v) => +v.toFixed(3)) });
  boxes.push(`drawbox=x=${Math.round(x0 * W)}:y=${Math.round(y0 * H)}:w=${Math.max(2, Math.round((x1 - x0) * W))}:h=${Math.max(2, Math.round((y1 - y0) * H))}:color=${color}@0.9:t=4`);
});
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', frame, '-vf', `scale=${W}:${H},${boxes.join(',') || 'null'}`, out]);
console.log(JSON.stringify({ wrote: out, obstacles: rows }, null, 1));
