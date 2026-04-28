/**
 * api/simulate/generate-personas.ts
 *
 * Vercel serverless function — generates simulation agent personas from a seed graph.
 * CRITICAL: Fully self-contained. No local imports. All helpers defined inline.
 *
 * PRD: PRD-Simulate-D — Native Persona Generation
 * Status: Scaffold — finalise once PRD-Simulate-C merges real SimulationConfig type
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'

// ─── Inline type definitions (mirrors src/types/simulate.ts) ─────────────────

type GroundingQuality = 'strong' | 'moderate' | 'weak' | 'inferred'
type EpistemicStyle = 'empirical' | 'ideological' | 'opportunistic' | 'contrarian' | 'cautious' | 'structural'
type InfluenceTier = 'high' | 'medium' | 'low'
type StanceCategory = 'pro' | 'anti' | 'conditional' | 'uncertain' | 'orthogonal'

interface SimulationPersona {
  agent_id: string
  label: string
  entity_type: string
  influence_tier: InfluenceTier
  grounding_quality: GroundingQuality
  grounding_chunk_ids: string[]
  source_count: number
  documented_position: string
  question_specific_stance: string
  stance_category: StanceCategory
  incentive_structure: string
  epistemic_style: EpistemicStyle
  update_conditions: string
  blind_spots: string
  inter_agent_relationships: string[]
  behavioural_prompt: string
  is_synthetic: boolean
  is_excluded: boolean
}

interface PersonaSetDiversity {
  score: number
  distribution: Record<StanceCategory, number>
  warning: 'none' | 'low_diversity' | 'single_source'
  recommendation: 'proceed' | 'inject_contrarian' | 'broaden_scope'
}

interface SeedGraphNode {
  id: string
  label: string
  entityType: string
  description: string
  isAnchor: boolean
  confidence: number
  centrality: number
  sourceId: string | null
  tags: string[]
}

interface SeedGraphEdge {
  id: string
  sourceNodeId: string
  targetNodeId: string
  relationType: string
  evidence: string
  weight: number
}

interface SeedGraphChunk {
  id: string
  sourceId: string
  content: string
  chunkIndex: number
}

interface SeedGraph {
  nodes: SeedGraphNode[]
  edges: SeedGraphEdge[]
  sourceChunks: SeedGraphChunk[]
  metadata: {
    exportedAt: string
    anchorIds: string[]
    timeWindowDays: number
  }
}

interface SimulationConfig {
  mode: 'prediction' | 'hypothesis_test' | 'contrarian_scan' | 'optimisation' | 'consensus_mapping'
  depth: 'quick_scan' | 'standard' | 'deep_dive' | 'exhaustive'
  surpriseSensitivity: 'conservative' | 'balanced' | 'expansive'
  question: string
  whatIfVariables: string[]
  externalAgents: { label: string; entity_type: string; known_position: string }[]
  [key: string]: unknown
}

interface RequestBody {
  seedGraph: SeedGraph
  config: SimulationConfig
  userId: string
}

// ─── Gemini helpers (inline) ─────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.VITE_GEMINI_API_KEY ?? ''
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'


// ─── Structured logging ─────────────────────────────────────────────────────

type LogStatus = 'ok' | 'failed' | 'partial' | 'skipped'

interface LogFields {
  stage: string
  user_id?: string
  source_id?: string
  duration_ms?: number
  status?: LogStatus
  error?: string
  [k: string]: unknown
}

function log(fields: LogFields): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }))
}

function logError(fields: LogFields & { error: string }): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', ...fields }))
}

async function callGemini(prompt: string, temperature: number): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens: 1024 },
    }),
  })
  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status}`)
  }
  const data = await response.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
}

function parseJSON<T>(text: string): T | null {
  // Strip markdown code fences if present
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  try {
    return JSON.parse(cleaned) as T
  } catch {
    return null
  }
}

// ─── Mode directive lookup ───────────────────────────────────────────────────

function getModeDirective(mode: string, question: string): string {
  switch (mode) {
    case 'prediction':
      return 'Reason probabilistically. Estimate likelihoods. Be willing to update when shown evidence.'
    case 'hypothesis_test':
      return `The hypothesis is: ${question}. Evaluate it critically. State whether you support or refute it and why.`
    case 'contrarian_scan':
      return 'Your role is to surface what others overlook. Challenge consensus. Prioritise minority positions and weak signals.'
    case 'optimisation':
      return 'Evaluate options rather than predict outcomes. Reason from your incentives about which path best serves your interests.'
    case 'consensus_mapping':
      return 'Find common ground. Identify what you can agree on with others. Resolve rather than amplify contradictions.'
    default:
      return 'Reason probabilistically. Estimate likelihoods. Be willing to update when shown evidence.'
  }
}

function getSensitivityDirective(sensitivity: string): string {
  switch (sensitivity) {
    case 'expansive':
      return 'Consider second and third-order effects. What would have to be true for an unexpected outcome? What does conventional wisdom get wrong?'
    case 'conservative':
      return 'Only surface claims you can directly ground in the source material. Flag speculation explicitly.'
    default:
      return ''
  }
}

// ─── Influence tier computation ──────────────────────────────────────────────

function computeInfluenceTier(node: SeedGraphNode): InfluenceTier {
  if (node.isAnchor) return 'high'
  if (node.centrality >= 8) return 'high'
  if (node.centrality >= 4) return 'medium'
  return 'low'
}

// ─── Relationship summariser ─────────────────────────────────────────────────

function summariseRelation(relationType: string, targetLabel: string): string {
  const typeMap: Record<string, string> = {
    leads_to: `Leads to ${targetLabel}`,
    supports: `Supports ${targetLabel}`,
    enables: `Enables ${targetLabel}`,
    blocks: `Blocks ${targetLabel}`,
    contradicts: `Contradicts ${targetLabel}`,
    part_of: `Part of ${targetLabel}`,
    relates_to: `Relates to ${targetLabel}`,
    mentions: `Mentions ${targetLabel}`,
    connected_to: `Connected to ${targetLabel}`,
    owns: `Owns ${targetLabel}`,
    created: `Created ${targetLabel}`,
    challenges: `Challenges ${targetLabel}`,
    risks: `Risks ${targetLabel}`,
  }
  return typeMap[relationType] ?? `${relationType.replace(/_/g, ' ')} ${targetLabel}`
}

// ─── Main handler ────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' })
  }

  const { seedGraph, config, userId } = req.body as RequestBody

  if (!seedGraph || !config || !userId) {
    return res.status(400).json({ error: 'Missing required fields: seedGraph, config, userId' })
  }

  try {
    // ─── Step 1: Filter eligible nodes ─────────────────────────────────
    const eligibleTypes = new Set(['Person', 'Organization', 'Team'])
    const eligible = seedGraph.nodes
      .filter(n => eligibleTypes.has(n.entityType))
      .sort((a, b) => {
        if (a.isAnchor !== b.isAnchor) return a.isAnchor ? -1 : 1
        return b.centrality - a.centrality
      })
      .slice(0, 30)

    const eligibleIdSet = new Set(eligible.map(n => n.id))
    const nodeMap = new Map(eligible.map(n => [n.id, n]))

    // ─── Step 2: Build inter-agent relationship map ────────────────────
    const relationshipMap: Record<string, string[]> = {}
    for (const edge of seedGraph.edges) {
      if (eligibleIdSet.has(edge.sourceNodeId) && eligibleIdSet.has(edge.targetNodeId)) {
        const targetNode = nodeMap.get(edge.targetNodeId)
        const sourceNode = nodeMap.get(edge.sourceNodeId)
        if (targetNode) {
          if (!relationshipMap[edge.sourceNodeId]) relationshipMap[edge.sourceNodeId] = []
          relationshipMap[edge.sourceNodeId].push(summariseRelation(edge.relationType, targetNode.label))
        }
        if (sourceNode) {
          if (!relationshipMap[edge.targetNodeId]) relationshipMap[edge.targetNodeId] = []
          relationshipMap[edge.targetNodeId].push(summariseRelation(edge.relationType, sourceNode.label))
        }
      }
    }

    // ─── Step 3 & 4: Evidence extraction + persona synthesis ───────────
    const personas: SimulationPersona[] = []

    for (const node of eligible) {
      const influenceTier = computeInfluenceTier(node)

      // Find linked chunks (by sourceId match)
      const linkedChunks = seedGraph.sourceChunks.filter(c => c.sourceId === node.sourceId)
      const chunkContent = linkedChunks.map(c => c.content).join('\n\n').slice(0, 8000)
      const chunkIds = linkedChunks.map(c => c.id)

      // Step 3: Evidence extraction
      let documentedPosition = 'No directly relevant sources found.'
      let stanceCategory: StanceCategory = 'uncertain'
      let groundingQuality: GroundingQuality = 'inferred'
      let sourceCount = 0

      if (chunkContent.length > 0) {
        const evidencePrompt = `You are extracting evidence about a specific entity from source documents.

Entity: ${node.label} (${node.entityType})
Question being investigated: ${config.question}

Source material:
${chunkContent}

Return JSON only — no preamble, no markdown:
{
  "documented_position": "One sentence: what do these sources say this entity has said or done relevant to the question? If nothing relevant, state that explicitly.",
  "stance_category": "pro | anti | conditional | uncertain | orthogonal",
  "topic_proximity": 0.0,
  "source_count": 0,
  "grounding_quality": "strong | moderate | weak | inferred"
}

grounding_quality rules:
- strong: 3+ sources with direct relevance
- moderate: 1–2 directly relevant sources
- weak: sources exist but are tangential
- inferred: no relevant sources — derive from entity type and relationships only`

        try {
          const evidenceText = await callGemini(evidencePrompt, 0.1)
          const parsed = parseJSON<{
            documented_position: string
            stance_category: StanceCategory
            source_count: number
            grounding_quality: GroundingQuality
          }>(evidenceText)

          if (parsed) {
            documentedPosition = parsed.documented_position
            stanceCategory = parsed.stance_category
            groundingQuality = parsed.grounding_quality
            sourceCount = parsed.source_count
          }
        } catch {
          // Gemini call failed — use inferred defaults
        }
      }

      // Step 4: Persona synthesis
      const modeDirective = getModeDirective(config.mode, config.question)
      const sensitivityDirective = getSensitivityDirective(config.surpriseSensitivity)
      const relationships = relationshipMap[node.id] ?? []

      const synthesisPrompt = `You are building a simulation agent profile for a multi-agent deliberation.

Entity: ${node.label} (${node.entityType})
Influence tier: ${influenceTier}
Documented position: ${documentedPosition}
Relationships to other agents: ${relationships.join(', ') || 'None identified'}
Question: ${config.question}
What-if conditions: ${config.whatIfVariables.join('; ') || 'None'}

${modeDirective}
${sensitivityDirective}

Return JSON only — no preamble, no markdown:
{
  "question_specific_stance": "Their specific position on the question. One sentence. Evidence-grounded.",
  "incentive_structure": "What they gain or lose from each possible outcome. One sentence.",
  "epistemic_style": "empirical | ideological | opportunistic | contrarian | cautious | structural",
  "update_conditions": "What specific evidence or argument would cause them to revise their position. One sentence.",
  "blind_spots": "What they are systematically unlikely to see or acknowledge. One sentence.",
  "behavioural_prompt": "3–4 sentence system prompt governing this agent's behaviour in the simulation. Written in second person. Incorporates all of the above."
}`

      let questionSpecificStance = documentedPosition
      let incentiveStructure = 'Unknown incentive structure.'
      let epistemicStyle: EpistemicStyle = 'cautious'
      let updateConditions = 'Would update given significant new evidence.'
      let blindSpots = 'Potential blind spots not identified.'
      let behaviouralPrompt = `You are ${node.label}, a ${node.entityType}. Respond based on your known position and relationships.`

      try {
        const synthesisText = await callGemini(synthesisPrompt, 0.3)
        const parsed = parseJSON<{
          question_specific_stance: string
          incentive_structure: string
          epistemic_style: EpistemicStyle
          update_conditions: string
          blind_spots: string
          behavioural_prompt: string
        }>(synthesisText)

        if (parsed) {
          questionSpecificStance = parsed.question_specific_stance
          incentiveStructure = parsed.incentive_structure
          epistemicStyle = parsed.epistemic_style
          updateConditions = parsed.update_conditions
          blindSpots = parsed.blind_spots
          behaviouralPrompt = parsed.behavioural_prompt
        }
      } catch {
        // Gemini call failed — use minimal defaults
      }

      personas.push({
        agent_id: node.id,
        label: node.label,
        entity_type: node.entityType,
        influence_tier: influenceTier,
        grounding_quality: groundingQuality,
        grounding_chunk_ids: chunkIds,
        source_count: sourceCount,
        documented_position: documentedPosition,
        question_specific_stance: questionSpecificStance,
        stance_category: stanceCategory,
        incentive_structure: incentiveStructure,
        epistemic_style: epistemicStyle,
        update_conditions: updateConditions,
        blind_spots: blindSpots,
        inter_agent_relationships: relationships,
        behavioural_prompt: behaviouralPrompt,
        is_synthetic: false,
        is_excluded: false,
      })
    }

    // ─── Step 5: External agents ─────────────────────────────────────────
    for (const ext of config.externalAgents ?? []) {
      const heuristicStance: StanceCategory = ext.known_position.toLowerCase().includes('against')
        ? 'anti'
        : ext.known_position.toLowerCase().includes('support')
          ? 'pro'
          : 'conditional'

      personas.push({
        agent_id: `ext-${ext.label.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
        label: ext.label,
        entity_type: ext.entity_type,
        influence_tier: 'medium',
        grounding_quality: 'inferred',
        grounding_chunk_ids: [],
        source_count: 0,
        documented_position: ext.known_position,
        question_specific_stance: ext.known_position,
        stance_category: heuristicStance,
        incentive_structure: 'External participant — incentive structure not derived from graph.',
        epistemic_style: 'cautious',
        update_conditions: 'Would update given direct engagement with graph-derived agents.',
        blind_spots: 'May lack context from the knowledge graph.',
        inter_agent_relationships: [],
        behavioural_prompt: `You are ${ext.label}, a ${ext.entity_type}. Your known position is: ${ext.known_position}. Respond consistently with this position while engaging with other agents.`,
        is_synthetic: true,
        is_excluded: false,
      })
    }

    // ─── Step 6: Diversity scoring ───────────────────────────────────────
    // Simplified diversity scoring (full embedding-based scoring deferred)
    const distribution: Record<StanceCategory, number> = {
      pro: 0, anti: 0, conditional: 0, uncertain: 0, orthogonal: 0,
    }
    for (const p of personas) {
      distribution[p.stance_category] = (distribution[p.stance_category] ?? 0) + 1
    }

    const representedCategories = Object.values(distribution).filter(v => v > 0).length

    // Compute source diversity
    const allChunkIds = personas.flatMap(p => p.grounding_chunk_ids)
    const sourceIdCounts: Record<string, number> = {}
    for (const chunkId of allChunkIds) {
      const chunk = seedGraph.sourceChunks.find(c => c.id === chunkId)
      if (chunk) {
        sourceIdCounts[chunk.sourceId] = (sourceIdCounts[chunk.sourceId] ?? 0) + 1
      }
    }
    const totalChunks = allChunkIds.length
    const maxSourcePct = totalChunks > 0
      ? Math.max(...Object.values(sourceIdCounts)) / totalChunks
      : 0

    // Heuristic diversity score (0-1): more stance categories + more source spread = higher
    const diversityScore = Math.min(1, (representedCategories / 5) * 0.6 + (1 - maxSourcePct) * 0.4)

    let warning: PersonaSetDiversity['warning'] = 'none'
    let recommendation: PersonaSetDiversity['recommendation'] = 'proceed'

    if (diversityScore < 0.25 || representedCategories <= 2) {
      warning = 'low_diversity'
      recommendation = 'inject_contrarian'
    } else if (maxSourcePct > 0.7) {
      warning = 'single_source'
      recommendation = 'broaden_scope'
    }

    const diversity: PersonaSetDiversity = {
      score: Math.round(diversityScore * 100) / 100,
      distribution,
      warning,
      recommendation,
    }

    return res.status(200).json({ personas, diversity })
  } catch (err) {
    console.error('[generate-personas] Error:', err)
    const message = err instanceof Error ? err.message : 'Unknown error'
    return res.status(500).json({ error: message })
  }
}
