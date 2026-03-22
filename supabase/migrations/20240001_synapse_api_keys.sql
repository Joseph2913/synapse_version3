-- PRD-24: Synapse API Keys table for MCP server authentication

create table synapse_api_keys (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  label       text not null,
  key_prefix  text not null,           -- first 12 chars of raw key, stored plaintext for display (e.g. "sk-syn-aBcD")
  key_hash    text not null,           -- sha-256 of full raw key, stored for verification
  created_at  timestamptz not null default now(),
  last_used_at timestamptz
);

-- RLS
alter table synapse_api_keys enable row level security;
create policy "Users manage own keys"
  on synapse_api_keys for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Index for fast lookup during MCP auth
create index synapse_api_keys_hash_idx on synapse_api_keys(key_hash);
