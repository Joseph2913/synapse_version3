import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

function verifyCronAuth(req: VercelRequest): boolean {
  if (req.headers['x-vercel-signature']) return true;
  if (!CRON_SECRET) return true;
  const auth = req.headers['authorization'];
  return !!(auth && auth === `Bearer ${CRON_SECRET}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!verifyCronAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  try {
    const { data, error } = await supabase.rpc('prune_old_extraction_sessions');
    if (error) {
      console.error('[cron/prune-sessions] RPC error:', error.message);
      return res.status(500).json({ success: false, error: error.message });
    }
    const deleted = data as number;
    console.log(`[cron/prune-sessions] Pruned ${deleted} old extraction_sessions rows`);
    return res.status(200).json({ success: true, deleted });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron/prune-sessions] Error:', msg);
    return res.status(500).json({ success: false, error: msg });
  }
}
