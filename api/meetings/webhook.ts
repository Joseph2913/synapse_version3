import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CIRCLEBACK_WEBHOOK_SECRET = process.env.CIRCLEBACK_WEBHOOK_SECRET ?? '';

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── CIRCLEBACK PAYLOAD TYPES ─────────────────────────────────────────────────

export interface CirclebackPayload {
  id?: number;
  name?: string;
  createdAt?: string;
  duration?: number;
  url?: string | null;
  recordingUrl?: string | null;
  tags?: string[];
  icalUid?: string | null;
  attendees?: Array<{ name?: string | null; email?: string | null }>;
  notes?: string;
  transcript?: Array<{ speaker: string; text: string; timestamp: number }>;
  actionItems?: Array<{
    id: number;
    title: string;
    description?: string;
    assignee?: { name?: string; email?: string } | null;
    status?: string;
  }>;
  insights?: Record<string, unknown>;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────


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

function formatTranscript(
  entries: Array<{ speaker: string; text: string; timestamp: number }>
): string {
  return entries
    .map(entry => {
      const minutes = Math.floor(entry.timestamp / 60);
      const seconds = entry.timestamp % 60;
      const ts = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      return `[${entry.speaker}] (${ts})\n${entry.text}`;
    })
    .join('\n\n');
}

function formatActionItems(
  items: CirclebackPayload['actionItems']
): string {
  if (!items || items.length === 0) return '';
  return (
    '\n\n--- ACTION ITEMS ---\n' +
    items
      .map(ai => {
        const assignee = ai.assignee?.name ?? ai.assignee?.email ?? 'Unassigned';
        return `- [${ai.status ?? 'PENDING'}] ${ai.title}${ai.description ? `: ${ai.description}` : ''} (${assignee})`;
      })
      .join('\n')
  );
}

// ─── PARTICIPANT PARSER (inlined — serverless cannot import local files) ──────

function toTitleCase(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// ─── CapturedSource (Stage 1 contract — inlined; serverless cannot share) ────

export interface CapturedSource {
  content: string;
  title: string;
  source_type: 'meeting';
  source_url: string | null;
  metadata: Record<string, unknown>;
}

export const MEETING_MAX_CHARS = 400_000;

export class MeetingCaptureError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MeetingCaptureError';
    this.code = code;
  }
}

/**
 * Stage 1 capture function — pure. Takes a Circleback webhook payload and
 * returns a CapturedSource, or throws MeetingCaptureError on rejection.
 *
 * Title rule: payload.name → "Meeting on YYYY-MM-DD" (from createdAt) →
 * "Untitled meeting".
 *
 * Size rule: rejects content over MEETING_MAX_CHARS (400k) instead of silently
 * truncating, matching the URL and YouTube adapters.
 */
export function circlebackToCapturedSource(payload: CirclebackPayload): CapturedSource {
  if (!payload || typeof payload !== 'object') {
    throw new MeetingCaptureError('MEETING_INVALID_PAYLOAD', 'Webhook payload is missing or not a JSON object.');
  }

  const transcriptText = (payload.transcript && Array.isArray(payload.transcript) && payload.transcript.length > 0)
    ? formatTranscript(payload.transcript)
    : '';

  const parts: string[] = [];
  if (payload.notes) parts.push(payload.notes);
  if (transcriptText) parts.push('\n\n--- TRANSCRIPT ---\n\n' + transcriptText);
  parts.push(formatActionItems(payload.actionItems));

  const content = parts.join('').trim();
  if (!content) {
    throw new MeetingCaptureError('MEETING_NO_CONTENT', 'Meeting payload has no notes, transcript, or action items.');
  }
  if (content.length > MEETING_MAX_CHARS) {
    throw new MeetingCaptureError(
      'MEETING_OVERSIZE',
      `Meeting is too large (${content.length.toLocaleString()} characters; maximum ${MEETING_MAX_CHARS.toLocaleString()}).`,
    );
  }

  let title = (payload.name ?? '').trim();
  if (!title) {
    if (payload.createdAt) {
      const datePart = new Date(payload.createdAt).toISOString().split('T')[0];
      title = `Meeting on ${datePart}`;
    } else {
      title = 'Untitled meeting';
    }
  }
  title = title.slice(0, 200);

  const attendeeNames = (payload.attendees ?? [])
    .map(a => a.name || a.email || '')
    .filter((s): s is string => Boolean(s));

  const participants = parseParticipants(content) ??
    (attendeeNames.length > 0 ? [...new Set(attendeeNames.map(n => toTitleCase(n)))] : null);

  return {
    content,
    title,
    source_type: 'meeting',
    source_url: payload.url ?? null,
    metadata: {
      provider: 'circleback',
      ingested_via: 'webhook',
      circleback_meeting_id: payload.id ?? null,
      duration_seconds: payload.duration ?? null,
      meeting_url: payload.url ?? null,
      recording_url: payload.recordingUrl ?? null,
      attendees: attendeeNames,
      tags: payload.tags ?? [],
      ical_uid: payload.icalUid ?? null,
      action_item_count: payload.actionItems?.length ?? 0,
      transcript_segment_count: payload.transcript?.length ?? 0,
      char_count: content.length,
      participants: participants ?? null,
      received_at: new Date().toISOString(),
    },
  };
}

function parseParticipants(content: string): string[] | null {
  if (!content) return null;
  const lines = content.split('\n').slice(0, 30);
  for (const line of lines) {
    const match = line.match(/^\*\*(?:People|Participants|Attendees)\*\*:\s*(.+)$/i);
    if (!match?.[1]) continue;
    const raw = match[1].trim();
    if (!raw) continue;
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    const result: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1 && /\band\b/i.test(part)) {
        const subParts = part.split(/\band\b/i).map(s => s.trim()).filter(Boolean);
        result.push(...subParts.map(toTitleCase));
      } else {
        result.push(toTitleCase(part));
      }
    }
    return result.length > 0 ? result : null;
  }
  return null;
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-signature');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const startTime = Date.now();

  // Optional shared-secret signature check. If CIRCLEBACK_WEBHOOK_SECRET is
  // set, the x-signature header must match. If unset, we keep the legacy
  // uid-only path and emit a warning log so it shows up in audits.
  const provided = (req.headers['x-signature'] as string | undefined) ?? '';
  if (CIRCLEBACK_WEBHOOK_SECRET) {
    if (provided !== CIRCLEBACK_WEBHOOK_SECRET) {
      logError({ stage: 'capture:meeting', status: 'failed', error: 'invalid signature' });
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
  } else {
    log({ stage: 'capture:meeting', status: 'skipped', warning: 'CIRCLEBACK_WEBHOOK_SECRET not set; webhook is uid-only' });
  }

  // Extract user ID from query param
  const uid = req.query['uid'] as string | undefined;
  if (!uid) {
    return res.status(400).json({ error: 'Missing uid query parameter' });
  }

  // Validate the user exists
  const supabase = getSupabase();
  const { data: userCheck } = await supabase.auth.admin.getUserById(uid);
  if (!userCheck?.user) {
    return res.status(401).json({ error: 'Invalid user ID' });
  }

  try {
    const payload = req.body as CirclebackPayload;

    // Stage 1 capture: pure transformation from Circleback payload to CapturedSource.
    // Throws MeetingCaptureError on rejection (no content, oversize, invalid).
    let captured: CapturedSource;
    try {
      captured = circlebackToCapturedSource(payload);
    } catch (err) {
      if (err instanceof MeetingCaptureError) {
        const status = err.code === 'MEETING_OVERSIZE' ? 413 : 400;
        logError({ stage: 'capture:meeting', user_id: uid, status: 'failed', error: err.code });
        return res.status(status).json({ error: err.message });
      }
      throw err;
    }

    const meetingTitle = captured.title;

    // ─── DEDUP GUARD (title + date) ──────────────────────────────────────────
    // The Circleback-ID dedup is now handled at the database level via the
    // unique index on (user_id, circleback_meeting_id) — see the upsert below.
    // This title+date check remains as a safety net for V1-era rows that
    // pre-date the circleback_meeting_id column.
    if (payload.createdAt) {
      const meetingDate = new Date(payload.createdAt).toISOString().split('T')[0];
      const { data: titleMatch } = await supabase
        .from('knowledge_sources')
        .select('id')
        .eq('user_id', uid)
        .eq('source_type', 'Meeting')
        .eq('title', meetingTitle)
        .gte('created_at', meetingDate)
        .lt('created_at', meetingDate + 'T23:59:59.999Z')
        .maybeSingle();

      if (titleMatch) {
        log({ stage: 'capture:meeting:dedup', user_id: uid, source_id: titleMatch.id, status: 'skipped', reason: 'duplicate-title-date' });
        return res.status(200).json({
          success: true,
          source_id: titleMatch.id,
          title: meetingTitle,
          duplicate: true,
          message: 'Meeting already ingested (matched by title+date)',
        });
      }
    }

    // Stage 2 will absorb this once persistSource() lands. For now the existing
    // inline write stays so behaviour is unchanged.
    const captureMetadata = { ...captured.metadata, extraction_status: 'pending' };
    const participants = captured.metadata.participants as string[] | null;

    const insertRow: Record<string, unknown> = {
      user_id: uid,
      title: meetingTitle,
      source_type: 'Meeting',
      source_url: captured.source_url,
      content: captured.content,
      metadata: captureMetadata,
      circleback_meeting_id: payload.id ?? null,
    };
    if (participants && participants.length > 0) {
      insertRow.participants = participants;
    }

    let sourceData: { id: string } | null = null;
    let sourceError: { message: string; code?: string } | null = null;

    if (payload.id) {
      // Use upsert with ignoreDuplicates so a duplicate webhook returns the
      // existing row instead of creating a second one.
      const { data, error } = await supabase
        .from('knowledge_sources')
        .upsert(insertRow, {
          onConflict: 'user_id,circleback_meeting_id',
          ignoreDuplicates: true,
        })
        .select('id')
        .maybeSingle();
      sourceData = data;
      sourceError = error;

      // ignoreDuplicates returns null on conflict — fetch the existing row.
      if (!sourceData && !sourceError) {
        const { data: existing } = await supabase
          .from('knowledge_sources')
          .select('id')
          .eq('user_id', uid)
          .eq('circleback_meeting_id', payload.id)
          .maybeSingle();
        if (existing) {
          log({
            stage: 'capture:meeting:dedup',
            user_id: uid,
            source_id: existing.id,
            status: 'skipped',
            circleback_meeting_id: payload.id,
          });
          return res.status(200).json({
            success: true,
            source_id: existing.id,
            title: meetingTitle,
            duplicate: true,
            message: 'Meeting already ingested',
          });
        }
      }
    } else {
      // No Circleback ID — fall back to plain insert.
      const { data, error } = await supabase
        .from('knowledge_sources')
        .insert(insertRow)
        .select('id')
        .single();
      sourceData = data;
      sourceError = error;
    }

    if (sourceError) {
      logError({
        stage: 'capture:meeting',
        user_id: uid,
        status: 'failed',
        error: sourceError.message,
      });
      return res.status(500).json({ error: `Failed to save meeting: ${sourceError.message}` });
    }
    if (!sourceData) {
      logError({
        stage: 'capture:meeting',
        user_id: uid,
        status: 'failed',
        error: 'No source row returned from upsert',
      });
      return res.status(500).json({ error: 'Failed to save meeting: no row returned' });
    }

    console.log(
      `[meetings/webhook] Saved meeting "${meetingTitle}" (${(sourceData as { id: string }).id}) for user ${uid}`
    );

    return res.status(200).json({
      success: true,
      source_id: (sourceData as { id: string }).id,
      title: meetingTitle,
      content_length: captured.content.length,
      duration_ms: Date.now() - startTime,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[meetings/webhook] Error:', err);
    return res.status(500).json({
      success: false,
      error: msg,
      duration_ms: Date.now() - startTime,
    });
  }
}
