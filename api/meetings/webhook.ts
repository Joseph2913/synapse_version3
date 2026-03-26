import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── CIRCLEBACK PAYLOAD TYPES ─────────────────────────────────────────────────

interface CirclebackPayload {
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

    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    // Build meeting title
    const meetingTitle = payload.name || 'Untitled Meeting';

    // ─── DEDUP GUARD ─────────────────────────────────────────────────────────
    // Skip if a meeting with the same Circleback ID or same title+date already exists
    if (payload.id) {
      const { data: existing } = await supabase
        .from('knowledge_sources')
        .select('id')
        .eq('user_id', uid)
        .eq('source_type', 'Meeting')
        .contains('metadata', { circleback_meeting_id: payload.id })
        .maybeSingle();

      if (existing) {
        console.log(`[meetings/webhook] Dedup: circleback_meeting_id ${payload.id} already exists (${existing.id}), skipping`);
        return res.status(200).json({
          success: true,
          source_id: existing.id,
          title: meetingTitle,
          duplicate: true,
          message: 'Meeting already ingested',
        });
      }
    }

    // Also check by title + date as fallback (catches V1 ingestions without circleback_meeting_id)
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
        console.log(`[meetings/webhook] Dedup: "${meetingTitle}" on ${meetingDate} already exists (${titleMatch.id}), skipping`);
        return res.status(200).json({
          success: true,
          source_id: titleMatch.id,
          title: meetingTitle,
          duplicate: true,
          message: 'Meeting already ingested (matched by title+date)',
        });
      }
    }

    // Build transcript text
    let transcriptText = '';
    if (payload.transcript && Array.isArray(payload.transcript) && payload.transcript.length > 0) {
      transcriptText = formatTranscript(payload.transcript);
    }

    // Build full content: notes + transcript + action items
    const parts: string[] = [];
    if (payload.notes) {
      parts.push(payload.notes);
    }
    if (transcriptText) {
      parts.push('\n\n--- TRANSCRIPT ---\n\n' + transcriptText);
    }
    parts.push(formatActionItems(payload.actionItems));

    const fullContent = parts.join('').trim();

    if (!fullContent) {
      return res.status(400).json({ error: 'No content in payload (no notes or transcript)' });
    }

    // Build metadata
    const attendeeNames = (payload.attendees ?? [])
      .map(a => a.name || a.email || 'Unknown')
      .filter(Boolean);

    const metadata: Record<string, unknown> = {
      provider: 'circleback',
      ingested_via: 'webhook',
      extraction_status: 'pending',
      circleback_meeting_id: payload.id ?? null,
      duration_seconds: payload.duration ?? null,
      meeting_url: payload.url ?? null,
      recording_url: payload.recordingUrl ?? null,
      attendees: attendeeNames,
      tags: payload.tags ?? [],
      ical_uid: payload.icalUid ?? null,
      action_item_count: payload.actionItems?.length ?? 0,
      received_at: new Date().toISOString(),
    };

    // Parse participants from content header, falling back to payload attendees
    const participants = parseParticipants(fullContent) ??
      (attendeeNames.length > 0
        ? [...new Set(attendeeNames.map(n => toTitleCase(n)))]
        : null);

    // Save to knowledge_sources
    const insertRow: Record<string, unknown> = {
      user_id: uid,
      title: meetingTitle,
      source_type: 'Meeting',
      source_url: payload.url ?? null,
      content: fullContent.slice(0, 100_000),
      metadata,
    };
    if (participants) {
      insertRow.participants = participants;
    }

    const { data: sourceData, error: sourceError } = await supabase
      .from('knowledge_sources')
      .insert(insertRow)
      .select('id')
      .single();

    if (sourceError) {
      console.error('[meetings/webhook] Failed to save source:', sourceError);
      return res.status(500).json({ error: `Failed to save meeting: ${sourceError.message}` });
    }

    console.log(
      `[meetings/webhook] Saved meeting "${meetingTitle}" (${(sourceData as { id: string }).id}) for user ${uid}`
    );

    return res.status(200).json({
      success: true,
      source_id: (sourceData as { id: string }).id,
      title: meetingTitle,
      content_length: fullContent.length,
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
