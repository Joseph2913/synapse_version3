// Stage 4 — fetch confirmed knowledge_skills for the user so they can be
// injected as expertise hints into the extraction prompt.
//
// Returns up to 12 confirmed skills, ordered by confidence then last reinforcement
// date. Failures degrade silently to an empty list — skills are a hint, not a
// hard requirement, and we don't want to block extraction if the table is
// unreachable.

import type { PromptSkillHint } from '../utils/promptBuilder'
import { supabase } from './supabase'

const MAX_SKILLS_IN_PROMPT = 12

export async function fetchActiveSkillsForPrompt(userId: string): Promise<PromptSkillHint[]> {
  try {
    const { data, error } = await supabase
      .from('knowledge_skills')
      .select('label, domain, exposure_level, confidence, last_reinforced_at')
      .eq('user_id', userId)
      .eq('status', 'confirmed')
      .order('confidence', { ascending: false })
      .order('last_reinforced_at', { ascending: false })
      .limit(MAX_SKILLS_IN_PROMPT)

    if (error || !data) return []

    return data.map(row => ({
      label: row.label as string,
      domain: (row.domain as string | null) ?? null,
      exposure_level: (row.exposure_level as string | null) ?? null,
    }))
  } catch (err) {
    console.warn('[promptSkillsContext] Skills fetch failed (non-blocking):', err)
    return []
  }
}
