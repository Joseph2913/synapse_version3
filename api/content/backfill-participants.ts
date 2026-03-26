import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// ─── ENVIRONMENT ─────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── INLINE PARSER (cannot import from src/ in serverless functions) ─────────

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

// ─── HANDLER ─────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = getSupabase();

  try {
    // Fetch all meeting sources that don't have participants yet
    const { data: meetings, error: fetchError } = await supabase
      .from('knowledge_sources')
      .select('id, content, metadata')
      .eq('source_type', 'Meeting')
      .is('participants', null);

    if (fetchError) {
      console.error('[backfill-participants] Fetch error:', fetchError);
      return res.status(500).json({ error: fetchError.message });
    }

    if (!meetings || meetings.length === 0) {
      return res.status(200).json({ message: 'No meeting sources to backfill', updated: 0, skipped: 0 });
    }

    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const meeting of meetings) {
      // Try content header first, then fall back to metadata.attendees
      const meta = meeting.metadata as Record<string, unknown> | null;
      const attendees = Array.isArray(meta?.attendees) ? (meta!.attendees as string[]) : [];
      const participants = parseParticipants(meeting.content ?? '') ??
        (attendees.length > 0
          ? [...new Set(attendees.map(n => toTitleCase(n)))]
          : null);

      if (!participants) {
        skipped++;
        continue;
      }

      const { error: updateError } = await supabase
        .from('knowledge_sources')
        .update({ participants })
        .eq('id', meeting.id);

      if (updateError) {
        errors.push(`${meeting.id}: ${updateError.message}`);
        continue;
      }

      updated++;
    }

    console.log(`[backfill-participants] Done: ${updated} updated, ${skipped} skipped, ${errors.length} errors`);

    return res.status(200).json({
      total: meetings.length,
      updated,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[backfill-participants] Error:', err);
    return res.status(500).json({ error: msg });
  }
}
