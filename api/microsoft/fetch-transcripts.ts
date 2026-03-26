import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 120;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID!;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const MAX_ITEMS_PER_BATCH = 3;
const MAX_CONTENT_CHARS = 100_000;

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

  // Refresh
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

  if (!tokenRes.ok) {
    await supabase.from('microsoft_integrations').update({
      status: 'expired',
      error_message: 'Token refresh failed',
      updated_at: new Date().toISOString(),
    }).eq('user_id', userId);
    return null;
  }

  const tokens = await tokenRes.json() as { access_token: string; refresh_token: string; expires_in: number };
  await supabase.from('microsoft_integrations').update({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('user_id', userId);

  return tokens.access_token;
}

// ─── VTT PARSER ───────────────────────────────────────────────────────────────

function parseVTT(vtt: string): string {
  // Convert WebVTT to readable transcript with speaker attribution
  const lines = vtt.split('\n');
  const segments: string[] = [];
  let currentSpeaker = '';

  for (const line of lines) {
    if (line.startsWith('WEBVTT') || line.trim() === '' || line.includes('-->')) continue;

    // Extract speaker from <v Name>text</v> format
    const speakerMatch = line.match(/<v\s+([^>]+)>(.+?)<\/v>/);
    if (speakerMatch) {
      const speaker = speakerMatch[1].trim();
      const text = speakerMatch[2].trim();
      if (speaker !== currentSpeaker) {
        currentSpeaker = speaker;
        segments.push(`\n${speaker}: ${text}`);
      } else {
        segments.push(text);
      }
    } else if (line.trim()) {
      segments.push(line.trim());
    }
  }

  return segments.join(' ').trim();
}

// ─── TRANSCRIPT FETCH ─────────────────────────────────────────────────────────

async function fetchMeetingTranscript(
  onlineMeetingId: string,
  accessToken: string
): Promise<string | null> {
  // List transcripts for the meeting
  const listRes = await fetch(
    `https://graph.microsoft.com/v1.0/me/onlineMeetings/${onlineMeetingId}/transcripts`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!listRes.ok) {
    console.warn('[fetch-transcripts] List transcripts failed:', listRes.status);
    return null;
  }

  const listData = await listRes.json() as { value: Array<{ id: string }> };
  if (!listData.value?.length) return null;

  // Fetch the first (usually only) transcript as VTT
  const transcriptId = listData.value[0].id;
  const contentRes = await fetch(
    `https://graph.microsoft.com/v1.0/me/onlineMeetings/${onlineMeetingId}/transcripts/${transcriptId}/content`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'text/vtt',
      },
    }
  );

  if (!contentRes.ok) {
    console.warn('[fetch-transcripts] Fetch content failed:', contentRes.status);
    return null;
  }

  const vttContent = await contentRes.text();
  return parseVTT(vttContent);
}

// ─── FULL CONTENT FETCH ───────────────────────────────────────────────────────

async function fetchFullEventContent(
  resourceId: string,
  accessToken: string
): Promise<{ content: string; attendees: Array<{ name: string; email: string }> } | null> {
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/events/${resourceId}?$select=subject,body,attendees,onlineMeeting,start,end`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!res.ok) return null;

  const event = await res.json() as {
    subject: string;
    body?: { content: string; contentType: string };
    attendees?: Array<{ emailAddress: { name: string; address: string } }>;
    onlineMeeting?: { onlineMeetingId?: string };
  };

  let content = event.body?.content || '';

  // Strip HTML if needed
  if (event.body?.contentType === 'html') {
    content = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const attendees = event.attendees?.map(a => ({
    name: a.emailAddress.name,
    email: a.emailAddress.address,
  })) || [];

  return { content, attendees };
}

async function fetchFullEmailContent(
  resourceId: string,
  accessToken: string
): Promise<string | null> {
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${resourceId}?$select=subject,body,from,toRecipients,receivedDateTime`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!res.ok) return null;

  const message = await res.json() as {
    subject: string;
    body?: { content: string; contentType: string };
    from?: { emailAddress: { name: string; address: string } };
    toRecipients?: Array<{ emailAddress: { name: string; address: string } }>;
    receivedDateTime?: string;
  };

  let content = message.body?.content || '';
  if (message.body?.contentType === 'html') {
    content = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Build a structured document for extraction
  const parts = [
    `Subject: ${message.subject || 'No subject'}`,
    message.from ? `From: ${message.from.emailAddress.name} <${message.from.emailAddress.address}>` : '',
    message.toRecipients?.length ? `To: ${message.toRecipients.map(r => r.emailAddress.name).join(', ')}` : '',
    message.receivedDateTime ? `Date: ${new Date(message.receivedDateTime).toLocaleString()}` : '',
    '',
    content,
  ].filter(Boolean);

  return parts.join('\n').slice(0, MAX_CONTENT_CHARS);
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
    // Find pending queue items that need content fetching
    let query = supabase
      .from('microsoft_ingestion_queue')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(MAX_ITEMS_PER_BATCH);

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data: items, error: fetchError } = await query;

    if (fetchError || !items?.length) {
      return res.status(200).json({ processed: 0, message: 'No pending items' });
    }

    let processed = 0;

    for (const item of items) {
      // Mark as fetching
      await supabase.from('microsoft_ingestion_queue').update({
        status: 'fetching_content',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', item.id);

      const accessToken = await getValidAccessToken(item.user_id);
      if (!accessToken) {
        await supabase.from('microsoft_ingestion_queue').update({
          status: 'failed',
          error_message: 'Could not obtain valid access token',
          updated_at: new Date().toISOString(),
        }).eq('id', item.id);
        continue;
      }

      try {
        let fullContent: string | null = null;

        if (item.resource_type === 'calendar_event') {
          // Try to fetch transcript if it's a Teams meeting
          if (item.online_meeting_id) {
            fullContent = await fetchMeetingTranscript(item.online_meeting_id, accessToken);
          }

          // Fall back to event body if no transcript
          if (!fullContent) {
            const eventData = await fetchFullEventContent(item.microsoft_resource_id, accessToken);
            if (eventData) {
              const attendeeList = eventData.attendees.map(a => `${a.name} (${a.email})`).join(', ');
              fullContent = [
                `Meeting: ${item.title || 'Untitled'}`,
                item.event_start ? `Time: ${new Date(item.event_start).toLocaleString()}` : '',
                attendeeList ? `Attendees: ${attendeeList}` : '',
                '',
                eventData.content,
              ].filter(Boolean).join('\n');
            }
          }

          // If it's a Teams meeting, mark resource_type as meeting_transcript
          if (item.online_meeting_id && fullContent && fullContent.length > 200) {
            await supabase.from('microsoft_ingestion_queue').update({
              resource_type: 'meeting_transcript',
            }).eq('id', item.id);
          }
        } else if (item.resource_type === 'email') {
          fullContent = await fetchFullEmailContent(item.microsoft_resource_id, accessToken);
        }

        if (fullContent && fullContent.trim().length > 50) {
          await supabase.from('microsoft_ingestion_queue').update({
            content: fullContent.slice(0, MAX_CONTENT_CHARS),
            status: 'content_ready',
            updated_at: new Date().toISOString(),
          }).eq('id', item.id);
          processed++;
        } else {
          // Not enough content to extract from — skip
          await supabase.from('microsoft_ingestion_queue').update({
            status: 'skipped',
            error_message: 'Insufficient content for extraction',
            updated_at: new Date().toISOString(),
          }).eq('id', item.id);
        }
      } catch (err) {
        console.error(`[fetch-transcripts] Error processing ${item.id}:`, err);
        await supabase.from('microsoft_ingestion_queue').update({
          status: 'failed',
          error_message: err instanceof Error ? err.message : 'Unknown error',
          updated_at: new Date().toISOString(),
        }).eq('id', item.id);
      }
    }

    return res.status(200).json({ processed, total: items.length });
  } catch (err) {
    console.error('[fetch-transcripts] Error:', err);
    return res.status(500).json({ error: 'Processing failed' });
  }
}
