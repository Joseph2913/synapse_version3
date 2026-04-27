/**
 * Stage 3 backfill: re-chunk + re-embed every source that is missing chunks
 * or whose source state is failed/degraded/pending. Idempotent via
 * (source_id, chunk_index) unique constraint.
 *
 * Usage: npx tsx --env-file=.env.local scripts/backfill-chunks-stage3.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.VITE_GEMINI_API_KEY!

if (!SUPABASE_URL || !SUPABASE_KEY || !GEMINI_API_KEY) {
  console.error('Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'
const EMBEDDING_BATCH_SIZE = 100

// ── Chunker (paste-in copy of src/utils/chunking.ts) ───────────────────────

const CHUNK_TARGET_CHARS = 2000
const CHUNK_OVERLAP_CHARS = 100
const CHUNK_MAX_CHARS = 3000

const ABBREVIATIONS = [
  'Dr', 'Mr', 'Mrs', 'Ms', 'Prof', 'Sr', 'Jr', 'St',
  'vs', 'etc', 'e.g', 'i.e', 'U.S', 'U.K', 'U.N',
  'No', 'Inc', 'Ltd', 'Co', 'Corp', 'Fig', 'cf', 'al',
]
const DOT_SENTINEL = String.fromCharCode(0xE000)
const ABBREV_RE = new RegExp(
  '\\b(' + ABBREVIATIONS.map(a => a.replace(/\./g, '\\.')).join('|') + ')\\.',
  'g',
)

function splitSentences(text: string): string[] {
  const masked = text.replace(ABBREV_RE, (_, a) => `${a}${DOT_SENTINEL}`)
  const parts = masked.split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9])/g)
  return parts.map(p => p.split(DOT_SENTINEL).join('.').trim()).filter(Boolean)
}

function splitSections(text: string): string[] {
  const lines = text.split('\n')
  const sections: string[] = []
  let buf: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    const isHeading = /^#{1,6}\s/.test(line)
    const isRule = /^[-_*]{3,}$/.test(trimmed)
    if (isHeading || isRule) {
      if (buf.length) sections.push(buf.join('\n').trim())
      buf = [line]
    } else {
      buf.push(line)
    }
  }
  if (buf.length) sections.push(buf.join('\n').trim())
  return sections.filter(s => s.length > 0)
}

function splitParagraphs(text: string): string[] {
  return text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
}

function chunkText(content: string): string[] {
  if (!content || !content.trim()) return []
  const units: string[] = []
  for (const section of splitSections(content)) {
    for (const para of splitParagraphs(section)) {
      if (para.length <= CHUNK_TARGET_CHARS) {
        units.push(para)
        continue
      }
      for (const sent of splitSentences(para)) {
        if (sent.length <= CHUNK_MAX_CHARS) {
          units.push(sent)
        } else {
          for (let i = 0; i < sent.length; i += CHUNK_TARGET_CHARS) {
            units.push(sent.slice(i, i + CHUNK_TARGET_CHARS))
          }
        }
      }
    }
  }
  const chunks: string[] = []
  let current = ''
  for (const unit of units) {
    const sep = current ? '\n\n' : ''
    if (current.length + sep.length + unit.length > CHUNK_TARGET_CHARS && current.length > 0) {
      chunks.push(current.trim())
      const overlapStart = Math.max(0, current.length - CHUNK_OVERLAP_CHARS)
      current = current.substring(overlapStart).trim() + '\n\n' + unit
    } else {
      current += sep + unit
    }
  }
  if (current.trim()) chunks.push(current.trim())
  const merged: string[] = []
  for (const c of chunks) {
    if (merged.length > 0 && c.length < 200) {
      merged[merged.length - 1] += '\n\n' + c
    } else {
      merged.push(c)
    }
  }
  return merged.filter(c => c.length > 0)
}

function buildEmbeddingInput(title: string | null, content: string): string {
  const t = (title ?? '').trim()
  return t ? `${t}\n\n${content}` : content
}

// ── Embedding (canonical batch helper) ─────────────────────────────────────

async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const out: number[][] = []
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const slice = texts.slice(start, start + EMBEDDING_BATCH_SIZE)
    const url = `${GEMINI_BASE}/${GEMINI_EMBEDDING_MODEL}:batchEmbedContents?key=${GEMINI_API_KEY}`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: slice.map(text => ({
          model: `models/${GEMINI_EMBEDDING_MODEL}`,
          content: { parts: [{ text }] },
        })),
      }),
    })
    if (!resp.ok) {
      const t = await resp.text().catch(() => '')
      throw new Error(`Batch embedding ${resp.status}: ${t.slice(0, 200)}`)
    }
    const data = (await resp.json()) as { embeddings?: Array<{ values?: number[] }> }
    const vectors = (data.embeddings ?? []).map(e => e.values ?? [])
    if (vectors.length !== slice.length) {
      throw new Error(`Batch embedding length mismatch: ${vectors.length} vs ${slice.length}`)
    }
    out.push(...vectors)
  }
  return out
}

// ── Backfill ───────────────────────────────────────────────────────────────

interface SourceRow {
  id: string
  user_id: string
  content: string
  title: string | null
  status: string | null
  source_type: string | null
}

async function processSource(s: SourceRow, sb: SupabaseClient): Promise<{
  outcome: 'backfilled' | 'no_chunks' | 'failed' | 'degraded'
  chunks: number
  error?: string
}> {
  const chunks = chunkText(s.content)
  if (chunks.length === 0) return { outcome: 'no_chunks', chunks: 0 }

  let embeddings: number[][]
  try {
    embeddings = await embedTexts(chunks.map(c => buildEmbeddingInput(s.title, c)))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await sb.from('knowledge_sources').update({ status: 'degraded' }).eq('id', s.id).eq('user_id', s.user_id)
    return { outcome: 'degraded', chunks: 0, error: msg }
  }

  const missing = embeddings.findIndex(e => !e || e.length === 0)
  if (missing >= 0) {
    await sb.from('knowledge_sources').update({ status: 'degraded' }).eq('id', s.id).eq('user_id', s.user_id)
    return { outcome: 'degraded', chunks: 0, error: `Missing embedding at ${missing}` }
  }

  const rows = chunks.map((content, i) => ({
    user_id: s.user_id,
    source_id: s.id,
    chunk_index: i,
    content,
    embedding: embeddings[i],
  }))

  const { error } = await sb
    .from('source_chunks')
    .upsert(rows, { onConflict: 'source_id,chunk_index', ignoreDuplicates: true })
  if (error) {
    await sb.from('knowledge_sources').update({ status: 'failed' }).eq('id', s.id).eq('user_id', s.user_id)
    return { outcome: 'failed', chunks: 0, error: error.message }
  }

  if (s.status && s.status !== 'complete') {
    await sb.from('knowledge_sources').update({ status: 'complete' }).eq('id', s.id).eq('user_id', s.user_id)
  }
  return { outcome: 'backfilled', chunks: chunks.length }
}

async function main() {
  const t0 = Date.now()
  console.log('[backfill] Fetching candidate sources…')

  // Find sources with content but no chunks at all (or null embeddings).
  const { data: candidates, error } = await supabase
    .from('knowledge_sources')
    .select('id, user_id, content, title, status, source_type')
    .not('content', 'is', null)
    .order('created_at', { ascending: true })
  if (error) throw error
  const all = (candidates ?? []) as SourceRow[]

  const toProcess: SourceRow[] = []
  for (const s of all) {
    if (!s.content || s.content.length < 200) continue
    const { count: total } = await supabase
      .from('source_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('source_id', s.id)
    const { count: nullEmb } = await supabase
      .from('source_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('source_id', s.id)
      .is('embedding', null)
    const noChunks = (total ?? 0) === 0
    const hasNullEmb = (nullEmb ?? 0) > 0
    const inRetryState = s.status !== null && s.status !== 'complete'
    if (noChunks || hasNullEmb || inRetryState) {
      toProcess.push(s)
    }
  }

  console.log(`[backfill] ${toProcess.length} sources to process (out of ${all.length} candidates)`)

  let backfilled = 0, degraded = 0, failed = 0, noChunks = 0, totalChunks = 0
  const issues: Array<{ id: string; title: string | null; error: string; outcome: string }> = []

  for (let i = 0; i < toProcess.length; i++) {
    const s = toProcess[i]
    process.stdout.write(`[backfill] ${i + 1}/${toProcess.length} ${s.title?.slice(0, 60) ?? s.id} … `)
    // If null-embedding chunks exist on this source, blow them away first so the
    // upsert can re-insert clean rows. (ignoreDuplicates would skip them.)
    await supabase.from('source_chunks').delete().eq('source_id', s.id).is('embedding', null)
    try {
      const r = await processSource(s, supabase)
      if (r.outcome === 'backfilled') { backfilled++; totalChunks += r.chunks }
      else if (r.outcome === 'degraded') degraded++
      else if (r.outcome === 'failed') failed++
      else if (r.outcome === 'no_chunks') noChunks++
      console.log(`${r.outcome} (${r.chunks} chunks)${r.error ? ' — ' + r.error : ''}`)
      if (r.outcome !== 'backfilled') issues.push({ id: s.id, title: s.title, error: r.error ?? '', outcome: r.outcome })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      failed++
      console.log(`failed — ${msg}`)
      issues.push({ id: s.id, title: s.title, error: msg, outcome: 'failed' })
    }
  }

  console.log('\n[backfill] Done in', ((Date.now() - t0) / 1000).toFixed(1), 's')
  console.log(`  backfilled: ${backfilled} (${totalChunks} chunks)`)
  console.log(`  degraded:   ${degraded}`)
  console.log(`  failed:     ${failed}`)
  console.log(`  no_chunks:  ${noChunks}`)
  if (issues.length) {
    console.log('\nIssues:')
    for (const i of issues) console.log(`  - [${i.outcome}] ${i.title?.slice(0, 70) ?? i.id} — ${i.error}`)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
