// MCP JSON-RPC types
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
  id?: string | number | null
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

// Config types
export interface SynapseConfig {
  apiUrl: string
  apiKey: string
  apiKeyPrefix: string
  outputFormat: 'json' | 'table' | 'text'
  defaultSourceLimit: number
  defaultConnectionHops: number
}

// Entity types
export interface Entity {
  id: string
  label: string
  description: string | null
  entity_type: string
  connection_count: number
  source_ids?: string[]
}

// Source types
export interface Source {
  id: string
  title: string
  source_type: string
  source_url: string | null
  created_at: string
  indexing_status: 'complete' | 'partial' | 'pending'
}

// Search result types
export interface SearchResult {
  id: string
  label: string
  type: string
  description?: string
  relevance?: number
}

// Connection types
export interface Connection {
  label: string
  entity_type: string
  relation_type: string
  level: number
}

// RAG response types
export interface RagResponse {
  answer: string
  sources: Array<{ title: string; source_type: string; relevance: number }>
  entities_mentioned: string[]
}

// CLI response format
export interface CliResponse<T> {
  status: 'ok' | 'error'
  data?: T
  error?: string
  message?: string
}
