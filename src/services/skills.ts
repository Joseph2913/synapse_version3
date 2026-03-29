import { supabase } from './supabase'
import type { KnowledgeSkill, SkillStatus } from '../types/database'

// ─── Lightweight columns (excludes content + embedding for list queries) ─────

const LIST_COLUMNS = [
  'id', 'user_id', 'name', 'title', 'description', 'domain', 'tags',
  'source_ids', 'source_count', 'confidence', 'instructional_ratio',
  'generalizability', 'structural_density', 'status', 'created_at', 'updated_at',
].join(',')

const INDEX_COLUMNS = [
  'name', 'title', 'description', 'domain', 'tags',
  'confidence', 'source_count', 'updated_at',
].join(',')

// ─── List skills ─────────────────────────────────────────────────────────────

export async function listSkills(filters?: {
  status?: SkillStatus
  domain?: string
}): Promise<KnowledgeSkill[]> {
  let query = supabase
    .from('knowledge_skills')
    .select(LIST_COLUMNS)
    .order('updated_at', { ascending: false })

  if (filters?.status) query = query.eq('status', filters.status)
  if (filters?.domain) query = query.eq('domain', filters.domain)

  const { data, error } = await query

  if (error) {
    console.error('[skills] listSkills error:', error.message)
    return []
  }

  return (data ?? []) as unknown as KnowledgeSkill[]
}

// ─── Get by name ─────────────────────────────────────────────────────────────

export async function getSkillByName(name: string): Promise<KnowledgeSkill | null> {
  const { data, error } = await supabase
    .from('knowledge_skills')
    .select('*')
    .eq('name', name)
    .maybeSingle()

  if (error) {
    console.error('[skills] getSkillByName error:', error.message)
    return null
  }

  return data as KnowledgeSkill | null
}

// ─── Get by ID ───────────────────────────────────────────────────────────────

export async function getSkillById(id: string): Promise<KnowledgeSkill | null> {
  const { data, error } = await supabase
    .from('knowledge_skills')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    console.error('[skills] getSkillById error:', error.message)
    return null
  }

  return data as KnowledgeSkill | null
}

// ─── Create ──────────────────────────────────────────────────────────────────

export async function createSkill(
  skill: Omit<KnowledgeSkill, 'id' | 'user_id' | 'created_at' | 'updated_at'>
): Promise<KnowledgeSkill | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    console.error('[skills] createSkill: no authenticated user')
    return null
  }

  const { data, error } = await supabase
    .from('knowledge_skills')
    .insert({ ...skill, user_id: user.id })
    .select()
    .single()

  if (error) {
    // Handle unique constraint violation — return existing skill
    if (error.code === '23505') {
      console.warn('[skills] createSkill: duplicate name, fetching existing:', skill.name)
      return getSkillByName(skill.name)
    }
    console.error('[skills] createSkill error:', error.message)
    return null
  }

  return data as KnowledgeSkill
}

// ─── Update ──────────────────────────────────────────────────────────────────

export async function updateSkill(
  id: string,
  updates: Partial<Omit<KnowledgeSkill, 'id' | 'user_id' | 'created_at'>>
): Promise<KnowledgeSkill | null> {
  const { data, error } = await supabase
    .from('knowledge_skills')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()

  if (error) {
    console.error('[skills] updateSkill error:', error.message)
    return null
  }

  return data as KnowledgeSkill
}

// ─── Update status ───────────────────────────────────────────────────────────

export async function updateSkillStatus(id: string, status: SkillStatus): Promise<void> {
  const { error } = await supabase
    .from('knowledge_skills')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) {
    console.error('[skills] updateSkillStatus error:', error.message)
  }
}

// ─── Exists check ────────────────────────────────────────────────────────────

export async function skillExists(name: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('knowledge_skills')
    .select('id')
    .eq('name', name)
    .maybeSingle()

  if (error) {
    console.error('[skills] skillExists error:', error.message)
    return false
  }

  return data !== null
}

// ─── Skill index (lightweight, for MCP get_skills) ───────────────────────────

export async function getSkillIndex(): Promise<Array<Pick<KnowledgeSkill,
  'name' | 'title' | 'description' | 'domain' | 'tags' | 'confidence' |
  'source_count' | 'updated_at'
>>> {
  const { data, error } = await supabase
    .from('knowledge_skills')
    .select(INDEX_COLUMNS)
    .eq('status', 'active')
    .order('confidence', { ascending: false })

  if (error) {
    console.error('[skills] getSkillIndex error:', error.message)
    return []
  }

  return (data ?? []) as unknown as Array<Pick<KnowledgeSkill,
    'name' | 'title' | 'description' | 'domain' | 'tags' | 'confidence' |
    'source_count' | 'updated_at'
  >>
}

// ─── Skills by source ID ────────────────────────────────────────────────────

export async function getSkillsBySourceId(sourceId: string): Promise<KnowledgeSkill[]> {
  const { data, error } = await supabase
    .from('knowledge_skills')
    .select(LIST_COLUMNS)
    .contains('source_ids', [sourceId])

  if (error) {
    console.error('[skills] getSkillsBySourceId error:', error.message)
    return []
  }

  return (data ?? []) as unknown as KnowledgeSkill[]
}
