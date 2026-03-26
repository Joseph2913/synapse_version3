import type { QueryConfig } from './rag'

// ─── Entry Point Enum ────────────────────────────────────────────────────────

export type ChatEntryPoint =
  | 'direct'                     // Nav rail, command palette, or manual navigation
  | 'suggestion_pill'            // Empty state suggestion pill
  // Home Feed (PRD-B)
  | 'home_entity_explore'       // "Explore with AI" from Home entity detail
  | 'home_entity_similar'       // "Find Similar" from Home entity detail
  | 'home_relationship_chat'    // "Chat about this relationship" from Home edge
  | 'home_source_chat'          // "Chat with source" from Home source card
  | 'home_source_anchor'        // "Ask how this relates" from source × anchor
  | 'home_source_compare'       // "Compare sources" from source × related source
  // Explore (PRD-B)
  | 'explore_entity_browse'     // "Explore with AI" from Entity Browser
  | 'explore_entity_graph'      // "Explore with AI" from NodeDetailPanel graph view
  | 'explore_source_connection' // "Ask about connection" from ExploreMetadataPanel
  | 'explore_anchor_connections' // "Learn how this connects" from anchor landscape card
  // Capture (PRD-B)
  | 'capture_post_extraction'   // "Chat with what you captured" after extraction
  // Pipeline (PRD-B)
  | 'pipeline_extraction_detail' // "Ask about this extraction" from Pipeline
  // Orient (PRD-B)
  | 'orient_digest_drilldown'   // "Dig deeper" from digest viewer
  // Anchors (PRD-B)
  | 'anchors_explore'           // "Explore with AI" from anchor detail
  // Legacy aliases (backward compat with existing ragRouter)
  | 'entity_explore'
  | 'entity_find_similar'
  | 'relationship_chat'
  | 'source_chat'
  | 'source_anchor_relate'
  | 'source_compare'
  | 'explore_node_detail'

// ─── Scope Definition ────────────────────────────────────────────────────────

export interface ChatScope {
  sourceIds?: string[]
  entityIds?: string[]
  anchorIds?: string[]
  mode: 'hard' | 'soft'
  /**
   * Use this entity's stored embedding vector for semantic search
   * instead of generating a new embedding from the question text.
   * Used by "Find Similar" to find entities conceptually close
   * to the selected entity.
   */
  useEntityEmbedding?: string
}

// ─── Entry Context ───────────────────────────────────────────────────────────

export interface ChatEntryContext {
  autoQuery: string
  systemDirective: string
  queryConfig: Partial<QueryConfig>
  scope?: ChatScope
  entryPoint: ChatEntryPoint
  displayLabel?: string
  metadata?: Record<string, string>
}

// ─── Entry Context Normalization ────────────────────────────────────────────

/**
 * Normalizes both legacy { autoQuery: string } state and new ChatEntryContext.
 * Ensures backward compatibility with any existing navigate() calls
 * that haven't been upgraded to pass full context yet.
 */
export function normalizeEntryContext(
  state: unknown
): ChatEntryContext | null {
  if (!state || typeof state !== 'object') return null
  const s = state as Record<string, unknown>

  // Full ChatEntryContext passed via { chatContext: ... }
  if (s.chatContext && typeof s.chatContext === 'object') {
    const ctx = s.chatContext as Record<string, unknown>
    if (ctx.entryPoint && typeof ctx.autoQuery === 'string') {
      return ctx as unknown as ChatEntryContext
    }
  }

  // Full ChatEntryContext passed directly
  if (s.entryPoint && typeof s.autoQuery === 'string') {
    return s as unknown as ChatEntryContext
  }

  // Legacy format: { autoQuery: string }
  if (typeof s.autoQuery === 'string' && (s.autoQuery as string).trim()) {
    return {
      autoQuery: s.autoQuery as string,
      systemDirective: '',
      queryConfig: {},
      entryPoint: 'direct',
    }
  }

  return null
}
