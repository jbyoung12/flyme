// Stretch 2 (T5b, PLAN.md §4 H, §6.8, §6.11): natural-language destination
// ("land by the tree", "past the parked SUV") → { target: {forward, right}, explanation }.

import { normalizeSite } from '../shared/schema.js';
import { landableMap } from '../shared/landable.js';
import { client, MODEL, parseJson } from './gemini.js';

const RESOLVE_SCHEMA = {
  type: 'object',
  properties: {
    target: {
      type: 'object',
      properties: {
        forward: { type: 'number' },
        right: { type: 'number' },
      },
      required: ['forward', 'right'],
    },
    explanation: { type: 'string' },
  },
  required: ['target', 'explanation'],
};

export async function resolveDestination({ site: rawSite, text } = {}) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new Error('text is required to resolve a destination');
  }
  const site = normalizeSite(rawSite ?? {});
  const zones = landableMap(site, { step: 2.0 });
  const clearSpots = zones.cells.filter((c) => c.ok).map(({ forward, right }) => ({ forward, right }));

  const prompt = [
    'You resolve a driver’s natural-language landing request into metric ground coordinates `{forward, right}` (metres, car-centric frame: `forward` ahead of the car, `right` to the car’s right).',
    `Driver request: "${text.trim()}"`,
    `Scene obstacles:\n${JSON.stringify(site.obstacles.map(({ id, type, label, shape, center, size, radius, from, to }) => ({ id, type, label, shape, center, size, radius, from, to })), null, 2)}`,
    `Clear landable ground spots (where the car footprint clears all obstacles by >= 0.5 m and pedestrians by >= 5 m):\n${JSON.stringify(clearSpots.slice(0, 120))}`,
    'Pick a `{forward, right}` target (preferring one of the clear landable spots within 5–35 m of the origin) that best matches the driver’s request, and provide a short 1-sentence `explanation` citing the relevant obstacle ID.',
  ].join('\n\n');

  const ix = await client().interactions.create(
    {
      model: MODEL,
      input: prompt,
      generation_config: { thinking_level: 'low' },
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: RESOLVE_SCHEMA,
      },
    },
    { timeout: 60_000 },
  );

  const parsed = parseJson(ix.output_text ?? '', 'resolve-destination');
  return {
    target: {
      forward: Math.round(Number(parsed.target.forward) * 10) / 10,
      right: Math.round(Number(parsed.target.right) * 10) / 10,
    },
    explanation: parsed.explanation ?? '',
  };
}
