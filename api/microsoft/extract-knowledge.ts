import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import {
  runExtractionCore,
  type Anchor,
  type UserProfile,
} from '../pipeline/extract-pipeline.js';

export const maxDuration = 300;

// ─── ENVIRONMENT ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const MAX_ITEMS_PER_BATCH = 2;
const MAX_CONTENT_CHARS = 100_000;
const TIME_BUDGET_MS = 50_000;

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface QueueItem {
  id: string;
  user_id: string;
  microsoft_resource_id: string;
  resource_type: string;
  title: string | null;
  content: string;
  event_start: string | null;
  event_end: string | null;
  attendees: string | null;
}

// ─── PARTICIPANT PARSER ────────────────────────────────────────────────────────
// Microsoft-specific: content headers may contain a "**Participants**: ..."
// line that we want to promote into the knowledge_sources.participants column
// for searchability. Kept inline because it's genuinely specific to this
// integration's content format.

function toTitleCase(name: string): string {
  return name.trim().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function parseMeetingParticipants(content: string, attendeesJson: string | null): string[] | null {
  if (content) {
    const lines = content.split('\n').slice(0, 30);
    for (const line of lines) {
      const match = line.match(/^\*\*(?:People|Participants|Attendees)\*\*:\s*(.+)$/i);
      if (!match?.[1]) continue;
      const raw = match[1].trim();
      if (!raw) continue;
      const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
      const result: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i] ?? '';
        if (i === parts.length - 1 && /\band\b/i.test(part)) {
          result.push(...part.split(/\band\b/i).map(s => s.trim()).filter(Boolean).map(toTitleCase));
        } else {
          result.push(toTitleCase(part));
        }
      }
      if (result.length > 0) return [...new Set(result)];
    }
  }
  if (attendeesJson) {
    try {
      const attendees = JSON.parse(attendeesJson) as string[];
      if (Array.isArray(attendees) && attendees.length > 0) {
        return [...new Set(attendees.map(a => toTitleCase(String(a))))];
      }
    } catch { /* ignore parse errors */ }
  }
  return null;
}

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

// ─── HANDLER ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const isCron = verifyCronAuth(req);
  const userId = isCron ? null : await getUserFromToken(req);

  if (!isCron && !userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();
  const startTime = Date.now();

  try {
    let query = supabase
      .from('microsoft_ingestion_queue')
      .select('*')
      .eq('status', 'content_ready')
      .order('created_at', { ascending: true })
      .limit(MAX_ITEMS_PER_BATCH);

    if (userId) query = query.eq('user_id', userId);

    const { data: items } = await query;
    if (!items?.length) return res.status(200).json({ processed: 0 });

    let processed = 0;

    for (const item of items as QueueItem[]) {
      if (Date.now() - startTime > TIME_BUDGET_MS) break;

      // Mark claimed
      await supabase.from('microsoft_ingestion_queue').update({
        status: 'extracting',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', item.id);

      const itemStartTime = Date.now();
      try {
        // ── Fetch extraction config (profile, integration settings, anchors) ──
        const [profileRes, integrationRes, anchorsRes, extractionSettingsRes] = await Promise.all([
          supabase.from('user_profiles').select('*').eq('user_id', item.user_id).maybeSingle(),
          supabase
            .from('microsoft_integrations')
            .select('extraction_mode, anchor_emphasis, linked_anchor_ids, custom_instructions')
            .eq('user_id', item.user_id)
            .maybeSingle(),
          supabase
            .from('knowledge_nodes')
            .select('label, entity_type, description')
            .eq('user_id', item.user_id)
            .eq('is_anchor', true)
            .limit(10),
          supabase.from('extraction_settings').select('default_mode, default_anchor_emphasis').eq('user_id', item.user_id).maybeSingle(),
        ]);

        const userProfile = profileRes.data as UserProfile | null;
        const integrationSettings = integrationRes.data as {
          extraction_mode: string | null;
          anchor_emphasis: string | null;
          linked_anchor_ids: string[] | null;
          custom_instructions: string | null;
        } | null;
        const defaults = extractionSettingsRes.data as { default_mode: string; default_anchor_emphasis: string } | null;

        const extractionMode = integrationSettings?.extraction_mode ?? defaults?.default_mode ?? 'comprehensive';
        const anchorEmphasis = integrationSettings?.anchor_emphasis ?? defaults?.default_anchor_emphasis ?? 'standard';

        // Full anchor context — before consolidation, Microsoft only passed
        // anchor labels as a comma-separated string to Gemini. Now it gets
        // the same rich anchor context (type + description) every other
        // pipeline uses.
        const anchors = (anchorsRes.data ?? []) as Anchor[];

        // ── Determine source shape ──
        const sourceType = item.resource_type === 'meeting_transcript' || item.resource_type === 'calendar_event'
          ? 'Meeting' : 'Research';

        const participants = sourceType === 'Meeting'
          ? parseMeetingParticipants(item.content, item.attendees)
          : null;

        // ── Save the source row first (shared core needs sourceId) ──
        const insertRow: Record<string, unknown> = {
          user_id: item.user_id,
          title: item.title || 'Microsoft 365 Import',
          content: item.content.slice(0, MAX_CONTENT_CHARS),
          source_type: sourceType,
          metadata: {
            provider: 'microsoft',
            resource_type: item.resource_type,
            microsoft_resource_id: item.microsoft_resource_id,
            event_start: item.event_start,
            event_end: item.event_end,
            attendees: item.attendees ? JSON.parse(item.attendees) : null,
          },
        };
        if (participants) insertRow.participants = participants;

        const { data: source, error: sourceErr } = await supabase
          .from('knowledge_sources')
          .insert(insertRow)
          .select('id')
          .single();
        if (sourceErr || !source) throw new Error(`Failed to save source: ${sourceErr?.message}`);
        const sourceId = (source as { id: string }).id;

        // ── Run the shared extraction pipeline ──
        const coreResult = await runExtractionCore({
          content: item.content,
          promptConfig: {
            mode: extractionMode,
            anchorEmphasis,
            anchors,
            userProfile,
            customInstructions: integrationSettings?.custom_instructions ?? null,
          },
          source: {
            sourceId,
            sourceType,
            sourceUrl: null,
            sourceLabel: item.title ?? 'Microsoft 365',
          },
          userId: item.user_id,
          supabase,
          options: { itemStartTime },
        });

        // ── Mark queue complete ──
        await supabase.from('microsoft_ingestion_queue').update({
          status: 'completed',
          source_id: sourceId,
          nodes_created: coreResult.nodesCreated,
          edges_created: coreResult.edgesCreated,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', item.id);

        // ── Link meeting sources to Microsoft-associated domain agents ──
        // Microsoft-specific: uses user_integrations.integration_slug='microsoft'
        // to find agents belonging to this integration path. Kept here because
        // no other pipeline uses microsoft_integrations as the routing key.
        if (sourceType === 'Meeting') {
          try {
            const agentIds = new Set<string>();

            const { data: msIntegrations } = await supabase
              .from('user_integrations')
              .select('id, domain_agent_id')
              .eq('user_id', item.user_id)
              .eq('integration_slug', 'microsoft');

            for (const msInt of (msIntegrations ?? []) as Array<{ id: string; domain_agent_id: string | null }>) {
              const { data: links } = await supabase
                .from('agent_integration_links')
                .select('agent_id')
                .eq('integration_id', msInt.id);
              for (const link of (links ?? []) as Array<{ agent_id: string }>) {
                agentIds.add(link.agent_id);
              }
              if (agentIds.size === 0 && msInt.domain_agent_id) {
                agentIds.add(msInt.domain_agent_id);
              }
            }

            if (agentIds.size === 0) {
              const { data: agents } = await supabase
                .from('domain_agents')
                .select('id')
                .eq('user_id', item.user_id)
                .not('integration_id', 'is', null)
                .eq('is_active', true)
                .limit(1);
              const fallbackId = (agents?.[0] as { id: string } | undefined)?.id;
              if (fallbackId) agentIds.add(fallbackId);
            }

            for (const agentId of agentIds) {
              await supabase
                .from('domain_agent_sources')
                .upsert({
                  user_id: item.user_id,
                  agent_id: agentId,
                  source_id: sourceId,
                  association_type: 'primary',
                }, { onConflict: 'agent_id,source_id', ignoreDuplicates: true });

              await supabase
                .from('domain_agents')
                .update({ index_stale: true, last_ingestion_at: new Date().toISOString() })
                .eq('id', agentId);

              console.log(`[microsoft/extract] Linked meeting source ${sourceId} to agent ${agentId}`);
            }
          } catch (agentErr) {
            console.warn('[microsoft/extract] Meeting agent link failed (non-fatal):', agentErr);
          }
        }

        processed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[microsoft/extract-knowledge] Error processing ${item.id}:`, err);

        // Distinguish transient (requeue) from terminal (give up) errors.
        const isRateLimited = msg.startsWith('RATE_LIMITED');
        if (isRateLimited) {
          // Reset back to content_ready so the next cron tick picks it up.
          await supabase.from('microsoft_ingestion_queue').update({
            status: 'content_ready',
            started_at: null,
            error_message: msg,
            updated_at: new Date().toISOString(),
          }).eq('id', item.id);
        } else {
          await supabase.from('microsoft_ingestion_queue').update({
            status: 'failed',
            error_message: msg,
            updated_at: new Date().toISOString(),
          }).eq('id', item.id);
        }
      }
    }

    return res.status(200).json({ processed });
  } catch (err) {
    console.error('[microsoft/extract-knowledge] Error:', err);
    return res.status(500).json({ error: 'Extraction failed' });
  }
}
