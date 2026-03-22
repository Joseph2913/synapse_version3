#!/usr/bin/env node
/**
 * PRD-15B: Re-Embedding Pipeline
 *
 * Generates fresh 3072-dimensional embeddings for all source_chunks
 * and knowledge_nodes using gemini-embedding-001, then stores them as proper
 * vector(3072) values in the database.
 *
 * Run:
 *   npm run reembed
 *   — or —
 *   node --env-file=.env.local scripts/reembed-all.mjs
 *
 * Requirements in .env.local:
 *   VITE_SUPABASE_URL         — your Supabase project URL
 *   VITE_GEMINI_API_KEY       — Gemini API key with gemini-embedding-001 access
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (bypasses RLS, processes all users)
 *       OR
 *   VITE_SUPABASE_ANON_KEY    — anon key (only processes rows for authenticated user,
 *                               fine for single-user personal apps)
 *
 * Resume: The script uses WHERE embedding IS NULL, so it automatically picks up
 * from where it stopped if interrupted and rerun.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

// ── Load .env.local if env vars are not already set ──────────────────────────
try {
  const content = readFileSync('.env.local', 'utf8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx === -1) continue
    const key = trimmed.slice(0, idx).trim()
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = val
  }
} catch {
  // .env.local not found — rely on existing process.env
}

// ── Validate config ───────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
const GEMINI_KEY = process.env.VITE_GEMINI_API_KEY

if (!SUPABASE_URL || !SUPABASE_KEY || !GEMINI_KEY) {
  console.error('❌  Missing required environment variables.')
  console.error('    Required: VITE_SUPABASE_URL, VITE_GEMINI_API_KEY')
  console.error('    Plus one of: SUPABASE_SERVICE_ROLE_KEY or VITE_SUPABASE_ANON_KEY')
  process.exit(1)
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('⚠️  Using anon key — RLS applies. Only rows for the authenticated user')
  console.warn('   will be processed. For full coverage, add SUPABASE_SERVICE_ROLE_KEY')
  console.warn('   to .env.local (found under Supabase Dashboard → Project Settings → API).')
  console.warn('')
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ── Constants ─────────────────────────────────────────────────────────────────
const BATCH_SIZE = 20     // rows fetched per DB query
const CONCURRENCY = 5     // concurrent Gemini API calls per batch
const BATCH_DELAY_MS = 200 // pause between batches (rate limit headroom)

// ── Gemini embedding call ─────────────────────────────────────────────────────
async function embedText(text, maxRetries = 4) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_KEY}`

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'models/gemini-embedding-001',
          content: { parts: [{ text: text || ' ' }] },
        }),
      })
    } catch (networkErr) {
      if (attempt < maxRetries - 1) {
        await sleep(Math.pow(2, attempt) * 1000)
        continue
      }
      throw networkErr
    }

    if (res.status === 429) {
      const backoff = Math.min(Math.pow(2, attempt) * 1000, 30_000)
      console.log(`    ⏳ Rate limited. Waiting ${backoff / 1000}s before retry ${attempt + 1}/${maxRetries}...`)
      await sleep(backoff)
      continue
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 200)}`)
    }

    const data = await res.json()
    const values = data?.embedding?.values

    if (!Array.isArray(values) || values.length !== 3072) {
      throw new Error(`Unexpected embedding dimensions: got ${values?.length}, expected 3072`)
    }

    return values
  }

  throw new Error(`Failed to embed after ${maxRetries} attempts (persistent rate limit)`)
}

// ── Run up to N promises concurrently ────────────────────────────────────────
async function runConcurrent(items, fn, concurrency) {
  const results = []
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency)
    const settled = await Promise.allSettled(batch.map(fn))
    results.push(...settled)
  }
  return results
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function fmtTime(ms) {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

// ── Phase 1: Source chunks ────────────────────────────────────────────────────
async function reembedChunks() {
  console.log('\n─── Phase 1: Source Chunks (source_chunks) ────────────')

  const { count, error: countErr } = await supabase
    .from('source_chunks')
    .select('*', { count: 'exact', head: true })
    .is('embedding', null)

  if (countErr) {
    console.error('  ❌ Failed to count chunks:', countErr.message)
    return { embedded: 0, failed: 0 }
  }

  const total = count ?? 0
  console.log(`  ${total} chunks need embedding`)
  if (total === 0) {
    console.log('  ✅ Nothing to do.')
    return { embedded: 0, failed: 0 }
  }

  let processed = 0
  let embedded = 0
  let failed = 0
  const start = Date.now()

  while (true) {
    const { data: rows, error: fetchErr } = await supabase
      .from('source_chunks')
      .select('id, content')
      .is('embedding', null)
      .order('id')
      .limit(BATCH_SIZE)

    if (fetchErr) {
      console.error('  ❌ Fetch error:', fetchErr.message)
      break
    }
    if (!rows || rows.length === 0) break

    const settled = await runConcurrent(rows, async (row) => {
      const vec = await embedText(row.content)
      const { error: upErr } = await supabase
        .from('source_chunks')
        .update({ embedding: vec })
        .eq('id', row.id)
      if (upErr) throw new Error(`DB update failed for chunk ${row.id}: ${upErr.message}`)
    }, CONCURRENCY)

    settled.forEach(r => r.status === 'fulfilled' ? embedded++ : failed++)
    if (failed > 0) {
      const errors = settled.filter(r => r.status === 'rejected').map(r => r.reason?.message)
      console.error('  ⚠️  Errors in this batch:', errors.slice(0, 3).join(' | '))
    }

    processed += rows.length
    const pct = ((processed / total) * 100).toFixed(1)
    const elapsed = fmtTime(Date.now() - start)
    console.log(`  [Chunks] ${processed}/${total} (${pct}%) — ${failed} errors — ${elapsed}`)

    if (rows.length < BATCH_SIZE) break
    await sleep(BATCH_DELAY_MS)
  }

  return { embedded, failed }
}

// ── Phase 2: Knowledge nodes ──────────────────────────────────────────────────
async function reembedNodes() {
  console.log('\n─── Phase 2: Knowledge Nodes ────────────────────────────────────')

  const { count, error: countErr } = await supabase
    .from('knowledge_nodes')
    .select('*', { count: 'exact', head: true })
    .is('embedding', null)

  if (countErr) {
    console.error('  ❌ Failed to count nodes:', countErr.message)
    return { embedded: 0, failed: 0 }
  }

  const total = count ?? 0
  console.log(`  ${total} nodes need embedding`)
  if (total === 0) {
    console.log('  ✅ Nothing to do.')
    return { embedded: 0, failed: 0 }
  }

  let processed = 0
  let embedded = 0
  let failed = 0
  const start = Date.now()

  while (true) {
    const { data: rows, error: fetchErr } = await supabase
      .from('knowledge_nodes')
      .select('id, label, description')
      .is('embedding', null)
      .order('id')
      .limit(BATCH_SIZE)

    if (fetchErr) {
      console.error('  ❌ Fetch error:', fetchErr.message)
      break
    }
    if (!rows || rows.length === 0) break

    const settled = await runConcurrent(rows, async (row) => {
      const text = `${row.label}: ${row.description ?? ''}`
      const vec = await embedText(text)
      const { error: upErr } = await supabase
        .from('knowledge_nodes')
        .update({ embedding: vec })
        .eq('id', row.id)
      if (upErr) throw new Error(`DB update failed for node ${row.id}: ${upErr.message}`)
    }, CONCURRENCY)

    settled.forEach(r => r.status === 'fulfilled' ? embedded++ : failed++)
    if (failed > 0) {
      const errors = settled.filter(r => r.status === 'rejected').map(r => r.reason?.message)
      console.error('  ⚠️  Errors in this batch:', errors.slice(0, 3).join(' | '))
    }

    processed += rows.length
    const pct = ((processed / total) * 100).toFixed(1)
    const elapsed = fmtTime(Date.now() - start)
    console.log(`  [Nodes]  ${processed}/${total} (${pct}%) — ${failed} errors — ${elapsed}`)

    if (rows.length < BATCH_SIZE) break
    await sleep(BATCH_DELAY_MS)
  }

  return { embedded, failed }
}

// ── Main ──────────────────────────────────────────────────────────────────────
const totalStart = Date.now()

console.log('═══════════════════════════════════════════════════════════')
console.log('  PRD-15B: Synapse Re-Embedding Pipeline')
console.log('  Model:   gemini-embedding-001 (3072 dimensions)')
console.log('  Batch:   20 rows · 5 concurrent · 200ms between batches')
console.log('═══════════════════════════════════════════════════════════')

const chunkResult = await reembedChunks()
const nodeResult = await reembedNodes()

const totalTime = fmtTime(Date.now() - totalStart)
const totalEmbedded = chunkResult.embedded + nodeResult.embedded
const totalFailed = chunkResult.failed + nodeResult.failed

console.log('\n═══════════════════════════════════════════════════════════')
console.log('  Re-embedding Complete')
console.log(`  Source chunks:    ${chunkResult.embedded} embedded, ${chunkResult.failed} failed`)
console.log(`  Knowledge nodes:  ${nodeResult.embedded} embedded, ${nodeResult.failed} failed`)
console.log(`  Total:            ${totalEmbedded} embedded, ${totalFailed} failed`)
console.log(`  Total time:       ${totalTime}`)
console.log('═══════════════════════════════════════════════════════════')

if (totalFailed > 0) {
  console.warn(`\n⚠️  ${totalFailed} items failed. Rerun the script to retry them.`)
  console.warn('   (WHERE embedding IS NULL automatically skips already-embedded rows)')
}

if (totalEmbedded > 0) {
  console.log('\n─── Next Step: Create IVFFlat Indexes ───────────────────────')
  console.log('  Paste these into Supabase SQL Editor:\n')
  console.log('  CREATE INDEX IF NOT EXISTS idx_source_chunks_embedding_ivfflat')
  console.log('    ON source_chunks USING ivfflat (embedding vector_cosine_ops)')
  console.log('    WITH (lists = 100);\n')
  console.log('  CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_embedding_ivfflat')
  console.log('    ON knowledge_nodes USING ivfflat (embedding vector_cosine_ops)')
  console.log('    WITH (lists = 100);')
}
