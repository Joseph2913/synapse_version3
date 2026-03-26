import { createContext, useState, useCallback, type ReactNode } from 'react'
import type { RightPanelContent } from '../../types/panels'
import type { RAGResponseContext } from '../../types/rag'
import type { KnowledgeNode } from '../../types/database'
import { useRecentNodes } from '../../hooks/useRecentNodes'

export interface GraphContextValue {
  rightPanelContent: RightPanelContent
  setRightPanelContent: (content: RightPanelContent) => void
  clearRightPanel: () => void
  selectedNodeId: string | null
  setSelectedNodeId: (id: string | null) => void
  clearSelection: () => void
  // Ask view state
  askContext: RAGResponseContext | null
  setAskContext: (ctx: RAGResponseContext | null) => void
  // Recent nodes (session-scoped, shared across all views)
  recentNodes: KnowledgeNode[]
  addRecentNode: (node: KnowledgeNode) => void
}

export const GraphContext = createContext<GraphContextValue | null>(null)

export function GraphProvider({ children }: { children: ReactNode }) {
  const [rightPanelContent, setRightPanelContent] = useState<RightPanelContent>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [askContext, setAskContext] = useState<RAGResponseContext | null>(null)
  const { recentNodes, addRecentNode } = useRecentNodes()

  const clearRightPanel = useCallback(() => setRightPanelContent(null), [])

  const clearSelection = useCallback(() => {
    setSelectedNodeId(null)
    setRightPanelContent(null)
  }, [])

  return (
    <GraphContext.Provider value={{
      rightPanelContent,
      setRightPanelContent,
      clearRightPanel,
      selectedNodeId,
      setSelectedNodeId,
      clearSelection,
      askContext,
      setAskContext,
      recentNodes,
      addRecentNode,
    }}>
      {children}
    </GraphContext.Provider>
  )
}
