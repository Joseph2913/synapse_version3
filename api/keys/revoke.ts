/**
 * api/keys/revoke.ts
 *
 * Vercel serverless function — revokes (deletes) an API key by id.
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
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const userId = await getUserIdFromJwt(req.headers.authorization)
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const { id } = req.body as { id?: string }

    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'Missing key id' })
    }

    const sb = getServiceSupabase()

    const { data, error } = await sb
      .from('synapse_api_keys')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
      .select('id')

    if (error) {
      return res.status(500).json({ error: 'Internal error' })
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Key not found' })
    }

    return res.status(200).json({ success: true })
  } catch {
    return res.status(500).json({ error: 'Internal error' })
  }
}
