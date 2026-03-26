import type { KnowledgeNode, KnowledgeSource } from './database'
import type { RAGResponseContext } from './rag'

export type RightPanelContent =
  | { type: 'node'; data: KnowledgeNode }
  | { type: 'source'; data: KnowledgeSource }
  | { type: 'feed'; data: FeedItem }
  | { type: 'ask_context'; data: RAGResponseContext }
  | { type: 'mcp-access'; data: null }
  | null

export interface FeedItem {
  id: string
  source: string
  sourceType: string
  time: string
  nodeCount: number
  edgeCount: number
  summary: string
  entities: Array<{ label: string; type: string }>
  crossConnections: Array<{ from: string; to: string; relation: string }>
}
