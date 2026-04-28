// Stage 2 — persistSource(): the only path into knowledge_sources from the
// browser. Takes a CapturedSource, returns a stable sourceId.
//
// Dedup identity rules (per Stage 2 Wave A):
//   - youtube → canonical URL https://www.youtube.com/watch?v=<id>; partial
//     unique index (user_id, source_type, source_url) WHERE source_url IS NOT NULL.
//   - url     → canonicalised URL; same index as youtube.
//   - file    → SHA-256 content_hash; partial unique index (user_id,
//               source_type, content_hash) WHERE content_hash IS NOT NULL
//               AND source_url IS NULL.
//   - paste   → SHA-256 content_hash; same index as file.
//   - meeting → circleback_meeting_id; partial unique index (user_id,
//               circleback_meeting_id) WHERE circleback_meeting_id IS NOT NULL.
//
// Re-ingest behaviour (per locked decision):
//   - youtube/url/file/paste → return existing sourceId, status='skipped-duplicate'.
//   - meeting                → if payload_signature differs from stored,
//     replace content/metadata/title and reset status='pending'. Otherwise
//     skip-with-telemetry (decision A2 from Wave A).
//
// Initial state machine value:
//   - status='pending' on insert. Replace also resets to 'pending'.

import { supabase } from './supabase'
import {
  canonicalUrl,
  canonicalYouTubeUrl,
  meetingPayloadSignature,
  sha256Hex,
} from '../utils/sourceIdentity'
import type { CapturedSource } from '../types/capture'

export type PersistStatus = 'inserted' | 'replaced' | 'skipped-duplicate'

export interface PersistResult {
  sourceId: string
  isNew: boolean
  status: PersistStatus
}

export class PersistSourceError extends Error {
  details: unknown
  constructor(message: string, details?: unknown) {
    super(message)
    this.name = 'PersistSourceError'
    this.details = details
  }
}

interface DedupKey {
  sourceUrl: string | null
  contentHash: string | null
  circlebackMeetingId: number | null
  payloadSignature: string | null
}

async function buildDedupKey(captured: CapturedSource): Promise<DedupKey> {
  const meta = captured.metadata as Record<string, unknown>

  if (captured.source_type === 'youtube') {
    const canonical = (captured.source_url && canonicalYouTubeUrl(captured.source_url)) ?? null
    return {
      sourceUrl: canonical ?? captured.source_url ?? null,
      contentHash: null,
      circlebackMeetingId: null,
      payloadSignature: null,
    }
  }

  if (captured.source_type === 'url') {
    return {
      sourceUrl: captured.source_url ? canonicalUrl(captured.source_url) : null,
      contentHash: null,
      circlebackMeetingId: null,
      payloadSignature: null,
    }
  }

  if (captured.source_type === 'meeting') {
    const id = meta['circleback_meeting_id']
    const cid = typeof id === 'number' ? id : null
    const sig = await meetingPayloadSignature({
      transcriptSegmentCount: Number(meta['transcript_segment_count'] ?? 0),
      actionItemCount: Number(meta['action_item_count'] ?? 0),
      contentLength: captured.content.length,
      content: captured.content,
    })
    return {
      sourceUrl: captured.source_url ?? null,
      contentHash: null,
      circlebackMeetingId: cid,
      payloadSignature: sig,
    }
  }

  // paste, file → content-hash dedup, no source_url.
  return {
    sourceUrl: null,
    contentHash: await sha256Hex(captured.content.trim()),
    circlebackMeetingId: null,
    payloadSignature: null,
  }
}

export async function persistSource(
  captured: CapturedSource,
  userId: string,
): Promise<PersistResult> {
  const dedup = await buildDedupKey(captured)
  const startedAt = Date.now()

  // ── 1. Look up existing row by the right identity. ─────────────────────────
  if (captured.source_type === 'meeting' && dedup.circlebackMeetingId !== null) {
    const { data: existing } = await supabase
      .from('knowledge_sources')
      .select('id, metadata')
      .eq('user_id', userId)
      .eq('circleback_meeting_id', dedup.circlebackMeetingId)
      .maybeSingle()

    if (existing) {
      const storedSig = (existing.metadata as Record<string, unknown> | null)?.['payload_signature'] ?? null
      if (storedSig === dedup.payloadSignature) {
        log({
          stage: 'persist',
          status: 'skipped-duplicate',
          source_type: captured.source_type,
          source_id: existing.id,
          duration_ms: Date.now() - startedAt,
        })
        return { sourceId: existing.id, isNew: false, status: 'skipped-duplicate' }
      }
      // Signature differs → replace content + metadata + title; reset status.
      const replaceMeta = {
        ...(captured.metadata ?? {}),
        payload_signature: dedup.payloadSignature,
      }
      const { error: updErr } = await supabase
        .from('knowledge_sources')
        .update({
          title: captured.title,
          content: captured.content,
          source_url: captured.source_url,
          metadata: replaceMeta,
          status: 'pending',
        })
        .eq('id', existing.id)
      if (updErr) throw new PersistSourceError('Failed to replace meeting row', updErr)
      log({
        stage: 'persist',
        status: 'replaced',
        source_type: captured.source_type,
        source_id: existing.id,
        duration_ms: Date.now() - startedAt,
      })
      return { sourceId: existing.id, isNew: false, status: 'replaced' }
    }
  } else if (dedup.sourceUrl) {
    const { data: existing } = await supabase
      .from('knowledge_sources')
      .select('id')
      .eq('user_id', userId)
      .eq('source_type', captured.source_type)
      .eq('source_url', dedup.sourceUrl)
      .maybeSingle()
    if (existing) {
      log({
        stage: 'persist',
        status: 'skipped-duplicate',
        source_type: captured.source_type,
        source_id: existing.id,
        duration_ms: Date.now() - startedAt,
      })
      return { sourceId: existing.id, isNew: false, status: 'skipped-duplicate' }
    }
  } else if (dedup.contentHash) {
    const { data: existing } = await supabase
      .from('knowledge_sources')
      .select('id')
      .eq('user_id', userId)
      .eq('source_type', captured.source_type)
      .eq('content_hash', dedup.contentHash)
      .maybeSingle()
    if (existing) {
      log({
        stage: 'persist',
        status: 'skipped-duplicate',
        source_type: captured.source_type,
        source_id: existing.id,
        duration_ms: Date.now() - startedAt,
      })
      return { sourceId: existing.id, isNew: false, status: 'skipped-duplicate' }
    }
  }

  // ── 2. Insert. Catch error 23505 (race) and re-fetch. ──────────────────────
  const insertRow: Record<string, unknown> = {
    user_id: userId,
    title: captured.title,
    content: captured.content,
    source_type: captured.source_type,
    source_url: dedup.sourceUrl,
    content_hash: dedup.contentHash,
    metadata: {
      ...(captured.metadata ?? {}),
      ...(dedup.payloadSignature ? { payload_signature: dedup.payloadSignature } : {}),
    },
    status: 'pending',
  }
  if (dedup.circlebackMeetingId !== null) {
    insertRow.circleback_meeting_id = dedup.circlebackMeetingId
  }
  // Optional participants (meeting captures stash them in metadata).
  const participants = (captured.metadata as Record<string, unknown> | undefined)?.['participants']
  if (Array.isArray(participants) && participants.length > 0) {
    insertRow.participants = participants
  }

  const { data: inserted, error } = await supabase
    .from('knowledge_sources')
    .insert(insertRow)
    .select('id')
    .single()

  if (error) {
    const isRace = error.code === '23505' || /duplicate key/i.test(error.message)
    if (isRace) {
      const fallback = await fetchExisting(userId, captured.source_type, dedup)
      if (fallback) {
        log({
          stage: 'persist',
          status: 'skipped-duplicate',
          source_type: captured.source_type,
          source_id: fallback,
          reason: 'race-fallback',
          duration_ms: Date.now() - startedAt,
        })
        return { sourceId: fallback, isNew: false, status: 'skipped-duplicate' }
      }
    }
    throw new PersistSourceError('Failed to insert source', error)
  }

  log({
    stage: 'persist',
    status: 'inserted',
    source_type: captured.source_type,
    source_id: inserted.id,
    duration_ms: Date.now() - startedAt,
  })
  return { sourceId: inserted.id, isNew: true, status: 'inserted' }
}

async function fetchExisting(
  userId: string,
  sourceType: string,
  dedup: DedupKey,
): Promise<string | null> {
  if (dedup.circlebackMeetingId !== null) {
    const { data } = await supabase
      .from('knowledge_sources')
      .select('id')
      .eq('user_id', userId)
      .eq('circleback_meeting_id', dedup.circlebackMeetingId)
      .maybeSingle()
    return data?.id ?? null
  }
  if (dedup.sourceUrl) {
    const { data } = await supabase
      .from('knowledge_sources')
      .select('id')
      .eq('user_id', userId)
      .eq('source_type', sourceType)
      .eq('source_url', dedup.sourceUrl)
      .maybeSingle()
    return data?.id ?? null
  }
  if (dedup.contentHash) {
    const { data } = await supabase
      .from('knowledge_sources')
      .select('id')
      .eq('user_id', userId)
      .eq('source_type', sourceType)
      .eq('content_hash', dedup.contentHash)
      .maybeSingle()
    return data?.id ?? null
  }
  return null
}

// ─── Local structured log (browser console) ──────────────────────────────────

interface LogFields {
  stage: string
  source_type?: string
  source_id?: string
  status?: PersistStatus
  duration_ms?: number
  reason?: string
}

function log(fields: LogFields): void {
  // eslint-disable-next-line no-console
  console.info('[persist]', { ts: new Date().toISOString(), ...fields })
}
