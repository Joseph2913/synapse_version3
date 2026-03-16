import type { QueryConfig } from './rag'

// ─── Entry Point Enum ────────────────────────────────────────────────────────

export type ChatEntryPoint =
  | 'direct'                  // Nav rail, command palette, or manual navigation
  | 'entity_explore'          // "Explore with AI" from entity detail
  | 'entity_find_similar'     // "Find Similar" from entity detail
  | 'relationship_chat'       // "Chat about this relationship" from edge detail
  | 'source_chat'             // "Chat with source" from source card
  | 'source_anchor_relate'    // "Ask how this relates" from source × anchor
  | 'source_compare'          // "Compare sources" from source × related source
  | 'suggestion_pill'         // Empty state suggestion pill
  | 'explore_entity_browse'   // "Explore with AI" from Entity Browser
  | 'explore_node_detail'     // "Explore with AI" from NodeDetailPanel
  | 'explore_source_connection' // "Ask about connection" from ExploreMetadataPanel

// ─── Scope Definition ────────────────────────────────────────────────────────

export interface ChatScope {
  sourceIds?: string[]
  entityIds?: string[]
  anchorIds?: string[]
  mode: 'hard' | 'soft'
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
