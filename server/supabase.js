// server/supabase.js
// Single Supabase client (service-role) shared by the KB store and retrieval.
// The service-role key is server-only — never expose it to the browser.

import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

export function supabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

export const supabase = supabaseConfigured()
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

// pgvector wants its text input as "[0.1,0.2,...]".
export function toVector(arr) {
  return `[${arr.join(",")}]`;
}
