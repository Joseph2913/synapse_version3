import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 30;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID!;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET!;
const MICROSOFT_REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI!;
const APP_URL = process.env.APP_URL || 'https://synapse-v2.vercel.app';

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

interface MicrosoftProfile {
  id: string;
  displayName: string;
  mail?: string;
  userPrincipalName: string;
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // This endpoint is called by Microsoft's redirect — it's a GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code, state, error: oauthError, error_description } = req.query;

  if (oauthError) {
    console.error('[microsoft-callback] OAuth error:', oauthError, error_description);
    return res.redirect(`${APP_URL}/automate?microsoft_error=${encodeURIComponent(String(error_description || oauthError))}`);
  }

  if (!code || !state) {
    return res.redirect(`${APP_URL}/automate?microsoft_error=missing_code`);
  }

  try {
    // Decode state to get userId
    const stateData = JSON.parse(Buffer.from(String(state), 'base64url').toString());
    const userId = stateData.userId as string;
    if (!userId) {
      return res.redirect(`${APP_URL}/automate?microsoft_error=invalid_state`);
    }

    // Exchange authorization code for tokens
    const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: MICROSOFT_CLIENT_ID,
        client_secret: MICROSOFT_CLIENT_SECRET,
        code: String(code),
        redirect_uri: MICROSOFT_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error('[microsoft-callback] Token exchange failed:', errBody);
      return res.redirect(`${APP_URL}/automate?microsoft_error=token_exchange_failed`);
    }

    const tokens = await tokenRes.json() as TokenResponse;

    // Fetch Microsoft profile
    const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    let profile: MicrosoftProfile | null = null;
    if (profileRes.ok) {
      profile = await profileRes.json() as MicrosoftProfile;
    }

    // Calculate token expiry
    const tokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    const scopes = tokens.scope.split(' ');

    // Upsert the integration record
    const supabase = getSupabase();
    const { error: upsertError } = await supabase
      .from('microsoft_integrations')
      .upsert({
        user_id: userId,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: tokenExpiresAt,
        scopes,
        microsoft_user_id: profile?.id ?? null,
        microsoft_email: profile?.mail ?? profile?.userPrincipalName ?? null,
        display_name: profile?.displayName ?? null,
        status: 'connected',
        error_message: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

    if (upsertError) {
      console.error('[microsoft-callback] Upsert error:', upsertError);
      return res.redirect(`${APP_URL}/automate?microsoft_error=save_failed`);
    }

    // Redirect back to the app with success
    return res.redirect(`${APP_URL}/automate?microsoft_connected=true`);
  } catch (err) {
    console.error('[microsoft-callback] Error:', err);
    return res.redirect(`${APP_URL}/automate?microsoft_error=unexpected`);
  }
}
