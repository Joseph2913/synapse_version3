import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../services/supabase'
import { useAuth } from './useAuth'
import type {
  KnowledgeSkillListItem,
  KnowledgeSkillDetail,
  KnowledgeSkillSource,
  KnowledgeSkillStatus,
} from '../types/skills'

// ─── Lightweight columns (excludes content + embedding) ──────────────────────

const LIST_COLUMNS = [
  'id', 'name', 'title', 'description', 'domain', 'tags', 'confidence',
  'source_count', 'status', 'usage_count', 'last_used_at', 'created_at', 'updated_at',
].join(',')

// ─── Hook ────────────────────────────────────────────────────────────────────

export interface UseKnowledgeSkillsReturn {
  skills: KnowledgeSkillListItem[]
  loading: boolean
  error: string | null
  counts: {
    total: number
    draft: number
    active: number
    archived: number
    byDomain: Record<string, number>
  }
  selectedSkill: KnowledgeSkillDetail | null
  selectedSkillLoading: boolean
  selectedSkillSources: KnowledgeSkillSource[]
  selectSkill: (id: string | null) => Promise<void>
  activateSkill: (id: string) => Promise<void>
  archiveSkill: (id: string) => Promise<void>
  updateSkillContent: (id: string, content: string) => Promise<void>
  updateSkillStatus: (id: string, status: KnowledgeSkillStatus) => Promise<void>
  refresh: () => Promise<void>
}

export function useKnowledgeSkills(): UseKnowledgeSkillsReturn {
  const { user } = useAuth()
  const [skills, setSkills] = useState<KnowledgeSkillListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedSkill, setSelectedSkill] = useState<KnowledgeSkillDetail | null>(null)
  const [selectedSkillLoading, setSelectedSkillLoading] = useState(false)
  const [selectedSkillSources, setSelectedSkillSources] = useState<KnowledgeSkillSource[]>([])

  // ── Fetch all skills (list query) ──────────────────────────────────────────

  const fetchSkills = useCallback(async () => {
    if (!user?.id) return
    setLoading(true)
    setError(null)

    const { data, error: err } = await supabase
      .from('knowledge_skills')
      .select(LIST_COLUMNS)
      .order('updated_at', { ascending: false })

    if (err) {
      console.error('[useKnowledgeSkills] list error:', err.message)
      setError(err.message)
      setLoading(false)
      return
    }

    setSkills((data ?? []) as unknown as KnowledgeSkillListItem[])
    setLoading(false)
    window.dispatchEvent(new CustomEvent('synapse:skill-drafts-changed'))
  }, [user?.id])

  useEffect(() => {
    fetchSkills()
  }, [fetchSkills])

  // ── Computed counts ────────────────────────────────────────────────────────

  const counts = useMemo(() => {
    const draft = skills.filter(s => s.status === 'draft').length
    const active = skills.filter(s => s.status === 'active').length
    const archived = skills.filter(s => s.status === 'archived').length
    const byDomain: Record<string, number> = {}
    for (const s of skills) {
      const d = s.domain ?? 'general'
      byDomain[d] = (byDomain[d] ?? 0) + 1
    }
    return { total: skills.length, draft, active, archived, byDomain }
  }, [skills])

  // ── Select skill (detail query) ───────────────────────────────────────────

  const selectSkill = useCallback(async (id: string | null) => {
    if (!id) {
      setSelectedSkill(null)
      setSelectedSkillSources([])
      return
    }

    setSelectedSkillLoading(true)

    const { data, error: err } = await supabase
      .from('knowledge_skills')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (err || !data) {
      console.error('[useKnowledgeSkills] detail error:', err?.message)
      setSelectedSkillLoading(false)
      return
    }

    const detail: KnowledgeSkillDetail = {
      id: data.id,
      name: data.name,
      title: data.title,
      description: data.description,
      domain: data.domain,
      tags: data.tags ?? [],
      confidence: data.confidence ?? 0,
      source_count: data.source_count ?? 0,
      status: data.status,
      usage_count: data.usage_count ?? 0,
      last_used_at: data.last_used_at ?? null,
      created_at: data.created_at,
      updated_at: data.updated_at,
      content: data.content ?? '',
      source_ids: data.source_ids ?? [],
      instructional_ratio: data.instructional_ratio,
      generalizability: data.generalizability,
      structural_density: data.structural_density,
      anchor_relevance: data.anchor_relevance ?? null,
    }

    setSelectedSkill(detail)

    // Fetch contributing sources
    if (detail.source_ids.length > 0) {
      const { data: sources } = await supabase
        .from('knowledge_sources')
        .select('id, title, source_type, created_at')
        .in('id', detail.source_ids)
        .order('created_at', { ascending: false })

      setSelectedSkillSources((sources ?? []) as KnowledgeSkillSource[])
    } else {
      setSelectedSkillSources([])
    }

    setSelectedSkillLoading(false)
  }, [])

  // ── Status updates (optimistic) ───────────────────────────────────────────

  const updateStatusOptimistic = useCallback(async (id: string, status: KnowledgeSkillStatus) => {
    // Optimistic: update local state
    const prevSkills = [...skills]
    const prevSelected = selectedSkill ? { ...selectedSkill } : null

    setSkills(prev => prev.map(s => s.id === id ? { ...s, status, updated_at: new Date().toISOString() } : s))
    if (selectedSkill?.id === id) {
      setSelectedSkill(prev => prev ? { ...prev, status, updated_at: new Date().toISOString() } : prev)
    }

    const { error: err } = await supabase
      .from('knowledge_skills')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (err) {
      console.error('[useKnowledgeSkills] status update error:', err.message)
      // Revert
      setSkills(prevSkills)
      if (prevSelected) setSelectedSkill(prevSelected)
      return
    }

    window.dispatchEvent(new CustomEvent('synapse:skill-drafts-changed'))
  }, [skills, selectedSkill])

  const activateSkill = useCallback((id: string) => updateStatusOptimistic(id, 'active'), [updateStatusOptimistic])
  const archiveSkill = useCallback((id: string) => updateStatusOptimistic(id, 'archived'), [updateStatusOptimistic])
  const updateSkillStatus = useCallback((id: string, status: KnowledgeSkillStatus) => updateStatusOptimistic(id, status), [updateStatusOptimistic])

  // ── Content editing ───────────────────────────────────────────────────────

  const updateSkillContent = useCallback(async (id: string, content: string) => {
    const { error: err } = await supabase
      .from('knowledge_skills')
      .update({ content, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (err) {
      console.error('[useKnowledgeSkills] content update error:', err.message)
      return
    }

    // Update local state
    if (selectedSkill?.id === id) {
      setSelectedSkill(prev => prev ? { ...prev, content, updated_at: new Date().toISOString() } : prev)
    }
    setSkills(prev => prev.map(s => s.id === id ? { ...s, updated_at: new Date().toISOString() } : s))
  }, [selectedSkill])

  return {
    skills,
    loading,
    error,
    counts,
    selectedSkill,
    selectedSkillLoading,
    selectedSkillSources,
    selectSkill,
    activateSkill,
    archiveSkill,
    updateSkillContent,
    updateSkillStatus,
    refresh: fetchSkills,
  }
}
