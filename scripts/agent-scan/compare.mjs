// Score reconstructions against paced ground truth by object *name* (ids change
// every scan): error = distance from the paced point to the matched object's
// footprint (0 if the point lies on it). Lower is better.
//   node scripts/agent-scan/compare.mjs
import fs from 'node:fs';
const LANDMARKS = {
  'bike-rack': [
    { truth: 'first Lyft bike back wheel', match: /(row|line).*bike|docked.*bike|bike.*(row|dock)/i },
    { truth: 'monument staircase below the railing', match: /stair|step|monument.*(base|platform)|platform|granite/i },
  ],
  crosswalk: [
    { truth: 'front of red car behind', match: /red/i, type: 'vehicle' },
  ],
};
function footprintDist(o, p) {
  if (o.shape === 'box') {
    const h = ((o.heading_deg ?? 0) * Math.PI) / 180, df = p.forward - o.center.forward, dr = p.right - o.center.right;
    const a = df * Math.cos(h) + dr * Math.sin(h), b = -df * Math.sin(h) + dr * Math.cos(h);
    return Math.hypot(Math.max(Math.abs(a) - o.size.length / 2, 0), Math.max(Math.abs(b) - o.size.width / 2, 0));
  }
  if (o.shape === 'cylinder') return Math.max(Math.hypot(p.forward - o.center.forward, p.right - o.center.right) - o.radius, 0);
  return Infinity;
}
const latest = (id) => {
  const n = fs.readdirSync(`runs/${id}`).filter((f) => /^site\.r\d+\.json$/.test(f)).sort().pop();
  return { name: n, site: JSON.parse(fs.readFileSync(`runs/${id}/${n}`)) };
};
for (const [id, marks] of Object.entries(LANDMARKS)) {
  const truth = JSON.parse(fs.readFileSync(`sites/${id}/truth.json`));
  const cur = latest(id);
  const r0 = { name: 'site.r0.json', site: JSON.parse(fs.readFileSync(`runs/${id}/site.r0.json`)) };
  const agent = fs.existsSync(`runs/${id}/site.agent.json`) ? { name: 'site.agent.json', site: JSON.parse(fs.readFileSync(`runs/${id}/site.agent.json`)) } : null;
  for (const m of marks) {
    const p = truth[m.truth];
    const row = [`${id}: ${m.truth} (${p.forward}, ${p.right})`];
    for (const v of [r0, cur, agent].filter(Boolean)) {
      const cands = v.site.obstacles.filter((o) => m.match.test(o.label) && (!m.type || o.type === m.type));
      const best = cands.map((o) => ({ o, d: footprintDist(o, p) })).sort((a, b) => a.d - b.d)[0];
      row.push(`${v.name}: ${best ? `${best.d.toFixed(1)} m (${best.o.id} "${best.o.label.slice(0, 30)}")` : 'NOT FOUND'}`);
    }
    console.log(row.join('\n   '));
  }
  console.log(`   obstacles: r0 ${r0.site.obstacles.length}, ${cur.name} ${cur.site.obstacles.length}${agent ? `, agent ${agent.site.obstacles.length}` : ''}`);
}
