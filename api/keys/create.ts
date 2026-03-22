/**
 * api/keys/create.ts
 *
 * Vercel serverless function — creates a new Synapse API key.
 * CRITICAL: Fully self-contained. No local imports. All helpers defined inline.
 *
 * PRD-24: API Key Management
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

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

// ─── Key generation ──────────────────────────────────────────────────────────

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function generateRawKey(): string {
  const bytes = crypto.randomBytes(40)
  let chars = ''
  for (let i = 0; i < 40; i++) {
    chars += BASE62[bytes[i]! % 62]
  }
  return `sk-syn-${chars}`
}

function hashKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex')
}

// ─── Max keys constant ──────────────────────────────────────────────────────

const MAX_KEYS_PER_USER = 10

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const userId = await getUserIdFromJwt(req.headers.authorization)
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const { label } = req.body as { label?: string }

    // Validate label
    if (!label || typeof label !== 'string' || label.trim().length === 0 || label.trim().length > 50) {
      return res.status(400).json({ error: 'Label must be between 1 and 50 characters.' })
    }

    const trimmedLabel = label.trim()
    const sb = getServiceSupabase()

    // Check key count limit
    const { count, error: countError } = await sb
      .from('synapse_api_keys')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)

    if (countError) {
      return res.status(500).json({ error: 'Internal error' })
    }

    if ((count ?? 0) >= MAX_KEYS_PER_USER) {
      return res.status(400).json({
        error: 'Maximum of 10 API keys allowed. Revoke an existing key to create a new one.',
      })
    }

    // Generate key
    const rawKey = generateRawKey()
    const keyHash = hashKey(rawKey)
    const keyPrefix = rawKey.slice(0, 12)

    // Insert
    const { data, error: insertError } = await sb
      .from('synapse_api_keys')
      .insert({
        user_id: userId,
        label: trimmedLabel,
        key_prefix: keyPrefix,
        key_hash: keyHash,
      })
      .select('id, label, key_prefix, created_at')
      .single()

    if (insertError || !data) {
      return res.status(500).json({ error: 'Failed to create API key' })
    }

    return res.status(200).json({
      id: data.id,
      label: data.label,
      key_prefix: data.key_prefix,
      raw_key: rawKey,
      created_at: data.created_at,
    })
  } catch {
    return res.status(500).json({ error: 'Internal error' })
  }
}
