import { homedir } from 'os'
import { join } from 'path'

export const CONFIG_DIR = join(homedir(), '.synapse')
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

export const DEFAULT_CONFIG = {
  apiUrl: 'http://localhost:3001/api/mcp',
  outputFormat: 'json' as const,
  defaultSourceLimit: 10,
  defaultConnectionHops: 2,
}

export const ENTITY_TYPES = [
  'Person',
  'Organization',
  'Team',
  'Topic',
  'Project',
  'Goal',
  'Action',
  'Risk',
  'Blocker',
  'Decision',
  'Insight',
  'Question',
  'Idea',
  'Concept',
  'Takeaway',
  'Lesson',
  'Document',
  'Event',
  'Location',
  'Technology',
  'Product',
  'Metric',
  'Hypothesis',
  'Anchor',
]

export const SOURCE_TYPES = [
  'Meeting',
  'YouTube',
  'Document',
  'Note',
  'Research',
  'Transcript',
]

export const MCP_TOOLS = [
  'ask_synapse',
  'search_entities',
  'get_entity',
  'get_connections',
  'list_anchors',
  'get_recent_sources',
  'get_source_content',
  'search_sources',
  'get_meeting_brief',
  'get_related_sources',
  'get_meeting_notes',
  'get_meeting_transcript',
  'consult_council',
  'send_to_synapse',
] as const
