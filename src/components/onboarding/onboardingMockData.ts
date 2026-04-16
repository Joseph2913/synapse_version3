import { Home, Compass, MessageSquare, Database, Radio, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// ─── Source ──────────────────────────────────────────────────────────────────

export interface MockSource {
  title: string
  type: string
  age: string
  entityCount: number
  color: string
  bgColor: string
}

export const MOCK_SOURCES: MockSource[] = [
  {
    title: 'How AI Agents Actually Work - Full Breakdown',
    type: 'YouTube',
    age: '2h ago',
    entityCount: 24,
    color: '#dc2626',
    bgColor: '#fef2f2',
  },
  {
    title: 'Product Strategy Sync - Q2 Roadmap',
    type: 'Meeting',
    age: '5h ago',
    entityCount: 31,
    color: '#ea580c',
    bgColor: '#fff7ed',
  },
  {
    title: 'Market Analysis: Personal Knowledge Tools 2026',
    type: 'Document',
    age: '1d ago',
    entityCount: 56,
    color: '#2563eb',
    bgColor: '#eff6ff',
  },
  {
    title: 'Graph RAG vs Traditional RAG - Benchmark Study',
    type: 'Research',
    age: '1d ago',
    entityCount: 18,
    color: '#9333ea',
    bgColor: '#faf5ff',
  },
  {
    title: 'Notes: Competitive positioning for enterprise',
    type: 'Note',
    age: '2d ago',
    entityCount: 12,
    color: '#16a34a',
    bgColor: '#f0fdf4',
  },
  {
    title: 'Building Knowledge Graphs at Scale',
    type: 'YouTube',
    age: '3d ago',
    entityCount: 19,
    color: '#dc2626',
    bgColor: '#fef2f2',
  },
]

// ─── Anchor ───────────────────────────────────────────────────────────────────

export interface MockAnchor {
  name: string
  entityCount: number
  score: number
  status: 'Active' | 'Growing' | 'Suggested'
  color: string
  connectionCount: number
}

export const MOCK_ANCHORS: MockAnchor[] = [
  {
    name: 'AI Agents',
    entityCount: 142,
    score: 94,
    status: 'Active',
    color: '#d63a00',
    connectionCount: 38,
  },
  {
    name: 'Product Strategy',
    entityCount: 87,
    score: 81,
    status: 'Active',
    color: '#2563eb',
    connectionCount: 24,
  },
  {
    name: 'Knowledge Graphs',
    entityCount: 73,
    score: 76,
    status: 'Growing',
    color: '#9333ea',
    connectionCount: 19,
  },
  {
    name: 'Market Intelligence',
    entityCount: 61,
    score: 68,
    status: 'Growing',
    color: '#16a34a',
    connectionCount: 15,
  },
  {
    name: 'LLM Tooling',
    entityCount: 44,
    score: 55,
    status: 'Suggested',
    color: '#ea580c',
    connectionCount: 11,
  },
  {
    name: 'Enterprise SaaS',
    entityCount: 38,
    score: 49,
    status: 'Suggested',
    color: '#0891b2',
    connectionCount: 9,
  },
]

// ─── Advisor ──────────────────────────────────────────────────────────────────

export interface AdvisorTheme {
  label: string
  color: string
  bgColor: string
}

export interface MockAdvisor {
  name: string
  health: 'Strong' | 'Growing' | 'Thin'
  healthColor: string
  healthBg: string
  description: string
  iconBg: string
  videoCount: number
  insightCount: number
  themes: AdvisorTheme[]
}

export const MOCK_ADVISORS: MockAdvisor[] = [
  {
    name: 'The AI Systems Analyst',
    health: 'Strong',
    healthColor: '#16a34a',
    healthBg: '#f0fdf4',
    description: 'Deep expertise in agent architectures, tool use, and multi-model orchestration. Surfaces technical patterns across your AI content.',
    iconBg: '#fef2f2',
    videoCount: 14,
    insightCount: 31,
    themes: [
      { label: 'Agent Architectures', color: '#dc2626', bgColor: '#fef2f2' },
      { label: 'Tool Use', color: '#ea580c', bgColor: '#fff7ed' },
      { label: 'Orchestration', color: '#9333ea', bgColor: '#faf5ff' },
    ],
  },
  {
    name: 'The Product Strategist',
    health: 'Growing',
    healthColor: '#2563eb',
    healthBg: '#eff6ff',
    description: 'Synthesizes roadmap thinking, competitive signals, and user insight from meetings and documents.',
    iconBg: '#eff6ff',
    videoCount: 8,
    insightCount: 19,
    themes: [
      { label: 'Roadmapping', color: '#2563eb', bgColor: '#eff6ff' },
      { label: 'Competitive Intel', color: '#16a34a', bgColor: '#f0fdf4' },
    ],
  },
  {
    name: 'The Market Researcher',
    health: 'Growing',
    healthColor: '#ea580c',
    healthBg: '#fff7ed',
    description: 'Tracks market trends, competitor moves, and opportunity signals from documents and research sources.',
    iconBg: '#fff7ed',
    videoCount: 6,
    insightCount: 14,
    themes: [
      { label: 'Market Trends', color: '#ea580c', bgColor: '#fff7ed' },
      { label: 'Opportunity Signals', color: '#0891b2', bgColor: '#ecfeff' },
    ],
  },
  {
    name: 'The Knowledge Architect',
    health: 'Thin',
    healthColor: '#9333ea',
    healthBg: '#faf5ff',
    description: 'Focuses on graph structure, entity relationships, and how knowledge connects across your content.',
    iconBg: '#faf5ff',
    videoCount: 4,
    insightCount: 9,
    themes: [
      { label: 'Graph Theory', color: '#9333ea', bgColor: '#faf5ff' },
      { label: 'Knowledge Structure', color: '#16a34a', bgColor: '#f0fdf4' },
    ],
  },
]

// ─── Skill ────────────────────────────────────────────────────────────────────

export interface MockSkill {
  title: string
  domain: string
  domainColor: string
  domainBg: string
  description: string
}

export const MOCK_SKILLS: MockSkill[] = [
  {
    title: 'Multi-Agent Orchestration Framework',
    domain: 'AI Systems',
    domainColor: '#dc2626',
    domainBg: '#fef2f2',
    description: 'A structured methodology for decomposing complex tasks across specialized agents, synthesized from 14 videos and research papers in your knowledge base.',
  },
  {
    title: 'Competitive Positioning Canvas',
    domain: 'Product Strategy',
    domainColor: '#2563eb',
    domainBg: '#eff6ff',
    description: 'Framework for mapping competitive differentiation across axes of value, synthesized from product strategy meetings and market analysis documents.',
  },
]

// ─── Source Entities ──────────────────────────────────────────────────────────

export interface MockSourceEntity {
  name: string
  type: string
  color: string
}

export const MOCK_SOURCE_ENTITIES: MockSourceEntity[] = [
  { name: 'Andrew Ng', type: 'Person', color: '#ea580c' },
  { name: 'Multi-Agent Systems', type: 'Topic', color: '#9333ea' },
  { name: 'Tool Use', type: 'Concept', color: '#0891b2' },
  { name: 'LangChain', type: 'Technology', color: '#16a34a' },
  { name: 'AutoGPT', type: 'Product', color: '#d63a00' },
  { name: 'ReAct Pattern', type: 'Concept', color: '#0891b2' },
  { name: 'OpenAI', type: 'Organization', color: '#2563eb' },
  { name: 'Chain of Thought', type: 'Concept', color: '#9333ea' },
]

// ─── Stats ────────────────────────────────────────────────────────────────────

export interface MockStats {
  totalSources: number
  totalNodes: number
  activeAnchors: number
  activeSkills: number
  sourceBreakdown: {
    youtube: number
    meetings: number
    documents: number
    notes: number
    research: number
  }
}

export const MOCK_STATS: MockStats = {
  totalSources: 247,
  totalNodes: 1842,
  activeAnchors: 12,
  activeSkills: 8,
  sourceBreakdown: {
    youtube: 94,
    meetings: 61,
    documents: 48,
    notes: 27,
    research: 17,
  },
}

// ─── Page Definitions ─────────────────────────────────────────────────────────

export interface PageDefinition {
  id: string
  name: string
  icon: LucideIcon
  description: string
  features: string[]
  accentFeatures: string[]
}

export const PAGES: PageDefinition[] = [
  {
    id: 'home',
    name: 'Home',
    icon: Home,
    description:
      'Your dashboard. See what\'s been ingested, how your knowledge is growing, and which council advisors are active. Everything you\'ve added shows up here as your knowledge feed.',
    features: [
      'Knowledge feed with recent ingestions',
      'Active anchor summaries',
      'Council advisor status',
    ],
    accentFeatures: ['Live ingestion updates', 'Quick capture shortcut'],
  },
  {
    id: 'explore',
    name: 'Explore',
    icon: Compass,
    description:
      'Visualize your knowledge as an interactive graph. Anchors are your key focus areas that cluster related entities into navigable bubbles. Click any cluster to dive into its neighborhood.',
    features: [
      'Interactive knowledge graph',
      'Anchor cluster visualization',
      'Entity browser with filters',
    ],
    accentFeatures: ['Drill-down into any cluster', 'Graph lens switching'],
  },
  {
    id: 'ask',
    name: 'Ask',
    icon: MessageSquare,
    description:
      'Chat with your knowledge graph using Graph RAG. Get answers grounded in your actual sources with inline citations. Switch to Council mode for multi-perspective reasoning from your domain advisors.',
    features: [
      'Graph RAG chat interface',
      'Inline source citations',
      'Council multi-perspective mode',
    ],
    accentFeatures: ['Grounded answers from your content', 'Advisor reasoning chains'],
  },
  {
    id: 'sources',
    name: 'Sources',
    icon: Database,
    description:
      'Everything you\'ve ingested into Synapse lives here. Browse your YouTube videos, meeting transcripts, documents, notes, and research. Click any source to see extracted entities, connected anchors, and key takeaways.',
    features: [
      'All ingested content in one place',
      'Filter by source type',
      'Entity and anchor connections per source',
    ],
    accentFeatures: ['Key takeaway extraction', 'Re-extraction controls'],
  },
  {
    id: 'signals',
    name: 'Signals',
    icon: Radio,
    description:
      'Your knowledge intelligence layer. Anchors are auto-detected focus areas that organize your graph. Skills are methodologies learned from your content. Together they make your knowledge graph smarter over time.',
    features: [
      'Anchor management and scoring',
      'Skill library from ingested content',
      'Signal health and coverage',
    ],
    accentFeatures: ['Auto-detected focus areas', 'Synthesized methodologies'],
  },
  {
    id: 'council',
    name: 'Council',
    icon: Users,
    description:
      'Your board of domain expert advisors, built from your own knowledge. Each advisor generates insights, sends cross-domain signals, and maintains standing questions. They reason independently and surface connections you might miss.',
    features: [
      'Domain expert advisor profiles',
      'Cross-domain insight signals',
      'Standing questions per advisor',
    ],
    accentFeatures: ['Built from your content', 'Independent reasoning agents'],
  },
]
