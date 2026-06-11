-- Tiny shared key-value store. Used to share the Zoho access token across
-- serverless instances so they don't each mint their own (Zoho rate-limits
-- token refreshes). Paste into the Supabase SQL Editor and run.

create table if not exists app_state (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz default now()
);
