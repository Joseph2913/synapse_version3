import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID!;
const MICROSOFT_REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI!;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Microsoft OAuth scopes for Outlook + Teams
const SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'User.Read',
  'Calendars.Read',
  'Mail.Read',
  'OnlineMeetings.Read',
  'OnlineMeetingTranscript.Read.All',
].join(' ');

// ─── AUTH ──────────────────────────────────────────────────────────────────────

async function getUserFromToken(req: VercelRequest): Promise<string | null> {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const supabase = getSupabase();
  const { data } = await supabase.auth.getUser(token);
  return data?.user?.id ?? null;
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const userId = await getUserFromToken(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!MICROSOFT_CLIENT_ID || !MICROSOFT_REDIRECT_URI) {
      return res.status(500).json({ error: 'Microsoft OAuth not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_REDIRECT_URI.' });
    }

    // Generate a random state parameter to prevent CSRF
    // Encode user_id in state so callback can associate tokens with the user
    const state = Buffer.from(JSON.stringify({
      userId,
      nonce: Math.random().toString(36).substring(2, 15),
    })).toString('base64url');

    // Build the Microsoft OAuth authorization URL
    const params = new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID,
      response_type: 'code',
      redirect_uri: MICROSOFT_REDIRECT_URI,
      response_mode: 'query',
      scope: SCOPES,
      state,
      prompt: 'consent', // Always show consent to ensure we get refresh_token
    });

    const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;

    return res.status(200).json({ authUrl, state });
  } catch (err) {
    console.error('[microsoft-connect] Error:', err);
    return res.status(500).json({ error: 'Failed to generate authorization URL' });
  }
}
