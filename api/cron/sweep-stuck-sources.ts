import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('[supabase] Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
}
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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

// Authenticated as cron via Vercel signature or shared secret. No user JWT path.
function verifyCronAuth(req: VercelRequest): boolean {
  if (req.headers['x-vercel-signature']) return true;
  if (!CRON_SECRET) return true;
  const auth = req.headers['authorization'];
  return !!(auth && auth === `Bearer ${CRON_SECRET}`);
}

// ─── HANDLER ───────────────────────────────────────────────────────────────────
//
// Stage 2 stuck-source sweep. Marks any knowledge_sources row that has been in
// a non-terminal status for >1 hour as 'degraded'. Hourly cadence is fine
// because sources stuck this long indicate a real failure upstream that the
// retry queue (FAILURE-POLICY) should pick up. Idempotent: re-running flips
// nothing because the WHERE clause excludes already-degraded rows.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!verifyCronAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startTime = Date.now();
  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago

  try {
    const { data, error } = await supabase
      .from('knowledge_sources')
      .update({ status: 'degraded' })
      .in('status', ['pending', 'chunking', 'extracting', 'augmenting'])
      .lt('created_at', cutoff)
      .select('id, user_id, status, created_at');

    if (error) {
      logError({ stage: 'persist:sweep', status: 'failed', error: error.message });
      return res.status(500).json({ error: error.message });
    }

    const updated = data ?? [];
    log({
      stage: 'persist:sweep',
      status: 'ok',
      count: updated.length,
      cutoff,
      duration_ms: Date.now() - startTime,
    });

    return res.status(200).json({
      success: true,
      degraded: updated.length,
      cutoff,
      duration_ms: Date.now() - startTime,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError({ stage: 'persist:sweep', status: 'failed', error: msg });
    return res.status(500).json({
      success: false,
      error: msg,
      duration_ms: Date.now() - startTime,
    });
  }
}
