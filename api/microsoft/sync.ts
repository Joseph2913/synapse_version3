import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 60;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID!;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET!;
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── AUTH ──────────────────────────────────────────────────────────────────────

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

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function refreshAccessToken(
  refreshToken: string,
  userId: string
): Promise<{ accessToken: string; newRefreshToken: string } | null> {
  const supabase = getSupabase();

  const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID,
      client_secret: MICROSOFT_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!tokenRes.ok) {
    console.error('[microsoft-sync] Token refresh failed:', await tokenRes.text());
    await supabase.from('microsoft_integrations').update({
      status: 'expired',
      error_message: 'Token refresh failed. Please reconnect your Microsoft account.',
      updated_at: new Date().toISOString(),
    }).eq('user_id', userId);
    return null;
  }

  const tokens = await tokenRes.json() as TokenResponse;
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  await supabase.from('microsoft_integrations').update({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  }).eq('user_id', userId);

  return { accessToken: tokens.access_token, newRefreshToken: tokens.refresh_token };
}

// ─── GRAPH API HELPERS ────────────────────────────────────────────────────────

interface GraphEvent {
  id: string;
  subject: string;
  bodyPreview: string;
  body?: { content: string; contentType: string };
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees: Array<{ emailAddress: { name: string; address: string }; status: { response: string } }>;
  onlineMeeting?: { joinUrl: string; onlineMeetingId?: string } | null;
  isOnlineMeeting?: boolean;
}

interface GraphMessage {
  id: string;
  subject: string;
  bodyPreview: string;
  body?: { content: string; contentType: string };
  from: { emailAddress: { name: string; address: string } };
  toRecipients: Array<{ emailAddress: { name: string; address: string } }>;
  receivedDateTime: string;
  hasAttachments: boolean;
}

interface DeltaResponse<T> {
  value: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

async function graphFetch<T>(
  url: string,
  accessToken: string
): Promise<T | null> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    console.warn(`[microsoft-sync] Graph API error (${res.status}):`, await res.text().catch(() => ''));
    return null;
  }
  return res.json() as Promise<T>;
}

// ─── SYNC LOGIC ───────────────────────────────────────────────────────────────

async function syncCalendar(
  accessToken: string,
  userId: string,
  deltaLink: string | null
): Promise<{ newDeltaLink: string | null; eventsQueued: number }> {
  const supabase = getSupabase();
  let eventsQueued = 0;

  // Use delta link for incremental sync, or full sync for initial
  let url = deltaLink
    || 'https://graph.microsoft.com/v1.0/me/calendarView/delta?startDateTime=' +
       new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() +
       '&endDateTime=' +
       new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() +
       '&$select=id,subject,bodyPreview,start,end,attendees,onlineMeeting,isOnlineMeeting';

  let newDeltaLink: string | null = null;

  // Follow pagination
  while (url) {
    const data = await graphFetch<DeltaResponse<GraphEvent>>(url, accessToken);
    if (!data) break;

    for (const event of data.value) {
      if (!event.subject) continue;

      const attendees = event.attendees?.map(a => ({
        name: a.emailAddress.name,
        email: a.emailAddress.address,
      })) || [];

      // Queue this event for processing
      const { error } = await supabase
        .from('microsoft_ingestion_queue')
        .upsert({
          user_id: userId,
          microsoft_resource_id: event.id,
          resource_type: 'calendar_event',
          title: event.subject,
          content: event.bodyPreview || null,
          event_start: event.start?.dateTime ? new Date(event.start.dateTime + 'Z').toISOString() : null,
          event_end: event.end?.dateTime ? new Date(event.end.dateTime + 'Z').toISOString() : null,
          attendees: attendees.length > 0 ? JSON.stringify(attendees) : null,
          online_meeting_id: event.onlineMeeting?.onlineMeetingId || null,
          status: 'pending',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,microsoft_resource_id', ignoreDuplicates: false });

      if (!error) eventsQueued++;
    }

    url = data['@odata.nextLink'] || '';
    newDeltaLink = data['@odata.deltaLink'] || newDeltaLink;
  }

  return { newDeltaLink, eventsQueued };
}

async function syncMail(
  accessToken: string,
  userId: string,
  deltaLink: string | null
): Promise<{ newDeltaLink: string | null; messagesQueued: number }> {
  const supabase = getSupabase();
  let messagesQueued = 0;

  let url = deltaLink
    || 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$select=id,subject,bodyPreview,from,toRecipients,receivedDateTime&$top=25';

  let newDeltaLink: string | null = null;
  let pages = 0;
  const MAX_PAGES = 5; // Limit initial sync to prevent timeout

  while (url && pages < MAX_PAGES) {
    pages++;
    const data = await graphFetch<DeltaResponse<GraphMessage>>(url, accessToken);
    if (!data) break;

    for (const message of data.value) {
      if (!message.subject) continue;

      const { error } = await supabase
        .from('microsoft_ingestion_queue')
        .upsert({
          user_id: userId,
          microsoft_resource_id: message.id,
          resource_type: 'email',
          title: message.subject,
          content: message.bodyPreview || null,
          status: 'pending',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,microsoft_resource_id', ignoreDuplicates: true });

      if (!error) messagesQueued++;
    }

    url = data['@odata.nextLink'] || '';
    newDeltaLink = data['@odata.deltaLink'] || newDeltaLink;
  }

  return { newDeltaLink, messagesQueued };
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Allow cron or authenticated user
  const isCron = verifyCronAuth(req);
  const userId = isCron ? null : await getUserFromToken(req);

  if (!isCron && !userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();

  try {
    // Fetch integrations to sync
    let query = supabase
      .from('microsoft_integrations')
      .select('*')
      .eq('status', 'connected');

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data: integrations, error: fetchError } = await query;

    if (fetchError || !integrations?.length) {
      return res.status(200).json({ synced: 0, message: 'No active Microsoft integrations' });
    }

    const results = [];

    for (const integration of integrations) {
      let accessToken = integration.access_token;

      // Refresh token if expired or about to expire (5 min buffer)
      const expiresAt = new Date(integration.token_expires_at).getTime();
      if (Date.now() > expiresAt - 5 * 60 * 1000) {
        const refreshed = await refreshAccessToken(integration.refresh_token, integration.user_id);
        if (!refreshed) {
          results.push({ userId: integration.user_id, error: 'token_refresh_failed' });
          continue;
        }
        accessToken = refreshed.accessToken;
      }

      let eventsQueued = 0;
      let messagesQueued = 0;

      // Sync calendar
      if (integration.sync_calendar) {
        const calResult = await syncCalendar(accessToken, integration.user_id, integration.calendar_delta_link);
        eventsQueued = calResult.eventsQueued;

        if (calResult.newDeltaLink) {
          await supabase.from('microsoft_integrations').update({
            calendar_delta_link: calResult.newDeltaLink,
            last_calendar_sync: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('user_id', integration.user_id);
        }
      }

      // Sync mail
      if (integration.sync_mail) {
        const mailResult = await syncMail(accessToken, integration.user_id, integration.mail_delta_link);
        messagesQueued = mailResult.messagesQueued;

        if (mailResult.newDeltaLink) {
          await supabase.from('microsoft_integrations').update({
            mail_delta_link: mailResult.newDeltaLink,
            last_mail_sync: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('user_id', integration.user_id);
        }
      }

      results.push({
        userId: integration.user_id,
        eventsQueued,
        messagesQueued,
      });
    }

    return res.status(200).json({ synced: results.length, results });
  } catch (err) {
    console.error('[microsoft-sync] Error:', err);
    return res.status(500).json({ error: 'Sync failed' });
  }
}
