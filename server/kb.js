// server/kb.js
// Supabase-backed Knowledge Base store. Articles + their 768-dim embedding live
// in the kb_articles table; semantic search is a pgvector query (see
// kb-index.js). Articles are embedded on write, so the KB stays searchable the
// moment it changes — and it persists across deploys (unlike the old JSON files).

import { supabase, toVector } from "./supabase.js";
import { embedDocuments } from "./embeddings.js";

export const SOURCES = ["manual", "web", "dropbox", "zoho-template", "youtube"];

function rowToArticle(r) {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    finish: r.finish,
    tags: r.tags || [],
    source: r.source,
    sourceUrl: r.source_url,
    updatedAt: r.updated_at,
  };
}

function toRow(a) {
  return {
    id: a.id,
    title: a.title || null,
    body: a.body || "",
    finish: a.finish || null,
    tags: a.tags || [],
    source: a.source,
    source_url: a.sourceUrl || null,
    updated_at: a.updatedAt || null,
  };
}

async function embedText(title, body) {
  const [vec] = await embedDocuments([`${title || ""}\n${body || ""}`]);
  return toVector(vec);
}

// All articles (paginated — Supabase caps at 1000 rows/request).
export async function listArticles() {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("kb_articles")
      .select("id,title,body,finish,tags,source,source_url,updated_at")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...data.map(rowToArticle));
    if (data.length < PAGE) break;
  }
  return all;
}

// Counts per source + total (cheap head counts, no data transfer).
export async function sourceCounts() {
  const bySource = {};
  for (const s of SOURCES) {
    const { count, error } = await supabase
      .from("kb_articles")
      .select("*", { count: "exact", head: true })
      .eq("source", s);
    if (error) throw new Error(error.message);
    bySource[s] = count || 0;
  }
  const { count: total } = await supabase
    .from("kb_articles")
    .select("*", { count: "exact", head: true });
  return { total: total || 0, bySource };
}

// ── manual CRUD (the KB editor) ──────────────────────────────
export async function createArticle({ title, body, finish, tags }) {
  const { data } = await supabase.from("kb_articles").select("id").like("id", "KB-%");
  const max = Math.max(0, ...(data || []).map((r) => Number(r.id.replace("KB-", "")) || 0));
  const id = "KB-" + String(max + 1).padStart(2, "0");
  const article = {
    id, title, body, finish: finish || null, tags: tags || [],
    source: "manual", sourceUrl: null, updatedAt: new Date().toISOString(),
  };
  const embedding = await embedText(title, body);
  const { error } = await supabase.from("kb_articles").insert({ ...toRow(article), embedding });
  if (error) throw new Error(error.message);
  return article;
}

export async function updateArticle(id, patch) {
  const { data: existing, error } = await supabase
    .from("kb_articles").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!existing) throw new Error(`Article ${id} not found`);
  const merged = { ...rowToArticle(existing), ...patch, id, updatedAt: new Date().toISOString() };
  const embedding = await embedText(merged.title, merged.body);
  const { error: e2 } = await supabase
    .from("kb_articles").update({ ...toRow(merged), embedding }).eq("id", id);
  if (e2) throw new Error(e2.message);
  return merged;
}

export async function deleteArticle(id) {
  const { error, count } = await supabase
    .from("kb_articles").delete({ count: "exact" }).eq("id", id);
  if (error) throw new Error(error.message);
  return { deleted: count || 0 };
}

// ── ingestion: replace all articles of one source (embedded) ──
export async function replaceSource(source, freshArticles) {
  if (source === "manual") throw new Error("Refusing to bulk-replace the manual source");
  // dedupe by id (ingestion can produce repeats)
  const byId = new Map();
  for (const a of freshArticles) byId.set(a.id, a);
  const arts = [...byId.values()];

  const stamp = new Date().toISOString();
  const vecs = arts.length
    ? await embedDocuments(arts.map((a) => `${a.title || ""}\n${a.body || ""}`))
    : [];
  const rows = arts.map((a, i) => ({
    ...toRow({ ...a, source, updatedAt: a.updatedAt || stamp }),
    embedding: toVector(vecs[i]),
  }));

  const { error: delErr } = await supabase.from("kb_articles").delete().eq("source", source);
  if (delErr) throw new Error(delErr.message);

  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await supabase.from("kb_articles").insert(rows.slice(i, i + 100));
    if (error) throw new Error(error.message);
  }
  return { source, added: rows.length };
}
