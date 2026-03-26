import { BASE_EXTRACTION_INSTRUCTIONS } from '../config/baseInstructions'
import type { ExtractionConfig } from '../types/extraction'
import type { UserProfile } from '../types/database'

const MODE_TEMPLATES: Record<ExtractionConfig['mode'], string> = {
  comprehensive:
    '## Extraction Mode: Comprehensive\n\nExtract ALL meaningful entities from the content. Cast a wide net — include people, organizations, topics, technologies, actions, decisions, risks, and insights. Capture every relationship you can identify. Err on the side of extracting more rather than fewer. This mode is for building a thorough, detailed knowledge base.',
  strategic:
    '## Extraction Mode: Strategic\n\nFocus on high-level strategic entities: decisions, goals, insights, concepts, and key people driving strategy. Skip minor actions, routine topics, and operational details. Extract the entities a C-suite executive would care about. Relationships should emphasize strategic connections (supports, enables, blocks, leads_to).',
  actionable:
    '## Extraction Mode: Actionable\n\nFocus on actionable entities: actions, goals, blockers, decisions, risks, and deadlines. Extract ownership (who is responsible for what). Skip background context and conceptual discussions unless they directly relate to an action item. This mode is for turning meetings into task lists and strategy into execution.',
  relational:
    '## Extraction Mode: Relational\n\nFocus on connections between concepts rather than exhaustive entity extraction. For each entity you extract, ensure it has multiple relationships to other entities. Prefer fewer, more connected entities over many isolated ones. This mode is for building a densely interconnected graph.',
}

export function getModeTemplate(mode: ExtractionConfig['mode']): string {
  return MODE_TEMPLATES[mode] ?? MODE_TEMPLATES.comprehensive
}

export function buildProfileContext(profile: UserProfile): string {
  const lines: string[] = ['## User Context']

  const role = profile.professional_context?.role
  const industry = profile.professional_context?.industry
  if (role || industry) {
    lines.push(`The user is a ${role || 'professional'}${industry ? ` in ${industry}` : ''}.`)
  }

  const projects = profile.professional_context?.current_projects
  if (projects) {
    lines.push(`Current projects: ${projects}.`)
  }

  const topics = profile.personal_interests?.topics
  if (topics) {
    lines.push(`Areas of interest: ${topics}.`)
  }

  const learningGoals = profile.personal_interests?.learning_goals
  if (learningGoals) {
    lines.push(`Learning goals: ${learningGoals}.`)
  }

  const depth = profile.processing_preferences?.insight_depth
  const focus = profile.processing_preferences?.relationship_focus
  if (depth || focus) {
    const prefs = [depth, focus].filter(Boolean).join(', ')
    lines.push(`Processing preference: ${prefs}.`)
  }

  lines.push(
    '\nFrame your extraction through this professional lens. Entities and relationships that are relevant to the user\'s role and interests should receive higher confidence scores.'
  )

  return lines.join('\n')
}

export interface AnchorInput {
  label: string
  entity_type: string
  description: string
  isAuto?: boolean // auto-detected anchor
}

export function buildAnchorContext(
  anchors: ExtractionConfig['anchors'] | AnchorInput[],
  emphasis: ExtractionConfig['anchorEmphasis']
): string {
  const manualAnchors = anchors.filter(a => !(a as AnchorInput).isAuto)
  const autoAnchors = anchors.filter(a => (a as AnchorInput).isAuto)

  const manualList = manualAnchors
    .map(a => `- ${a.label} (${a.entity_type})${a.description ? `: ${a.description}` : ''}`)
    .join('\n')

  const autoList = autoAnchors
    .map(a => `- ${a.label} (${a.entity_type})${a.description ? `: ${a.description}` : ''}`)
    .join('\n')

  const parts: string[] = []

  if (manualAnchors.length > 0) {
    if (emphasis === 'passive') {
      parts.push(`## Areas of Interest\nThe user has the following areas of ongoing interest. Note connections to these if they naturally exist, but do not force connections:\n${manualList}`)
    } else if (emphasis === 'aggressive') {
      parts.push(`## High-Priority Anchors — Active Connection Required\nThe user considers these entities critically important. For EACH anchor below, determine whether the source content has ANY connection — direct or indirect. Extract entities that serve as bridges between the content and these anchors, even if the connection requires inference:\n${manualList}`)
    } else {
      parts.push(`## Priority Anchors\nThe user has designated these as priority entities. Actively look for connections between the source content and these anchors. If a meaningful relationship exists, extract it with supporting evidence:\n${manualList}`)
    }
  }

  // Auto-anchors always use passive emphasis
  if (autoAnchors.length > 0) {
    parts.push(`## Emerging Themes (Auto-Detected)\nThe system has detected the following emerging knowledge themes. Include connections to these naturally if they exist, but do not force them:\n${autoList}`)
  }

  return parts.join('\n\n')
}

export function buildExtractionPrompt(config: ExtractionConfig): string {
  const parts: string[] = [
    BASE_EXTRACTION_INSTRUCTIONS,
    getModeTemplate(config.mode),
  ]

  if (config.userProfile) {
    parts.push(buildProfileContext(config.userProfile))
  }

  if (config.anchors.length > 0) {
    parts.push(buildAnchorContext(config.anchors, config.anchorEmphasis))
  }

  if (config.customGuidance) {
    parts.push(`## Additional Guidance from the User\n${config.customGuidance}`)
  }

  return parts.join('\n\n')
}
