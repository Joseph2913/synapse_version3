// Browser-side wrapper around the canonical Stage 4 prompt module. The actual
// prompt text is composed in api/pipeline/extract-prompt.ts so the serverless
// path and the browser path are guaranteed identical for identical inputs.

import {
  buildExtractionPrompt as buildExtractionPromptCanonical,
  composeExtractionPrompt as composeExtractionPromptCanonical,
  PROMPT_VERSION,
  MODE_INSTRUCTIONS,
  EMPHASIS_INSTRUCTIONS,
  type PromptConfig as CanonicalPromptConfig,
  type PromptSkillHint,
  type ComposedPrompt,
} from '../../api/pipeline/extract-prompt'
import type { ExtractionConfig } from '../types/extraction'
import type { UserProfile } from '../types/database'

export { PROMPT_VERSION, MODE_INSTRUCTIONS, EMPHASIS_INSTRUCTIONS }
export type { PromptSkillHint, ComposedPrompt }

export interface AnchorInput {
  label: string
  entity_type: string
  description: string
  isAuto?: boolean
}

export type ExtractionConfigWithSkills = ExtractionConfig & {
  activeSkills?: PromptSkillHint[]
}

function toCanonicalConfig(config: ExtractionConfigWithSkills): CanonicalPromptConfig {
  return {
    mode: config.mode,
    anchorEmphasis: config.anchorEmphasis,
    anchors: config.anchors,
    userProfile: config.userProfile,
    customInstructions: config.customGuidance ?? null,
    activeSkills: config.activeSkills,
  }
}

export function getModeTemplate(mode: ExtractionConfig['mode']): string {
  return MODE_INSTRUCTIONS[mode] ?? MODE_INSTRUCTIONS.comprehensive
}

/**
 * Browser-facing prompt builder. Returns the composed prompt string only, for
 * legacy call sites. New code should prefer `composeExtractionPrompt()` to also
 * receive the prompt version (stamped onto extraction_sessions).
 */
export function buildExtractionPrompt(config: ExtractionConfigWithSkills): string {
  return buildExtractionPromptCanonical(toCanonicalConfig(config))
}

export function composeExtractionPrompt(config: ExtractionConfigWithSkills): ComposedPrompt {
  return composeExtractionPromptCanonical(toCanonicalConfig(config))
}

// ── Legacy helpers (retained so any UI code that previewed sub-sections keeps
// working). They are no longer used to assemble the final prompt — that goes
// through the canonical builder above.

export function buildProfileContext(profile: UserProfile): string {
  const lines: string[] = ['## User Context']
  const role = profile.professional_context?.role
  const industry = profile.professional_context?.industry
  if (role || industry) {
    lines.push(`The user is a ${role || 'professional'}${industry ? ` in ${industry}` : ''}.`)
  }
  const projects = profile.professional_context?.current_projects
  if (projects) lines.push(`Current projects: ${projects}.`)
  const topics = profile.personal_interests?.topics
  if (topics) lines.push(`Areas of interest: ${topics}.`)
  return lines.join('\n')
}

export function buildAnchorContext(
  anchors: ExtractionConfig['anchors'] | AnchorInput[],
  emphasis: ExtractionConfig['anchorEmphasis']
): string {
  return `## Anchors (${emphasis})\n${anchors.map(a => `- ${a.label} (${a.entity_type})`).join('\n')}`
}
