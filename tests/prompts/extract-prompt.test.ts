import { describe, it, expect } from 'vitest'
import {
  buildExtractionPrompt,
  composeExtractionPrompt,
  PROMPT_VERSION,
  type PromptConfig,
} from '../../api/pipeline/extract-prompt'

const baseConfig: PromptConfig = {
  mode: 'comprehensive',
  anchorEmphasis: 'standard',
  anchors: [],
  userProfile: null,
}

describe('Stage 4 — extract-prompt: invariants', () => {
  it('PROMPT_VERSION is a non-empty semver-shaped string', () => {
    expect(PROMPT_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('produces a non-empty prompt for a minimal config', () => {
    const prompt = buildExtractionPrompt(baseConfig)
    expect(prompt.length).toBeGreaterThan(1000)
    expect(prompt).toContain('<role>')
    expect(prompt).toContain('<output_schema>')
    expect(prompt).toContain('<final_instructions>')
  })

  it('is deterministic — identical inputs produce identical output', () => {
    expect(buildExtractionPrompt(baseConfig)).toBe(buildExtractionPrompt(baseConfig))
  })

  it('composeExtractionPrompt returns the same version constant', () => {
    const composed = composeExtractionPrompt(baseConfig)
    expect(composed.version).toBe(PROMPT_VERSION)
    expect(composed.prompt).toBe(buildExtractionPrompt(baseConfig))
  })
})

describe('Stage 4 — extract-prompt: extraction modes', () => {
  const modes: Array<PromptConfig['mode']> = [
    'comprehensive',
    'strategic',
    'actionable',
    'relational',
  ]

  for (const mode of modes) {
    it(`mode "${mode}" — emits a unique mode block matching expected text`, () => {
      const prompt = buildExtractionPrompt({ ...baseConfig, mode })
      expect(prompt).toContain(`<extraction_mode>\nMode: ${mode}`)
    })
  }

  it('unknown mode falls back to comprehensive instruction text', () => {
    const prompt = buildExtractionPrompt({ ...baseConfig, mode: 'bogus' as never })
    expect(prompt).toContain('Mode: bogus')
    expect(prompt).toContain('Extract every entity and relationship that will still be useful')
  })

  it('snapshot — comprehensive mode prompt is locked', () => {
    expect(buildExtractionPrompt({ ...baseConfig, mode: 'comprehensive' })).toMatchSnapshot()
  })

  it('snapshot — strategic mode prompt is locked', () => {
    expect(buildExtractionPrompt({ ...baseConfig, mode: 'strategic' })).toMatchSnapshot()
  })

  it('snapshot — actionable mode prompt is locked', () => {
    expect(buildExtractionPrompt({ ...baseConfig, mode: 'actionable' })).toMatchSnapshot()
  })

  it('snapshot — relational mode prompt is locked', () => {
    expect(buildExtractionPrompt({ ...baseConfig, mode: 'relational' })).toMatchSnapshot()
  })
})

describe('Stage 4 — extract-prompt: anchor emphasis', () => {
  const anchors = [
    { label: 'Project Phoenix', entity_type: 'Project', description: 'Q3 platform rebuild.' },
  ]

  it('passive — emits the passive emphasis sentence', () => {
    const prompt = buildExtractionPrompt({ ...baseConfig, anchors, anchorEmphasis: 'passive' })
    expect(prompt).toContain('low-priority context')
  })

  it('aggressive — emits the aggressive emphasis sentence', () => {
    const prompt = buildExtractionPrompt({ ...baseConfig, anchors, anchorEmphasis: 'aggressive' })
    expect(prompt).toContain('Heavily weight extraction')
  })

  it('omits anchor block entirely when no anchors are supplied', () => {
    const prompt = buildExtractionPrompt(baseConfig)
    expect(prompt).not.toContain('<anchor_context>')
  })

  it('separates manual anchors from emerging-theme auto-anchors', () => {
    const prompt = buildExtractionPrompt({
      ...baseConfig,
      anchors: [
        { label: 'Anchor A', entity_type: 'Project', description: 'a manual anchor.' },
        { label: 'Theme B',  entity_type: 'Topic',  description: 'an auto-detected theme.', isAuto: true },
      ],
    })
    expect(prompt).toContain('<anchor_context>')
    expect(prompt).toContain('<emerging_themes>')
  })
})

describe('Stage 4 — extract-prompt: skills wiring', () => {
  it('omits the user_expertise block when no skills are supplied', () => {
    const prompt = buildExtractionPrompt(baseConfig)
    expect(prompt).not.toContain('<user_expertise>')
  })

  it('omits the user_expertise block when activeSkills is an empty array', () => {
    const prompt = buildExtractionPrompt({ ...baseConfig, activeSkills: [] })
    expect(prompt).not.toContain('<user_expertise>')
  })

  it('injects skill labels into the user_expertise block when skills are present', () => {
    const prompt = buildExtractionPrompt({
      ...baseConfig,
      activeSkills: [
        { label: 'Founder Storytelling', domain: 'consulting', exposure_level: 'advanced' },
        { label: 'Knowledge Graph Design' },
      ],
    })
    expect(prompt).toContain('<user_expertise>')
    expect(prompt).toContain('Founder Storytelling (consulting, advanced)')
    expect(prompt).toContain('Knowledge Graph Design')
  })

  it('caps the skills list at 12 to keep the prompt bounded', () => {
    const skills = Array.from({ length: 30 }, (_, i) => ({ label: `Skill ${i}` }))
    const prompt = buildExtractionPrompt({ ...baseConfig, activeSkills: skills })
    expect(prompt).toContain('- Skill 0\n')
    expect(prompt).toContain('- Skill 11\n')
    expect(prompt).not.toContain('- Skill 12\n')
  })
})

describe('Stage 4 — extract-prompt: user profile + custom instructions', () => {
  it('omits user_context when profile is empty', () => {
    const prompt = buildExtractionPrompt({ ...baseConfig, userProfile: {} })
    expect(prompt).not.toContain('<user_context>')
  })

  it('emits user_context lines for populated profile fields', () => {
    const prompt = buildExtractionPrompt({
      ...baseConfig,
      userProfile: {
        professional_context: { role: 'Founder', industry: 'Consulting' },
        personal_interests: { topics: 'AI, knowledge graphs' },
      },
    })
    expect(prompt).toContain('Role: Founder')
    expect(prompt).toContain('Industry: Consulting')
    expect(prompt).toContain('Interests: AI, knowledge graphs')
  })

  it('includes a custom_instructions block when provided', () => {
    const prompt = buildExtractionPrompt({
      ...baseConfig,
      customInstructions: 'Pay close attention to legal entities.',
    })
    expect(prompt).toContain('<custom_instructions>')
    expect(prompt).toContain('Pay close attention to legal entities.')
  })

  it('omits custom_instructions when only whitespace is provided', () => {
    const prompt = buildExtractionPrompt({ ...baseConfig, customInstructions: '   ' })
    expect(prompt).not.toContain('<custom_instructions>')
  })
})
