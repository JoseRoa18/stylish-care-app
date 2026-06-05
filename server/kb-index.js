// server/kb-index.js
// Semantic search now lives in Postgres (pgvector). Articles are embedded on
// write (see kb.js), so there's no separate JSON index to maintain. These
// functions keep the same names the rest of the app already imports.

import { supabase, toVector } from "./supabase.js";
import { embedQuery, embedDocuments, embeddingsConfigured } from "./embeddings.js";

export { embeddingsConfigured };

// The "index" is the DB — always available when Supabase is configured.
export function indexExists() {
  return Boolean(supabase);
}

function rowToArticle(r) {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    finish: r.finish,
    tags: r.tags || [],
    source: r.source,
    sourceUrl: r.source_url,
    _score: r.score != null ? Number(r.score.toFixed(4)) : undefined,
  };
}

// Top-k KB articles by cosine similarity to `query`. The `articles` arg is
// ignored (kept for call-site compatibility) — pgvector ranks the whole table.
export async function semanticSearch(query, _articles, k = 8) {
  const qvec = toVector(await embedQuery(query));
  const { data, error } = await supabase.rpc("match_kb_articles", {
    query_embedding: qvec,
    match_count: k,
  });
  if (error) throw new Error(error.message);
  return (data || []).map(rowToArticle);
}

// Keyword fallback (used only if embeddings are unavailable).
export async function keywordSearch(query, k = 8) {
  const { data, error } = await supabase.rpc("search_kb_articles", {
    q: (query || "").slice(0, 120),
    match_count: k,
  });
  if (error) throw new Error(error.message);
  return (data || []).map(rowToArticle);
}

// Articles are embedded on write, so this only backfills rows missing a vector
// (e.g. if an embedding call failed mid-ingest). onProgress(done,total).
export async function buildIndex({ onProgress } = {}) {
  const { data, error } = await supabase
    .from("kb_articles")
    .select("id,title,body")
    .is("embedding", null);
  if (error) throw new Error(error.message);
  const missing = data || [];
  if (!missing.length) return { embedded: 0, reused: 0, total: 0 };

  const vecs = await embedDocuments(
    missing.map((r) => `${r.title || ""}\n${r.body || ""}`),
    { onProgress }
  );
  for (let i = 0; i < missing.length; i++) {
    await supabase
      .from("kb_articles")
      .update({ embedding: toVector(vecs[i]) })
      .eq("id", missing[i].id);
  }
  return { embedded: missing.length, reused: 0, total: missing.length };
}

export function invalidateCache() {}
