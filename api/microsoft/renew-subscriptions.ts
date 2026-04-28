import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 30;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID!;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET!;
const MICROSOFT_WEBHOOK_SECRET = process.env.MICROSOFT_WEBHOOK_SECRET || 'synapse-ms-webhook';
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Webhook URL for Microsoft Graph to send notifications
const WEBHOOK_URL = process.env.MICROSOFT_WEBHOOK_URL || process.env.APP_URL
  ? `${process.env.APP_URL}/api/webhooks/microsoft`
  : '';

// ─── AUTH ──────────────────────────────────────────────────────────────────────


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

function verifyCronAuth(req: VercelRequest): boolean {
  if (req.headers['x-vercel-signature']) return true;
  if (!CRON_SECRET) return true;
  const auth = req.headers['authorization'];
  return !!(auth && auth === `Bearer ${CRON_SECRET}`);
}

async function getUserFromToken(req: VercelRequest): Promise<string | null> {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const supabase = getSupabase();
  const { data } = await supabase.auth.getUser(token);
  return data?.user?.id ?? null;
}

// ─── TOKEN REFRESH ────────────────────────────────────────────────────────────

async function getValidAccessToken(userId: string): Promise<string | null> {
  const supabase = getSupabase();
  const { data: integration } = await supabase
    .from('microsoft_integrations')
    .select('access_token, refresh_token, token_expires_at')
    .eq('user_id', userId)
    .eq('status', 'connected')
    .maybeSingle();

  if (!integration) return null;

  const expiresAt = new Date(integration.token_expires_at).getTime();
  if (Date.now() < expiresAt - 5 * 60 * 1000) {
    return integration.access_token;
  }

  const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID,
      client_secret: MICROSOFT_CLIENT_SECRET,
      refresh_token: integration.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!tokenRes.ok) return null;

  const tokens = await tokenRes.json() as { access_token: string; refresh_token: string; expires_in: number };
  await supabase.from('microsoft_integrations').update({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('user_id', userId);

  return tokens.access_token;
}

// ─── SUBSCRIPTION MANAGEMENT ──────────────────────────────────────────────────

// Max expiration for Outlook resources is ~4230 minutes (~2.94 days)
const SUBSCRIPTION_EXPIRY_MINUTES = 4200;

interface SubscriptionResponse {
  id: string;
  resource: string;
  changeType: string;
  expirationDateTime: string;
}

async function createOrRenewSubscription(
  accessToken: string,
  resource: string,
  existingSubId: string | null
): Promise<{ id: string; expiresAt: string } | null> {
  const expirationDateTime = new Date(Date.now() + SUBSCRIPTION_EXPIRY_MINUTES * 60 * 1000).toISOString();

  if (existingSubId) {
    // Try to renew existing subscription
    const renewRes = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${existingSubId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expirationDateTime }),
    });

    if (renewRes.ok) {
      const data = await renewRes.json() as SubscriptionResponse;
      return { id: data.id, expiresAt: data.expirationDateTime };
    }

    // If renewal failed (expired or deleted), create new
    console.warn(`[renew-subscriptions] Renewal failed for ${existingSubId}, creating new subscription`);
  }

  if (!WEBHOOK_URL) {
    console.error('[renew-subscriptions] No WEBHOOK_URL configured');
    return null;
  }

  // Create new subscription
  const createRes = await fetch('https://graph.microsoft.com/v1.0/subscriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      changeType: 'created,updated',
      notificationUrl: WEBHOOK_URL,
      resource,
      expirationDateTime,
      clientState: MICROSOFT_WEBHOOK_SECRET,
    }),
  });

  if (!createRes.ok) {
    const errText = await createRes.text().catch(() => '');
    console.error(`[renew-subscriptions] Create subscription failed (${createRes.status}):`, errText);
    return null;
  }

  const data = await createRes.json() as SubscriptionResponse;
  return { id: data.id, expiresAt: data.expirationDateTime };
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const isCron = verifyCronAuth(req);
  const userId = isCron ? null : await getUserFromToken(req);

  if (!isCron && !userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();

  try {
    let query = supabase
      .from('microsoft_integrations')
      .select('*')
      .eq('status', 'connected');

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data: integrations } = await query;

    if (!integrations?.length) {
      return res.status(200).json({ renewed: 0, message: 'No active integrations' });
    }

    const results = [];

    for (const integration of integrations) {
      const accessToken = await getValidAccessToken(integration.user_id);
      if (!accessToken) {
        results.push({ userId: integration.user_id, error: 'no_valid_token' });
        continue;
      }

      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

      // Calendar subscription
      if (integration.sync_calendar) {
        const calSub = await createOrRenewSubscription(
          accessToken,
          '/me/events',
          integration.calendar_subscription_id
        );
        if (calSub) {
          updates.calendar_subscription_id = calSub.id;
          updates.calendar_subscription_expires = calSub.expiresAt;
        }
      }

      // Mail subscription
      if (integration.sync_mail) {
        const mailSub = await createOrRenewSubscription(
          accessToken,
          '/me/mailFolders/inbox/messages',
          integration.mail_subscription_id
        );
        if (mailSub) {
          updates.mail_subscription_id = mailSub.id;
          updates.mail_subscription_expires = mailSub.expiresAt;
        }
      }

      await supabase.from('microsoft_integrations').update(updates).eq('user_id', integration.user_id);

      results.push({
        userId: integration.user_id,
        calendarSubscription: !!updates.calendar_subscription_id,
        mailSubscription: !!updates.mail_subscription_id,
      });
    }

    return res.status(200).json({ renewed: results.length, results });
  } catch (err) {
    console.error('[renew-subscriptions] Error:', err);
    return res.status(500).json({ error: 'Renewal failed' });
  }
}
