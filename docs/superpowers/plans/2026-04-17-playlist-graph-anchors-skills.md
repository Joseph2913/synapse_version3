# Playlist Graph: Anchors & Skills Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add confirmed anchors and active skills as hexagonal nodes in the playlist graph view, with amber/teal color coding, glowing edges, density sliders, and right-panel detail views.

**Architecture:** Two new query functions fetch ranked anchors and skills. A layout pass positions hexagons in white space between playlist clusters. SVG rendering adds hexagon shapes, dotted glowing edges, and click-to-panel interaction. Control bar gets toggle pills and density sliders.

**Tech Stack:** React 18, TypeScript strict, SVG rendering, Supabase client queries, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-04-17-playlist-graph-anchors-skills-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/types/explore.ts` | Modify | Add `PlaylistGraphAnchor`, `PlaylistGraphSkill` types |
| `src/services/exploreQueries.ts` | Modify | Add `fetchGraphAnchors()`, `fetchGraphSkills()` |
| `src/hooks/useHexagonLayout.ts` | Create | Position hexagons in interstitial white space |
| `src/views/explore/PlaylistGraphView.tsx` | Modify | Integrate anchors/skills: state, fetching, SVG rendering, edges, click handlers, control bar |
| `src/views/explore/PlaylistAnchorPanel.tsx` | Create | Read-only anchor detail panel for graph context |
| `src/views/explore/PlaylistSkillPanel.tsx` | Create | Read-only skill detail panel for graph context |

---

### Task 1: Add Types

**Files:**
- Modify: `src/types/explore.ts:114` (after `ExploreRightPanelContent`)

- [ ] **Step 1: Add PlaylistGraphAnchor and PlaylistGraphSkill interfaces**

At the end of the Playlist Graph types section in `src/types/explore.ts` (after line 148, before the Entity Browser types comment), add:

```typescript
export interface PlaylistGraphAnchor {
  id: string                    // anchor_candidates.id
  nodeId: string                // knowledge_nodes.id
  label: string
  entityType: string
  description: string | null
  compositeScore: number
  entityCount: number
  connectedSourceIds: string[]  // source IDs with entities linked to this anchor
}

export interface PlaylistGraphSkill {
  id: string
  name: string
  title: string
  description: string
  domain: string | null
  confidence: number
  sourceIds: string[]           // source_ids from the skill record
  usageCount: number
  sourceCount: number
  tags: string[]
  relevanceScore: number        // computed ranking score
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No new errors related to these types (they're not imported yet).

- [ ] **Step 3: Commit**

```bash
git add src/types/explore.ts
git commit -m "feat: add PlaylistGraphAnchor and PlaylistGraphSkill types"
```

---

### Task 2: Add Query Functions

**Files:**
- Modify: `src/services/exploreQueries.ts` (add after the `fetchPlaylistGraph` function, around line 900)

- [ ] **Step 1: Add fetchGraphAnchors function**

Add the following at the end of `src/services/exploreQueries.ts`:

```typescript
// ─── fetchGraphAnchors ──────────────────────────────────────────────────────
// Fetch top N confirmed anchors with connected source IDs for the playlist graph.

import type { PlaylistGraphAnchor, PlaylistGraphSkill } from '../types/explore'

export async function fetchGraphAnchors(userId: string, limit: number): Promise<PlaylistGraphAnchor[]> {
  // 1. Get top confirmed anchors by composite score
  const { data: candidates, error: candErr } = await supabase
    .from('anchor_candidates')
    .select(`
      id,
      node_id,
      composite_score,
      knowledge_nodes!inner (
        id, label, entity_type, description
      )
    `)
    .eq('user_id', userId)
    .eq('status', 'confirmed')
    .order('composite_score', { ascending: false })
    .limit(limit)

  if (candErr) throw new Error(candErr.message)
  if (!candidates || candidates.length === 0) return []

  // 2. For each anchor's node_id, find connected source IDs via edges
  const nodeIds = candidates.map((c: Record<string, unknown>) => (c.node_id as string))

  // Get all edges involving these anchor nodes
  const { data: edges, error: edgeErr } = await supabase
    .from('knowledge_edges')
    .select('source_node_id, target_node_id')
    .eq('user_id', userId)
    .or(`source_node_id.in.(${nodeIds.join(',')}),target_node_id.in.(${nodeIds.join(',')})`)

  if (edgeErr) throw new Error(edgeErr.message)

  // Build nodeId → set of connected entity IDs
  const nodeIdSet = new Set(nodeIds)
  const anchorToEntityIds = new Map<string, Set<string>>()
  for (const nid of nodeIds) anchorToEntityIds.set(nid, new Set())

  for (const e of edges ?? []) {
    const src = e.source_node_id as string
    const tgt = e.target_node_id as string
    if (nodeIdSet.has(src) && !nodeIdSet.has(tgt)) {
      anchorToEntityIds.get(src)!.add(tgt)
    }
    if (nodeIdSet.has(tgt) && !nodeIdSet.has(src)) {
      anchorToEntityIds.get(tgt)!.add(src)
    }
  }

  // 3. Resolve entity IDs → source IDs
  const allEntityIds = new Set<string>()
  for (const set of anchorToEntityIds.values()) {
    for (const eid of set) allEntityIds.add(eid)
  }

  // Batch fetch source_id for all connected entities
  const entityIdArray = Array.from(allEntityIds)
  const entityToSource = new Map<string, string>()

  // Fetch in batches of 500 to avoid URL length limits
  for (let i = 0; i < entityIdArray.length; i += 500) {
    const batch = entityIdArray.slice(i, i + 500)
    const { data: entityRows, error: entityErr } = await supabase
      .from('knowledge_nodes')
      .select('id, source_id')
      .in('id', batch)

    if (entityErr) throw new Error(entityErr.message)
    for (const row of entityRows ?? []) {
      const r = row as { id: string; source_id: string | null }
      if (r.source_id) entityToSource.set(r.id, r.source_id)
    }
  }

  // Build final result
  return candidates.map((c: Record<string, unknown>) => {
    const node = c.knowledge_nodes as { id: string; label: string; entity_type: string; description: string | null }
    const entityIds = anchorToEntityIds.get(c.node_id as string) ?? new Set<string>()
    const sourceIds = new Set<string>()
    for (const eid of entityIds) {
      const sid = entityToSource.get(eid)
      if (sid) sourceIds.add(sid)
    }

    return {
      id: c.id as string,
      nodeId: c.node_id as string,
      label: node.label,
      entityType: node.entity_type,
      description: node.description,
      compositeScore: (c.composite_score as number) ?? 0,
      entityCount: entityIds.size,
      connectedSourceIds: Array.from(sourceIds),
    }
  })
}
```

- [ ] **Step 2: Add fetchGraphSkills function**

Directly after `fetchGraphAnchors`, add:

```typescript
// ─── fetchGraphSkills ───────────────────────────────────────────────────────
// Fetch top N active skills ranked by relevance for the playlist graph.

export async function fetchGraphSkills(userId: string, limit: number): Promise<PlaylistGraphSkill[]> {
  const { data, error } = await supabase
    .from('knowledge_skills')
    .select('id, name, title, description, domain, confidence, source_ids, usage_count, source_count, tags')
    .eq('user_id', userId)
    .eq('status', 'active')

  if (error) throw new Error(error.message)
  if (!data || data.length === 0) return []

  // Compute relevance scores
  const maxUsage = Math.max(...data.map((s: Record<string, unknown>) => (s.usage_count as number) ?? 0), 1)
  const maxSources = Math.max(...data.map((s: Record<string, unknown>) => (s.source_count as number) ?? 0), 1)

  const scored = data.map((s: Record<string, unknown>) => {
    const confidence = (s.confidence as number) ?? 0
    const usageCount = (s.usage_count as number) ?? 0
    const sourceCount = (s.source_count as number) ?? 0
    const relevanceScore =
      confidence * 0.4 +
      (usageCount / maxUsage) * 0.3 +
      (sourceCount / maxSources) * 0.3

    return {
      id: s.id as string,
      name: s.name as string,
      title: s.title as string,
      description: (s.description as string) ?? '',
      domain: (s.domain as string | null),
      confidence,
      sourceIds: (s.source_ids as string[]) ?? [],
      usageCount,
      sourceCount,
      tags: (s.tags as string[]) ?? [],
      relevanceScore,
    }
  })

  // Sort by relevance and take top N
  scored.sort((a, b) => b.relevanceScore - a.relevanceScore)
  return scored.slice(0, limit)
}
```

- [ ] **Step 3: Move the import to the top of the file**

The `import type { PlaylistGraphAnchor, PlaylistGraphSkill }` must be added to the existing import at line 2 of `exploreQueries.ts`. Update the import to include the new types:

```typescript
import type { ClusterData, CrossClusterEdge, TypeDistributionEntry, EntityNode, EntityWithConnections, PlaylistNode, PlaylistEdge, PlaylistVideoNode, PlaylistVideoEdge, PlaylistGraphAnchor, PlaylistGraphSkill } from '../types/explore'
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No new errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/exploreQueries.ts src/types/explore.ts
git commit -m "feat: add fetchGraphAnchors and fetchGraphSkills query functions"
```

---

### Task 3: Create Hexagon Layout Hook

**Files:**
- Create: `src/hooks/useHexagonLayout.ts`

- [ ] **Step 1: Create the layout hook**

```typescript
// src/hooks/useHexagonLayout.ts
// Positions anchor/skill hexagons in the white space between playlist clusters.

import { useMemo } from 'react'

interface ClusterCenter {
  id: string
  x: number
  y: number
  radius: number
}

interface HexNode {
  id: string
  connectedClusterIds: string[]  // playlist IDs this hex connects to
  kind: 'anchor' | 'skill'
  score: number                  // for sizing
}

export interface HexPosition {
  id: string
  x: number
  y: number
  radius: number                 // hex circumradius in px
  kind: 'anchor' | 'skill'
}

/** Generate a deterministic angle from a string ID (0 to 2*PI) */
function hashAngle(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
  }
  return (Math.abs(hash) % 360) * (Math.PI / 180)
}

export function useHexagonLayout(
  hexNodes: HexNode[],
  clusterCenters: ClusterCenter[],
  canvasWidth: number,
  canvasHeight: number,
): HexPosition[] {
  return useMemo(() => {
    if (hexNodes.length === 0 || clusterCenters.length === 0) return []

    const clusterMap = new Map<string, ClusterCenter>()
    for (const c of clusterCenters) clusterMap.set(c.id, c)

    const positions: HexPosition[] = []

    for (const node of hexNodes) {
      // Find connected clusters that exist in the current graph
      const connected = node.connectedClusterIds
        .map(id => clusterMap.get(id))
        .filter((c): c is ClusterCenter => c !== undefined)

      if (connected.length === 0) continue

      // Hex radius based on kind and score
      const hexRadius = node.kind === 'anchor'
        ? 14 + node.score * 6   // 14-20px
        : 12 + node.score * 4   // 12-16px

      let x: number
      let y: number

      if (connected.length === 1) {
        // Single cluster: place just outside its boundary
        const c = connected[0]!
        const angle = hashAngle(node.id)
        const dist = c.radius + 30 + hexRadius
        x = c.x + Math.cos(angle) * dist
        y = c.y + Math.sin(angle) * dist
      } else {
        // Multiple clusters: centroid of connected cluster centers
        x = connected.reduce((sum, c) => sum + c.x, 0) / connected.length
        y = connected.reduce((sum, c) => sum + c.y, 0) / connected.length
      }

      positions.push({ id: node.id, x, y, radius: hexRadius, kind: node.kind })
    }

    // Step 2: Push outside cluster boundaries
    for (const pos of positions) {
      for (const cluster of clusterCenters) {
        const dx = pos.x - cluster.x
        const dy = pos.y - cluster.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        const minDist = cluster.radius + pos.radius + 20

        if (dist < minDist && dist > 0) {
          const push = (minDist - dist) / dist
          pos.x += dx * push
          pos.y += dy * push
        }
      }
    }

    // Step 3: Repulsion between hexagons (10 iterations)
    const MIN_SEP = 40
    for (let iter = 0; iter < 10; iter++) {
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          const a = positions[i]!
          const b = positions[j]!
          const dx = b.x - a.x
          const dy = b.y - a.y
          const dist = Math.sqrt(dx * dx + dy * dy)

          if (dist < MIN_SEP && dist > 0) {
            const push = ((MIN_SEP - dist) / dist) * 0.5
            a.x -= dx * push
            a.y -= dy * push
            b.x += dx * push
            b.y += dy * push
          }
        }
      }
    }

    // Step 4: Boundary containment (soft push)
    const PAD = 50
    for (const pos of positions) {
      if (canvasWidth > 0 && canvasHeight > 0) {
        // Use canvas bounds as rough guide (positions are in world space,
        // but we assume the cluster layout uses a similar coordinate range)
        const maxExtent = Math.max(canvasWidth, canvasHeight) * 1.5
        if (pos.x < -maxExtent) pos.x = -maxExtent + PAD
        if (pos.x > maxExtent) pos.x = maxExtent - PAD
        if (pos.y < -maxExtent) pos.y = -maxExtent + PAD
        if (pos.y > maxExtent) pos.y = maxExtent - PAD
      }
    }

    return positions
  }, [hexNodes, clusterCenters, canvasWidth, canvasHeight])
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: Clean compile.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useHexagonLayout.ts
git commit -m "feat: add useHexagonLayout hook for anchor/skill positioning"
```

---

### Task 4: Create Anchor Detail Panel for Graph Context

**Files:**
- Create: `src/views/explore/PlaylistAnchorPanel.tsx`

This is a read-only panel that shows anchor info when clicked in the graph. It's simpler than the full `AnchorDetailPanel` (no confirm/dismiss/archive actions) because these are already-confirmed anchors.

- [ ] **Step 1: Create PlaylistAnchorPanel**

```typescript
// src/views/explore/PlaylistAnchorPanel.tsx
import { useState, useEffect } from 'react'
import { X, Network, FileText, Link2 } from 'lucide-react'
import { EntityBadge } from '../../components/shared/EntityBadge'
import { getEntityColor } from '../../config/entityTypes'
import { supabase } from '../../services/supabase'
import { useAuth } from '../../hooks/useAuth'
import type { PlaylistGraphAnchor } from '../../types/explore'

interface PlaylistAnchorPanelProps {
  anchor: PlaylistGraphAnchor
  onClose: () => void
}

interface ConnectedAnchor {
  id: string
  label: string
  entityType: string
  edgeCount: number
}

export function PlaylistAnchorPanel({ anchor, onClose }: PlaylistAnchorPanelProps) {
  const { user } = useAuth()
  const [connections, setConnections] = useState<ConnectedAnchor[]>([])
  const [totalEdges, setTotalEdges] = useState(0)
  const color = getEntityColor(anchor.entityType)

  // Fetch connections to other anchors
  useEffect(() => {
    if (!user) return
    let cancelled = false

    const fetchConnections = async () => {
      // Get edges from this anchor node
      const [outRes, inRes] = await Promise.all([
        supabase.from('knowledge_edges').select('target_node_id').eq('source_node_id', anchor.nodeId).eq('user_id', user.id),
        supabase.from('knowledge_edges').select('source_node_id').eq('target_node_id', anchor.nodeId).eq('user_id', user.id),
      ])

      if (cancelled) return

      const edgeCounts = new Map<string, number>()
      for (const r of outRes.data ?? []) {
        const id = r.target_node_id as string
        edgeCounts.set(id, (edgeCounts.get(id) ?? 0) + 1)
      }
      for (const r of inRes.data ?? []) {
        const id = r.source_node_id as string
        edgeCounts.set(id, (edgeCounts.get(id) ?? 0) + 1)
      }
      edgeCounts.delete(anchor.nodeId)
      setTotalEdges(edgeCounts.size)

      // Check which connected nodes are anchors
      const connIds = Array.from(edgeCounts.keys()).slice(0, 50)
      if (connIds.length === 0) { setConnections([]); return }

      const { data: nodes } = await supabase
        .from('knowledge_nodes')
        .select('id, label, entity_type, is_anchor')
        .in('id', connIds)
        .eq('is_anchor', true)

      if (cancelled) return

      const anchorConns: ConnectedAnchor[] = (nodes ?? []).map((n: Record<string, unknown>) => ({
        id: n.id as string,
        label: n.label as string,
        entityType: n.entity_type as string,
        edgeCount: edgeCounts.get(n.id as string) ?? 0,
      }))
      anchorConns.sort((a, b) => b.edgeCount - a.edgeCount)
      setConnections(anchorConns.slice(0, 10))
    }

    fetchConnections()
    return () => { cancelled = true }
  }, [anchor.nodeId, user])

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        width: 320,
        height: '100%',
        background: 'var(--color-bg-card)',
        borderLeft: '1px solid var(--border-subtle)',
        zIndex: 40,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
          <EntityBadge entityType={anchor.entityType} />
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center cursor-pointer"
            style={{ width: 24, height: 24, borderRadius: 6, background: 'none', border: 'none', color: 'var(--color-text-secondary)' }}
          >
            <X size={14} />
          </button>
        </div>
        <h3 className="font-display" style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}>
          {anchor.label}
        </h3>
        {anchor.description && (
          <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '6px 0 0', lineHeight: 1.5 }}>
            {anchor.description}
          </p>
        )}
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-4" style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-1.5">
          <Network size={12} style={{ color: 'var(--color-text-placeholder)' }} />
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            <strong style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{connections.length}</strong> anchor connections
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Link2 size={12} style={{ color: 'var(--color-text-placeholder)' }} />
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            <strong style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{totalEdges}</strong> edges
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <FileText size={12} style={{ color: 'var(--color-text-placeholder)' }} />
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            <strong style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{anchor.connectedSourceIds.length}</strong> sources
          </span>
        </div>
      </div>

      {/* Score bar */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>Composite Score</span>
          <span className="font-body" style={{ fontSize: 11, fontWeight: 600, color }}>
            {Math.round(anchor.compositeScore * 100)}%
          </span>
        </div>
        <div style={{ height: 4, borderRadius: 2, background: 'var(--color-bg-content)' }}>
          <div style={{ height: '100%', width: `${anchor.compositeScore * 100}%`, borderRadius: 2, background: color }} />
        </div>
      </div>

      {/* Connected anchors */}
      <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
        {connections.length > 0 && (
          <>
            <div className="font-display" style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-placeholder)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
              Top Connections ({connections.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {connections.map(conn => (
                <div key={conn.id} className="flex items-center gap-2" style={{ padding: '4px 0' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: getEntityColor(conn.entityType), flexShrink: 0 }} />
                  <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {conn.label}
                  </span>
                  <span className="font-body" style={{ fontSize: 10, color: 'var(--color-text-placeholder)', flexShrink: 0 }}>
                    {conn.edgeCount} edge{conn.edgeCount !== 1 ? 's' : ''}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
        {connections.length === 0 && (
          <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)', textAlign: 'center', padding: '20px 0' }}>
            No anchor connections found
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: Clean compile.

- [ ] **Step 3: Commit**

```bash
git add src/views/explore/PlaylistAnchorPanel.tsx
git commit -m "feat: add PlaylistAnchorPanel for graph anchor detail view"
```

---

### Task 5: Create Skill Detail Panel for Graph Context

**Files:**
- Create: `src/views/explore/PlaylistSkillPanel.tsx`

Read-only skill panel showing full content when a skill hexagon is clicked.

- [ ] **Step 1: Create PlaylistSkillPanel**

```typescript
// src/views/explore/PlaylistSkillPanel.tsx
import { useState, useEffect } from 'react'
import { X, FileText, Sparkles, BarChart3, ChevronDown, ChevronRight } from 'lucide-react'
import { SourceIcon } from '../../components/shared/SourceIcon'
import { supabase } from '../../services/supabase'
import { useAuth } from '../../hooks/useAuth'
import type { PlaylistGraphSkill } from '../../types/explore'

interface PlaylistSkillPanelProps {
  skill: PlaylistGraphSkill
  onClose: () => void
}

const DOMAIN_COLORS: Record<string, string> = {
  'ai-tooling':              '#3b82f6',
  'ai-prompting':            '#8b5cf6',
  'consulting-methodology':  '#d63a00',
  'change-management':       '#059669',
  'financial-analysis':      '#d97706',
  'risk-management':         '#ef4444',
  'sales-methodology':       '#ec4899',
  'project-management':      '#0891b2',
  'product-design':          '#6366f1',
  'general':                 '#6b7280',
}

function getDomainColor(domain: string | null): string {
  if (!domain) return '#6b7280'
  return DOMAIN_COLORS[domain] ?? '#6b7280'
}

interface ContentSection {
  heading: string
  body: string
}

function parseContentSections(content: string): ContentSection[] {
  const sections: ContentSection[] = []
  const lines = content.split('\n')
  let currentHeading = ''
  let currentBody: string[] = []

  for (const line of lines) {
    const h2Match = line.match(/^## (.+)/)
    const h3Match = !h2Match ? line.match(/^### (.+)/) : null
    const heading = h2Match?.[1]?.trim() ?? h3Match?.[1]?.trim() ?? null

    if (heading) {
      if (currentHeading || currentBody.length > 0) {
        const body = currentBody.join('\n').trim()
        if (body.length > 0) {
          sections.push({ heading: currentHeading || 'Overview', body })
        }
      }
      currentHeading = heading
      currentBody = []
    } else {
      currentBody.push(line)
    }
  }

  if (currentHeading || currentBody.length > 0) {
    const body = currentBody.join('\n').trim()
    if (body.length > 0) {
      sections.push({ heading: currentHeading || 'Overview', body })
    }
  }

  return sections
}

interface SkillSource {
  id: string
  title: string
  sourceType: string
}

export function PlaylistSkillPanel({ skill, onClose }: PlaylistSkillPanelProps) {
  const { user } = useAuth()
  const [content, setContent] = useState<string | null>(null)
  const [sources, setSources] = useState<SkillSource[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['Overview']))

  const domainColor = getDomainColor(skill.domain)

  // Fetch full skill content + sources
  useEffect(() => {
    if (!user) return
    let cancelled = false
    setLoading(true)

    const fetchDetail = async () => {
      // Get full content
      const { data: skillData } = await supabase
        .from('knowledge_skills')
        .select('content')
        .eq('id', skill.id)
        .maybeSingle()

      if (cancelled) return
      setContent((skillData as { content: string } | null)?.content ?? null)

      // Get source details
      if (skill.sourceIds.length > 0) {
        const { data: sourceData } = await supabase
          .from('knowledge_sources')
          .select('id, title, source_type')
          .in('id', skill.sourceIds)

        if (cancelled) return
        setSources((sourceData ?? []).map((s: Record<string, unknown>) => ({
          id: s.id as string,
          title: s.title as string,
          sourceType: s.source_type as string,
        })))
      }

      setLoading(false)
    }

    fetchDetail()
    return () => { cancelled = true }
  }, [skill.id, user])

  const sections = content ? parseContentSections(content) : []

  const toggleSection = (heading: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (next.has(heading)) next.delete(heading)
      else next.add(heading)
      return next
    })
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        width: 320,
        height: '100%',
        background: 'var(--color-bg-card)',
        borderLeft: '1px solid var(--border-subtle)',
        zIndex: 40,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
          {skill.domain && (
            <span
              className="font-body"
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: domainColor,
                padding: '2px 8px',
                borderRadius: 10,
                background: `${domainColor}12`,
                border: `1px solid ${domainColor}25`,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              {skill.domain}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center cursor-pointer"
            style={{ width: 24, height: 24, borderRadius: 6, background: 'none', border: 'none', color: 'var(--color-text-secondary)' }}
          >
            <X size={14} />
          </button>
        </div>
        <h3 className="font-display" style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}>
          {skill.title}
        </h3>
        <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '6px 0 0', lineHeight: 1.5 }}>
          {skill.description}
        </p>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-4" style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-1.5">
          <FileText size={12} style={{ color: 'var(--color-text-placeholder)' }} />
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            <strong style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{skill.sourceCount}</strong> sources
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Sparkles size={12} style={{ color: 'var(--color-text-placeholder)' }} />
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            <strong style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{skill.usageCount}</strong> uses
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <BarChart3 size={12} style={{ color: 'var(--color-text-placeholder)' }} />
          <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            <strong style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{Math.round(skill.confidence * 100)}%</strong>
          </span>
        </div>
      </div>

      {/* Tags */}
      {skill.tags.length > 0 && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {skill.tags.slice(0, 8).map(tag => (
            <span
              key={tag}
              className="font-body"
              style={{
                fontSize: 10,
                color: 'var(--color-text-secondary)',
                padding: '2px 6px',
                borderRadius: 8,
                background: 'var(--color-bg-content)',
              }}
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      {/* Content sections */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {loading && (
          <div className="font-body" style={{ fontSize: 11, color: 'var(--color-text-placeholder)', textAlign: 'center', padding: '20px 0' }}>
            Loading skill content...
          </div>
        )}
        {!loading && sections.map(section => {
          const isExpanded = expandedSections.has(section.heading)
          return (
            <div key={section.heading} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <button
                type="button"
                onClick={() => toggleSection(section.heading)}
                className="flex items-center gap-2 w-full cursor-pointer"
                style={{
                  padding: '10px 16px',
                  background: 'none',
                  border: 'none',
                  textAlign: 'left',
                }}
              >
                {isExpanded ? <ChevronDown size={12} style={{ color: 'var(--color-text-placeholder)', flexShrink: 0 }} /> : <ChevronRight size={12} style={{ color: 'var(--color-text-placeholder)', flexShrink: 0 }} />}
                <span className="font-display" style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                  {section.heading}
                </span>
              </button>
              {isExpanded && (
                <div
                  className="font-body"
                  style={{
                    padding: '0 16px 12px 32px',
                    fontSize: 11,
                    lineHeight: 1.7,
                    color: 'var(--color-text-body)',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {section.body}
                </div>
              )}
            </div>
          )
        })}

        {/* Sources */}
        {sources.length > 0 && (
          <div style={{ padding: '12px 16px' }}>
            <div className="font-display" style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-placeholder)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
              Sources ({sources.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {sources.map(source => (
                <div key={source.id} className="flex items-center gap-2" style={{ padding: '4px 0' }}>
                  <SourceIcon sourceType={source.sourceType} size={12} />
                  <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {source.title}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: Clean compile.

- [ ] **Step 3: Commit**

```bash
git add src/views/explore/PlaylistSkillPanel.tsx
git commit -m "feat: add PlaylistSkillPanel for graph skill detail view"
```

---

### Task 6: Integrate Data Fetching into PlaylistGraphView

**Files:**
- Modify: `src/views/explore/PlaylistGraphView.tsx`

This task adds state, imports, and the fetch calls. No rendering yet.

- [ ] **Step 1: Add imports**

At the top of `PlaylistGraphView.tsx`, add to the existing imports:

```typescript
import { fetchGraphAnchors, fetchGraphSkills } from '../../services/exploreQueries'
import { useHexagonLayout } from '../../hooks/useHexagonLayout'
import { PlaylistAnchorPanel } from './PlaylistAnchorPanel'
import { PlaylistSkillPanel } from './PlaylistSkillPanel'
import type { PlaylistGraphAnchor, PlaylistGraphSkill } from '../../types/explore'
```

- [ ] **Step 2: Add state variables**

After the existing state declarations (around line 131, after `const [legendOpen, setLegendOpen] = useState(false)`), add:

```typescript
  // Anchor & skill integration
  const [graphAnchors, setGraphAnchors] = useState<PlaylistGraphAnchor[]>([])
  const [graphSkills, setGraphSkills] = useState<PlaylistGraphSkill[]>([])
  const [showAnchors, setShowAnchors] = useState(true)
  const [showSkills, setShowSkills] = useState(true)
  const [anchorLimit, setAnchorLimit] = useState(50)
  const [skillLimit, setSkillLimit] = useState(15)
  const [selectedAnchorId, setSelectedAnchorId] = useState<string | null>(null)
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [hoveredHexId, setHoveredHexId] = useState<string | null>(null)
```

- [ ] **Step 3: Add anchor/skill fetching to the existing useEffect**

In the existing data fetch `useEffect` (around line 434), add anchor and skill fetching to the `Promise.all`:

Replace the existing Promise.all block:
```typescript
    Promise.all([
      fetchPlaylistGraph(user.id),
      fetchSourceGraph(user.id),
    ])
```

With:
```typescript
    Promise.all([
      fetchPlaylistGraph(user.id),
      fetchSourceGraph(user.id),
      fetchGraphAnchors(user.id, anchorLimit),
      fetchGraphSkills(user.id, skillLimit),
    ])
```

And update the `.then` callback to destructure the new results:

Replace:
```typescript
      .then(([playlistData, sourceData]) => {
```

With:
```typescript
      .then(([playlistData, sourceData, anchorData, skillData]) => {
```

And at the end of the `.then` block (just before the closing `})`), add:

```typescript
        setGraphAnchors(anchorData)
        setGraphSkills(skillData)
```

- [ ] **Step 4: Add dependency on limits to refetch**

The fetch `useEffect` depends on `user` but also needs to refetch when limits change. Update the dependency array from `[user]` to `[user, anchorLimit, skillLimit]`.

- [ ] **Step 5: Compute hex nodes for the layout hook**

After the `clusterRadii` useMemo (around line 236), add:

```typescript
  // ─── Anchor/skill hex layout ──────────────────────────────────────────────

  // Map source IDs to playlist IDs for anchor/skill cluster resolution
  const sourceToPlaylistId = useMemo(() => {
    const map = new Map<string, string>()
    for (const v of videos) map.set(v.sourceId, v.playlistId)
    return map
  }, [videos])

  // Build hex nodes for layout
  const hexNodes = useMemo(() => {
    const nodes: Array<{ id: string; connectedClusterIds: string[]; kind: 'anchor' | 'skill'; score: number }> = []

    if (showAnchors) {
      for (const a of graphAnchors) {
        const clusterIds = new Set<string>()
        for (const sid of a.connectedSourceIds) {
          const pid = sourceToPlaylistId.get(sid)
          if (pid) clusterIds.add(pid)
        }
        if (clusterIds.size > 0) {
          nodes.push({
            id: `anchor:${a.id}`,
            connectedClusterIds: Array.from(clusterIds),
            kind: 'anchor',
            score: a.compositeScore,
          })
        }
      }
    }

    if (showSkills) {
      for (const s of graphSkills) {
        const clusterIds = new Set<string>()
        for (const sid of s.sourceIds) {
          const pid = sourceToPlaylistId.get(sid)
          if (pid) clusterIds.add(pid)
        }
        if (clusterIds.size > 0) {
          nodes.push({
            id: `skill:${s.id}`,
            connectedClusterIds: Array.from(clusterIds),
            kind: 'skill',
            score: s.confidence,
          })
        }
      }
    }

    return nodes
  }, [graphAnchors, graphSkills, sourceToPlaylistId, showAnchors, showSkills])

  // Cluster centers for layout
  const clusterCentersForLayout = useMemo(() => {
    return Array.from(playlistCenterPositions.entries()).map(([id, pos]) => ({
      id,
      x: pos.x,
      y: pos.y,
      radius: clusterRadii.get(id) ?? 50,
    }))
  }, [playlistCenterPositions, clusterRadii])

  const hexPositions = useHexagonLayout(hexNodes, clusterCentersForLayout, size.width, size.height)

  // Lookup maps for quick access
  const anchorById = useMemo(() => {
    const map = new Map<string, PlaylistGraphAnchor>()
    for (const a of graphAnchors) map.set(a.id, a)
    return map
  }, [graphAnchors])

  const skillById = useMemo(() => {
    const map = new Map<string, PlaylistGraphSkill>()
    for (const s of graphSkills) map.set(s.id, s)
    return map
  }, [graphSkills])

  // Selected objects
  const selectedAnchor = selectedAnchorId ? anchorById.get(selectedAnchorId) ?? null : null
  const selectedSkill = selectedSkillId ? skillById.get(selectedSkillId) ?? null : null
```

- [ ] **Step 6: Add hex positions to the live nodes system**

In the `useEffect` that initializes live nodes from computed positions (around line 298), add hexagon positions. After the video loop, add:

```typescript
    for (const hex of hexPositions) {
      nodes.push({ id: `h:${hex.id}`, x: hex.x, y: hex.y, vx: 0, vy: 0 })
    }
```

Also add `hexPositions` to the dependency array of that `useEffect`.

- [ ] **Step 7: Add hex click handlers**

After the `handlePlaylistCenterClick` callback (around line 693), add:

```typescript
  const handleAnchorClick = useCallback((anchorId: string) => {
    if (hasDraggedRef.current) return
    setSelectedAnchorId(prev => prev === anchorId ? null : anchorId)
    setSelectedSkillId(null)
    setSelectedPlaylistId(null)
    setExploringVideoId(null)
  }, [])

  const handleSkillClick = useCallback((skillId: string) => {
    if (hasDraggedRef.current) return
    setSelectedSkillId(prev => prev === skillId ? null : skillId)
    setSelectedAnchorId(null)
    setSelectedPlaylistId(null)
    setExploringVideoId(null)
  }, [])
```

- [ ] **Step 8: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: Clean compile (handlers and positions exist but aren't rendered yet).

- [ ] **Step 9: Commit**

```bash
git add src/views/explore/PlaylistGraphView.tsx
git commit -m "feat: add anchor/skill data fetching and layout to PlaylistGraphView"
```

---

### Task 7: Add SVG Rendering for Hexagons and Edges

**Files:**
- Modify: `src/views/explore/PlaylistGraphView.tsx`

This task adds the SVG elements for hexagon nodes and their glowing edges.

- [ ] **Step 1: Add SVG glow filter definitions**

Inside the `<svg>` element, before the `<g transform=...>` group (around line 741), add SVG filter definitions:

```tsx
          {/* Glow filters for anchor/skill edges */}
          <defs>
            <filter id="glow-amber" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="glow-teal" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
```

- [ ] **Step 2: Add a hexagon path helper function**

At the top of the file (after the `videoRadius` and `playlistCenterRadius` functions, around line 108), add:

```typescript
/** Generate SVG path for a regular hexagon centered at (0,0) */
function hexagonPath(radius: number): string {
  const points: string[] = []
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 2  // start from top
    points.push(`${Math.cos(angle) * radius},${Math.sin(angle) * radius}`)
  }
  return `M${points.join('L')}Z`
}

const ANCHOR_COLOR = '#d97706'
const SKILL_COLOR = '#0891b2'
```

- [ ] **Step 3: Add anchor/skill edge rendering**

Inside the main SVG `<g>` group, after the cross-cluster video edges block (comment "2. All source edges") and before the video nodes block (comment "3. Video nodes"), add:

```tsx
            {/* 2b. Anchor → source edges (amber, dotted, glow) */}
            {showAnchors && hexPositions.filter(h => h.kind === 'anchor').map(hex => {
              const anchorId = hex.id.replace('anchor:', '')
              const anchor = anchorById.get(anchorId)
              if (!anchor) return null

              const hexLive = livePositions.get(`h:${hex.id}`)
              const hx = hexLive?.x ?? hex.x
              const hy = hexLive?.y ?? hex.y
              const isHexHovered = hoveredHexId === hex.id

              return anchor.connectedSourceIds.map(sourceId => {
                const vLive = livePositions.get(`v:${sourceId}`)
                const vPos = vLive ?? videoPositions.get(sourceId)
                if (!vPos) return null

                const isSourceHovered = hoveredVideoId === sourceId
                const highlighted = isHexHovered || isSourceHovered

                return (
                  <line
                    key={`ae-${hex.id}-${sourceId}`}
                    x1={hx} y1={hy}
                    x2={vPos.x} y2={vPos.y}
                    stroke={ANCHOR_COLOR}
                    strokeWidth={1.5}
                    strokeOpacity={highlighted ? 0.55 : 0.30}
                    strokeDasharray="3,3"
                    filter={highlighted ? 'url(#glow-amber)' : undefined}
                    style={{ transition: 'stroke-opacity 0.15s ease' }}
                  />
                )
              })
            })}

            {/* 2c. Skill → source edges (teal, dotted, glow) */}
            {showSkills && hexPositions.filter(h => h.kind === 'skill').map(hex => {
              const skillId = hex.id.replace('skill:', '')
              const skill = skillById.get(skillId)
              if (!skill) return null

              const hexLive = livePositions.get(`h:${hex.id}`)
              const hx = hexLive?.x ?? hex.x
              const hy = hexLive?.y ?? hex.y
              const isHexHovered = hoveredHexId === hex.id

              return skill.sourceIds.map(sourceId => {
                const vLive = livePositions.get(`v:${sourceId}`)
                const vPos = vLive ?? videoPositions.get(sourceId)
                if (!vPos) return null

                const isSourceHovered = hoveredVideoId === sourceId
                const highlighted = isHexHovered || isSourceHovered

                return (
                  <line
                    key={`se-${hex.id}-${sourceId}`}
                    x1={hx} y1={hy}
                    x2={vPos.x} y2={vPos.y}
                    stroke={SKILL_COLOR}
                    strokeWidth={1.5}
                    strokeOpacity={highlighted ? 0.55 : 0.30}
                    strokeDasharray="3,3"
                    filter={highlighted ? 'url(#glow-teal)' : undefined}
                    style={{ transition: 'stroke-opacity 0.15s ease' }}
                  />
                )
              })
            })}
```

- [ ] **Step 4: Add hexagon node rendering**

After the playlist center buttons block (comment "4. Playlist center buttons"), add:

```tsx
            {/* 5. Anchor hexagons */}
            {showAnchors && hexPositions.filter(h => h.kind === 'anchor').map(hex => {
              const anchorId = hex.id.replace('anchor:', '')
              const anchor = anchorById.get(anchorId)
              if (!anchor) return null

              const hexLive = livePositions.get(`h:${hex.id}`)
              const px = hexLive?.x ?? hex.x
              const py = hexLive?.y ?? hex.y
              const isHovered = hoveredHexId === hex.id
              const isSelected = selectedAnchorId === anchorId
              const scale = isHovered ? 1.08 : 1
              const label = anchor.label.length > 18 ? anchor.label.slice(0, 17) + '\u2026' : anchor.label

              return (
                <g
                  key={hex.id}
                  onMouseDown={e => handleNodeMouseDown(e, hex.id, 'video')}
                  onMouseEnter={() => { if (!dragRef.current) setHoveredHexId(hex.id) }}
                  onMouseLeave={() => { if (!dragRef.current) setHoveredHexId(null) }}
                  onClick={() => handleAnchorClick(anchorId)}
                  style={{ cursor: 'pointer' }}
                >
                  <g transform={`translate(${px}, ${py})`}>
                    <g transform={`scale(${scale})`} style={{ transition: 'transform 0.15s ease' }}>
                      {/* Glow ring on hover */}
                      {(isHovered || isSelected) && (
                        <path
                          d={hexagonPath(hex.radius + 5)}
                          fill="none"
                          stroke={ANCHOR_COLOR}
                          strokeWidth={isSelected ? 2 : 1.5}
                          strokeOpacity={isSelected ? 0.5 : 0.35}
                        />
                      )}
                      {/* Main hexagon */}
                      <path
                        d={hexagonPath(hex.radius)}
                        fill={`${ANCHOR_COLOR}12`}
                        stroke={ANCHOR_COLOR}
                        strokeWidth={2}
                        strokeDasharray={isSelected ? 'none' : '4,3'}
                      />
                      {/* Center dot in entity type color */}
                      <circle r={4} fill={getEntityColor(anchor.entityType)} />
                    </g>

                    <text
                      y={hex.radius + 12}
                      textAnchor="middle"
                      style={{
                        fontFamily: 'var(--font-body)',
                        fontSize: 10,
                        fontWeight: 500,
                        fill: ANCHOR_COLOR,
                        pointerEvents: 'none',
                        userSelect: 'none',
                      }}
                    >
                      {label}
                    </text>
                  </g>
                </g>
              )
            })}

            {/* 6. Skill hexagons */}
            {showSkills && hexPositions.filter(h => h.kind === 'skill').map(hex => {
              const skillId = hex.id.replace('skill:', '')
              const skill = skillById.get(skillId)
              if (!skill) return null

              const hexLive = livePositions.get(`h:${hex.id}`)
              const px = hexLive?.x ?? hex.x
              const py = hexLive?.y ?? hex.y
              const isHovered = hoveredHexId === hex.id
              const isSelected = selectedSkillId === skillId
              const scale = isHovered ? 1.08 : 1
              const label = skill.title.length > 18 ? skill.title.slice(0, 17) + '\u2026' : skill.title

              return (
                <g
                  key={hex.id}
                  onMouseDown={e => handleNodeMouseDown(e, hex.id, 'video')}
                  onMouseEnter={() => { if (!dragRef.current) setHoveredHexId(hex.id) }}
                  onMouseLeave={() => { if (!dragRef.current) setHoveredHexId(null) }}
                  onClick={() => handleSkillClick(skillId)}
                  style={{ cursor: 'pointer' }}
                >
                  <g transform={`translate(${px}, ${py})`}>
                    <g transform={`scale(${scale})`} style={{ transition: 'transform 0.15s ease' }}>
                      {/* Glow ring on hover */}
                      {(isHovered || isSelected) && (
                        <path
                          d={hexagonPath(hex.radius + 5)}
                          fill="none"
                          stroke={SKILL_COLOR}
                          strokeWidth={isSelected ? 2 : 1.5}
                          strokeOpacity={isSelected ? 0.5 : 0.35}
                        />
                      )}
                      {/* Main hexagon */}
                      <path
                        d={hexagonPath(hex.radius)}
                        fill={`${SKILL_COLOR}12`}
                        stroke={SKILL_COLOR}
                        strokeWidth={2}
                        strokeDasharray={isSelected ? 'none' : '4,3'}
                      />
                      {/* Center sparkle icon */}
                      <path
                        d="M0,-4 L1,-1 L4,0 L1,1 L0,4 L-1,1 L-4,0 L-1,-1 Z"
                        fill={SKILL_COLOR}
                        opacity={0.7}
                      />
                    </g>

                    <text
                      y={hex.radius + 12}
                      textAnchor="middle"
                      style={{
                        fontFamily: 'var(--font-body)',
                        fontSize: 10,
                        fontWeight: 500,
                        fill: SKILL_COLOR,
                        pointerEvents: 'none',
                        userSelect: 'none',
                      }}
                    >
                      {label}
                    </text>
                  </g>
                </g>
              )
            })}
```

Note: The `getEntityColor` import should already exist from `../../config/entityTypes` — if not, add it to the imports.

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: Clean compile.

- [ ] **Step 6: Commit**

```bash
git add src/views/explore/PlaylistGraphView.tsx
git commit -m "feat: add hexagon and edge SVG rendering for anchors and skills"
```

---

### Task 8: Add Right Panel Integration

**Files:**
- Modify: `src/views/explore/PlaylistGraphView.tsx`

- [ ] **Step 1: Add right panel rendering for anchors and skills**

After the existing right-side detail panels (the `SourceDetailCard` block for `exploringVideoId`, around line 1038), add:

```tsx
      {/* Right-side detail panel: anchor */}
      {selectedAnchor && (
        <PlaylistAnchorPanel
          anchor={selectedAnchor}
          onClose={() => setSelectedAnchorId(null)}
        />
      )}

      {/* Right-side detail panel: skill */}
      {selectedSkill && (
        <PlaylistSkillPanel
          skill={selectedSkill}
          onClose={() => setSelectedSkillId(null)}
        />
      )}
```

- [ ] **Step 2: Clear hex selections when clicking empty SVG space**

Update the `handleSvgClick` function (around line 633) to also clear hex selections:

Replace:
```typescript
    if (e.target === e.currentTarget && !hasDraggedRef.current) {
      setSelectedPlaylistId(null)
      setExploringVideoId(null)
    }
```

With:
```typescript
    if (e.target === e.currentTarget && !hasDraggedRef.current) {
      setSelectedPlaylistId(null)
      setExploringVideoId(null)
      setSelectedAnchorId(null)
      setSelectedSkillId(null)
    }
```

- [ ] **Step 3: Clear hex selections on Escape key**

Update the keyboard handler (around line 600) to also handle hex selections. In the `else if (e.key === 'Escape')` block, add:

```typescript
        else if (selectedAnchorId) setSelectedAnchorId(null)
        else if (selectedSkillId) setSelectedSkillId(null)
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: Clean compile.

- [ ] **Step 5: Commit**

```bash
git add src/views/explore/PlaylistGraphView.tsx
git commit -m "feat: add anchor/skill right panel integration"
```

---

### Task 9: Add Control Bar (Toggle Pills + Density Sliders)

**Files:**
- Modify: `src/views/explore/PlaylistGraphView.tsx`

- [ ] **Step 1: Add control bar overlay**

After the stats overlay (the `div` with "clusters / sources / cross-connections" around line 1086), add:

```tsx
      {/* Anchor/Skill toggle controls — top-left */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          left: 16,
          background: 'rgba(255,255,255,0.92)',
          backdropFilter: 'blur(8px)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 10,
          padding: '8px 12px',
          zIndex: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {/* Toggle row */}
        <div className="flex items-center gap-2">
          {/* Anchor toggle */}
          <button
            type="button"
            onClick={() => setShowAnchors(prev => !prev)}
            className="font-body font-semibold cursor-pointer"
            style={{
              borderRadius: 20,
              padding: '5px 13px',
              fontSize: 12,
              border: showAnchors
                ? '1px solid rgba(217,119,6,0.15)'
                : '1px solid var(--border-subtle)',
              background: showAnchors ? '#fef3c7' : 'transparent',
              color: showAnchors ? ANCHOR_COLOR : 'var(--color-text-secondary)',
              transition: 'all 0.15s ease',
            }}
          >
            Anchors
          </button>

          {/* Skill toggle */}
          <button
            type="button"
            onClick={() => setShowSkills(prev => !prev)}
            className="font-body font-semibold cursor-pointer"
            style={{
              borderRadius: 20,
              padding: '5px 13px',
              fontSize: 12,
              border: showSkills
                ? '1px solid rgba(8,145,178,0.15)'
                : '1px solid var(--border-subtle)',
              background: showSkills ? '#cffafe' : 'transparent',
              color: showSkills ? SKILL_COLOR : 'var(--color-text-secondary)',
              transition: 'all 0.15s ease',
            }}
          >
            Skills
          </button>
        </div>

        {/* Anchor density slider */}
        {showAnchors && graphAnchors.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="font-body" style={{ fontSize: 10, color: ANCHOR_COLOR, whiteSpace: 'nowrap', minWidth: 80 }}>
              Top {anchorLimit} anchors
            </span>
            <input
              type="range"
              min={10}
              max={Math.min(200, Math.max(graphAnchors.length, 10))}
              step={10}
              value={anchorLimit}
              onChange={e => setAnchorLimit(Number(e.target.value))}
              style={{
                width: 80,
                accentColor: ANCHOR_COLOR,
                height: 4,
              }}
            />
          </div>
        )}

        {/* Skill density slider */}
        {showSkills && graphSkills.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="font-body" style={{ fontSize: 10, color: SKILL_COLOR, whiteSpace: 'nowrap', minWidth: 80 }}>
              Top {skillLimit} skills
            </span>
            <input
              type="range"
              min={5}
              max={Math.min(50, Math.max(graphSkills.length, 5))}
              step={5}
              value={skillLimit}
              onChange={e => setSkillLimit(Number(e.target.value))}
              style={{
                width: 80,
                accentColor: SKILL_COLOR,
                height: 4,
              }}
            />
          </div>
        )}
      </div>
```

- [ ] **Step 2: Update stats overlay to include anchor/skill counts**

In the stats overlay (around line 1097), add two more stat spans after the "cross-connections" span:

```tsx
        {graphAnchors.length > 0 && showAnchors && (
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, color: 'var(--color-text-secondary)' }}>
            <strong style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: ANCHOR_COLOR }}>{hexPositions.filter(h => h.kind === 'anchor').length}</strong> anchors
          </span>
        )}
        {graphSkills.length > 0 && showSkills && (
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, color: 'var(--color-text-secondary)' }}>
            <strong style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: SKILL_COLOR }}>{hexPositions.filter(h => h.kind === 'skill').length}</strong> skills
          </span>
        )}
```

- [ ] **Step 3: Update legend to include anchor/skill entries**

After the playlist legend entries (around line 1082), add anchor and skill legend entries:

```tsx
            {showAnchors && (
              <div className="flex items-center gap-2">
                <svg width={9} height={9} viewBox="-5 -5 10 10" style={{ flexShrink: 0 }}>
                  <path d={hexagonPath(4)} fill={`${ANCHOR_COLOR}12`} stroke={ANCHOR_COLOR} strokeWidth={1} strokeDasharray="2,1" />
                </svg>
                <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, fontWeight: 500, color: ANCHOR_COLOR }}>
                  Anchors
                </span>
              </div>
            )}
            {showSkills && (
              <div className="flex items-center gap-2">
                <svg width={9} height={9} viewBox="-5 -5 10 10" style={{ flexShrink: 0 }}>
                  <path d={hexagonPath(4)} fill={`${SKILL_COLOR}12`} stroke={SKILL_COLOR} strokeWidth={1} strokeDasharray="2,1" />
                </svg>
                <span style={{ fontFamily: 'var(--font-body)', fontSize: 9, fontWeight: 500, color: SKILL_COLOR }}>
                  Skills
                </span>
              </div>
            )}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: Clean compile.

- [ ] **Step 5: Test in browser**

Run: `npm run dev` and navigate to Explore > Playlists view. Verify:
- Anchor and skill hexagons appear between playlist clusters
- Toggle pills show/hide anchors and skills
- Density sliders adjust node count
- Clicking a hexagon opens the detail panel
- Edges glow on hover
- Legend includes anchor/skill entries
- Stats show anchor/skill counts

- [ ] **Step 6: Commit**

```bash
git add src/views/explore/PlaylistGraphView.tsx
git commit -m "feat: add control bar with toggle pills and density sliders for anchors/skills"
```

---

### Task 10: Final Polish and Drag Integration Fix

**Files:**
- Modify: `src/views/explore/PlaylistGraphView.tsx`

The hexagon nodes use `handleNodeMouseDown(e, hex.id, 'video')` as a shortcut. This works for dragging but the live node IDs use `h:` prefix while the drag handler uses `v:` prefix. Fix the drag integration.

- [ ] **Step 1: Update drag handler to support hex nodes**

The `handleNodeMouseDown` callback (around line 642) uses a `nodeType` parameter of `'playlist' | 'video'`. Add a third type `'hex'`:

Update the type from:
```typescript
const handleNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string, nodeType: 'playlist' | 'video') => {
```
To:
```typescript
const handleNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string, nodeType: 'playlist' | 'video' | 'hex') => {
```

Update the `liveId` computation inside `handleNodeMouseDown`:
```typescript
    const liveId = nodeType === 'playlist' ? `p:${nodeId}` : nodeType === 'hex' ? `h:${nodeId}` : `v:${nodeId}`
```

Update the `dragRef` assignment:
```typescript
    dragRef.current = { id: nodeId, offsetX: worldX - node.x, offsetY: worldY - node.y, type: nodeType }
```

Update the `dragRef` interface to include `'hex'` in the type:
```typescript
const dragRef = useRef<{ id: string; offsetX: number; offsetY: number; type: 'playlist' | 'video' | 'hex' } | null>(null)
```

Update all places in the animation loop that reference `dragRef.current.type`:
- The `dragId` computation (around line 357):
```typescript
        const dragId = dragRef.current
          ? (dragRef.current.type === 'playlist' ? `p:${dragRef.current.id}` : dragRef.current.type === 'hex' ? `h:${dragRef.current.id}` : `v:${dragRef.current.id}`)
          : null
```

- The `onMove` handler inside `handleNodeMouseDown`:
```typescript
      const lid = dragRef.current.type === 'playlist' ? `p:${dragRef.current.id}` : dragRef.current.type === 'hex' ? `h:${dragRef.current.id}` : `v:${dragRef.current.id}`
```

- The `onUp` handler:
```typescript
        const lid = dragRef.current.type === 'playlist' ? `p:${dragRef.current.id}` : dragRef.current.type === 'hex' ? `h:${dragRef.current.id}` : `v:${dragRef.current.id}`
```

- The `dragNode` lookup in the animation loop (around line 321):
```typescript
        const dragNode = nodeMap.get(
          dragRef.current.type === 'playlist' ? `p:${dragRef.current.id}` : dragRef.current.type === 'hex' ? `h:${dragRef.current.id}` : `v:${dragRef.current.id}`
        )
```

- [ ] **Step 2: Update hex SVG nodes to use 'hex' type**

In Task 7 Step 4, the hexagon `<g>` elements use `handleNodeMouseDown(e, hex.id, 'video')`. Update both the anchor and skill hexagon blocks to use:

```tsx
onMouseDown={e => handleNodeMouseDown(e, hex.id, 'hex')}
```

- [ ] **Step 3: Add hex connectivity to drift system**

In the connectivity `useEffect` (around line 277), add hex-to-source links:

After the cross-playlist video edges block, add:

```typescript
    // Hex → connected sources (weak drift)
    for (const hex of hexPositions) {
      const hexId = `h:${hex.id}`
      const isAnchor = hex.kind === 'anchor'
      const anchorId = hex.id.replace('anchor:', '')
      const skillId = hex.id.replace('skill:', '')
      const sourceIds = isAnchor
        ? (anchorById.get(anchorId)?.connectedSourceIds ?? [])
        : (skillById.get(skillId)?.sourceIds ?? [])

      for (const sid of sourceIds) {
        addLink(hexId, `v:${sid}`, 0.3)
      }
    }
```

Add `hexPositions`, `anchorById`, `skillById` to the dependency array of that `useEffect`.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: Clean compile.

- [ ] **Step 5: Full browser test**

Run `npm run dev` and verify:
- Hexagons are draggable
- Connected sources drift slightly when a hexagon is dragged
- Clicking empty space clears all selections
- Escape key dismisses panels
- Toggle pills and sliders all work
- No console errors

- [ ] **Step 6: Commit**

```bash
git add src/views/explore/PlaylistGraphView.tsx
git commit -m "feat: fix drag integration for hex nodes and add drift connectivity"
```

---

### Task 11: Add getEntityColor Import If Missing

**Files:**
- Modify: `src/views/explore/PlaylistGraphView.tsx` (only if `getEntityColor` is not already imported)

- [ ] **Step 1: Check if getEntityColor is imported**

Search the existing imports in `PlaylistGraphView.tsx`. If `getEntityColor` from `../../config/entityTypes` is not present, add it:

```typescript
import { getEntityColor } from '../../config/entityTypes'
```

- [ ] **Step 2: Verify final build**

Run: `npm run build 2>&1 | tail -10`
Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit if any changes**

```bash
git add src/views/explore/PlaylistGraphView.tsx
git commit -m "chore: ensure getEntityColor import for anchor hexagons"
```
