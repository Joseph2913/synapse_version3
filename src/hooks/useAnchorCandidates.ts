import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAuth } from './useAuth'
import { useSettings } from './useSettings'
import {
  fetchCandidatesWithNodes,
  fetchSuggestedCount,
  fetchAnchorHealthSummary,
  confirmAnchorCandidate,
  dismissAnchorCandidate,
  archiveAnchorCandidate,
  createManualAnchor,
} from '../services/anchorCandidates'
import { supabase } from '../services/supabase'
import type {
  AnchorCandidateWithNode,
  AnchorHealthSummary,
} from '../types/anchors'
import type { EntityType } from '../types/database'

export type AnchorSortKey = 'most_connected' | 'recently_added' | 'alphabetical' | 'dormant_first'
export type AnchorFilterKey = 'all' | 'confirmed' | 'suggested' | 'manual' | 'dormant' | 'archived'

export function useAnchorCandidates() {
  const { user } = useAuth()
  const { refreshAnchors } = useSettings()

  const [suggested, setSuggested] = useState<AnchorCandidateWithNode[]>([])
  const [confirmed, setConfirmed] = useState<AnchorCandidateWithNode[]>([])
  const [archived, setArchived] = useState<AnchorCandidateWithNode[]>([])
  const [health, setHealth] = useState<AnchorHealthSummary | null>(null)
  const [suggestedCount, setSuggestedCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [healthLoading, setHealthLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<AnchorFilterKey>('all')
  const [sortKey, setSortKey] = useState<AnchorSortKey>('most_connected')

  const fetchAll = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setError(null)
    try {
      const [suggestedData, confirmedData, archivedData, count] = await Promise.all([
        fetchCandidatesWithNodes(user.id, ['suggested']),
        fetchCandidatesWithNodes(user.id, ['confirmed', 'dormant']),
        fetchCandidatesWithNodes(user.id, ['archived']),
        fetchSuggestedCount(user.id),
      ])

      // Legacy fallback: if anchor_candidates returned nothing, directly query
      // knowledge_nodes where is_anchor = true and synthesize candidate objects
      // with real edge counts and source data.
      let finalConfirmed = confirmedData
      if (confirmedData.length === 0) {
        const { data: anchorNodes } = await supabase
          .from('knowledge_nodes')
          .select('id, user_id, label, entity_type, description, confidence, is_anchor, parent_anchor_id, source_id, source_type, created_at')
          .eq('user_id', user.id)
          .eq('is_anchor', true)
          .order('created_at', { ascending: false })

        if (anchorNodes && anchorNodes.length > 0) {
          console.log(`[useAnchorCandidates] Legacy fallback: found ${anchorNodes.length} anchor nodes without candidate rows`)
          const nodeIds = anchorNodes.map(n => n.id as string)
          const anchorIdSet = new Set(nodeIds)
          const now = new Date().toISOString()

          // Fetch real edge counts in bulk
          const [outRes, inRes] = await Promise.all([
            supabase.from('knowledge_edges').select('source_node_id, target_node_id').in('source_node_id', nodeIds),
            supabase.from('knowledge_edges').select('source_node_id, target_node_id').in('target_node_id', nodeIds),
          ])
          const edgeCounts: Record<string, number> = {}
          const anchorConnectionCounts: Record<string, number> = {}
          for (const id of nodeIds) { edgeCounts[id] = 0; anchorConnectionCounts[id] = 0 }
          for (const e of outRes.data ?? []) {
            edgeCounts[e.source_node_id] = (edgeCounts[e.source_node_id] ?? 0) + 1
            if (anchorIdSet.has(e.target_node_id)) anchorConnectionCounts[e.source_node_id] = (anchorConnectionCounts[e.source_node_id] ?? 0) + 1
          }
          for (const e of inRes.data ?? []) {
            edgeCounts[e.target_node_id] = (edgeCounts[e.target_node_id] ?? 0) + 1
            if (anchorIdSet.has(e.source_node_id)) anchorConnectionCounts[e.target_node_id] = (anchorConnectionCounts[e.target_node_id] ?? 0) + 1
          }

          // Fetch source counts: count distinct source_id values among connected nodes
          const allNeighbourIds = new Set<string>()
          for (const e of outRes.data ?? []) allNeighbourIds.add(e.target_node_id)
          for (const e of inRes.data ?? []) allNeighbourIds.add(e.source_node_id)
          const neighbourList = Array.from(allNeighbourIds)
          const neighbourSourceMap = new Map<string, { source_id: string | null; source_type: string | null }>()
          if (neighbourList.length > 0) {
            const { data: nbNodes } = await supabase
              .from('knowledge_nodes')
              .select('id, source_id, source_type')
              .in('id', neighbourList)
            for (const nb of nbNodes ?? []) {
              neighbourSourceMap.set(nb.id as string, { source_id: nb.source_id as string | null, source_type: nb.source_type as string | null })
            }
          }

          // Build source counts per anchor
          const sourceCountsMap: Record<string, number> = {}
          const sourceTypesMap: Record<string, number> = {}
          for (const id of nodeIds) {
            const srcIds = new Set<string>()
            const srcTypes = new Set<string>()
            const selfNode = anchorNodes.find(n => n.id === id)
            if (selfNode?.source_id) srcIds.add(selfNode.source_id as string)
            if (selfNode?.source_type) srcTypes.add(selfNode.source_type as string)
            // Add neighbour sources
            for (const e of outRes.data ?? []) {
              if (e.source_node_id === id) {
                const nb = neighbourSourceMap.get(e.target_node_id)
                if (nb?.source_id) srcIds.add(nb.source_id)
                if (nb?.source_type) srcTypes.add(nb.source_type)
              }
            }
            for (const e of inRes.data ?? []) {
              if (e.target_node_id === id) {
                const nb = neighbourSourceMap.get(e.source_node_id)
                if (nb?.source_id) srcIds.add(nb.source_id)
                if (nb?.source_type) srcTypes.add(nb.source_type)
              }
            }
            sourceCountsMap[id] = srcIds.size
            sourceTypesMap[id] = srcTypes.size
          }

          // Compute basic signal scores from real data
          finalConfirmed = anchorNodes.map(n => {
            const nid = n.id as string
            const totalEdges = edgeCounts[nid] ?? 0
            const srcCount = sourceCountsMap[nid] ?? 0
            const srcTypes = sourceTypesMap[nid] ?? 0
            const createdMs = new Date(n.created_at as string).getTime()
            const daysActive = Math.floor((Date.now() - createdMs) / 86400000)

            // Compute signal scores (same algorithm as PRD-18)
            const centralityScore = Math.min(totalEdges / 50, 1.0) * 0.6 + 0 * 0.4
            const diversityScore = (Math.min(srcCount / 8, 1.0) * 0.65) + (Math.min(srcTypes / 3, 1.0) * 0.35)
            const velocityScore = Math.min(daysActive / 30, 1.0) * 0.45 + 0.183 // baseline acceleration
            const richnessScore = 0 // would need relation_type query, skip for fallback
            const compositeScore = Math.min(
              centralityScore * 0.35 + diversityScore * 0.25 + velocityScore * 0.20 + richnessScore * 0.15,
              1.0
            )

            return {
              id:                  `legacy-${nid}`,
              userId:              n.user_id as string,
              nodeId:              nid,
              compositeScore:      Math.round(compositeScore * 10000) / 10000,
              centralityScore:     Math.round(centralityScore * 10000) / 10000,
              diversityScore:      Math.round(diversityScore * 10000) / 10000,
              velocityScore:       Math.round(velocityScore * 10000) / 10000,
              richnessScore:       0,
              behaviouralScore:    0,
              mentionCount:        totalEdges,
              sourceCount:         srcCount,
              uniqueSourceTypes:   srcTypes,
              daysActive,
              recentVelocity:      0,
              velocityDirection:   'stable' as const,
              status:              'confirmed' as const,
              scoringProfile:      'balanced' as const,
              reasoningText:       null,
              firstScoredAt:       n.created_at as string,
              lastScoredAt:        now,
              suggestedAt:         null,
              reviewedAt:          null,
              dormantSince:        null,
              dismissCount:        0,
              resurface_after:     null,
              thresholdAtScoring:  null,
              totalEdges:          totalEdges,
              createdAt:           n.created_at as string,
              updatedAt:           now,
              suggestedParentAnchorId: null,
              node: {
                id:               nid,
                label:            n.label as string,
                entity_type:      n.entity_type as EntityType,
                description:      (n.description ?? null) as string | null,
                confidence:       (n.confidence ?? null) as number | null,
                is_anchor:        true,
                parent_anchor_id: (n.parent_anchor_id as string | null) ?? null,
                created_at:       n.created_at as string,
              },
              connectionCount:     totalEdges,
              anchorConnections:   anchorConnectionCounts[nid] ?? 0,
            } satisfies AnchorCandidateWithNode
          })
        }
      }

      setSuggested(suggestedData)
      setConfirmed(finalConfirmed)
      setArchived(archivedData)
      setSuggestedCount(count)
    } catch (err) {
      setError('Failed to load anchor candidates')
      console.error('[useAnchorCandidates]', err)
    } finally {
      setLoading(false)
    }
  }, [user])

  const fetchHealth = useCallback(async () => {
    if (!user) return
    setHealthLoading(true)
    try {
      const summary = await fetchAnchorHealthSummary(user.id)
      setHealth(summary)
    } finally {
      setHealthLoading(false)
    }
  }, [user])

  useEffect(() => {
    fetchAll()
    fetchHealth()
  }, [fetchAll, fetchHealth])

  const sortedConfirmed = useMemo(() => {
    const arr = [...confirmed]
    switch (sortKey) {
      case 'most_connected': return arr.sort((a, b) => b.connectionCount - a.connectionCount)
      case 'recently_added': return arr.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      case 'alphabetical': return arr.sort((a, b) => (a.node?.label ?? '').localeCompare(b.node?.label ?? ''))
      case 'dormant_first': return arr.sort((a, b) => {
        if (a.status === 'dormant' && b.status !== 'dormant') return -1
        if (b.status === 'dormant' && a.status !== 'dormant') return 1
        return b.connectionCount - a.connectionCount
      })
      default: return arr
    }
  }, [confirmed, sortKey])

  const filteredSuggested = useMemo(() => {
    if (filter === 'confirmed' || filter === 'dormant' || filter === 'manual' || filter === 'archived') return []
    return suggested
  }, [suggested, filter])

  const filteredConfirmed = useMemo(() => {
    switch (filter) {
      case 'suggested': return []
      case 'archived': return []
      case 'dormant': return sortedConfirmed.filter(c => c.status === 'dormant')
      case 'manual': return sortedConfirmed.filter(c => c.compositeScore === 1.0)
      case 'confirmed': return sortedConfirmed.filter(c => c.status === 'confirmed')
      default: return sortedConfirmed
    }
  }, [sortedConfirmed, filter])

  const filteredArchived = useMemo(() => {
    if (filter !== 'all' && filter !== 'archived') return []
    return archived
  }, [archived, filter])

  const totalCount = confirmed.length + suggested.length

  const lastScoredAt = useMemo(() => {
    const all = [...suggested, ...confirmed]
    if (all.length === 0) return null
    return all.reduce((max, c) =>
      c.lastScoredAt > (max ?? '') ? c.lastScoredAt : max, null as string | null
    )
  }, [suggested, confirmed])

  // Actions with optimistic updates
  const confirm = useCallback(async (candidateId: string, nodeId: string) => {
    const candidate = suggested.find(c => c.id === candidateId)
    if (!candidate) return
    setSuggested(prev => prev.filter(c => c.id !== candidateId))
    setSuggestedCount(prev => Math.max(0, prev - 1))
    setConfirmed(prev => [...prev, { ...candidate, status: 'confirmed' }])

    const success = await confirmAnchorCandidate(candidateId, nodeId)
    if (!success) {
      setSuggested(prev => [...prev, candidate])
      setSuggestedCount(prev => prev + 1)
      setConfirmed(prev => prev.filter(c => c.id !== candidateId))
    } else {
      await refreshAnchors()
      fetchHealth()
      window.dispatchEvent(new CustomEvent('synapse:anchor-suggestions-changed'))
      window.dispatchEvent(new CustomEvent('synapse:anchor-confirmed', { detail: { nodeId } }))
    }
  }, [suggested, refreshAnchors, fetchHealth])

  const dismiss = useCallback(async (candidateId: string, dismissCount: number) => {
    const candidate = suggested.find(c => c.id === candidateId)
    if (!candidate || !user) return
    setSuggested(prev => prev.filter(c => c.id !== candidateId))
    setSuggestedCount(prev => Math.max(0, prev - 1))

    const success = await dismissAnchorCandidate(candidateId, dismissCount, 30)
    if (!success) {
      setSuggested(prev => [...prev, candidate])
      setSuggestedCount(prev => prev + 1)
    } else {
      window.dispatchEvent(new CustomEvent('synapse:anchor-suggestions-changed'))
    }
  }, [suggested, user])

  const dismissAll = useCallback(async () => {
    if (!user) return
    const toDismiss = [...suggested]
    setSuggested([])
    setSuggestedCount(0)
    await Promise.all(
      toDismiss.map(c => dismissAnchorCandidate(c.id, c.dismissCount, 30))
    )
    window.dispatchEvent(new CustomEvent('synapse:anchor-suggestions-changed'))
  }, [suggested, user])

  const archive = useCallback(async (candidateId: string, nodeId: string) => {
    const candidate = confirmed.find(c => c.id === candidateId)
    if (!candidate) return
    setConfirmed(prev => prev.filter(c => c.id !== candidateId))

    const success = await archiveAnchorCandidate(candidateId, nodeId)
    if (!success) {
      setConfirmed(prev => [...prev, candidate])
    } else {
      await refreshAnchors()
      fetchHealth()
    }
  }, [confirmed, refreshAnchors, fetchHealth])

  const createManual = useCallback(async (nodeId: string) => {
    if (!user) return
    const success = await createManualAnchor(user.id, nodeId)
    if (success) {
      await Promise.all([fetchAll(), fetchHealth(), refreshAnchors()])
      window.dispatchEvent(new CustomEvent('synapse:anchor-suggestions-changed'))
    }
  }, [user, fetchAll, fetchHealth, refreshAnchors])

  const restore = useCallback(async (candidateId: string, nodeId: string) => {
    // Re-confirm: set status back to confirmed and is_anchor = true
    const { error: nodeErr } = await supabase
      .from('knowledge_nodes')
      .update({ is_anchor: true })
      .eq('id', nodeId)
    if (nodeErr) return

    const { error: candErr } = await supabase
      .from('anchor_candidates')
      .update({ status: 'confirmed', reviewed_at: new Date().toISOString() })
      .eq('id', candidateId)
    if (candErr) {
      // rollback
      await supabase.from('knowledge_nodes').update({ is_anchor: false }).eq('id', nodeId)
      return
    }

    await Promise.all([fetchAll(), fetchHealth(), refreshAnchors()])
    window.dispatchEvent(new CustomEvent('synapse:anchor-confirmed'))
  }, [fetchAll, fetchHealth, refreshAnchors])

  return {
    suggested, confirmed, archived, health, suggestedCount,
    loading, healthLoading, error,
    filter, setFilter, sortKey, setSortKey,
    filteredConfirmed, filteredSuggested, filteredArchived, totalCount, lastScoredAt,
    confirm, dismiss, dismissAll, archive, restore, createManual,
    refetch: fetchAll,
  }
}
