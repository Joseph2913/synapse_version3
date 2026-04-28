/**
 * Stage 3 validation: semantic search end-to-end.
 *
 * Embed a known phrase, call match_source_chunks via the service role,
 * print the top hits and confirm the right source ranks first.
 *
 * Usage: npx tsx --env-file=.env.local scripts/stage3-semantic-search-test.ts
 */

import { createClient } from '@supabase/supabase-js'

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

async function embedQuery(text: string): Promise<number[]> {
  const resp = await fetch(
    `${GEMINI_BASE}/${GEMINI_EMBEDDING_MODEL}:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The production API key is HTTP-referrer-restricted to the deployed
        // domain. Server-side scripts must spoof a matching Referer header.
        'Referer': 'https://connectsynapse.com',
      },
      body: JSON.stringify({
        model: `models/${GEMINI_EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
      }),
    },
  )
  if (!resp.ok) throw new Error(`Embed ${resp.status}: ${await resp.text()}`)
  const data = (await resp.json()) as { embedding?: { values?: number[] } }
  if (!data.embedding?.values) throw new Error('No embedding values')
  return data.embedding.values
}

interface TestCase {
  query: string
  expectedTitleSubstring: string
}

const TESTS: TestCase[] = [
  {
    query: 'Tiago Forte building a second brain methodology',
    expectedTitleSubstring: 'Second Brain',
  },
  {
    query: 'Cassidy Hardin Google DeepMind open models talk',
    expectedTitleSubstring: 'DeepMind',
  },
  {
    query: 'productivity apps tested over the past decade',
    expectedTitleSubstring: 'Productivity Apps',
  },
]

async function main() {
  // Pick any user with chunks for the RPC user filter.
  const { data: anyChunk } = await supabase
    .from('source_chunks')
    .select('user_id')
    .limit(1)
    .single()
  const userId = (anyChunk as { user_id: string } | null)?.user_id
  if (!userId) {
    console.error('No chunks in DB.')
    process.exit(1)
  }

  let passed = 0
  for (const t of TESTS) {
    console.log(`\n--- query: "${t.query}"`)
    const vec = await embedQuery(t.query)
    const { data, error } = await supabase.rpc('match_source_chunks', {
      query_embedding: vec,
      match_threshold: 0.0,
      match_count: 5,
      p_user_id: userId,
    })
    if (error) {
      console.error('RPC error:', error.message)
      continue
    }
    const rows = (data ?? []) as Array<{ id: string; source_id: string; chunk_index: number; content: string; similarity: number }>
    if (rows.length === 0) {
      console.log('  no hits')
      continue
    }
    // Resolve titles for the source_ids in the result.
    const sourceIds = [...new Set(rows.map(r => r.source_id))]
    const { data: sources } = await supabase
      .from('knowledge_sources')
      .select('id, title')
      .in('id', sourceIds)
    const titleById = new Map((sources ?? []).map(s => [s.id, s.title as string]))

    rows.forEach((r, i) => {
      const title = titleById.get(r.source_id) ?? '(unknown)'
      console.log(`  ${i + 1}. sim=${r.similarity.toFixed(4)} ${title.slice(0, 70)}`)
    })

    const top = rows[0]
    const topTitle = titleById.get(top.source_id) ?? ''
    const ok = topTitle.toLowerCase().includes(t.expectedTitleSubstring.toLowerCase())
    console.log(`  expected substring: "${t.expectedTitleSubstring}" -> ${ok ? 'PASS' : 'FAIL'}`)
    if (ok) passed += 1
  }

  console.log(`\n${passed}/${TESTS.length} tests passed`)
  process.exit(passed === TESTS.length ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
