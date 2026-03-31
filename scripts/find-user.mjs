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
const { data } = await sb.from('user_profiles').select('user_id')
for (const p of data ?? []) {
  const { data: u } = await sb.auth.admin.getUserById(p.user_id)
  console.log(p.user_id, u?.user?.email ?? '?')
}
