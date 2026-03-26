export interface QueryMindset {
  id: string
  label: string
  description: string
  icon: string
  color: string
  promptAddition: string
  temperatureOverride?: number
}

export const QUERY_MINDSETS: QueryMindset[] = [
  {
    id: 'auto',
    label: 'Auto',
    description: 'Synapse detects the query type and adapts automatically. Best for most questions.',
    icon: 'Sparkles',
    color: '#6b7280',
    promptAddition: '',  // No static prompt — handled by classifier
    temperatureOverride: undefined,
  },
  {
    id: 'factual',
    label: 'Factual',
    description: 'Direct answers with precise citations. Best for "what", "when", "who" questions.',
    icon: 'Target',
    color: '#2563eb',
    promptAddition: `## Response Mindset: Factual

Provide direct, precise answers. Lead with the specific fact or data point the user is asking about. Keep the response concise — avoid unnecessary elaboration or synthesis. Every claim must cite a specific source. If the answer is a single entity, date, decision, or fact, state it immediately in the first sentence. If the knowledge graph does not contain a clear answer, say so explicitly rather than speculating.

Format: Short paragraphs. No headers unless the answer genuinely has multiple distinct parts. Prioritize source chunk citations over entity citations.`,
    temperatureOverride: 0.1,
  },
  {
    id: 'analytical',
    label: 'Analytical',
    description: 'Structured analysis with patterns and implications. Best for "why", "how", "what does this mean" questions.',
    icon: 'TrendingUp',
    color: '#7c3aed',
    promptAddition: `## Response Mindset: Analytical

Analyze the topic by identifying patterns, causes, and implications across the user's knowledge graph. Structure your response with clear reasoning: state the finding, explain the evidence, then draw the implication. Look for non-obvious connections between entities — this is where the knowledge graph adds unique value.

If you find contradictory evidence across different sources, highlight the contradiction rather than resolving it arbitrarily. Distinguish between what the sources explicitly state and what you are inferring from the graph structure.

Format: Use a logical progression. Start with the core analysis, then supporting evidence, then implications or open questions. Cite both source chunks and entity relationships.`,
    temperatureOverride: 0.3,
  },
  {
    id: 'comparative',
    label: 'Comparative',
    description: 'Side-by-side analysis of entities, concepts, or approaches. Best for "how does X compare to Y" questions.',
    icon: 'GitCompareArrows',
    color: '#db2777',
    promptAddition: `## Response Mindset: Comparative

Structure your response as a comparison. Identify the key entities or concepts being compared and evaluate them along consistent dimensions. For each dimension, cite the specific source that supports each side.

If the user's question implies a comparison (e.g., mentions two projects, two people, two approaches), organize the response to make the comparison explicit even if the user didn't frame it that way. If only one side has evidence in the knowledge graph, state what is known and what is missing.

Format: Use parallel structure. For 2-3 comparison dimensions, use inline comparison. For 4+ dimensions, use a structured format with clear labels for each entity being compared. Always end with a synthesis noting the most significant differences or similarities.`,
    temperatureOverride: 0.2,
  },
  {
    id: 'exploratory',
    label: 'Exploratory',
    description: 'Discovers connections, surfaces related topics, and maps knowledge terrain. Best for open-ended exploration.',
    icon: 'Compass',
    color: '#0891b2',
    promptAddition: `## Response Mindset: Exploratory

Cast a wide net across the knowledge graph. The user is exploring, not seeking a specific answer. Surface surprising connections, related topics the user may not have considered, and patterns that emerge from the graph structure.

Organize your response as a knowledge map: start with the most directly relevant entities, then branch outward to connected topics, then highlight the most unexpected or non-obvious connections. For each connection you surface, briefly explain why it's relevant.

If the graph traversal reveals clusters of related knowledge, name those clusters. If there are gaps — topics where the user has limited knowledge that seem relevant — mention those as potential areas to explore further.

Format: Use a flowing narrative that moves from the center of the topic outward. Cite entities and relationships heavily — the user wants to see the graph structure reflected in the response. End with 2-3 follow-up questions the user could ask to go deeper.`,
    temperatureOverride: 0.5,
  },
]

export const DEFAULT_MINDSET_ID = 'auto'

// ─── Model Tiers ─────────────────────────────────────────────────────────────

export interface ModelTier {
  id: string
  label: string
  description: string
  icon: string
  generationConfig: {
    model: string
    maxOutputTokens: number
    temperature?: number
  }
}

export const MODEL_TIERS: ModelTier[] = [
  {
    id: 'fast',
    label: 'Fast',
    description: 'Quick responses, shorter context window',
    icon: 'Rabbit',
    generationConfig: {
      model: 'gemini-2.5-flash',
      maxOutputTokens: 1024,
      temperature: 0.2,
    },
  },
  {
    id: 'thorough',
    label: 'Thorough',
    description: 'Deeper analysis, larger context window',
    icon: 'Brain',
    generationConfig: {
      model: 'gemini-2.5-flash',
      maxOutputTokens: 8192,
      temperature: 0.3,
    },
  },
]

export const DEFAULT_MODEL_TIER_ID = 'thorough'
