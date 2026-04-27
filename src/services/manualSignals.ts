import { supabase } from './supabase'
import { saveChunks } from './extractionPersistence'
import { chunkSourceContent, buildEmbeddingInput } from '../utils/chunking'
import { generateEmbeddings } from './gemini'
import { runHeadlessExtraction } from './extractionPipeline'

interface CreateManualAnchorInput {
  userId: string
  title: string
  description: string
  settings: string
}

interface CreateManualAnchorResult {
  candidateId: string
  nodeId: string
  sourceId: string
}

interface CreateSkillSourceInput {
  userId: string
  accessToken: string
  title?: string
  content: string
  sourceType: 'Note' | 'Document' | 'Meeting' | 'YouTube'
  sourceUrl?: string
  inputType: 'text' | 'url' | 'document' | 'transcript' | 'youtube'
}

export interface ProcessSkillSourceResult {
  sourceId: string
  action: string
  skillName: string | null
  skillId: string | null
}

export async function createManualAnchorFromScratch({
  userId,
  title,
  description,
  settings,
}: CreateManualAnchorInput): Promise<CreateManualAnchorResult> {
  const trimmedTitle = title.trim()
  const trimmedDescription = description.trim()
  const trimmedSettings = settings.trim()
  const now = new Date().toISOString()

  if (!trimmedTitle) throw new Error('Anchor name is required.')
  if (!trimmedDescription) throw new Error('Anchor description is required.')

  const noteContent = [
    `# Anchor: ${trimmedTitle}`,
    '',
    '## Description',
    trimmedDescription,
    '',
    '## Settings',
    trimmedSettings || 'No additional settings provided.',
  ].join('\n')

  const { data: sourceRow, error: sourceError } = await supabase
    .from('knowledge_sources')
    .insert({
      user_id: userId,
      title: `${trimmedTitle} anchor brief`,
      content: noteContent,
      source_type: 'Note',
      metadata: {
        ingested_via: 'signals_manual_anchor',
        manual_anchor: true,
      },
    })
    .select('id')
    .single()

  if (sourceError || !sourceRow) {
    throw new Error(sourceError?.message ?? 'Failed to save anchor notes.')
  }

  const chunks = chunkSourceContent(noteContent)
  if (chunks.length > 0) {
    const sourceTitle = `${trimmedTitle} anchor brief`
    const inputs = chunks.map(c => buildEmbeddingInput(sourceTitle, c))
    try {
      const embeddings = await generateEmbeddings(inputs, 5)
      await saveChunks(userId, sourceRow.id, chunks, embeddings)
    } catch (err) {
      await supabase
        .from('knowledge_sources')
        .update({ status: 'degraded' })
        .eq('id', sourceRow.id)
        .eq('user_id', userId)
      throw err
    }
  }

  const { data: nodeRow, error: nodeError } = await supabase
    .from('knowledge_nodes')
    .insert({
      user_id: userId,
      label: trimmedTitle,
      entity_type: 'Anchor',
      description: trimmedDescription,
      quote: trimmedSettings || null,
      source: `${trimmedTitle} anchor brief`,
      source_type: 'Note',
      source_id: sourceRow.id,
      confidence: 1,
      is_anchor: true,
    })
    .select('id')
    .single()

  if (nodeError || !nodeRow) {
    throw new Error(nodeError?.message ?? 'Failed to create anchor node.')
  }

  const { data: candidateRow, error: candidateError } = await supabase
    .from('anchor_candidates')
    .insert({
      user_id: userId,
      node_id: nodeRow.id,
      composite_score: 1.0,
      centrality_score: 0,
      diversity_score: 0,
      velocity_score: 0,
      richness_score: 0,
      behavioural_score: 0,
      mention_count: 0,
      source_count: 0,
      unique_source_types: 0,
      days_active: 0,
      recent_velocity: 0,
      velocity_direction: 'stable',
      status: 'confirmed',
      scoring_profile: 'balanced',
      reasoning_text: 'Manually created from the Signals overview.',
      suggested_at: now,
      reviewed_at: now,
      first_scored_at: now,
      last_scored_at: now,
    })
    .select('id')
    .single()

  if (candidateError || !candidateRow) {
    throw new Error(candidateError?.message ?? 'Failed to confirm manual anchor.')
  }

  return {
    candidateId: candidateRow.id,
    nodeId: nodeRow.id,
    sourceId: sourceRow.id,
  }
}

export async function createAndProcessSkillSource({
  userId,
  accessToken,
  title,
  content,
  sourceType,
  sourceUrl,
  inputType,
  onProgress,
}: CreateSkillSourceInput & {
  onProgress?: (step: string, message: string) => void
}): Promise<ProcessSkillSourceResult> {
  const trimmedContent = content.trim()
  const trimmedTitle = title?.trim()

  if (!trimmedContent) throw new Error('Skill source content is required.')

  // Step 1: Create the source row
  const { data: sourceRow, error: sourceError } = await supabase
    .from('knowledge_sources')
    .insert({
      user_id: userId,
      title: trimmedTitle || `Manual skill source (${inputType})`,
      content: trimmedContent,
      source_type: sourceType,
      source_url: sourceUrl ?? null,
      metadata: {
        ingested_via: 'signals_skill_manual',
        manual_skill_input: inputType,
        skill_candidate: true,
      },
    })
    .select('id')
    .single()

  if (sourceError || !sourceRow) {
    throw new Error(sourceError?.message ?? 'Failed to save skill source.')
  }

  const sourceId = sourceRow.id

  // Step 2: Run full extraction pipeline FIRST so nodes, edges, chunks,
  // embeddings, cross-connections, and anchor scoring are all saved.
  // The backfill endpoint needs chunks in source_chunks to pass its
  // pre-filter, so it must run AFTER extraction completes.

  await runHeadlessExtraction({
    userId,
    accessToken,
    content: trimmedContent,
    existingSourceId: sourceId,
    metadata: {
      title: trimmedTitle || `Manual skill source (${inputType})`,
      sourceType,
      sourceUrl,
    },
    onProgress,
  })

  // Step 3: Now that chunks exist, run skill backfill
  const backfillResult = await callSkillBackfill(accessToken, sourceId)

  // Look up the created skill ID if one was created
  const skillName = backfillResult.skillName
  let skillId: string | null = null

  if (skillName) {
    const { data: skillRow } = await supabase
      .from('knowledge_skills')
      .select('id')
      .eq('name', skillName)
      .maybeSingle()
    skillId = skillRow?.id ?? null
  }

  return {
    sourceId,
    action: backfillResult.action,
    skillName,
    skillId,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function callSkillBackfill(
  accessToken: string,
  sourceId: string,
): Promise<{ action: string; skillName: string | null }> {
  const response = await fetch('/api/skills/backfill', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ batchSize: 1, sourceId }),
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Skill extraction failed.' })) as { error?: string }
    throw new Error(body.error ?? 'Skill extraction failed.')
  }

  const payload = await response.json() as {
    batch?: {
      details?: Array<{
        sourceId: string
        action: string
        skillName: string | null
      }>
    }
  }

  const detail = payload.batch?.details?.find(item => item.sourceId === sourceId)
    ?? payload.batch?.details?.[0]

  return {
    action: detail?.action ?? 'deferred',
    skillName: detail?.skillName ?? null,
  }
}
