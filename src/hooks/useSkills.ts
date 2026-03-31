import { useState, useCallback, useRef, useEffect } from 'react'
import { supabase } from '../services/supabase'
import { useAuth } from './useAuth'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Skill {
  id: string
  label: string
  domain: 'technical' | 'consulting' | 'strategic' | 'interpersonal' | 'domain_specific'
  description: string | null
  exposure_level: 'novice' | 'developing' | 'proficient' | 'advanced'
  confidence: number
  evidence_count: number
  status: 'candidate' | 'confirmed' | 'dormant' | 'archived'
  when_to_apply: string | null
  how_to_apply: string | null
  related_anchor_ids: string[]
  related_skill_ids: string[]
  signal_breakdown: Record<string, number> | null
  last_reinforced_at: string
  first_detected_at: string
}

export interface SkillWithSources extends Skill {
  contributing_sources: Array<{
    id: string
    title: string
    source_type: string
    created_at: string
    contribution: 'created' | 'reinforced' | 'upgraded' | 'corrected'
  }>
  related_anchors: Array<{
    id: string
    label: string
    entity_type: string
  }>
  related_skills: Array<{
    id: string
    label: string
    domain: string
    confidence: number
  }>
}

export interface UseSkillsReturn {
  confirmed: Skill[]
  candidates: Skill[]
  loading: boolean
  error: string | null
  selectedSkill: SkillWithSources | null
  selectedSkillLoading: boolean
  selectSkill: (id: string | null) => Promise<void>
  confirmSkill: (id: string) => Promise<void>
  dismissSkill: (id: string) => Promise<void>
  updateExposureLevel: (id: string, level: Skill['exposure_level']) => Promise<void>
  updateLabel: (id: string, label: string) => Promise<void>
  refresh: () => Promise<void>
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useSkills(): UseSkillsReturn {
  const { user } = useAuth()
  const [confirmed, setConfirmed] = useState<Skill[]>([])
  const [candidates, setCandidates] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedSkill, setSelectedSkill] = useState<SkillWithSources | null>(null)
  const [selectedSkillLoading, setSelectedSkillLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const fetchSkills = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setError(null)

    try {
      const [confirmedRes, candidatesRes] = await Promise.all([
        supabase
          .from('knowledge_skills')
          .select('id, label, domain, description, exposure_level, confidence, evidence_count, status, when_to_apply, how_to_apply, related_anchor_ids, related_skill_ids, signal_breakdown, last_reinforced_at, first_detected_at')
          .eq('user_id', user.id)
          .in('status', ['confirmed', 'dormant'])
          .order('confidence', { ascending: false })
          .order('evidence_count', { ascending: false }),
        supabase
          .from('knowledge_skills')
          .select('id, label, domain, description, exposure_level, confidence, evidence_count, status, when_to_apply, how_to_apply, related_anchor_ids, related_skill_ids, signal_breakdown, last_reinforced_at, first_detected_at')
          .eq('user_id', user.id)
          .eq('status', 'candidate')
          .order('confidence', { ascending: false })
          .limit(30),
      ])

      if (confirmedRes.error) throw confirmedRes.error
      if (candidatesRes.error) throw candidatesRes.error

      setConfirmed((confirmedRes.data ?? []) as Skill[])
      setCandidates((candidatesRes.data ?? []) as Skill[])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load skills')
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    fetchSkills()
  }, [fetchSkills])

  const selectSkill = useCallback(async (id: string | null) => {
    if (abortRef.current) abortRef.current.abort()

    if (!id || !user) {
      setSelectedSkill(null)
      return
    }

    abortRef.current = new AbortController()
    setSelectedSkillLoading(true)

    try {
      const [skillRes, sourcesRes] = await Promise.all([
        supabase
          .from('knowledge_skills')
          .select('*')
          .eq('id', id)
          .eq('user_id', user.id)
          .maybeSingle(),
        supabase
          .from('skill_sources')
          .select('source_id, contribution, created_at')
          .eq('skill_id', id)
          .order('created_at', { ascending: true }),
      ])

      if (abortRef.current?.signal.aborted) return

      if (skillRes.error) throw skillRes.error
      if (!skillRes.data) {
        setSelectedSkill(null)
        return
      }

      const skill = skillRes.data as Skill

      // Fetch source details
      let contributing_sources: SkillWithSources['contributing_sources'] = []
      if (sourcesRes.data && sourcesRes.data.length > 0) {
        const sourceIds = sourcesRes.data.map((ss: { source_id: string }) => ss.source_id)
        const { data: sourceDetails } = await supabase
          .from('knowledge_sources')
          .select('id, title, source_type, created_at')
          .in('id', sourceIds)

        if (abortRef.current?.signal.aborted) return

        if (sourceDetails) {
          const sourceMap = new Map(sourceDetails.map((s: { id: string; title: string | null; source_type: string | null; created_at: string }) => [s.id, s]))
          contributing_sources = sourcesRes.data
            .map((ss: { source_id: string; contribution: string; created_at: string }) => {
              const src = sourceMap.get(ss.source_id)
              if (!src) return null
              return {
                id: src.id,
                title: src.title ?? 'Untitled',
                source_type: src.source_type ?? 'Document',
                created_at: src.created_at,
                contribution: ss.contribution as SkillWithSources['contributing_sources'][0]['contribution'],
              }
            })
            .filter(Boolean) as SkillWithSources['contributing_sources']
        }
      }

      // Fetch related anchors
      let related_anchors: SkillWithSources['related_anchors'] = []
      if (skill.related_anchor_ids?.length > 0) {
        const { data: anchorNodes } = await supabase
          .from('knowledge_nodes')
          .select('id, label, entity_type')
          .in('id', skill.related_anchor_ids)
          .eq('user_id', user.id)

        if (abortRef.current?.signal.aborted) return
        if (anchorNodes) related_anchors = anchorNodes as SkillWithSources['related_anchors']
      }

      // Fetch related skills
      let related_skills: SkillWithSources['related_skills'] = []
      if (skill.related_skill_ids?.length > 0) {
        const { data: relatedSkillRows } = await supabase
          .from('knowledge_skills')
          .select('id, label, domain, confidence')
          .in('id', skill.related_skill_ids)
          .eq('user_id', user.id)

        if (abortRef.current?.signal.aborted) return
        if (relatedSkillRows) related_skills = relatedSkillRows as SkillWithSources['related_skills']
      }

      setSelectedSkill({
        ...skill,
        contributing_sources,
        related_anchors,
        related_skills,
      })
    } catch (err) {
      if (abortRef.current?.signal.aborted) return
      setError(err instanceof Error ? err.message : 'Failed to load skill detail')
    } finally {
      setSelectedSkillLoading(false)
    }
  }, [user])

  const confirmSkill = useCallback(async (id: string) => {
    // Optimistic update
    const skill = candidates.find(s => s.id === id)
    if (!skill) return

    const confirmedSkill = {
      ...skill,
      status: 'confirmed' as const,
      confidence: Math.max(skill.confidence, 0.55),
    }

    setCandidates(prev => prev.filter(s => s.id !== id))
    setConfirmed(prev => {
      const next = [...prev, confirmedSkill]
      next.sort((a, b) => b.confidence - a.confidence || b.evidence_count - a.evidence_count)
      return next
    })

    const { error: err } = await supabase
      .from('knowledge_skills')
      .update({ status: 'confirmed', confidence: confirmedSkill.confidence })
      .eq('id', id)

    if (err) {
      // Revert
      setCandidates(prev => {
        const next = [...prev, skill]
        next.sort((a, b) => b.confidence - a.confidence)
        return next
      })
      setConfirmed(prev => prev.filter(s => s.id !== id))
    }
  }, [candidates])

  const dismissSkill = useCallback(async (id: string) => {
    // Save for revert
    const fromConfirmed = confirmed.find(s => s.id === id)
    const fromCandidates = candidates.find(s => s.id === id)
    const skill = fromConfirmed ?? fromCandidates

    if (!skill) return

    // Optimistic remove
    setConfirmed(prev => prev.filter(s => s.id !== id))
    setCandidates(prev => prev.filter(s => s.id !== id))

    if (selectedSkill?.id === id) setSelectedSkill(null)

    const { error: err } = await supabase
      .from('knowledge_skills')
      .update({ status: 'archived' })
      .eq('id', id)

    if (err) {
      // Revert
      if (fromConfirmed) {
        setConfirmed(prev => {
          const next = [...prev, fromConfirmed]
          next.sort((a, b) => b.confidence - a.confidence || b.evidence_count - a.evidence_count)
          return next
        })
      } else if (fromCandidates) {
        setCandidates(prev => {
          const next = [...prev, fromCandidates]
          next.sort((a, b) => b.confidence - a.confidence)
          return next
        })
      }
    }
  }, [confirmed, candidates, selectedSkill])

  const updateExposureLevel = useCallback(async (id: string, level: Skill['exposure_level']) => {
    // Optimistic update
    const updateInList = (prev: Skill[]) =>
      prev.map(s => s.id === id ? { ...s, exposure_level: level } : s)

    setConfirmed(updateInList)
    setCandidates(updateInList)
    if (selectedSkill?.id === id) {
      setSelectedSkill(prev => prev ? { ...prev, exposure_level: level } : null)
    }

    const { error: err } = await supabase
      .from('knowledge_skills')
      .update({ exposure_level: level })
      .eq('id', id)

    if (err) {
      // Refresh to revert
      fetchSkills()
    }
  }, [selectedSkill, fetchSkills])

  const updateLabel = useCallback(async (id: string, label: string) => {
    const trimmed = label.trim()
    if (!trimmed || trimmed.length > 80) return

    // Check if same
    const existing = [...confirmed, ...candidates].find(s => s.id === id)
    if (existing && existing.label === trimmed) return

    // Optimistic update
    const updateInList = (prev: Skill[]) =>
      prev.map(s => s.id === id ? { ...s, label: trimmed } : s)

    setConfirmed(updateInList)
    setCandidates(updateInList)
    if (selectedSkill?.id === id) {
      setSelectedSkill(prev => prev ? { ...prev, label: trimmed } : null)
    }

    const { error: err } = await supabase
      .from('knowledge_skills')
      .update({ label: trimmed })
      .eq('id', id)

    if (err) {
      // Revert
      fetchSkills()
      // Check for duplicate constraint violation
      if (err.code === '23505') {
        throw new Error('A skill with this name already exists')
      }
      throw err
    }
  }, [confirmed, candidates, selectedSkill, fetchSkills])

  return {
    confirmed,
    candidates,
    loading,
    error,
    selectedSkill,
    selectedSkillLoading,
    selectSkill,
    confirmSkill,
    dismissSkill,
    updateExposureLevel,
    updateLabel,
    refresh: fetchSkills,
  }
}
