import { supabase } from './supabase'
import type {
  ReviewEntity,
  SavedNode,
  SourceMetadata,
  ExtractedRelationship,
} from '../types/extraction'
import { parseParticipants } from '../utils/parseParticipants'

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

export async function saveSource(
  userId: string,
  content: string,
  metadata: SourceMetadata
): Promise<string> {
  const row: Record<string, unknown> = {
    user_id: userId,
    title: metadata.title || deriveTitle(content),
    content,
    source_type: metadata.sourceType,
    source_url: metadata.sourceUrl || null,
    metadata: {
      ingested_via: 'quick_capture',
    },
  }

  // Parse participants for meeting sources
  if (metadata.sourceType === 'Meeting') {
    const participants = parseParticipants(content)
    if (participants) {
      row.participants = participants
    }
  }

  const { data, error } = await supabase
    .from('knowledge_sources')
    .insert(row)
    .select('id')
    .single()

  if (error) throw new PersistenceError('Failed to save source', error)
  return data.id
}

// --- Save Nodes ---

export interface SaveNodesResult {
  newNodes:     SavedNode[]         // nodes actually inserted
  reusedNodes:  SavedNode[]         // existing nodes reused (from exactMatches)
  allNodes:     SavedNode[]         // newNodes + reusedNodes combined — use this for edge creation
}

export async function saveNodes(
  userId: string,
  entities: ReviewEntity[],
  sourceId: string,
  sourceMetadata: { sourceName: string; sourceType: string; sourceUrl?: string },
  exactMatches: Map<string, string>  // label.toLowerCase() → existing node ID
): Promise<SaveNodesResult> {
  const included = entities.filter(e => !e.removed)

  // Separate: entities to insert vs entities to reuse
  const toInsert = included.filter(
    e => !exactMatches.has(e.label.toLowerCase())
  )
  const toReuse = included.filter(
    e => exactMatches.has(e.label.toLowerCase())
  )

  // Insert new nodes
  let newNodes: SavedNode[] = []
  if (toInsert.length > 0) {
    const rows = toInsert.map(e => {
      const row: Record<string, unknown> = {
        user_id: userId,
        label: e.label,
        entity_type: e.entity_type,
        source: sourceMetadata.sourceName,
        source_type: sourceMetadata.sourceType,
        source_id: sourceId,
        confidence: e.confidence,
      }
      if (e.description)                row.description = e.description
      if (sourceMetadata.sourceUrl)     row.source_url  = sourceMetadata.sourceUrl
      if (e.tags && e.tags.length > 0)  row.tags        = e.tags
      return row
    })

    const { data, error } = await supabase
      .from('knowledge_nodes')
      .insert(rows)
      .select('id, label, entity_type')

    if (error) throw new PersistenceError('Failed to save nodes', error)
    newNodes = (data ?? []) as SavedNode[]
  }

  // Build reused nodes array from existing IDs
  const reusedNodes: SavedNode[] = toReuse.map(e => ({
    id:          exactMatches.get(e.label.toLowerCase())!,
    label:       e.label,
    entity_type: e.entity_type,
  }))

  return {
    newNodes,
    reusedNodes,
    allNodes: [...newNodes, ...reusedNodes],
  }
}

// --- Save Edges ---

export async function saveEdges(
  userId: string,
  relationships: ExtractedRelationship[],
  savedNodes: SavedNode[],
  removedLabels: Set<string>
): Promise<string[]> {
  const labelToId = new Map(savedNodes.map(n => [n.label.toLowerCase(), n.id]))

  const toInsert = relationships
    .filter(r => {
      const sourceId = labelToId.get(r.source.toLowerCase())
      const targetId = labelToId.get(r.target.toLowerCase())
      return (
        sourceId &&
        targetId &&
        sourceId !== targetId &&
        !removedLabels.has(r.source.toLowerCase()) &&
        !removedLabels.has(r.target.toLowerCase())
      )
    })
    .map(r => ({
      user_id: userId,
      source_node_id: labelToId.get(r.source.toLowerCase())!,
      target_node_id: labelToId.get(r.target.toLowerCase())!,
      relation_type: r.relation_type,
      evidence: r.evidence || null,
      weight: 1.0,
    }))

  if (!toInsert.length) return []

  const { data, error } = await supabase
    .from('knowledge_edges')
    .insert(toInsert)
    .select('id')

  if (error) throw new PersistenceError('Failed to save edges', error)
  return (data ?? []).map(d => d.id)
}

// --- Update Node Embeddings ---

export async function updateNodeEmbeddings(
  nodes: Array<{ id: string; embedding: number[] }>
): Promise<void> {
  const batchSize = 10
  for (let i = 0; i < nodes.length; i += batchSize) {
    await Promise.all(
      nodes.slice(i, i + batchSize).map(n =>
        supabase
          .from('knowledge_nodes')
          .update({ embedding: n.embedding })
          .eq('id', n.id)
      )
    )
  }
}

// --- Save Chunks ---

export async function saveChunks(
  userId: string,
  sourceId: string,
  chunks: string[],
  embeddings: (number[] | null)[]
): Promise<void> {
  const toInsert = chunks.map((content, i) => {
    const row: Record<string, unknown> = {
      user_id: userId,
      source_id: sourceId,
      chunk_index: i,
      content,
    }
    if (embeddings[i]) {
      row.embedding = embeddings[i]
    }
    return row
  })

  const { error, data } = await supabase.from('source_chunks').insert(toInsert).select('id')

  if (error) throw new PersistenceError('Failed to save chunks', error)
  if (!data || data.length === 0) {
    console.error('[saveChunks] Insert returned 0 rows — possible table name mismatch or RLS rejection')
  }
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
