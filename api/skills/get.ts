/**
 * api/skills/get.ts
 *
 * Returns the user's skill library. Called by MCP get_skills tool and future UI.
 * CRITICAL: Fully self-contained. No local imports.
 *
 * PRD-26 — Persistent Skill Pipeline
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 10

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''


// ─── Structured logging ─────────────────────────────────────────────────────

type LogStatus = 'ok' | 'failed' | 'partial' | 'skipped'

interface LogFields {
  stage: string
  user_id?: string
  source_id?: string
  duration_ms?: number
  status?: LogStatus
  error?: string
  [k: string]: unknown
}

function log(fields: LogFields): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }))
}

function logError(fields: LogFields & { error: string }): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', ...fields }))
}

function getSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
}

async function getUserFromToken(req: VercelRequest): Promise<string | null> {
  const auth = req.headers['authorization']
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  const sb = getSupabase()
  const { data } = await sb.auth.getUser(token)
  return data?.user?.id ?? null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'Supabase not configured' })

  const userId = await getUserFromToken(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const supabase = getSupabase()

  const domain = req.query.domain as string | undefined
  const status = req.query.status as string ?? 'confirmed'
  const minConfidence = parseFloat(req.query.min_confidence as string ?? '0')
  const exposureLevel = req.query.exposure_level as string | undefined
  const limit = Math.min(parseInt(req.query.limit as string ?? '50', 10), 100)
  const includeSources = req.query.include_sources === 'true'

  try {
    let query = supabase
      .from('knowledge_skills')
      .select('id, name, title, domain, exposure_level, confidence, status, evidence_count, when_to_apply, how_to_apply, related_anchor_ids, last_reinforced_at, signal_breakdown, description')
      .eq('user_id', userId)
      .eq('status', status)
      .gte('confidence', minConfidence)
      .order('confidence', { ascending: false })
      .limit(limit)

    if (domain) query = query.eq('domain', domain)
    if (exposureLevel) query = query.eq('exposure_level', exposureLevel)

    const { data: skills, error } = await query

    if (error) return res.status(500).json({ error: error.message })
    if (!skills || skills.length === 0) return res.status(200).json({ skills: [], total: 0 })

    // Optionally fetch anchor labels
    const allAnchorIds = new Set<string>()
    for (const s of skills) {
      for (const aid of (s.related_anchor_ids as string[] ?? [])) {
        allAnchorIds.add(aid)
      }
    }

    let anchorLabelMap = new Map<string, string>()
    if (allAnchorIds.size > 0) {
      const { data: anchorNodes } = await supabase
        .from('knowledge_nodes')
        .select('id, label')
        .in('id', [...allAnchorIds])
        .eq('user_id', userId)

      for (const n of (anchorNodes ?? []) as Array<{ id: string; label: string }>) {
        anchorLabelMap.set(n.id, n.label)
      }
    }

    // Optionally fetch contributing source titles
    let sourcesBySkill = new Map<string, string[]>()
    if (includeSources) {
      const skillIds = skills.map(s => s.id as string)
      const { data: junctions } = await supabase
        .from('skill_sources')
        .select('skill_id, source_id')
        .in('skill_id', skillIds)

      if (junctions) {
        const sourceIds = new Set<string>()
        for (const j of junctions as Array<{ skill_id: string; source_id: string }>) {
          sourceIds.add(j.source_id)
        }

        const { data: sourceTitles } = await supabase
          .from('knowledge_sources')
          .select('id, title')
          .in('id', [...sourceIds])

        const titleMap = new Map<string, string>()
        for (const s of (sourceTitles ?? []) as Array<{ id: string; title: string }>) {
          titleMap.set(s.id, s.title)
        }

        for (const j of junctions as Array<{ skill_id: string; source_id: string }>) {
          const existing = sourcesBySkill.get(j.skill_id) ?? []
          const title = titleMap.get(j.source_id)
          if (title) existing.push(title)
          sourcesBySkill.set(j.skill_id, existing)
        }
      }
    }

    const enriched = skills.map(s => ({
      ...s,
      related_anchor_labels: ((s.related_anchor_ids as string[]) ?? []).map(id => anchorLabelMap.get(id)).filter(Boolean),
      contributing_source_titles: includeSources ? (sourcesBySkill.get(s.id as string) ?? []) : undefined,
    }))

    return res.status(200).json({ skills: enriched, total: enriched.length })
  } catch (err) {
    console.error('[skills/get] Error:', err)
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
}
