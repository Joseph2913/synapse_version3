import { supabase } from './supabase'
import type {
  SourceMetadata,
} from '../types/extraction'
import { parseParticipants } from '../utils/parseParticipants'
import { persistSource } from './persistSource'
import { normaliseSourceType } from '../config/sourceTypes'
import type { CapturedSource, CaptureSourceType } from '../types/capture'

// --- Custom Error ---

export class PersistenceError extends Error {
  details: unknown
  constructor(message: string, details?: unknown) {
    super(message)
    this.name = 'PersistenceError'
    this.details = details
  }
}

// --- Title Derivation ---

function deriveTitle(content: string): string {
  const trimmed = content.trim()

  // If content starts with a URL, extract domain
  if (trimmed.startsWith('http')) {
    try {
      const url = new URL(trimmed.split(/\s/)[0] ?? trimmed)
      return url.hostname.replace('www.', '')
    } catch {
      // not a valid URL, fall through
    }
  }

  // First line if it's short
  const firstLine = (trimmed.split('\n')[0] ?? '').trim()
  if (firstLine.length <= 100) {
    return firstLine
  }

  // Otherwise first 60 chars
  return firstLine.substring(0, 60) + '...'
}

// --- Save Source ---

const CAPTURE_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'paste', 'url', 'file', 'youtube', 'meeting',
])

/**
 * Stage 2 — saveSource() now routes through persistSource().
 *
 * Callers still pass a SourceMetadata where `sourceType` may be in the legacy
 * mixed-case form. We translate via normaliseSourceType() and only proceed if
 * the result is one of the five Stage 1 capture types — anything else (e.g.
 * 'research', 'github') has its own dedicated server-side write path and
 * should not be coming through this browser helper.
 */
export async function saveSource(
  userId: string,
  content: string,
  metadata: SourceMetadata
): Promise<string> {
  const lowered = normaliseSourceType(metadata.sourceType)
  if (!lowered || !CAPTURE_SOURCE_TYPES.has(lowered)) {
    throw new PersistenceError(
      `saveSource() does not support source_type='${metadata.sourceType}' from the browser`,
      { received: metadata.sourceType, allowed: Array.from(CAPTURE_SOURCE_TYPES) },
    )
  }

  const sourceType = lowered as CaptureSourceType
  const title = metadata.title || deriveTitle(content)

  // Build a CapturedSource-shaped object so persistSource() can apply the
  // right dedup identity rule (canonical URL for url/youtube, content_hash
  // for paste/file, circleback id for meeting).
  const meetingMetadata = sourceType === 'meeting'
    ? { participants: parseParticipants(content) ?? null, ingested_via: 'quick_capture' }
    : { ingested_via: 'quick_capture' }

  const captured: CapturedSource = {
    content,
    title,
    source_type: sourceType,
    source_url: metadata.sourceUrl ?? null,
    metadata: meetingMetadata,
  }

  try {
    const result = await persistSource(captured, userId)
    return result.sourceId
  } catch (err) {
    throw new PersistenceError('Failed to save source', err)
  }
}

// --- Save Chunks ---

/**
 * Bulk-upsert chunks for a source.
 *
 * Stage 3 contract: every chunk must have a non-null embedding. If any
 * embedding is missing the function throws — the caller must update the
 * source state to 'degraded'. Idempotent via ON CONFLICT (source_id, chunk_index).
 */
export async function saveChunks(
  userId: string,
  sourceId: string,
  chunks: string[],
  embeddings: (number[] | null)[]
): Promise<void> {
  if (chunks.length === 0) return

  const missing = embeddings.findIndex(e => !e || e.length === 0)
  if (missing >= 0) {
    throw new PersistenceError(
      `Embedding missing for chunk ${missing} — refusing to save chunks without vectors`,
      { sourceId, chunkIndex: missing },
    )
  }

  const toInsert = chunks.map((content, i) => ({
    user_id: userId,
    source_id: sourceId,
    chunk_index: i,
    content,
    embedding: embeddings[i],
  }))

  const { error } = await supabase
    .from('source_chunks')
    .upsert(toInsert, { onConflict: 'source_id,chunk_index', ignoreDuplicates: true })

  if (error) throw new PersistenceError('Failed to save chunks', error)
}

// --- Save Extraction Session ---

export async function saveExtractionSession(
  userId: string,
  data: {
    sourceName: string
    sourceType: string
    contentPreview: string
    extractionMode: string
    anchorEmphasis: string
    userGuidance?: string
    selectedAnchorIds?: string[]
    extractedNodeIds: string[]
    extractedEdgeIds: string[]
    entityCount: number
    relationshipCount: number
    chunkCount: number
    crossConnectionCount: number
    durationMs: number
    promptVersion?: string
    model?: string
    embeddingModel?: string
  }
): Promise<string | null> {
  try {
    const row: Record<string, unknown> = {
      user_id: userId,
      source_name: data.sourceName,
      source_type: data.sourceType,
      source_content_preview: data.contentPreview.substring(0, 500),
      extraction_mode: data.extractionMode,
      anchor_emphasis: data.anchorEmphasis,
      entity_count: data.entityCount,
      relationship_count: data.relationshipCount,
      chunk_count: data.chunkCount,
      cross_connection_count: data.crossConnectionCount,
      extraction_duration_ms: data.durationMs,
      prompt_version: data.promptVersion ?? 'unknown',
      model: data.model ?? 'unknown',
      embedding_model: data.embeddingModel ?? 'unknown',
    }

    if (data.userGuidance) row.user_guidance = data.userGuidance
    if (data.selectedAnchorIds && data.selectedAnchorIds.length > 0) {
      row.selected_anchor_ids = data.selectedAnchorIds
    }
    if (data.extractedNodeIds.length > 0) row.extracted_node_ids = data.extractedNodeIds
    if (data.extractedEdgeIds.length > 0) row.extracted_edge_ids = data.extractedEdgeIds

    const { data: session, error } = await supabase
      .from('extraction_sessions')
      .insert(row)
      .select('id')
      .single()

    if (error) {
      console.warn('[extractionPersistence] Failed to save extraction session:', error.message)
      return null
    }
    return session.id
  } catch (err) {
    console.warn('[extractionPersistence] Failed to save extraction session:', err)
    return null
  }
}
