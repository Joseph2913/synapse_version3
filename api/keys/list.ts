/**
 * api/keys/list.ts
 *
 * Vercel serverless function — lists all API keys for the authenticated user.
 * CRITICAL: Fully self-contained. No local imports. All helpers defined inline.
 *
 * PRD-24: API Key Management
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

// ─── Inline Supabase helpers ─────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

function getServiceSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
}

// ─── Auth helper: extract user_id from Supabase JWT ──────────────────────────

async function getUserIdFromJwt(authHeader: string | undefined): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user.id
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const userId = await getUserIdFromJwt(req.headers.authorization)
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const sb = getServiceSupabase()

    const { data, error } = await sb
      .from('synapse_api_keys')
      .select('id, label, key_prefix, created_at, last_used_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (error) {
      return res.status(500).json({ error: 'Internal error' })
    }

    return res.status(200).json(data ?? [])
  } catch {
    return res.status(500).json({ error: 'Internal error' })
  }
}
