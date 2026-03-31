/**
 * Comprehensive RAG Pipeline Test
 * Tests JSON validity, citations, source mapping, answer quality,
 * token usage, finish reason, and format compliance across 6 scenarios.
 *
 * Usage: node scripts/rag-comprehensive-test.mjs
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

const sb = createClient(vars.SUPABASE_URL, vars.SUPABASE_SERVICE_ROLE_KEY)
const GEMINI_API_KEY = vars.GEMINI_API_KEY
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
const USER_ID = 'b9264b41-bee4-49a7-a141-c37764f60216'

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function fetchChunks(sourceId, limit = 15) {
  const { data: chunks } = await sb.from('source_chunks').select('id, content, source_id').eq('source_id', sourceId).limit(limit)
  const { data: src } = await sb.from('knowledge_sources').select('id, title, source_type, created_at').eq('id', sourceId).single()
  return (chunks ?? []).map(c => ({
    ...c,
    sourceTitle: src?.title ?? 'Unknown',
    sourceType: src?.source_type ?? 'unknown',
    sourceCreatedAt: src?.created_at ?? new Date().toISOString(),
    source_id: sourceId,
  }))
}

async function semanticSearch(query, limit = 20) {
  const embedResp = await fetch(
    `${GEMINI_BASE_URL}/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'models/gemini-embedding-001', content: { parts: [{ text: query }] } }),
    }
  )
  const embedData = await embedResp.json()
  const embedding = embedData.embedding?.values
  if (!embedding) return []

  const { data } = await sb.rpc('match_source_chunks', {
    query_embedding: embedding,
    match_threshold: 0.3,
    match_count: limit,
    p_user_id: USER_ID,
  })
  if (!data || data.length === 0) return []

  const sourceIds = [...new Set(data.map(c => c.source_id))]
  const { data: sources } = await sb.from('knowledge_sources').select('id, title, source_type, created_at').in('id', sourceIds)
  const sourceMap = new Map((sources ?? []).map(s => [s.id, s]))

  return data.map(c => {
    const src = sourceMap.get(c.source_id)
    return { ...c, sourceTitle: src?.title ?? 'Unknown', sourceType: src?.source_type ?? 'unknown', sourceCreatedAt: src?.created_at ?? new Date().toISOString() }
  })
}

function buildPrompt(chunks, question, extraInstruction = '') {
  const distinctSources = new Set(chunks.map(c => c.source_id))
  const isMultiSource = distinctSources.size >= 2

  const chunksText = chunks.map((c, i) =>
    `--- Chunk ${i + 1} | Source: "${c.sourceTitle}" | source_id: "${c.source_id}" | Type: ${c.sourceType} | Date: ${new Date(c.sourceCreatedAt).toLocaleDateString()} ---\n${c.content}`
  ).join('\n\n')

  return `You are Synapse, a Graph RAG assistant. Answer from the source chunks below.
INLINE CITATIONS — Use [N] numbered references inline in your answer text (e.g. "The project launched in Q3 [1] and expanded later [2]"). Every factual claim should have a citation. Cite source chunks with their chunk number.
${isMultiSource ? `COMPARISON — ${distinctSources.size} distinct sources present. Attribute clearly.` : ''}
${extraInstruction}

RESPONSE FORMAT — return ONLY valid JSON:
{
  "answer": "Your comprehensive answer with [1], [2] inline citations. Use **bold** for key entities.",
  "citations": [
    {"index": 1, "label": "Source title", "entity_type": "Topic", "node_id": null, "source_id": "uuid", "chunk_index": 0}
  ],
  "followUp": {"question": "A natural follow-up question", "label": "2-4 word label"}
}
Ensure every [N] reference in your answer has a matching entry in the citations array with matching index.

SOURCE CHUNKS:
${chunksText}`
}

async function callGemini(systemPrompt, question) {
  const startTime = Date.now()
  const resp = await fetch(
    `${GEMINI_BASE_URL}/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: question }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 32768, responseMimeType: 'application/json' },
      }),
    }
  )

  const data = await resp.json()
  const elapsed = Date.now() - startTime
  const candidate = data.candidates?.[0]
  const usage = data.usageMetadata
  const parts = candidate?.content?.parts ?? []
  const textPart = parts.find(p => p.thought !== true && typeof p.text === 'string') ?? parts.find(p => typeof p.text === 'string')
  const responseText = textPart?.text ?? ''

  return {
    elapsed,
    finishReason: candidate?.finishReason,
    promptTokens: usage?.promptTokenCount ?? 0,
    responseTokens: usage?.candidatesTokenCount ?? 0,
    thinkingTokens: usage?.thoughtsTokenCount ?? 0,
    totalTokens: usage?.totalTokenCount ?? 0,
    responseText,
  }
}

// ─── Validation functions ──────────────────────────────────────────────────────

function validateResponse(raw, chunks, scenarioName) {
  const results = {
    scenario: scenarioName,
    checks: [],
    pass: true,
  }

  function check(name, passed, detail = '') {
    results.checks.push({ name, passed, detail })
    if (!passed) results.pass = false
  }

  // 1. JSON validity
  let parsed = null
  try {
    parsed = JSON.parse(raw.responseText)
    check('JSON valid', true)
  } catch (e) {
    check('JSON valid', false, e.message)
    // Try to salvage — mirrors the production parser in gemini.ts

    // Fix 1: Escape unescaped double quotes inside JSON string values
    let fixed = ''
    {
      let inStr = false, esc = false
      const src = raw.responseText
      for (let idx = 0; idx < src.length; idx++) {
        const ch = src[idx]
        if (esc) { fixed += ch; esc = false; continue }
        if (ch === '\\' && inStr) { fixed += ch; esc = true; continue }
        if (ch === '"') {
          if (!inStr) { inStr = true; fixed += ch }
          else {
            let ni = idx + 1
            while (ni < src.length && ' \n\r\t'.includes(src[ni])) ni++
            const nc = ni < src.length ? src[ni] : ''
            if (',}]:'.includes(nc) || nc === '') { inStr = false; fixed += ch }
            else { fixed += '\\"' }
          }
        } else { fixed += ch }
      }
    }

    // Fix 2: trailing commas, brace closure
    fixed = fixed.replace(/,\s*$/, '')
    let bc = 0, bk = 0, inStr2 = false, esc2 = false
    for (const ch of fixed) {
      if (esc2) { esc2 = false; continue }
      if (ch === '\\') { esc2 = true; continue }
      if (ch === '"') { inStr2 = !inStr2; continue }
      if (inStr2) continue
      if (ch === '{') bc++; if (ch === '}') bc--
      if (ch === '[') bk++; if (ch === ']') bk--
    }
    if (inStr2) fixed += '"'
    while (bk > 0) { fixed += ']'; bk-- }
    while (bc > 0) { fixed += '}'; bc-- }
    fixed = fixed.replace(/,\s*([}\]])/g, '$1')

    try {
      parsed = JSON.parse(fixed)
      check('JSON recoverable', true, 'Fixed with quote escaping + brace closure')
    } catch (fixErr) {
      check('JSON recoverable', false, 'Could not fix JSON')
      const posMatch = fixErr.message?.match(/position (\d+)/)
      if (posMatch) {
        const pos = parseInt(posMatch[1], 10)
        const wnd = 100
        const start = Math.max(0, pos - wnd)
        const end = Math.min(fixed.length, pos + wnd)
        console.log(`\n  🔍 JSON ERROR AT POSITION ${pos}:`)
        console.log(`  Context: ...${fixed.slice(start, end).replace(/\n/g, '\\n')}...`)
        console.log(`  Char at pos: "${fixed[pos]}" (charCode: ${fixed.charCodeAt(pos)})`)
        console.log()
      }
    }
  }

  // 2. Has answer field
  const answer = parsed?.answer
  check('Has "answer" field', typeof answer === 'string' && answer.length > 0, `${typeof answer === 'string' ? answer.length + ' chars' : 'missing'}`)

  // 3. Has citations array
  const citations = parsed?.citations
  check('Has "citations" array', Array.isArray(citations), `${Array.isArray(citations) ? citations.length + ' entries' : 'missing'}`)

  // 4. Answer quality — substantive length
  const wordCount = answer ? answer.split(/\s+/).length : 0
  check('Answer > 100 words', wordCount > 100, `${wordCount} words`)

  // 5. Citation matching — every [N] in text has a matching citation
  if (typeof answer === 'string' && Array.isArray(citations)) {
    const textRefs = new Set()
    const refMatches = answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)
    for (const m of refMatches) {
      for (const num of m[1].split(/\s*,\s*/)) {
        textRefs.add(parseInt(num, 10))
      }
    }
    const citationIndices = new Set(citations.map(c => c.index))
    const unmatchedRefs = [...textRefs].filter(n => !citationIndices.has(n))
    check('All [N] refs have matching citation', unmatchedRefs.length === 0, unmatchedRefs.length > 0 ? `Unmatched: [${unmatchedRefs.join(', ')}]` : `${textRefs.size} refs, all matched`)
  }

  // 6. Citation source_ids match real chunks
  if (Array.isArray(citations)) {
    const chunkSourceIds = new Set(chunks.map(c => c.source_id))
    const validSourceIds = citations.filter(c => c.source_id && chunkSourceIds.has(c.source_id)).length
    const totalWithSourceId = citations.filter(c => c.source_id).length
    check('Citation source_ids valid', totalWithSourceId === 0 || validSourceIds > 0, `${validSourceIds}/${totalWithSourceId} match real sources`)
  }

  // 7. Finish reason
  check('Finish reason is STOP', raw.finishReason === 'STOP', raw.finishReason)

  // 8. Token budget
  const budgetUsed = ((raw.responseTokens + raw.thinkingTokens) / 32768 * 100).toFixed(1)
  check('Token budget < 80%', (raw.responseTokens + raw.thinkingTokens) < 32768 * 0.8, `${budgetUsed}% used (${raw.thinkingTokens} thinking + ${raw.responseTokens} response)`)

  // 9. Has followUp (optional but nice)
  const hasFollowUp = parsed?.followUp && typeof parsed.followUp.question === 'string'
  check('Has followUp suggestion', hasFollowUp, hasFollowUp ? parsed.followUp.label : 'missing (optional)')

  // 10. Format — bold headings present (for structured responses)
  const hasBoldHeadings = answer ? /\*\*[^*]+\*\*/.test(answer) : false
  check('Uses **bold** formatting', hasBoldHeadings, hasBoldHeadings ? 'yes' : 'no bold text found')

  // Summary stats
  results.stats = {
    time: (raw.elapsed / 1000).toFixed(1) + 's',
    words: wordCount,
    citations: Array.isArray(citations) ? citations.length : 0,
    thinkingTokens: raw.thinkingTokens,
    responseTokens: raw.responseTokens,
    budgetUsed: budgetUsed + '%',
  }

  return results
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(80))
  console.log('  COMPREHENSIVE RAG PIPELINE TEST')
  console.log('═'.repeat(80))
  console.log()

  // ── Define test scenarios ────────────────────────────────────────────────

  const scenarios = []

  // 1. Single source chat — YouTube
  {
    const chunks = await fetchChunks('40fbbeef-9b51-4977-bd80-79ac662dbcdd', 12)
    scenarios.push({
      name: '1. SOURCE CHAT (YouTube): "Speed is not fast"',
      question: 'Tell me about "Speed is not fast, and it makes no sense" in depth. What are the key arguments, specific details, and notable insights?',
      chunks,
      extra: '## Response Structure\nOrganise by themes (2-4). Use **bold headings**. End with "Connections to your graph."',
    })
  }

  // 2. Single source chat — Meeting
  {
    const chunks = await fetchChunks('a8d14912-e79c-4953-b286-3674589689ee', 20)
    scenarios.push({
      name: '2. SOURCE CHAT (Meeting): "InfoAICert Initial BrainHurricane"',
      question: 'Tell me about the InfoAICert Initial BrainHurricane meeting in depth. What were the key arguments, decisions, and action items?',
      chunks,
      extra: '## Response Structure\nOrganise by themes (2-4). Use **bold headings**. End with "Connections to your graph."',
    })
  }

  // 3. General broad query
  {
    const chunks = await semanticSearch('What are the main projects and initiatives being worked on?', 20)
    scenarios.push({
      name: '3. GENERAL QUERY: "Main projects and initiatives"',
      question: 'What are the main projects and initiatives being worked on across my knowledge graph?',
      chunks,
      extra: '## Response Structure\nWrite in clear flowing prose. Use **bold** for key terms. Lead with the most important finding.',
    })
  }

  // 4. Multi-source comparison
  {
    const chunksA = await fetchChunks('93ae8b3d-4da1-4591-9891-dd8abb9beff6', 12) // Feedback collection
    const chunksB = await fetchChunks('843e6c95-a074-48c9-a61f-f17ae7a73214', 12) // Data privacy
    scenarios.push({
      name: '4. COMPARE: "Feedback collection" vs "Data privacy discussion"',
      question: 'Compare the "AI Upskilling platform: Feedback collection" meeting with the "Data privacy discussion" meeting. What are the similarities, differences, and complementary insights?',
      chunks: [...chunksA, ...chunksB],
      extra: '## Response Structure\nOpen with commonality. Organise by shared themes. Add "Unique to each" section. Close with "Synthesis."',
    })
  }

  // 5. Entity exploration
  {
    const chunks = await semanticSearch('Marisha Boyd role projects contributions', 15)
    scenarios.push({
      name: '5. ENTITY EXPLORE: "Marisha Boyd"',
      question: 'Tell me about Marisha Boyd. What is her role, what projects is she involved in, and what contributions has she made?',
      chunks,
      extra: '## Response Structure\nLead with significance. Then Key Relationships (3-5). Then Across Sources. End with Open Threads.',
    })
  }

  // 6. Anchor/relationship query
  {
    const chunks = await semanticSearch('AI upskilling platform features levels learning pathway', 18)
    scenarios.push({
      name: '6. ANCHOR QUERY: "AI Upskilling Platform"',
      question: 'Give me a comprehensive overview of the AI Upskilling Platform. What are its key features, the learning levels, who built it, and what feedback has it received?',
      chunks,
      extra: '## Response Structure\nStart with Hub summary. Then Top connected entities grouped by type. Then Source coverage. End with Trajectory.',
    })
  }

  // ── Run all scenarios ────────────────────────────────────────────────────

  const allResults = []

  for (const sc of scenarios) {
    console.log('─'.repeat(80))
    console.log(`  ${sc.name}`)
    console.log(`  Chunks: ${sc.chunks.length} | Sources: ${new Set(sc.chunks.map(c => c.source_id)).size}`)
    console.log()

    const prompt = buildPrompt(sc.chunks, sc.question, sc.extra)
    console.log(`  Prompt: ~${Math.round(prompt.length / 4)} tokens | Calling Gemini...`)

    const raw = await callGemini(prompt, sc.question)
    const result = validateResponse(raw, sc.chunks, sc.name)
    allResults.push(result)

    // Print checks
    for (const c of result.checks) {
      const icon = c.passed ? '  ✅' : '  ❌'
      console.log(`${icon} ${c.name}${c.detail ? ' — ' + c.detail : ''}`)
    }
    console.log()
    console.log(`  Stats: ${result.stats.time} | ${result.stats.words} words | ${result.stats.citations} citations | ${result.stats.budgetUsed} budget | ${result.stats.thinkingTokens} thinking tokens`)
    console.log()
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log('═'.repeat(80))
  console.log('  SUMMARY')
  console.log('═'.repeat(80))
  console.log()

  const totalChecks = allResults.reduce((sum, r) => sum + r.checks.length, 0)
  const passedChecks = allResults.reduce((sum, r) => sum + r.checks.filter(c => c.passed).length, 0)
  const failedChecks = totalChecks - passedChecks

  console.log(`  Total checks: ${totalChecks}`)
  console.log(`  Passed:       ${passedChecks} ✅`)
  console.log(`  Failed:       ${failedChecks} ❌`)
  console.log()

  for (const r of allResults) {
    const icon = r.pass ? '✅' : '❌'
    const failCount = r.checks.filter(c => !c.passed).length
    console.log(`  ${icon} ${r.scenario} — ${r.stats.words} words, ${r.stats.citations} cit, ${r.stats.time}${failCount > 0 ? ' [' + failCount + ' failed]' : ''}`)
  }

  console.log()

  if (failedChecks > 0) {
    console.log('  FAILED CHECKS:')
    for (const r of allResults) {
      for (const c of r.checks) {
        if (!c.passed) {
          console.log(`    ❌ [${r.scenario}] ${c.name} — ${c.detail}`)
        }
      }
    }
  }

  console.log()
  console.log('═'.repeat(80))
}

main().catch(console.error)
