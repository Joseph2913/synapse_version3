import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf-8')
const vars = {}
for (const line of env.split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue
  const i = t.indexOf('='); if (i === -1) continue
  vars[t.slice(0, i).trim()] = t.slice(i + 1).trim()
}

const sb = createClient(vars.SUPABASE_URL, vars.SUPABASE_SERVICE_ROLE_KEY)
const userId = 'b9264b41-bee4-49a7-a141-c37764f60216'

const { data } = await sb.from('knowledge_nodes')
  .select('id, label, is_anchor, embedding')
  .eq('user_id', userId)
  .eq('is_anchor', true)
  .limit(2)

for (const node of data ?? []) {
  console.log('Label:', node.label)
  console.log('Embedding type:', typeof node.embedding)
  console.log('Is array:', Array.isArray(node.embedding))
  if (node.embedding) {
    const str = String(node.embedding)
    console.log('First 100 chars:', str.slice(0, 100))
    console.log('Length:', typeof node.embedding === 'string' ? node.embedding.length : (Array.isArray(node.embedding) ? node.embedding.length : 'N/A'))
  } else {
    console.log('Embedding is null/undefined')
  }
  console.log('---')
}
