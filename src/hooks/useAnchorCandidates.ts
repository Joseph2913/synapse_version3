import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAuth } from './useAuth'
import { useSettings } from './useSettings'
import {
  fetchAllCandidatesViaRpc,
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
    setHealthLoading(true)
    setError(null)
    try {
      // Single RPC call replaces 15-25 separate queries.
      // See: supabase/migrations/20260331_get_anchor_candidates.sql
      const rpcResult = await fetchAllCandidatesViaRpc(user.id)

      let finalConfirmed = rpcResult.confirmed

      // Legacy fallback: if no candidate rows exist but anchor nodes do,
      // synthesize candidate objects from knowledge_nodes directly.
      if (finalConfirmed.length === 0 && rpcResult.suggested.length === 0) {
        const { data: anchorNodes } = await supabase
          .from('knowledge_nodes')
          .select('id, user_id, label, entity_type, description, confidence, is_anchor, parent_anchor_id, created_at')
          .eq('user_id', user.id)
          .eq('is_anchor', true)
          .order('created_at', { ascending: false })

        if (anchorNodes && anchorNodes.length > 0) {
          console.log(`[useAnchorCandidates] Legacy fallback: found ${anchorNodes.length} anchor nodes without candidate rows`)
          const now = new Date().toISOString()
          finalConfirmed = anchorNodes.map(n => {
            const nid = n.id as string
            return {
              id: `legacy-${nid}`, userId: n.user_id as string, nodeId: nid,
              compositeScore: 0, centralityScore: 0, diversityScore: 0,
              velocityScore: 0, richnessScore: 0, behaviouralScore: 0,
              mentionCount: 0, sourceCount: 0, uniqueSourceTypes: 0,
              daysActive: 0, recentVelocity: 0, velocityDirection: 'stable' as const,
              status: 'confirmed' as const, scoringProfile: 'balanced' as const,
              reasoningText: null, firstScoredAt: n.created_at as string,
              lastScoredAt: now, suggestedAt: null, reviewedAt: null,
              dormantSince: null, dismissCount: 0, resurface_after: null,
              thresholdAtScoring: null, totalEdges: 0,
              createdAt: n.created_at as string, updatedAt: now,
              suggestedParentAnchorId: null,
              node: {
                id: nid, label: n.label as string,
                entity_type: n.entity_type as EntityType,
                description: (n.description ?? null) as string | null,
                quote: null, user_tags: null,
                confidence: (n.confidence ?? null) as number | null,
                is_anchor: true,
                parent_anchor_id: (n.parent_anchor_id as string | null) ?? null,
                created_at: n.created_at as string,
              },
              connectionCount: 0, anchorConnections: 0,
            } satisfies AnchorCandidateWithNode
          })
        }
      }

      setSuggested(rpcResult.suggested)
      setConfirmed(finalConfirmed)
      setArchived(rpcResult.archived)
      setSuggestedCount(rpcResult.suggestedCount)

      // Compute health summary from the data we already have (no extra queries)
      const allConfirmed = finalConfirmed
      const dormant = allConfirmed.filter(c => c.status === 'dormant')
      const active = allConfirmed.filter(c => c.status === 'confirmed')
      const totalNodes = allConfirmed.reduce((sum, c) => sum + c.connectionCount, 0)
      const avgNodes = allConfirmed.length > 0 ? Math.round((totalNodes / allConfirmed.length) * 10) / 10 : 0
      const sorted = [...allConfirmed].sort((a, b) => b.connectionCount - a.connectionCount)
      const topAnchor = sorted[0]
      const stale: AnchorHealthSummary['staleAnchors'] = []
      for (const c of allConfirmed) {
        if (!c.node) continue
        if (c.anchorConnections === 0 && c.connectionCount > 0) {
          stale.push({ candidateId: c.id, nodeId: c.node.id, label: c.node.label, issue: 'isolated', detail: 'Not connected to any other anchors' })
        } else if (c.connectionCount < 3) {
          stale.push({ candidateId: c.id, nodeId: c.node.id, label: c.node.label, issue: 'low_nodes', detail: `Only ${c.connectionCount} node${c.connectionCount === 1 ? '' : 's'} connected` })
        } else if (c.status === 'dormant') {
          const dormantDays = c.dormantSince ? Math.floor((Date.now() - new Date(c.dormantSince).getTime()) / 86400000) : 0
          stale.push({ candidateId: c.id, nodeId: c.node.id, label: c.node.label, issue: 'dormant', detail: `No new content in ${dormantDays} days` })
        } else if (c.sourceCount === 1) {
          stale.push({ candidateId: c.id, nodeId: c.node.id, label: c.node.label, issue: 'single_source', detail: 'Only referenced in one source' })
        }
      }
      setHealth({
        totalConfirmed: active.length,
        totalSuggested: rpcResult.suggested.length,
        totalDormant: dormant.length,
        avgNodesPerAnchor: avgNodes,
        mostConnectedAnchor: topAnchor?.node ? { label: topAnchor.node.label, nodeCount: topAnchor.connectionCount } : null,
        isolatedAnchors: allConfirmed.filter(c => c.anchorConnections === 0).length,
        staleAnchors: stale.slice(0, 8),
      })
    } catch (err) {
      setError('Failed to load anchor candidates')
      console.error('[useAnchorCandidates]', err)
    } finally {
      setLoading(false)
      setHealthLoading(false)
    }
  }, [user])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

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
      fetchAll()
      window.dispatchEvent(new CustomEvent('synapse:anchor-suggestions-changed'))
      window.dispatchEvent(new CustomEvent('synapse:anchor-confirmed', { detail: { nodeId } }))
    }
  }, [suggested, refreshAnchors, fetchAll])

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
      fetchAll()
    }
  }, [confirmed, refreshAnchors, fetchAll])

  const createManual = useCallback(async (nodeId: string) => {
    if (!user) return
    const success = await createManualAnchor(user.id, nodeId)
    if (success) {
      await Promise.all([fetchAll(), refreshAnchors()])
      window.dispatchEvent(new CustomEvent('synapse:anchor-suggestions-changed'))
    }
  }, [user, fetchAll, refreshAnchors])

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

    await Promise.all([fetchAll(), fetchAll(), refreshAnchors()])
    window.dispatchEvent(new CustomEvent('synapse:anchor-confirmed'))
  }, [fetchAll, refreshAnchors])

  return {
    suggested, confirmed, archived, health, suggestedCount,
    loading, healthLoading, error,
    filter, setFilter, sortKey, setSortKey,
    filteredConfirmed, filteredSuggested, filteredArchived, totalCount, lastScoredAt,
    confirm, dismiss, dismissAll, archive, restore, createManual,
    refetch: fetchAll,
  }
}
