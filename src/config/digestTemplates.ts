export interface DigestTemplate {
  id: string
  name: string
  description: string
  frequency: 'daily' | 'weekly' | 'monthly'
  icon: string
  systemPrompt: string
  defaultContext?: string
}

export const DIGEST_TEMPLATES: DigestTemplate[] = [
  // ─── DAILY (6) ─────────────────────────────────────────────────────────────
  {
    id: 'active_project_status',
    name: 'Active Project Status',
    description: 'Status updates for all active projects and goals',
    frequency: 'daily',
    icon: 'FolderKanban',
    systemPrompt: `Analyze my knowledge graph for active Project and Goal entities.
For each project found, report: current status based on recent connections,
new entities linked recently, pending Action items connected to it,
and any Risk or Blocker entities associated with it.
Organize by project with clear status indicators. If no projects exist, summarize the most active topics.`,
    defaultContext: 'Focus on my top 3 most active projects',
  },
  {
    id: 'todays_priorities',
    name: "Today's Priorities",
    description: 'Actions and decisions requiring attention today',
    frequency: 'daily',
    icon: 'ListChecks',
    systemPrompt: `Review Action, Decision, and Goal entities in my knowledge graph.
Identify what requires attention today based on: recency of creation,
connection density (highly connected items are higher priority),
and any explicit urgency signals in descriptions or related entities.
Rank the top 5 priorities with brief justification for each.`,
  },
  {
    id: 'people_pulse',
    name: 'People Pulse',
    description: 'Recent activity and connections involving people',
    frequency: 'daily',
    icon: 'Users',
    systemPrompt: `Query Person entities and their recent relationship changes in my knowledge graph.
Who has new connections or has been mentioned in recent sources?
What decisions or actions involve specific people?
Highlight any Person entities that appear to be central connectors or bottlenecks.
Include relevant Organization and Team entities as context.`,
  },
  {
    id: 'attention_map',
    name: 'Attention Map',
    description: 'Where my knowledge-building attention is concentrated',
    frequency: 'daily',
    icon: 'Map',
    systemPrompt: `Analyze my knowledge graph's recent source ingestion patterns.
What topics and entity types have the highest density of recent additions?
Where is my attention concentrated vs. spread thin?
Identify the top 3 most active knowledge domains and the top 3 most neglected areas.
Provide a concise attention distribution summary.`,
  },
  {
    id: 'signals_alerts',
    name: 'Signals & Alerts',
    description: 'Risks, blockers, and urgent signals from your graph',
    frequency: 'daily',
    icon: 'AlertTriangle',
    systemPrompt: `Query Risk, Blocker, Question, and high-uncertainty entities in my knowledge graph.
Surface anything that might need urgent attention: unresolved blockers, open questions with no answers,
risks that are connected to active projects or goals, and decision nodes that are pending.
Flag anything that appears time-sensitive based on context.`,
  },
  {
    id: 'learning_gaps',
    name: 'Learning & Knowledge Gaps',
    description: 'Areas that deserve deeper exploration',
    frequency: 'daily',
    icon: 'BookOpen',
    systemPrompt: `Identify Topic and Concept entities in my knowledge graph that have many inbound references
but sparse descriptions or few outgoing connections. These represent areas frequently mentioned
but not deeply explored. Also identify Question entities that remain unconnected to any answers.
What areas deserve deeper exploration or research today?`,
  },

  // ─── WEEKLY (6) ────────────────────────────────────────────────────────────
  {
    id: 'weekly_progress',
    name: 'Weekly Progress Review',
    description: 'What was learned, decided, and accomplished this week',
    frequency: 'weekly',
    icon: 'CheckSquare',
    systemPrompt: `Review all entities and sources created or updated this week in my knowledge graph.
Group findings by project or topic area. Summarize:
- What was learned (new Insight, Lesson, Concept, Takeaway nodes)
- What was decided (Decision nodes and their supporting evidence)
- What was accomplished (completed Goals, Actions with outcomes)
- What was ingested (source types and topics covered)
Provide a concise weekly accomplishments narrative.`,
  },
  {
    id: 'emerging_themes',
    name: 'Emerging Themes & Patterns',
    description: 'New clusters and cross-source patterns forming this week',
    frequency: 'weekly',
    icon: 'TrendingUp',
    systemPrompt: `Identify clusters of entities that share cross-connections across different sources this week.
What themes are emerging that span multiple projects, conversations, or documents?
Look for Topic and Concept entities with rapidly growing connection counts.
Identify any unexpected relationships between previously unconnected areas.
Surface the top 3 emerging themes with supporting evidence from the graph.`,
  },
  {
    id: 'relationship_dynamics',
    name: 'Relationship Dynamics',
    description: 'How people and organization networks evolved this week',
    frequency: 'weekly',
    icon: 'Network',
    systemPrompt: `Analyze Person and Organization entity networks in my knowledge graph this week.
Who are the most connected people? What new organizational relationships formed?
Identify any Person entities that have become more central (higher connection count) this week.
Highlight any collaboration patterns, reporting relationships, or team dynamics visible in the graph.
Focus on changes and new connections, not just the full static picture.`,
  },
  {
    id: 'decision_audit',
    name: 'Decision Audit',
    description: 'Review decisions made this week with supporting evidence',
    frequency: 'weekly',
    icon: 'GitBranch',
    systemPrompt: `Query all Decision entities from this week with their supporting evidence and related risks.
For each decision: what evidence supports it? What risks or blockers are connected?
Are there any decisions that appear underdocumented or lack supporting rationale?
Identify decisions that may need follow-up actions or review.
Flag any conflicting decisions or decisions that contradict established goals.`,
  },
  {
    id: 'knowledge_velocity',
    name: 'Knowledge Velocity',
    description: 'Quantitative graph growth metrics for the week',
    frequency: 'weekly',
    icon: 'BarChart2',
    systemPrompt: `Provide a quantitative analysis of my knowledge graph's growth this week.
How many new entities were created? What types? How many new relationships?
What sources were processed and what types?
Which anchor nodes grew the most connections?
Compare the activity distribution across entity types (Person, Project, Topic, etc.).
Present as a clear metrics summary with the most significant growth areas highlighted.`,
  },
  {
    id: 'week_ahead',
    name: 'Week Ahead Preparation',
    description: 'Recommended focus areas for the coming week',
    frequency: 'weekly',
    icon: 'CalendarCheck',
    systemPrompt: `Based on active projects, pending actions, open questions, and scheduled events in my knowledge graph,
synthesize what I should focus on next week.
Identify: unresolved blockers that need clearing, actions that are overdue,
goals that are at risk of slipping, and opportunities to make progress on stalled projects.
Provide a prioritized list of recommended focus areas with reasoning.`,
  },

  // ─── MONTHLY (6) ───────────────────────────────────────────────────────────
  {
    id: 'strategic_arc',
    name: 'Strategic Arc Review',
    description: "How strategic priorities have shifted over the month",
    frequency: 'monthly',
    icon: 'Compass',
    systemPrompt: `Review Goal and Project entities across the full month in my knowledge graph.
How have strategic priorities shifted? Which goals are on track, which are drifting?
What new strategic themes emerged that weren't present at the start of the month?
Identify any goals that were abandoned, completed, or significantly reprioritized.
Provide a strategic narrative of the month's direction and momentum.`,
  },
  {
    id: 'goal_trajectory',
    name: 'Goal Trajectory Analysis',
    description: 'Deep progress analysis on all active goals',
    frequency: 'monthly',
    icon: 'Target',
    systemPrompt: `Perform a deep analysis of Goal entities in my knowledge graph.
For each active goal: what progress is indicated by connected Action and Decision nodes?
What Risk and Blocker entities are threatening this goal?
Which goals have strong supporting evidence and which lack execution momentum?
Rate each goal's trajectory (on track / at risk / stalled) with specific evidence from the graph.`,
  },
  {
    id: 'network_evolution',
    name: 'Network Evolution',
    description: "How the knowledge graph's structure changed this month",
    frequency: 'monthly',
    icon: 'Share2',
    systemPrompt: `Analyze how my knowledge graph has changed structurally this month.
What new clusters or topic domains have formed?
Which entities have become the most central connectors (bridge nodes)?
Are there any isolated subgraphs or knowledge islands that are disconnected?
What entity types grew the fastest? What relationship types are most common?
Provide a structural health assessment of the knowledge graph.`,
  },
  {
    id: 'knowledge_portfolio',
    name: 'Knowledge Portfolio Assessment',
    description: "Where your knowledge portfolio is deep, shallow, or missing",
    frequency: 'monthly',
    icon: 'PieChart',
    systemPrompt: `Categorize all knowledge in my graph by entity type and topic domain.
Where is the portfolio deep (many entities, strong descriptions, dense connections)?
Where is it shallow (few entities, sparse descriptions, weak connections)?
What is the distribution of source types contributing to the graph?
Identify 3 knowledge areas that are well-developed and 3 that need investment.
Recommend what types of sources to ingest next month to balance the portfolio.`,
  },
  {
    id: 'hypothesis_review',
    name: 'Hypothesis & Assumption Review',
    description: "Which hypotheses have strengthened or weakened this month",
    frequency: 'monthly',
    icon: 'FlaskConical',
    systemPrompt: `Query Hypothesis entities and their supporting or contradicting evidence accumulated this month.
For each hypothesis: what new evidence has strengthened it? What has weakened or contradicted it?
Which hypotheses should be promoted to facts (strong evidence) or retired (contradicted)?
Identify any untested hypotheses that have sat without evidence gathering.
Summarize the state of your hypothesis portfolio.`,
  },
  {
    id: 'monthly_priorities',
    name: 'Monthly Priorities Framework',
    description: 'Synthesized priorities and focus areas for next month',
    frequency: 'monthly',
    icon: 'Layers',
    systemPrompt: `Synthesize this month's learnings into a prioritized framework for next month.
Based on goal trajectories, emerging themes, unresolved blockers, and knowledge gaps:
What should receive more attention and investment next month?
What should be deprioritized or handed off?
What are the top 5 strategic priorities with clear rationale?
Present as an actionable monthly planning framework.`,
  },
]

export function getTemplatesForFrequency(
  frequency: 'daily' | 'weekly' | 'monthly'
): DigestTemplate[] {
  return DIGEST_TEMPLATES.filter(t => t.frequency === frequency)
}

/** Maps legacy/variant template IDs to current canonical IDs */
const TEMPLATE_ALIASES: Record<string, string> = {
  weekly_progress_review: 'weekly_progress',
  weekly_next_week_preview: 'week_ahead',
}

export function getTemplateById(id: string): DigestTemplate | undefined {
  const canonicalId = TEMPLATE_ALIASES[id] ?? id
  return DIGEST_TEMPLATES.find(t => t.id === canonicalId)
}
