/**
 * RAG Pipeline Diagnostic — Tests the real RAG pipeline across 4 use cases
 * and logs thinking tokens, output tokens, finishReason, and response quality.
 *
 * Usage: node scripts/rag-diagnostic.mjs
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

// ─── Load env ──────────────────────────────────────────────────────────────────
const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf-8')
const vars = {}
for (const line of env.split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue
  const i = t.indexOf('='); if (i === -1) continue
  vars[t.slice(0, i).trim()] = t.slice(i + 1).trim()
}

const SUPABASE_URL = vars.SUPABASE_URL
const SUPABASE_KEY = vars.SUPABASE_SERVICE_ROLE_KEY
const GEMINI_API_KEY = vars.GEMINI_API_KEY
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

// ─── Helper: Find a real user ──────────────────────────────────────────────────
async function findUserId() {
  // Use the user with actual chunk data
  return 'b9264b41-bee4-49a7-a141-c37764f60216'
}

// ─── Helper: Find sources ──────────────────────────────────────────────────────
async function findSources(userId, limit = 5) {
  const { data } = await sb
    .from('knowledge_sources')
    .select('id, title, source_type')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)
  return data ?? []
}

// ─── Helper: Fetch chunks for a source ─────────────────────────────────────────
async function fetchChunksForSource(sourceId, userId, limit = 30) {
  const { data } = await sb
    .from('source_chunks')
    .select('id, content, source_id')
    .eq('source_id', sourceId)
    .limit(limit)

  // Enrich with source metadata
  const { data: source } = await sb
    .from('knowledge_sources')
    .select('id, title, source_type, created_at')
    .eq('id', sourceId)
    .single()

  return (data ?? []).map(c => ({
    ...c,
    sourceTitle: source?.title ?? 'Unknown',
    sourceType: source?.source_type ?? 'unknown',
    sourceCreatedAt: source?.created_at ?? new Date().toISOString(),
    source_id: sourceId,
  }))
}

// ─── Helper: Semantic search chunks (general query) ────────────────────────────
async function semanticSearchChunks(userId, query, limit = 20) {
  // Get embedding for query
  const embedResp = await fetch(
    `${GEMINI_BASE_URL}/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text: query }] },
      }),
    }
  )
  const embedData = await embedResp.json()
  const embedding = embedData.embedding?.values
  if (!embedding) { console.error('Failed to get embedding'); return [] }

  const { data } = await sb.rpc('match_source_chunks', {
    query_embedding: embedding,
    match_threshold: 0.3,
    match_count: limit,
    p_user_id: userId,
  })

  if (!data || data.length === 0) return []

  // Enrich with source metadata
  const sourceIds = [...new Set(data.map(c => c.source_id))]
  const { data: sources } = await sb
    .from('knowledge_sources')
    .select('id, title, source_type, created_at')
    .in('id', sourceIds)
  const sourceMap = new Map((sources ?? []).map(s => [s.id, s]))

  return data.map(c => {
    const src = sourceMap.get(c.source_id)
    return {
      ...c,
      sourceTitle: src?.title ?? 'Unknown',
      sourceType: src?.source_type ?? 'unknown',
      sourceCreatedAt: src?.created_at ?? new Date().toISOString(),
    }
  })
}

// ─── Build RAG prompt (mirrors gemini.ts buildRAGSystemPrompt) ─────────────────
function buildPrompt(chunks, question) {
  const distinctSources = new Set(chunks.map(c => c.source_id))
  const isMultiSource = distinctSources.size >= 2

  const chunksText = chunks.length > 0
    ? chunks.map((c, i) =>
        `--- Chunk ${i + 1} | Source: "${c.sourceTitle}" | source_id: "${c.source_id}" | Type: ${c.sourceType} | Date: ${new Date(c.sourceCreatedAt).toLocaleDateString()} ---\n${c.content}`
      ).join('\n\n')
    : '(No source chunks were retrieved for this query)'

  const systemPrompt = `You are Synapse, a Graph RAG assistant. Answer from the source chunks below.
INLINE CITATIONS — Use [N] numbered references inline (e.g. "The project launched in Q3 [1]").
${isMultiSource ? `COMPARISON — ${distinctSources.size} distinct sources present. Attribute clearly.` : ''}

RESPONSE FORMAT — return ONLY valid JSON:
{
  "answer": "Your answer with [1], [2] inline citations. Use **bold** for key entities.",
  "citations": [{"index": 1, "label": "Source title", "entity_type": "Topic", "node_id": null, "source_id": "uuid", "chunk_index": 0}],
  "followUp": {"question": "A follow-up question", "label": "Go deeper"}
}

SOURCE CHUNKS:
${chunksText}`

  return systemPrompt
}

// ─── Call Gemini and measure everything ─────────────────────────────────────────
async function callGemini(systemPrompt, question, maxOutputTokens = 32768, useJsonMode = true) {
  const startTime = Date.now()

  const generationConfig = {
    temperature: 0.3,
    maxOutputTokens,
  }
  if (useJsonMode) {
    generationConfig.responseMimeType = 'application/json'
  }

  const resp = await fetch(
    `${GEMINI_BASE_URL}/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: question }] }],
        generationConfig,
      }),
    }
  )

  const data = await resp.json()
  const elapsed = Date.now() - startTime
  const candidate = data.candidates?.[0]
  const finishReason = candidate?.finishReason
  const usageMetadata = data.usageMetadata

  // Extract parts
  const parts = candidate?.content?.parts ?? []
  const thinkingParts = parts.filter(p => p.thought === true)
  const textParts = parts.filter(p => p.thought !== true && typeof p.text === 'string')
  const responseText = textParts.map(p => p.text).join('') || ''

  // Try to parse as JSON
  let cleaned = responseText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim()
  const firstBrace = cleaned.indexOf('{')
  if (firstBrace > 0) cleaned = cleaned.slice(firstBrace)

  let parsedAnswer = null
  let citationCount = 0
  let parseMethod = 'none'

  try {
    const parsed = JSON.parse(cleaned)
    parsedAnswer = parsed.answer
    citationCount = Array.isArray(parsed.citations) ? parsed.citations.length : 0
    parseMethod = 'clean JSON'
  } catch {
    // Try fix-up
    let fixAttempt = cleaned.replace(/,\s*$/, '')
    let braceCount = 0, bracketCount = 0, inString = false, escaped = false
    for (const ch of fixAttempt) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === '{') braceCount++; if (ch === '}') braceCount--
      if (ch === '[') bracketCount++; if (ch === ']') bracketCount--
    }
    if (inString) fixAttempt += '"'
    while (bracketCount > 0) { fixAttempt += ']'; bracketCount-- }
    while (braceCount > 0) { fixAttempt += '}'; braceCount-- }
    fixAttempt = fixAttempt.replace(/,\s*([}\]])/g, '$1')

    try {
      const parsed = JSON.parse(fixAttempt)
      parsedAnswer = parsed.answer
      citationCount = Array.isArray(parsed.citations) ? parsed.citations.length : 0
      parseMethod = 'fix-up JSON (was truncated)'
    } catch {
      // Regex fallback
      const m = cleaned.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)/)
      if (m?.[1]) {
        parsedAnswer = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
        parseMethod = 'regex extraction (JSON broken)'
      } else {
        parsedAnswer = cleaned.slice(0, 500)
        parseMethod = 'raw text (no JSON found)'
      }
    }
  }

  return {
    elapsed,
    finishReason,
    usageMetadata,
    thinkingTokensApprox: thinkingParts.reduce((sum, p) => sum + (p.text?.length ?? 0), 0),
    thinkingPartsCount: thinkingParts.length,
    rawResponseLength: responseText.length,
    parseMethod,
    answerLength: parsedAnswer?.length ?? 0,
    answerPreview: parsedAnswer?.slice(0, 200) ?? '(empty)',
    answerWordCount: parsedAnswer ? parsedAnswer.split(/\s+/).length : 0,
    citationCount,
    promptLength: systemPrompt.length,
    startsWithJson: responseText.trimStart().startsWith('{'),
    rawFirst100: responseText.slice(0, 100),
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(80))
  console.log('RAG PIPELINE DIAGNOSTIC')
  console.log('='.repeat(80))
  console.log()

  const userId = await findUserId()
  if (!userId) { console.error('No user found'); return }
  console.log(`User ID: ${userId}`)

  const sources = await findSources(userId, 5)
  console.log(`Found ${sources.length} recent sources:`)
  sources.forEach((s, i) => console.log(`  ${i + 1}. [${s.source_type}] ${s.title}`))
  console.log()

  const testCases = []

  // ── Test 1: Chat with a specific source ──────────────────────────────────
  if (sources[0]) {
    const src = sources[0]
    const chunks = await fetchChunksForSource(src.id, userId, 30)
    testCases.push({
      name: `1. CHAT WITH SOURCE: "${src.title}" (${src.source_type})`,
      question: `Tell me about "${src.title}" in depth. What are the key arguments, specific details, important decisions, and notable insights in this source? Go beyond the summary.`,
      chunks,
    })
  }

  // ── Test 2: General knowledge query ──────────────────────────────────────
  {
    const chunks = await semanticSearchChunks(userId, 'What are the key themes and important decisions across my recent meetings?', 20)
    testCases.push({
      name: '2. GENERAL QUERY: "Key themes across recent meetings"',
      question: 'What are the key themes and important decisions across my recent meetings?',
      chunks,
    })
  }

  // ── Test 3: Comparative query ────────────────────────────────────────────
  if (sources.length >= 2) {
    const src1 = sources[0], src2 = sources[1]
    const chunks1 = await fetchChunksForSource(src1.id, userId, 15)
    const chunks2 = await fetchChunksForSource(src2.id, userId, 15)
    testCases.push({
      name: `3. COMPARE: "${src1.title}" vs "${src2.title}"`,
      question: `Compare "${src1.title}" with "${src2.title}". What are the key similarities, differences, and complementary insights?`,
      chunks: [...chunks1, ...chunks2],
    })
  }

  // ── Test 4: Entity exploration ───────────────────────────────────────────
  {
    const chunks = await semanticSearchChunks(userId, 'Joseph Thomas role responsibilities projects', 15)
    testCases.push({
      name: '4. ENTITY EXPLORE: "Joseph Thomas"',
      question: 'Tell me about Joseph Thomas. What is his role, what projects is he involved in, and what key decisions has he made?',
      chunks,
    })
  }

  // ── Run all tests ────────────────────────────────────────────────────────
  for (const tc of testCases) {
    console.log('─'.repeat(80))
    console.log(`TEST: ${tc.name}`)
    console.log(`Chunks: ${tc.chunks.length} | Question: ${tc.question.slice(0, 80)}...`)
    console.log()

    const prompt = buildPrompt(tc.chunks, tc.question)

    console.log(`Prompt size: ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)`)
    console.log('Calling Gemini 2.5 Flash (maxOutputTokens=32768, JSON MODE ON)...')
    console.log()

    const result = await callGemini(prompt, tc.question, 32768, true)

    console.log('RESULTS:')
    console.log(`  Time:              ${(result.elapsed / 1000).toFixed(1)}s`)
    console.log(`  Finish Reason:     ${result.finishReason}`)
    console.log(`  Parse Method:      ${result.parseMethod}`)
    console.log(`  Starts with JSON:  ${result.startsWithJson}`)
    console.log()
    console.log(`  Usage Metadata:`)
    if (result.usageMetadata) {
      console.log(`    Prompt tokens:     ${result.usageMetadata.promptTokenCount ?? '?'}`)
      console.log(`    Response tokens:   ${result.usageMetadata.candidatesTokenCount ?? '?'}`)
      console.log(`    Thinking tokens:   ${result.usageMetadata.thoughtsTokenCount ?? result.usageMetadata.cachedContentTokenCount ?? '?'}`)
      console.log(`    Total tokens:      ${result.usageMetadata.totalTokenCount ?? '?'}`)
    } else {
      console.log(`    (not available)`)
    }
    console.log()
    console.log(`  Thinking parts:    ${result.thinkingPartsCount} (${result.thinkingTokensApprox} chars)`)
    console.log(`  Raw response:      ${result.rawResponseLength} chars`)
    console.log(`  Answer length:     ${result.answerLength} chars (~${result.answerWordCount} words)`)
    console.log(`  Citations:         ${result.citationCount}`)
    console.log()
    console.log(`  Raw first 100:     ${result.rawFirst100}`)
    console.log(`  Answer preview:    ${result.answerPreview}`)
    console.log()
  }

  console.log('='.repeat(80))
  console.log('DIAGNOSTIC COMPLETE')
  console.log('='.repeat(80))
}

main().catch(console.error)
