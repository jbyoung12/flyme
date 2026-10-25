#!/usr/bin/env node
// Simulator CLI for the Managed Agent sandbox and local testing (PLAN.md §6.5).
// Usage:
//   node sim-cli.mjs --site site.json --params params.json [--out result.json] [--svg plot.svg]
// Prints summary JSON (no samples) to stdout; exits 0 always.

import fs from 'node:fs';
import path from 'node:path';
import { normalizeSite } from './schema.js';
import { prepareObstacles } from './geometry.js';
import { simulate } from './physics.js';
import { plotSvg } from './plot-svg.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function loadJsonArg(val, name) {
  if (!val || typeof val !== 'string') {
    throw new Error(`Missing required argument --${name}`);
  }
  const trimmed = val.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  return JSON.parse(fs.readFileSync(val, 'utf8'));
}

function writeFileSafe(filePath, content) {
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content);
}

function stripSamples(simResult, keepSamples = false) {
  if (keepSamples) return simResult;
  const { samples, ...summary } = simResult;
  return summary;
}

function main() {
  try {
    const args = parseArgs(process.argv);
    const rawSite = loadJsonArg(args.site, 'site');
    const rawParams = loadJsonArg(args.params, 'params');
    const keepSamples = Boolean(args.full);

    const site = normalizeSite(rawSite);
    const preparedObstacles = prepareObstacles(site);

    const isBatch = Array.isArray(rawParams) || Array.isArray(rawParams?.candidates);

    if (isBatch) {
      const list = Array.isArray(rawParams) ? rawParams : rawParams.candidates;
      const plotItems = [];
      const summaries = list.map((item, idx) => {
        const id = item?.id ?? `c${idx + 1}`;
        const label = item?.label ?? `candidate ${idx + 1}`;
        const p = item?.params ?? item;
        const sim = simulate(site, p, { preparedObstacles });
        plotItems.push({ id, label, params: sim.params, sim });
        const summary = stripSamples(sim, keepSamples);
        return {
          id,
          label,
          params: sim.params,
          verdict: sim.verdict,
          sim_verdict: sim.verdict,
          failures: sim.failures,
          margins: sim.margins,
          checks: summary.checks,
          touchdown: summary.touchdown,
          air: summary.air,
          peak: summary.peak,
          ...(summary.param_violations ? { param_violations: summary.param_violations } : {}),
          ...(keepSamples ? { samples: sim.samples } : {}),
        };
      });

      if (typeof args.svg === 'string') {
        writeFileSafe(args.svg, plotSvg(site, plotItems));
      }

      const safeIds = summaries.filter((c) => c.verdict === 'SAFE').map((c) => c.id);
      const output = {
        schema: 'flyme.sim-batch/1',
        safe_count: safeIds.length,
        safe_ids: safeIds,
        candidates: summaries,
      };

      const jsonText = JSON.stringify(output, null, 2);
      if (typeof args.out === 'string') {
        writeFileSafe(args.out, jsonText);
      }
      process.stdout.write(jsonText + '\n');
    } else {
      const p = rawParams?.params ?? rawParams;
      const sim = simulate(site, p, { preparedObstacles });
      if (typeof args.svg === 'string') {
        writeFileSafe(
          args.svg,
          plotSvg(site, [{ id: rawParams?.id ?? 'c1', label: rawParams?.label ?? 'single', params: sim.params, sim }]),
        );
      }
      const output = stripSamples(sim, keepSamples);
      const jsonText = JSON.stringify(output, null, 2);
      if (typeof args.out === 'string') {
        writeFileSafe(args.out, jsonText);
      }
      process.stdout.write(jsonText + '\n');
    }
  } catch (err) {
    const errObj = { error: err?.message ?? String(err) };
    process.stdout.write(JSON.stringify(errObj, null, 2) + '\n');
  }
  process.exit(0);
}

main();
