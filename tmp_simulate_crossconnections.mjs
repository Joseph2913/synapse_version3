/**
 * Simulates cross-connection discovery for both pipelines.
 *
 * - Automated pipeline (process.ts): automated entities = NEW, manual entities = EXISTING
 * - Manual pipeline (crossConnections.ts): manual entities = NEW, automated entities = EXISTING
 *
 * Outputs:
 *   tmp_crossconnections_automated.json
 *   tmp_crossconnections_manual.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Manual .env.local loader
try {
  const envContent = readFileSync(resolve(__dirname, '.env.local'), 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* no .env.local */ }

const GEMINI_API_KEY = process.env.VITE_GEMINI_API_KEY ?? process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

if (!GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY in .env.local');
  process.exit(1);
}

// ── Load extraction results ───────────────────────────────────────────────────
const automated = JSON.parse(readFileSync(resolve(__dirname, 'tmp_extraction_automated.json'), 'utf8'));
const manual    = JSON.parse(readFileSync(resolve(__dirname, 'tmp_extraction_manual.json'), 'utf8'));

const automatedEntities = automated.entities;
const manualEntities    = manual.entities;

function entityLine(e) {
  return `- ${e.label} (${e.entity_type}): ${e.description ?? ''}`;
}

// ── Gemini helper ─────────────────────────────────────────────────────────────
async function callGemini(prompt, systemInstruction = null) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
  };
  if (systemInstruction) {
    body.system_instruction = { parts: [{ text: systemInstruction }] };
  }

  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err}`);
  }

  const data = await res.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error('Empty Gemini response');
  return JSON.parse(rawText);
}

// ── AUTOMATED pipeline cross-connection (mirrors process.ts) ──────────────────
// NEW = automated entities, EXISTING = manual entities
async function runAutomatedCrossConnect() {
  console.log('\n[Automated] Running cross-connection discovery (process.ts approach)...');

  const newList      = automatedEntities.slice(0, 20).map(entityLine).join('\n');
  const existingList = manualEntities.slice(0, 30).map(entityLine).join('\n');

  const prompt = `Given these NEW entities from a YouTube video and EXISTING entities from other sources, identify meaningful cross-source relationships.

NEW entities:
${newList}

EXISTING entities:
${existingList}

Return ONLY valid JSON:
{
  "relationships": [
    { "source": "new entity label", "target": "existing entity label", "relation_type": "one of: relates_to|supports|contradicts|part_of|enables|leads_to", "evidence": "brief explanation" }
  ]
}

Only include high-confidence relationships with clear evidence. Return empty array if none found.`;

  const result = await callGemini(prompt);
  console.log(`[Automated] Found ${result.relationships?.length ?? 0} cross-connections`);
  return result;
}

// ── MANUAL pipeline cross-connection (mirrors crossConnections.ts inferBatch) ─
// NEW = manual entities, EXISTING = automated entities
async function runManualCrossConnect() {
  console.log('\n[Manual] Running cross-connection discovery (crossConnections.ts approach)...');

  const newList      = manualEntities.map(entityLine).join('\n');
  const existingList = automatedEntities.map(entityLine).join('\n');

  const prompt = `Given these pairs of entities from different sources, identify which pairs have meaningful relationships. Only return relationships where a genuine connection exists — do not force connections.

New entities (from the just-ingested source):
${newList}

Existing entities (from the user's knowledge graph):
${existingList}

Return JSON:
{
  "connections": [
    {
      "new_entity": "exact label of the new entity",
      "existing_entity": "exact label of the existing entity",
      "relation_type": "one of: leads_to, supports, enables, blocks, contradicts, part_of, relates_to, mentions, connected_to, associated_with",
      "evidence": "brief justification for this connection"
    }
  ]
}

Return an empty connections array if no genuine connections exist.`;

  const result = await callGemini(
    prompt,
    'You are a knowledge graph relationship expert. Identify genuine connections between entities.'
  );
  console.log(`[Manual] Found ${result.connections?.length ?? 0} cross-connections`);
  return result;
}

// ── Run both in parallel ──────────────────────────────────────────────────────
const [automatedResult, manualResult] = await Promise.all([
  runAutomatedCrossConnect(),
  runManualCrossConnect(),
]);

// ── Build output files ────────────────────────────────────────────────────────

// Automated output — mirroring process.ts field names
const automatedOutput = {
  pipeline: 'automated',
  approach: 'process.ts — inline Gemini prompt',
  prompt_format: { source: 'new entity label', target: 'existing entity label', relation_type: 'relates_to|supports|contradicts|part_of|enables|leads_to' },
  new_entities_source: 'tmp_extraction_automated.json',
  existing_entities_source: 'tmp_extraction_manual.json (simulates prior knowledge graph)',
  summary: {
    total_cross_connections: automatedResult.relationships?.length ?? 0,
    relation_type_breakdown: buildBreakdown(automatedResult.relationships ?? [], 'relation_type'),
  },
  cross_connections: automatedResult.relationships ?? [],
};

// Manual output — mirroring crossConnections.ts field names
const manualOutput = {
  pipeline: 'manual',
  approach: 'crossConnections.ts — inferBatch Gemini prompt',
  prompt_format: { new_entity: 'exact label', existing_entity: 'exact label', relation_type: 'leads_to|supports|enables|blocks|contradicts|part_of|relates_to|mentions|connected_to|associated_with' },
  new_entities_source: 'tmp_extraction_manual.json',
  existing_entities_source: 'tmp_extraction_automated.json (simulates prior knowledge graph)',
  summary: {
    total_cross_connections: manualResult.connections?.length ?? 0,
    relation_type_breakdown: buildBreakdown(manualResult.connections ?? [], 'relation_type'),
  },
  cross_connections: manualResult.connections ?? [],
};

function buildBreakdown(items, key) {
  return items.reduce((acc, item) => {
    const v = item[key] ?? 'unknown';
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});
}

writeFileSync(
  resolve(__dirname, 'tmp_crossconnections_automated.json'),
  JSON.stringify(automatedOutput, null, 2)
);
writeFileSync(
  resolve(__dirname, 'tmp_crossconnections_manual.json'),
  JSON.stringify(manualOutput, null, 2)
);

console.log('\n✓ tmp_crossconnections_automated.json');
console.log('✓ tmp_crossconnections_manual.json');
console.log('\n── Automated cross-connections ──────────────────────────────────');
for (const r of automatedOutput.cross_connections) {
  console.log(`  ${r.source} → ${r.target} [${r.relation_type}]`);
  console.log(`    Evidence: ${r.evidence}`);
}
console.log('\n── Manual cross-connections ─────────────────────────────────────');
for (const c of manualOutput.cross_connections) {
  console.log(`  ${c.new_entity} → ${c.existing_entity} [${c.relation_type}]`);
  console.log(`    Evidence: ${c.evidence}`);
}
