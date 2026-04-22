import { supabase } from './supabase'
import type {
  SimulationJob, SimulationSeedGraph, SimulationBuilderState,
  SimulationStatus, SimulationReport, SimulationNode,
  SimulationConfig, SourceTypeFilter, SimulationPersona,
  PersonaSetDiversity, GroundingQuality, EpistemicStyle,
  InfluenceTier, StanceCategory,
} from '../types/simulate'

const SIDECAR_URL = import.meta.env.VITE_SIMULATE_SIDECAR_URL ?? 'http://localhost:8000'
const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY ?? ''
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

// ─── SUPABASE QUERIES ───────────────────────────────────────────────

export async function fetchSimulationJobs(): Promise<SimulationJob[]> {
  const { data, error } = await supabase
    .from('simulation_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return (data ?? []).map(mapJobRow)
}

export async function fetchSimulationJob(id: string): Promise<SimulationJob | null> {
  const { data, error } = await supabase
    .from('simulation_jobs')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data ? mapJobRow(data) : null
}

export function buildSimulationConfig(state: SimulationBuilderState): SimulationConfig {
  const timeWindowMap: Record<number, '30d' | '90d' | '6m' | 'all'> = {
    30: '30d', 90: '90d', 180: '6m', 3650: 'all',
  }
  return {
    anchorNodeIds: state.selectedAnchorIds,
    timeWindow: timeWindowMap[state.timeWindowDays] ?? '90d',
    sourceTypeFilter: state.sourceTypeFilter,
    outputHorizon: state.outputHorizon,
    question: state.predictionQuestion,
    whatIfVariables: state.whatIfVariables,
    externalAgents: state.externalAgents,
    mode: state.mode,
    depth: state.depth,
    surpriseSensitivity: state.surpriseSensitivity,
    presetUsed: state.presetUsed,
  }
}

export async function createSimulationJob(
  state: SimulationBuilderState,
  title: string
): Promise<SimulationJob> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const config = buildSimulationConfig(state)

  console.log('[SIMULATE] Inserting job row with user_id:', user.id)
  const { data, error } = await supabase
    .from('simulation_jobs')
    .insert({
      user_id: user.id,
      status: 'pending',
      title,
      scope_anchor_ids: state.selectedAnchorIds,
      scope_time_window_days: state.timeWindowDays,
      prediction_question: state.predictionQuestion,
      what_if_variables: state.whatIfVariables,
      excluded_node_ids: state.excludedNodeIds,
      config,
    })
    .select()
    .single()
  console.log('[SIMULATE] Insert response:', { data, error })
  if (error) throw error
  return mapJobRow(data)
}

export async function updateSimulationJobStatus(
  id: string,
  update: Partial<Pick<SimulationJob,
    'status' | 'progress' | 'progressMessage' | 'result' |
    'errorMessage' | 'completedAt' | 'seedGraph' | 'personas' |
    'scopeNodeCount' | 'scopeEdgeCount' | 'scopeSourceCount'
  >>
): Promise<void> {
  const snakeUpdate: Record<string, unknown> = {}
  if (update.status !== undefined) snakeUpdate.status = update.status
  if (update.progress !== undefined) snakeUpdate.progress = update.progress
  if (update.progressMessage !== undefined) snakeUpdate.progress_message = update.progressMessage
  if (update.result !== undefined) snakeUpdate.result = update.result
  if (update.errorMessage !== undefined) snakeUpdate.error_message = update.errorMessage
  if (update.completedAt !== undefined) snakeUpdate.completed_at = update.completedAt
  if (update.seedGraph !== undefined) snakeUpdate.seed_graph = update.seedGraph
  if (update.personas !== undefined) snakeUpdate.personas = update.personas
  if (update.scopeNodeCount !== undefined) snakeUpdate.scope_node_count = update.scopeNodeCount
  if (update.scopeEdgeCount !== undefined) snakeUpdate.scope_edge_count = update.scopeEdgeCount
  if (update.scopeSourceCount !== undefined) snakeUpdate.scope_source_count = update.scopeSourceCount

  const { error } = await supabase
    .from('simulation_jobs')
    .update(snakeUpdate)
    .eq('id', id)
  if (error) throw error
}

// ─── GRAPH EXPORT ───────────────────────────────────────────────────

export async function buildSeedGraph(
  anchorIds: string[],
  timeWindowDays: number,
  excludedNodeIds: string[],
  sourceTypeFilter?: SourceTypeFilter[] | null
): Promise<SimulationSeedGraph> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - timeWindowDays)
  const cutoffISO = cutoff.toISOString()

  // Fetch nodes created after cutoff, excluding specified IDs
  let nodesQuery = supabase
    .from('knowledge_nodes')
    .select('id, label, entity_type, description, is_anchor, confidence, source_id, tags, created_at')
    .gte('created_at', cutoffISO)
    .order('created_at', { ascending: false })

  if (excludedNodeIds.length > 0) {
    nodesQuery = nodesQuery.not('id', 'in', `(${excludedNodeIds.join(',')})`)
  }

  const { data: allNodes, error: nodesError } = await nodesQuery
  if (nodesError) throw nodesError

  // Fetch edges via RPC to avoid URL length limits from .in() with hundreds of IDs
  const { data: allEdges, error: edgesError } = await supabase
    .rpc('get_scoped_edges', {
      p_user_id: user.id,
      p_cutoff: cutoffISO,
    })
  if (edgesError) throw edgesError

  // Compute centrality (edge count per node)
  const edgeCounts: Record<string, number> = {}
  ;(allEdges ?? []).forEach((e: Record<string, unknown>) => {
    edgeCounts[e.source_node_id as string] = (edgeCounts[e.source_node_id as string] ?? 0) + 1
    edgeCounts[e.target_node_id as string] = (edgeCounts[e.target_node_id as string] ?? 0) + 1
  })

  // Cap to top 150 nodes by centrality to keep payloads manageable
  const nodes = (allNodes ?? [])
    .sort((a, b) => (edgeCounts[b.id as string] ?? 0) - (edgeCounts[a.id as string] ?? 0))
    .slice(0, 150)
  const nodeIdSet = new Set(nodes.map(n => n.id as string))

  // Filter edges to only those connecting retained nodes
  const scopedEdges = (allEdges ?? []).filter(
    (e: Record<string, unknown>) => nodeIdSet.has(e.source_node_id as string) && nodeIdSet.has(e.target_node_id as string)
  )

  // Fetch source chunks via time-based query to avoid URL length limits
  let chunksQuery = supabase
    .from('source_chunks')
    .select('id, source_id, content, chunk_index')
    .eq('user_id', user.id)
    .gte('created_at', cutoffISO)
    .limit(150)

  if (sourceTypeFilter && sourceTypeFilter.length > 0) {
    chunksQuery = chunksQuery.in('source_type', sourceTypeFilter)
  }

  const { data: chunks, error: chunksError } = await chunksQuery
  if (chunksError) throw chunksError

  return {
    nodes: nodes.map(n => ({
      id: n.id as string,
      label: n.label as string,
      entityType: n.entity_type as string,
      description: (n.description as string) ?? '',
      isAnchor: (n.is_anchor as boolean) ?? false,
      confidence: (n.confidence as number) ?? 0.8,
      centrality: edgeCounts[n.id as string] ?? 0,
      sourceId: (n.source_id as string) ?? null,
      tags: (n.tags as string[]) ?? [],
    })),
    edges: scopedEdges.map((e: Record<string, unknown>) => ({
      id: e.id as string,
      sourceNodeId: e.source_node_id as string,
      targetNodeId: e.target_node_id as string,
      relationType: e.relation_type as string,
      evidence: (e.evidence as string) ?? '',
      weight: (e.weight as number) ?? 1.0,
    })),
    sourceChunks: (chunks ?? []).map(c => ({
      id: c.id as string,
      sourceId: c.source_id as string,
      content: c.content as string,
      chunkIndex: c.chunk_index as number,
    })),
    metadata: {
      exportedAt: new Date().toISOString(),
      anchorIds,
      timeWindowDays,
    },
  }
}

// ─── SIDECAR COMMUNICATION ───────────────────────────────────────────

export async function triggerSidecarSimulation(
  jobId: string,
  seedGraph: SimulationSeedGraph,
  predictionQuestion: string,
  whatIfVariables: string[],
  config?: SimulationConfig,
  personas?: SimulationPersona[]
): Promise<void> {
  // Convert camelCase seed graph to snake_case for the Python sidecar
  const snakeSeedGraph = {
    nodes: seedGraph.nodes.map(n => ({
      id: n.id,
      label: n.label,
      entity_type: n.entityType,
      description: n.description,
      is_anchor: n.isAnchor,
      confidence: n.confidence,
      centrality: n.centrality,
      source_id: n.sourceId,
      tags: n.tags,
    })),
    edges: seedGraph.edges.map(e => ({
      id: e.id,
      source_node_id: e.sourceNodeId,
      target_node_id: e.targetNodeId,
      relation_type: e.relationType,
      evidence: e.evidence,
      weight: e.weight,
    })),
    source_chunks: seedGraph.sourceChunks.map(c => ({
      id: c.id,
      source_id: c.sourceId,
      content: c.content,
      chunk_index: c.chunkIndex,
    })),
    metadata: {
      exported_at: seedGraph.metadata.exportedAt,
      anchor_ids: seedGraph.metadata.anchorIds,
      time_window_days: seedGraph.metadata.timeWindowDays,
    },
  }

  const targetUrl = `${SIDECAR_URL}/simulate`
  console.log('[SIMULATE] Sidecar URL:', SIDECAR_URL)
  console.log('[SIMULATE] POSTing to:', targetUrl, '| job_id:', jobId)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000) // 30s timeout

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        job_id: jobId,
        seed_graph: snakeSeedGraph,
        prediction_question: predictionQuestion,
        what_if_variables: whatIfVariables,
        ...(config ? { config } : {}),
        ...(personas ? { personas } : {}),
      }),
    })
    clearTimeout(timeout)

    console.log('[SIMULATE] Sidecar response status:', response.status)
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Sidecar error: ${response.status} — ${text}`)
    }
    console.log('[SIMULATE] Sidecar accepted job')
  } catch (err) {
    clearTimeout(timeout)
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Sidecar timeout: no response from ${targetUrl} after 30 seconds`)
    }
    throw err
  }
}

export async function checkSidecarHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${SIDECAR_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch {
    return false
  }
}

// ─── PRD-Simulate-D: PERSONA GENERATION (client-side) ────────────────

async function callGeminiForPersonas(prompt: string, temperature: number): Promise<string> {
  const url = `${GEMINI_BASE_URL}/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens: 1024 },
    }),
  })
  if (!response.ok) throw new Error(`Gemini API error: ${response.status}`)
  const data = await response.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
}

function parseGeminiJSON<T>(text: string): T | null {
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  try {
    return JSON.parse(cleaned) as T
  } catch {
    return null
  }
}

function getModeDirective(mode: string, question: string): string {
  switch (mode) {
    case 'prediction': return 'Reason probabilistically. Estimate likelihoods. Be willing to update when shown evidence.'
    case 'hypothesis_test': return `The hypothesis is: ${question}. Evaluate it critically. State whether you support or refute it and why.`
    case 'contrarian_scan': return 'Your role is to surface what others overlook. Challenge consensus. Prioritise minority positions and weak signals.'
    case 'optimisation': return 'Evaluate options rather than predict outcomes. Reason from your incentives about which path best serves your interests.'
    case 'consensus_mapping': return 'Find common ground. Identify what you can agree on with others. Resolve rather than amplify contradictions.'
    default: return 'Reason probabilistically. Estimate likelihoods.'
  }
}

function getSensitivityDirective(sensitivity: string): string {
  switch (sensitivity) {
    case 'expansive': return 'Consider second and third-order effects. What would have to be true for an unexpected outcome? What does conventional wisdom get wrong?'
    case 'conservative': return 'Only surface claims you can directly ground in the source material. Flag speculation explicitly.'
    default: return ''
  }
}

function computeInfluenceTier(node: SimulationNode): InfluenceTier {
  if (node.isAnchor) return 'high'
  if (node.centrality >= 8) return 'high'
  if (node.centrality >= 4) return 'medium'
  return 'low'
}

function summariseRelation(relationType: string, targetLabel: string): string {
  const map: Record<string, string> = {
    leads_to: 'Leads to', supports: 'Supports', enables: 'Enables',
    blocks: 'Blocks', contradicts: 'Contradicts', part_of: 'Part of',
    relates_to: 'Relates to', mentions: 'Mentions', connected_to: 'Connected to',
    owns: 'Owns', created: 'Created', challenges: 'Challenges', risks: 'Risks',
  }
  const prefix = map[relationType] ?? relationType.replace(/_/g, ' ')
  return `${prefix} ${targetLabel}`
}

export interface PersonaGenerationProgress {
  current: number
  total: number
  currentLabel: string
  phase: 'filtering' | 'evidence' | 'synthesis' | 'scoring'
}

export async function generatePersonas(
  seedGraph: SimulationSeedGraph,
  config: SimulationConfig,
  _userId: string,
  onProgress?: (progress: PersonaGenerationProgress) => void
): Promise<{ personas: SimulationPersona[]; diversity: PersonaSetDiversity }> {
  if (!GEMINI_API_KEY) throw new Error('VITE_GEMINI_API_KEY is not configured.')

  // Step 1: Filter eligible nodes
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

  // Step 2: Build inter-agent relationship map
  const relationshipMap: Record<string, string[]> = {}
  for (const edge of seedGraph.edges) {
    if (eligibleIdSet.has(edge.sourceNodeId) && eligibleIdSet.has(edge.targetNodeId)) {
      const targetNode = nodeMap.get(edge.targetNodeId)
      const sourceNode = nodeMap.get(edge.sourceNodeId)
      if (targetNode) {
        const srcId = edge.sourceNodeId
        if (!relationshipMap[srcId]) relationshipMap[srcId] = []
        relationshipMap[srcId]!.push(summariseRelation(edge.relationType, targetNode.label))
      }
      if (sourceNode) {
        const tgtId = edge.targetNodeId
        if (!relationshipMap[tgtId]) relationshipMap[tgtId] = []
        relationshipMap[tgtId]!.push(summariseRelation(edge.relationType, sourceNode.label))
      }
    }
  }

  // Steps 3 & 4: Evidence extraction + persona synthesis per agent
  const personas: SimulationPersona[] = []
  const totalAgents = eligible.length

  for (let agentIndex = 0; agentIndex < eligible.length; agentIndex++) {
    const node = eligible[agentIndex]!
    onProgress?.({ current: agentIndex, total: totalAgents, currentLabel: node.label, phase: 'evidence' })
    const influenceTier = computeInfluenceTier(node)
    const linkedChunks = seedGraph.sourceChunks.filter(c => c.sourceId === node.sourceId)
    const chunkContent = linkedChunks.map(c => c.content).join('\n\n').slice(0, 8000)
    const chunkIds = linkedChunks.map(c => c.id)

    let documentedPosition = 'No directly relevant sources found.'
    let stanceCategory: StanceCategory = 'uncertain'
    let groundingQuality: GroundingQuality = 'inferred'
    let sourceCount = 0

    // Step 3: Evidence extraction
    if (chunkContent.length > 0) {
      try {
        const evidenceText = await callGeminiForPersonas(
          `You are extracting evidence about a specific entity from source documents.

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
- inferred: no relevant sources — derive from entity type and relationships only`,
          0.1
        )
        const parsed = parseGeminiJSON<{
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
      } catch (err) {
        console.warn(`[PERSONA] Evidence extraction failed for ${node.label}:`, err)
      }
    }

    // Step 4: Persona synthesis
    onProgress?.({ current: agentIndex, total: totalAgents, currentLabel: node.label, phase: 'synthesis' })
    const modeDirective = getModeDirective(config.mode, config.question)
    const sensitivityDirective = getSensitivityDirective(config.surpriseSensitivity)
    const relationships = relationshipMap[node.id] ?? []

    let questionSpecificStance = documentedPosition
    let incentiveStructure = 'Unknown incentive structure.'
    let epistemicStyle: EpistemicStyle = 'cautious'
    let updateConditions = 'Would update given significant new evidence.'
    let blindSpots = 'Potential blind spots not identified.'
    let behaviouralPrompt = `You are ${node.label}, a ${node.entityType}. Respond based on your known position and relationships.`

    try {
      const synthesisText = await callGeminiForPersonas(
        `You are building a simulation agent profile for a multi-agent deliberation.

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
}`,
        0.3
      )
      const parsed = parseGeminiJSON<{
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
    } catch (err) {
      console.warn(`[PERSONA] Synthesis failed for ${node.label}:`, err)
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

  // Step 5: External agents
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

  // Step 6: Diversity scoring
  onProgress?.({ current: totalAgents, total: totalAgents, currentLabel: 'Scoring diversity…', phase: 'scoring' })
  const distribution: Record<StanceCategory, number> = {
    pro: 0, anti: 0, conditional: 0, uncertain: 0, orthogonal: 0,
  }
  for (const p of personas) {
    distribution[p.stance_category] = (distribution[p.stance_category] ?? 0) + 1
  }

  const representedCategories = Object.values(distribution).filter(v => v > 0).length
  const allChunkIds = personas.flatMap(p => p.grounding_chunk_ids)
  const sourceIdCounts: Record<string, number> = {}
  for (const chunkId of allChunkIds) {
    const chunk = seedGraph.sourceChunks.find(c => c.id === chunkId)
    if (chunk) sourceIdCounts[chunk.sourceId] = (sourceIdCounts[chunk.sourceId] ?? 0) + 1
  }
  const totalChunks = allChunkIds.length
  const maxSourcePct = totalChunks > 0
    ? Math.max(...Object.values(sourceIdCounts)) / totalChunks
    : 0

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

  return {
    personas,
    diversity: {
      score: Math.round(diversityScore * 100) / 100,
      distribution,
      warning,
      recommendation,
    },
  }
}

// ─── PREVIEW: PERSONAS DERIVED FROM GRAPH ────────────────────────────

export function derivePersonasFromGraph(seedGraph: SimulationSeedGraph): SimulationNode[] {
  return seedGraph.nodes
    .filter(n => ['Person', 'Organization', 'Team'].includes(n.entityType))
    .sort((a, b) => {
      if (a.isAnchor !== b.isAnchor) return a.isAnchor ? -1 : 1
      return b.centrality - a.centrality
    })
}

// ─── MAPPER ─────────────────────────────────────────────────────────

function mapReportRow(r: Record<string, unknown>): SimulationReport {
  const forecasts = ((r.forecasts as Record<string, unknown>[]) ?? []).map(f => ({
    direction: f.direction as string,
    rationale: f.rationale as string,
    timeframe: f.timeframe as string,
    confidence: f.confidence as 'low' | 'medium' | 'high',
  }))
  const agentMoves = ((r.agent_moves ?? r.agentMoves) as Record<string, unknown>[] ?? []).map(m => ({
    agentLabel: (m.agent_label ?? m.agentLabel) as string,
    entityType: (m.entity_type ?? m.entityType) as string,
    likelyAction: (m.likely_action ?? m.likelyAction) as string,
    rationale: m.rationale as string,
    influence: m.influence as 'low' | 'medium' | 'high',
  }))
  return {
    headline: r.headline as string,
    summary: r.summary as string,
    forecasts,
    agentMoves,
    surprises: (r.surprises as string[]) ?? [],
    confidenceLevel: (r.confidence_level ?? r.confidenceLevel) as 'low' | 'medium' | 'high',
    confidenceRationale: (r.confidence_rationale ?? r.confidenceRationale) as string,
    simulationRounds: (r.simulation_rounds ?? r.simulationRounds) as number,
    agentCount: (r.agent_count ?? r.agentCount) as number,
    generatedAt: (r.generated_at ?? r.generatedAt) as string,
  }
}

function mapJobRow(row: Record<string, unknown>): SimulationJob {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    status: row.status as SimulationStatus,
    title: row.title as string,
    scopeAnchorIds: (row.scope_anchor_ids as string[]) ?? [],
    scopeTimeWindowDays: row.scope_time_window_days as number,
    scopeNodeCount: row.scope_node_count as number | null,
    scopeEdgeCount: row.scope_edge_count as number | null,
    scopeSourceCount: row.scope_source_count as number | null,
    predictionQuestion: row.prediction_question as string,
    whatIfVariables: (row.what_if_variables as string[]) ?? [],
    excludedNodeIds: (row.excluded_node_ids as string[]) ?? [],
    seedGraph: row.seed_graph as SimulationSeedGraph | null,
    config: (row.config as SimulationConfig) ?? null,
    personas: (row.personas as SimulationPersona[]) ?? null,
    progress: row.progress as number,
    progressMessage: row.progress_message as string | null,
    result: row.result ? mapReportRow(row.result as Record<string, unknown>) : null,
    ingestedSourceId: row.ingested_source_id as string | null,
    errorMessage: row.error_message as string | null,
    createdAt: row.created_at as string,
    completedAt: row.completed_at as string | null,
  }
}
