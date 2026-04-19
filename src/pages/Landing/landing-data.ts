// Static data used across landing page sections.

export interface GraphNode {
  x: number
  y: number
  r: number
  type: string
  label: string
}

export const GRAPH_NODES: GraphNode[] = [
  { x: 0.22, y: 0.30, r: 5, type: 'person',   label: 'Sarah K.' },
  { x: 0.34, y: 0.52, r: 7, type: 'anchor',   label: 'Q2 Strategy' },
  { x: 0.14, y: 0.62, r: 4, type: 'topic',    label: 'Pricing' },
  { x: 0.28, y: 0.74, r: 4, type: 'concept',  label: 'TAM expansion' },
  { x: 0.46, y: 0.36, r: 6, type: 'project',  label: 'InfoCert' },
  { x: 0.56, y: 0.22, r: 4, type: 'insight',  label: 'retention loop' },
  { x: 0.58, y: 0.60, r: 5, type: 'decision', label: 'ship v3 in May' },
  { x: 0.70, y: 0.44, r: 7, type: 'anchor',   label: 'GTM' },
  { x: 0.82, y: 0.30, r: 4, type: 'org',      label: 'Acme Ltd.' },
  { x: 0.88, y: 0.60, r: 5, type: 'risk',     label: 'churn signal' },
  { x: 0.72, y: 0.76, r: 4, type: 'action',   label: 'brief Ben' },
  { x: 0.50, y: 0.82, r: 4, type: 'lesson',   label: 'talk less sell more' },
]

export const GRAPH_EDGES: [number, number][] = [
  [0,1],[1,2],[1,3],[1,4],[4,5],[4,6],[6,7],[7,8],[7,9],[6,10],[3,11],[5,7],[6,11],[1,6]
]

export const ENTITY_COLOR: Record<string, string> = {
  person:   '#d97706',
  org:      '#7c3aed',
  topic:    '#0891b2',
  project:  '#059669',
  decision: '#db2777',
  action:   '#2563eb',
  risk:     '#dc2626',
  insight:  '#7c3aed',
  concept:  '#4f46e5',
  anchor:   '#b45309',
  lesson:   '#65a30d',
}

export const HEADLINES: Record<string, { main: string; emph: string }> = {
  'second-brain':     { main: 'Your second brain,', emph: 'compounding.' },
  'cross-referenced': { main: 'Every thought,', emph: 'cross-referenced.' },
  'stop-organising':  { main: 'Stop organising.', emph: 'Start understanding.' },
  'infrastructure':   { main: 'Infrastructure for', emph: 'thinking.' },
}

export interface PipelineStep {
  k: string
  n: string
  label: string
  caption: string
  blurb: string
  meta: string
}

export const PIPELINE_STEPS: PipelineStep[] = [
  {
    k: 'ingest', n: '01', label: 'Ingest',
    caption: 'Meetings \u00b7 video \u00b7 docs \u00b7 notes',
    blurb: 'Connects to what you already use \u2014 Zoom, Meet, Granola, Notion, Drive, Slack, YouTube. Continuous, in the background.',
    meta: 'Sources connected: 9',
  },
  {
    k: 'extract', n: '02', label: 'Extract',
    caption: '24 typed entities \u00b7 18 relation kinds',
    blurb: 'Every person, project, decision, risk, and insight is extracted and typed. Cited to the exact source timestamp.',
    meta: 'Confidence threshold: 0.88',
  },
  {
    k: 'connect', n: '03', label: 'Connect',
    caption: 'Cross-source \u00b7 embedding-ranked \u00b7 deduped',
    blurb: 'Entities mentioned in one doc and another get merged. A decision from a call is linked to the project it affects.',
    meta: 'Merges this week: 142',
  },
  {
    k: 'anchor', n: '04', label: 'Anchor',
    caption: 'Centrality \u00b7 velocity \u00b7 engagement',
    blurb: 'The important things surface. Anchors are scored by reference frequency, edit velocity, and attention.',
    meta: 'Active anchors: 187',
  },
  {
    k: 'query', n: '05', label: 'Query',
    caption: 'Graph-RAG \u00b7 MCP \u00b7 any model',
    blurb: 'Ask in natural language. Your agents read the same graph via MCP. Answers cite back to the exact source, every time.',
    meta: 'MCP clients: Claude, GPT, Cursor',
  },
]

export interface StageVisibility {
  nodes: number[]
  edges: number[]
  highlight?: number[]
  query?: boolean
}

export const STAGE_VISIBLE: Record<string, StageVisibility> = {
  ingest:  { nodes: [0, 4], edges: [] },
  extract: { nodes: [0, 1, 2, 3, 4, 5, 6, 7], edges: [] },
  connect: { nodes: [0,1,2,3,4,5,6,7,8,9,10,11], edges: [0,1,2,3,4,5,6,7,8,9,10,11,12,13] },
  anchor:  { nodes: [0,1,2,3,4,5,6,7,8,9,10,11], edges: [0,1,2,3,4,5,6,7,8,9,10,11,12,13], highlight: [1, 7] },
  query:   { nodes: [0,1,2,3,4,5,6,7,8,9,10,11], edges: [0,1,2,3,4,5,6,7,8,9,10,11,12,13], highlight: [1, 7], query: true },
}

export interface AgentStep {
  t: number
  line: string
  kind: 'call' | 'out' | 'answer'
}

export interface AgentCite {
  src: string
  loc: string
  kind: string
  quote: string
  who: string
}

export interface AgentScenario {
  k: string
  badge: string
  badgeColor: string
  title: string
  tagline: string
  prompt: string
  steps: AgentStep[]
  cites: AgentCite[]
}

export const AGENT_SCENARIOS: AgentScenario[] = [
  {
    k: 'retrieve', badge: 'READ', badgeColor: 'accent',
    title: 'Retrieve knowledge',
    tagline: 'Cited answers from meetings, docs, calls.',
    prompt: 'Why did we decide to ship v3 in May?',
    steps: [
      { t: 0,    line: 'graph.search("ship v3 in May")',               kind: 'call' },
      { t: 400,  line: '\u2192 decision \u00b7 0.91 \u00b7 owned_by Ben R.',           kind: 'out' },
      { t: 900,  line: 'graph.trace(node, depth=2)',                    kind: 'call' },
      { t: 1300, line: '\u2192 3 sources \u00b7 4 relations',                      kind: 'out' },
      { t: 1800, line: 'Decided Apr 14 during exec sync.',             kind: 'answer' },
      { t: 2100, line: 'Supports GTM anchor, blocked by latency risk.', kind: 'answer' },
      { t: 2400, line: 'Cited: call\u00b7exec-sync@00:42:10, doc\u00b7may-launch.', kind: 'answer' },
    ],
    cites: [
      { src: 'call \u00b7 exec-sync', loc: '00:42:10', kind: 'call',
        quote: '\u201COK, committing to May for v3. Ben will own the ship date.\u201D', who: 'Sarah K.' },
      { src: 'doc \u00b7 may-launch-plan', loc: 'p.1', kind: 'doc',
        quote: 'Target release: May 14. Owned by: Ben R.', who: 'exec sync notes' },
      { src: 'slack \u00b7 #launches', loc: '2d ago', kind: 'slack',
        quote: 'v3 May ship confirmed. Marketing handoff Monday.', who: 'ben.r' },
    ],
  },
  {
    k: 'skill', badge: 'SKILL', badgeColor: 'ink',
    title: 'Apply a skill',
    tagline: 'Find the right playbook for the moment.',
    prompt: 'Sarah\u2019s onboarding a new PM next week \u2014 help me prep.',
    steps: [
      { t: 0,    line: 'graph.skills.find(context="onboarding", role="PM")', kind: 'call' },
      { t: 500,  line: '\u2192 skill \u00b7 "PM onboarding playbook" \u00b7 v3.2',     kind: 'out' },
      { t: 1000, line: 'graph.skill.match(current_entities)',               kind: 'call' },
      { t: 1400, line: '\u2192 adapts to: Q2 cycle, GTM anchor, v3 timeline',   kind: 'out' },
      { t: 1900, line: 'Loaded: 7-step playbook, 3 templates, 2 cases.',   kind: 'answer' },
      { t: 2200, line: 'Customised for Sarah\u2019s team \u00b7 ship v3 in scope.',kind: 'answer' },
      { t: 2500, line: 'Start with the day-1 intro meeting.',              kind: 'answer' },
    ],
    cites: [
      { src: 'skill \u00b7 pm-onboarding-playbook', loc: 'v3.2', kind: 'skill',
        quote: 'Day 1: intro to anchors. Day 2: shadow a cycle review. Day 3: own a small decision.', who: 'you, authored 6mo ago' },
      { src: 'template \u00b7 30-60-90-plan', loc: 'p.1', kind: 'doc',
        quote: 'Week 1: observe. Week 4: contribute. Week 12: own an anchor.', who: 'people ops' },
      { src: 'case \u00b7 ben\u2019s onboarding', loc: '8mo ago', kind: 'note',
        quote: 'What worked: pairing Ben with Sarah on GTM anchor from week 2.', who: 'you' },
      { src: 'doc \u00b7 team-rituals', loc: '\u00a73', kind: 'doc',
        quote: 'Mondays: async status. Thursdays: cycle review. Fridays: demo.', who: 'Ben R.' },
    ],
  },
  {
    k: 'share', badge: 'WRITE', badgeColor: 'green',
    title: 'Share back to the graph',
    tagline: 'Agents publish too \u2014 new decisions, notes, links.',
    prompt: 'Log the decision from today\u2019s pricing call.',
    steps: [
      { t: 0,    line: 'graph.propose({ type: "decision", ... })',      kind: 'call' },
      { t: 500,  line: '\u2192 staged \u00b7 3 inferred relations',                kind: 'out' },
      { t: 1000, line: 'graph.suggest_links(staged)',                   kind: 'call' },
      { t: 1400, line: '\u2192 links_to: GTM, Ship v3, pricing-sync',       kind: 'out' },
      { t: 1900, line: 'graph.commit(staged, cite="call\u00b7pricing\u00b721:03")', kind: 'call' },
      { t: 2300, line: '\u2713 written \u00b7 workspace now has 1 new decision.',kind: 'answer' },
      { t: 2600, line: 'Visible to teammates and every connected agent.', kind: 'answer' },
    ],
    cites: [
      { src: 'call \u00b7 pricing-sync', loc: '00:21:03', kind: 'call',
        quote: '\u201COK, lock in annual-only billing for enterprise tier.\u201D', who: 'Sarah K.' },
      { src: 'new decision \u00b7 staged', loc: 'just now', kind: 'doc',
        quote: 'Decision: annual-only enterprise billing, effective May launch.', who: 'agent \u00b7 on your behalf' },
      { src: 'inferred link', loc: '\u2192 GTM', kind: 'note',
        quote: 'Pricing affects GTM positioning \u2014 auto-linked.', who: 'graph' },
      { src: 'inferred link', loc: '\u2192 Ship v3', kind: 'note',
        quote: 'Ties to the May launch window.', who: 'graph' },
    ],
  },
]

// MCP client config snippets for the dynamic endpoint picker
export interface MCPClient {
  id: string
  name: string
  file: string
  snippet: string
}

export const MCP_CLIENTS: MCPClient[] = [
  {
    id: 'anthropic', name: 'Claude',
    file: 'claude_desktop_config.json',
    snippet: `{
  "mcpServers": {
    "synapse": {
      "command": "npx",
      "args": ["-y", "@synapse/mcp-server"],
      "env": { "SYNAPSE_TOKEN": "<your-token>" }
    }
  }
}`,
  },
  {
    id: 'openai', name: 'GPT',
    file: 'settings.json',
    snippet: `{
  "mcp": {
    "servers": {
      "synapse": {
        "command": "npx @synapse/mcp-server",
        "token": "<your-token>"
      }
    }
  }
}`,
  },
  {
    id: 'cursor', name: 'Cursor',
    file: '.cursor/mcp.json',
    snippet: `{
  "mcpServers": {
    "synapse": {
      "command": "npx",
      "args": ["-y", "@synapse/mcp-server"],
      "env": { "SYNAPSE_TOKEN": "<your-token>" }
    }
  }
}`,
  },
  {
    id: 'windsurf', name: 'Windsurf',
    file: '~/.codeium/windsurf/mcp.json',
    snippet: `{
  "mcpServers": {
    "synapse": {
      "command": "npx",
      "args": ["-y", "@synapse/mcp-server"],
      "env": { "SYNAPSE_TOKEN": "<your-token>" }
    }
  }
}`,
  },
  {
    id: 'zed', name: 'Zed',
    file: 'settings.json (Zed)',
    snippet: `{
  "context_servers": {
    "synapse": {
      "command": { "path": "npx", "args": ["-y", "@synapse/mcp-server"] },
      "settings": { "token": "<your-token>" }
    }
  }
}`,
  },
  {
    id: 'custom', name: 'Custom',
    file: 'curl / direct',
    snippet: `curl -X POST https://mcp.connectsynapse.com/v1 \\
  -H "Authorization: Bearer <your-token>" \\
  -H "Content-Type: application/json" \\
  -d '{"method": "graph.search", "params": {"q": "..."}}'`,
  },
]

// Anatomy section: entity data for the interactive sentence
export interface AnatomyEntity {
  id: string
  label: string
  type: string
  sentence: string
  isScene: boolean
}

export const ANATOMY_ENTITIES: AnatomyEntity[] = [
  { id: 'ship_v3', label: 'Ship v3 in May', type: 'decision', sentence: '', isScene: true },
  { id: 'gtm', label: 'GTM', type: 'anchor', sentence: '', isScene: true },
  { id: 'latency', label: 'latency risk', type: 'risk', sentence: '', isScene: true },
  { id: 'sarah', label: 'Sarah K.', type: 'person', sentence: '', isScene: false },
  { id: 'exec_sync', label: 'exec sync', type: 'event', sentence: '', isScene: false },
]

export interface AnatomyDetail {
  label: string
  type: string
  confidence: number
  firstSeen: string
  mentions: number
  trend: string
  relations: Array<{ verb: string; target: string; kind: string }>
  sources: Array<{ label: string; kind: string; loc: string }>
  mentionData: number[]
  agents: Array<{ model: string; query: string; result: string }>
}

export const ANATOMY_DETAILS: Record<string, AnatomyDetail> = {
  ship_v3: {
    label: 'Ship v3 in May', type: 'decision', confidence: 0.91,
    firstSeen: '14 Apr', mentions: 34,
    trend: '+200% in last 4 weeks',
    relations: [
      { verb: 'supports', target: 'GTM', kind: 'anchor' },
      { verb: 'owned_by', target: 'Ben R.', kind: 'person' },
      { verb: 'blocked_by', target: 'latency risk', kind: 'risk' },
      { verb: 'part_of', target: 'Q2 Strategy', kind: 'anchor' },
    ],
    sources: [
      { label: 'exec sync 04/14', kind: 'call', loc: '00:42:10' },
      { label: 'may-launch-plan', kind: 'doc', loc: 'p.1' },
      { label: '#launches', kind: 'slack', loc: '2d ago' },
    ],
    mentionData: [2, 4, 3, 7, 5, 9, 8, 12],
    agents: [
      { model: 'Claude', query: 'graph.get("ship_v3")', result: '{ type: "decision", conf: 0.91 }' },
    ],
  },
  gtm: {
    label: 'GTM', type: 'anchor', confidence: 0.96,
    firstSeen: '02 Mar', mentions: 89,
    trend: 'Steady, +12% last 4 weeks',
    relations: [
      { verb: 'contains', target: 'Ship v3 in May', kind: 'decision' },
      { verb: 'owned_by', target: 'Sarah K.', kind: 'person' },
      { verb: 'connected_to', target: 'Pricing', kind: 'topic' },
      { verb: 'enables', target: 'TAM expansion', kind: 'concept' },
    ],
    sources: [
      { label: 'strategy-deck-q2', kind: 'doc', loc: 'slide 4' },
      { label: 'weekly sync 04/10', kind: 'call', loc: '00:12:33' },
      { label: '#gtm-planning', kind: 'slack', loc: '6h ago' },
    ],
    mentionData: [8, 10, 9, 11, 10, 12, 11, 13],
    agents: [
      { model: 'Claude', query: 'graph.get("gtm")', result: '{ type: "anchor", conf: 0.96 }' },
    ],
  },
  latency: {
    label: 'latency risk', type: 'risk', confidence: 0.87,
    firstSeen: '10 Apr', mentions: 18,
    trend: 'New, spiking',
    relations: [
      { verb: 'blocks', target: 'Ship v3 in May', kind: 'decision' },
      { verb: 'raised_by', target: 'Sarah K.', kind: 'person' },
      { verb: 'affects', target: 'InfoCert', kind: 'project' },
    ],
    sources: [
      { label: 'exec sync 04/14', kind: 'call', loc: '00:38:22' },
      { label: 'perf-audit-v3', kind: 'doc', loc: '\u00a72.1' },
    ],
    mentionData: [0, 0, 0, 1, 3, 5, 8, 11],
    agents: [
      { model: 'Claude', query: 'graph.get("latency_risk")', result: '{ type: "risk", conf: 0.87 }' },
    ],
  },
}
