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


// ─── Stage 2 — persistSource (meeting variant, inlined) ────────────────────
//
// Vercel functions cannot share local imports, so the meeting-specific
// persistence helper lives here. Identity rule for meetings is the
// circleback_meeting_id; the partial unique index
// `(user_id, circleback_meeting_id) WHERE circleback_meeting_id IS NOT NULL`
// catches concurrent inserts. On re-delivery we compare a content-stable
// payload signature stored in metadata.payload_signature: if it differs we
// replace content/metadata/title and reset status to 'pending'; if it matches
// we skip silently.

type MeetingPersistStatus = 'inserted' | 'replaced' | 'skipped-duplicate';

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function meetingPayloadSignature(parts: {
  transcriptSegmentCount: number;
  actionItemCount: number;
  contentLength: number;
  content: string;
}): Promise<string> {
  const seed = `${parts.transcriptSegmentCount}|${parts.actionItemCount}|${parts.contentLength}|${parts.content.slice(0, 4096)}`;
  return sha256Hex(seed);
}

interface PersistMeetingResult {
  sourceId: string;
  status: MeetingPersistStatus;
}

async function persistMeetingSource(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  captured: CapturedSource,
  circlebackMeetingId: number | null,
): Promise<PersistMeetingResult> {
  const meta = captured.metadata as Record<string, unknown>;
  const signature = await meetingPayloadSignature({
    transcriptSegmentCount: Number(meta['transcript_segment_count'] ?? 0),
    actionItemCount: Number(meta['action_item_count'] ?? 0),
    contentLength: captured.content.length,
    content: captured.content,
  });
  const enrichedMetadata = { ...meta, payload_signature: signature };

  // ── 1. Lookup by circleback_meeting_id when present (decision A2 path).
  if (circlebackMeetingId !== null) {
    const { data: existing } = await supabase
      .from('knowledge_sources')
      .select('id, metadata')
      .eq('user_id', userId)
      .eq('circleback_meeting_id', circlebackMeetingId)
      .maybeSingle();

    if (existing) {
      const storedSig = (existing.metadata as Record<string, unknown> | null)?.['payload_signature'] ?? null;
      if (storedSig === signature) {
        return { sourceId: existing.id as string, status: 'skipped-duplicate' };
      }
      // Replace: content / metadata / title; reset status so downstream re-runs.
      const participants = meta['participants'] as string[] | null | undefined;
      const updateRow: Record<string, unknown> = {
        title: captured.title,
        content: captured.content,
        source_url: captured.source_url,
        metadata: enrichedMetadata,
        status: 'pending',
      };
      if (participants && participants.length > 0) updateRow.participants = participants;
      const { error: updErr } = await supabase
        .from('knowledge_sources')
        .update(updateRow)
        .eq('id', existing.id);
      if (updErr) throw new Error(`Meeting replace failed: ${updErr.message}`);
      return { sourceId: existing.id as string, status: 'replaced' };
    }
  }

  // ── 2. Insert. Catch error 23505 race and re-fetch by circleback_meeting_id.
  const participants = meta['participants'] as string[] | null | undefined;
  const insertRow: Record<string, unknown> = {
    user_id: userId,
    title: captured.title,
    content: captured.content,
    source_type: 'meeting',
    source_url: captured.source_url,
    metadata: enrichedMetadata,
    circleback_meeting_id: circlebackMeetingId,
    status: 'pending',
  };
  if (participants && participants.length > 0) insertRow.participants = participants;

  const { data: inserted, error } = await supabase
    .from('knowledge_sources')
    .insert(insertRow)
    .select('id')
    .single();

  if (error) {
    const isRace = error.code === '23505' || /duplicate key/i.test(error.message);
    if (isRace && circlebackMeetingId !== null) {
      const { data: existing } = await supabase
        .from('knowledge_sources')
        .select('id')
        .eq('user_id', userId)
        .eq('circleback_meeting_id', circlebackMeetingId)
        .maybeSingle();
      if (existing) return { sourceId: existing.id as string, status: 'skipped-duplicate' };
    }
    throw new Error(`Meeting insert failed: ${error.message}`);
  }
  return { sourceId: inserted.id as string, status: 'inserted' };
}

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

    // ─── Stage 2 — persistSource() (inlined). ────────────────────────────────
    // Decision A2: meeting re-ingest replaces content only when the payload
    // signature (transcript + action items shape) differs from the stored one.
    // Otherwise skip silently. Webhook re-deliveries are now no-ops, and a
    // genuine Circleback edit triggers a full re-run by resetting status to
    // 'pending'.
    let persistResult: PersistMeetingResult;
    try {
      persistResult = await persistMeetingSource(
        supabase,
        uid,
        captured,
        payload.id ?? null,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError({ stage: 'persist', user_id: uid, status: 'failed', error: msg });
      return res.status(500).json({ error: `Failed to save meeting: ${msg}` });
    }

    log({
      stage: 'persist',
      user_id: uid,
      source_id: persistResult.sourceId,
      status: persistResult.status === 'skipped-duplicate' ? 'skipped' : 'ok',
      source_type: 'meeting',
      circleback_meeting_id: payload.id ?? null,
      result: persistResult.status,
      duration_ms: Date.now() - startTime,
    });

    return res.status(200).json({
      success: true,
      source_id: persistResult.sourceId,
      title: meetingTitle,
      content_length: captured.content.length,
      duplicate: persistResult.status !== 'inserted',
      persist_status: persistResult.status,
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
