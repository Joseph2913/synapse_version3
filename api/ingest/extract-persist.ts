// api/ingest/extract-persist.ts
// Receives reviewed entities and relationships from the browser, runs
// deduplication, persistence, chunking, cross-connections.
// Called after the user has reviewed the extract-preview results.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import {
  deduplicateEntities,
  saveNodes,
  saveEdges,
  saveTranscriptChunks,
  queueNearMatches,
  batchEmbed,
  type ExtractedEntity,
  type ExtractedRelationship,
  type SourceContext,
} from '../pipeline/extract-pipeline.js';

export const maxDuration = 300;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!process.env.GEMINI_API_KEY) {
  throw new Error('[gemini] Missing env var: GEMINI_API_KEY');
}

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

type LogStatus = 'ok' | 'failed' | 'partial' | 'skipped';
interface LogFields { stage: string; user_id?: string; source_id?: string; duration_ms?: number; status?: LogStatus; error?: string; [k: string]: unknown; }
function log(f: LogFields) { console.log(JSON.stringify({ ts: new Date().toISOString(), ...f })); }
function logError(f: LogFields & { error: string }) { console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', ...f })); }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const supabase = getSupabase();

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid auth token' });
  const userId = user.id;

  const body = req.body as {
    sourceId?: string;
    content?: string;
    entities?: ExtractedEntity[];
    relationships?: ExtractedRelationship[];
    sourceContext?: {
      sourceType: string;
      sourceUrl?: string | null;
      sourceLabel?: string | null;
    };
    enableFuzzyDedup?: boolean;
    enableCrossConnections?: boolean;
  };

  const { sourceId, content, entities, relationships, sourceContext } = body;
  if (!sourceId || typeof sourceId !== 'string') return res.status(400).json({ error: 'sourceId is required' });
  if (!entities || !Array.isArray(entities)) return res.status(400).json({ error: 'entities array is required' });
  if (!relationships || !Array.isArray(relationships)) return res.status(400).json({ error: 'relationships array is required' });

  const t0 = Date.now();

  const source: SourceContext = {
    sourceId,
    sourceType: sourceContext?.sourceType ?? 'paste',
    sourceUrl: sourceContext?.sourceUrl ?? null,
    sourceLabel: sourceContext?.sourceLabel ?? null,
  };

  try {
    const enableFuzzyDedup = body.enableFuzzyDedup !== false;
    const enableCrossConnections = body.enableCrossConnections !== false;

    // Dedup
    const dedup = await deduplicateEntities(entities, userId, supabase, enableFuzzyDedup);

    // Save nodes + embeddings
    const { savedNodeMap, nodesCreated } = await saveNodes(entities, dedup, source, userId, supabase);

    // Queue near-matches for review
    if (enableFuzzyDedup && dedup.nearMatchQueue.length > 0) {
      await queueNearMatches(dedup.nearMatchQueue, savedNodeMap, userId, supabase);
    }

    // Save edges
    let edgesCreated = await saveEdges(relationships, savedNodeMap, userId, supabase, 1.0);

    // Embed edges inline
    if (edgesCreated > 0) {
      try {
        const edgeTexts: string[] = [];
        const edgeKeys: Array<{ sourceId: string; targetId: string; relationType: string }> = [];
        // Build node label lookup
        const nodeIds = [...new Set([
          ...relationships.map(r => savedNodeMap.get(r.source)).filter(Boolean) as string[],
          ...relationships.map(r => savedNodeMap.get(r.target)).filter(Boolean) as string[],
        ])];
        const nodeLabelMap = new Map<string, string>();
        if (nodeIds.length > 0) {
          const { data: nodeRows } = await supabase.from('knowledge_nodes').select('id, label').in('id', nodeIds);
          for (const n of nodeRows ?? []) { nodeLabelMap.set((n as { id: string; label: string }).id, (n as { id: string; label: string }).label); }
        }
        for (const rel of relationships) {
          const sId = savedNodeMap.get(rel.source);
          const tId = savedNodeMap.get(rel.target);
          if (!sId || !tId || sId === tId) continue;
          const sLabel = nodeLabelMap.get(sId) ?? rel.source;
          const tLabel = nodeLabelMap.get(tId) ?? rel.target;
          edgeTexts.push(`${sLabel} ${rel.relation_type} ${tLabel}${rel.evidence ? `: ${rel.evidence}` : ''}`);
          edgeKeys.push({ sourceId: sId, targetId: tId, relationType: rel.relation_type });
        }
        if (edgeTexts.length > 0) {
          const embeddings = await batchEmbed(edgeTexts);
          await Promise.allSettled(
            edgeKeys.map((k, i) => {
              const emb = embeddings[i];
              if (!emb || emb.length === 0) return Promise.resolve();
              return supabase.from('knowledge_edges').update({ embedding: emb })
                .eq('user_id', userId).eq('source_node_id', k.sourceId)
                .eq('target_node_id', k.targetId).eq('relation_type', k.relationType);
            })
          );
        }
      } catch (edgeEmbedErr) {
        logError({ stage: 'extract:persist:edge-embed', user_id: userId, source_id: sourceId, status: 'failed', error: String(edgeEmbedErr) });
      }
    }

    // Chunks
    let chunkCount = 0;
    if (content && content.trim().length > 0) {
      try {
        chunkCount = await saveTranscriptChunks(content, sourceId, userId, supabase, source.sourceLabel ?? null);
      } catch (chunkErr) {
        const message = chunkErr instanceof Error ? chunkErr.message : String(chunkErr);
        const newStatus = message.startsWith('Embedding missing') || message.includes('RATE_LIMITED') ? 'degraded' : 'failed';
        await supabase.from('knowledge_sources').update({ status: newStatus }).eq('id', sourceId).eq('user_id', userId);
        logError({ stage: 'chunk', user_id: userId, source_id: sourceId, status: newStatus, error: message });
        return res.status(500).json({ error: message });
      }
    }

    // Cross-connections — moved out of the inline path. Fire-and-forget the
    // standalone endpoint, which reads embeddings from the DB so retries work.
    void enableCrossConnections;
    const crossConnectionCount = 0;

    // Set source status to complete
    await supabase.from('knowledge_sources').update({ status: 'complete' }).eq('id', sourceId).eq('user_id', userId);

    {
      const appUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
      fetch(`${appUrl}/api/cross-connect/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ingest-secret': process.env.INGEST_SECRET ?? '' },
        body: JSON.stringify({ sourceId, userId }),
      }).catch(err => { console.warn('[extract-persist] Cross-connect trigger failed (non-fatal):', err); });
    }

    log({ stage: 'extract:persist', user_id: userId, source_id: sourceId, duration_ms: Date.now() - t0, status: 'ok', nodes_created: nodesCreated, edges_created: edgesCreated, chunks: chunkCount, cross_connections: crossConnectionCount });

    return res.status(200).json({
      sourceId,
      nodeIds: [...savedNodeMap.values()],
      edgesCreated,
      chunkCount,
      crossConnectionCount,
      durationMs: Date.now() - t0,
      mergedEntitiesLog: dedup.mergedEntitiesLog,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError({ stage: 'extract:persist', user_id: userId, source_id: sourceId, duration_ms: Date.now() - t0, status: 'failed', error: message });
    await supabase.from('knowledge_sources').update({ status: 'failed' }).eq('id', sourceId).eq('user_id', userId);
    return res.status(500).json({ error: message });
  }
}
