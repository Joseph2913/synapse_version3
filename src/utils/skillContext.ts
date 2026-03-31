import type { SkillContextItem } from '../types/extraction'

export function buildSkillContext(skills: SkillContextItem[]): string {
  if (!skills || skills.length === 0) return ''

  // Group by domain for readability in the prompt
  const grouped = skills.reduce((acc, skill) => {
    if (!acc[skill.domain]) acc[skill.domain] = []
    ;(acc[skill.domain] as SkillContextItem[]).push(skill)
    return acc
  }, {} as Record<string, SkillContextItem[]>)

  const lines: string[] = [
    '## User Skill Profile',
    '',
    'The following confirmed skills represent capabilities this user has already accumulated.',
    'Use this context to:',
    '1. Extract entities at the appropriate depth — do not over-explain concepts the user already knows well',
    '2. Frame new entities in relation to existing skills where natural connections exist',
    '3. Prioritise extraction of concepts that extend or complement existing skills over redundant basics',
    '4. Note when content introduces a significantly more advanced treatment of an existing skill',
    '',
  ]

  for (const [domain, domainSkills] of Object.entries(grouped) as [string, SkillContextItem[]][]) {
    lines.push(`**${domain.charAt(0).toUpperCase() + domain.slice(1)} Skills (${domainSkills.length}):**`)
    for (const skill of domainSkills) {
      const levelNote =
        skill.exposure_level === 'advanced' || skill.exposure_level === 'proficient'
          ? ` [${skill.exposure_level}]`
          : ''
      lines.push(`- ${skill.label}${levelNote}`)
    }
    lines.push('')
  }

  lines.push(
    'Do not avoid extracting entities related to existing skills — extract them, but frame them',
    'relative to what the user already knows. Use the exposure level annotations to calibrate depth.',
    'A [proficient] or [advanced] skill means the user has substantial prior exposure — extract',
    'nuances, edge cases, and advanced applications rather than foundational explanations.'
  )

  return lines.join('\n')
}

export function selectSkillsForContext(skills: SkillContextItem[]): SkillContextItem[] {
  const LEVEL_PRIORITY: Record<string, number> = { advanced: 0, proficient: 1, developing: 2, novice: 3 }
  const sorted = [...skills].sort(
    (a, b) => (LEVEL_PRIORITY[a.exposure_level] ?? 3) - (LEVEL_PRIORITY[b.exposure_level] ?? 3)
  )
  return sorted.slice(0, 40)
}
