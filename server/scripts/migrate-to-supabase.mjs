// One-time migration: load the current file-based KB (kb-data.json) and its
// embeddings (kb-embeddings.json) into Supabase. Reuses existing vectors so we
// don't pay to re-embed. Any article missing a vector is embedded on the fly.
// Run: node server/scripts/migrate-to-supabase.mjs
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { supabase, supabaseConfigured, toVector } from "../supabase.js";
import { embedDocuments, embeddingsConfigured } from "../embeddings.js";

if (!supabaseConfigured()) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, "..");

const articles = JSON.parse(await readFile(path.join(root, "kb-data.json"), "utf-8"));
let index = { items: {} };
try {
  index = JSON.parse(await readFile(path.join(root, "kb-embeddings.json"), "utf-8"));
} catch {
  console.log("no kb-embeddings.json found — will embed everything");
}
console.log(`articles: ${articles.length} · embedded vectors on file: ${Object.keys(index.items || {}).length}`);

// embed any article that has no stored vector
const missing = articles.filter((a) => !index.items?.[a.id]?.vec);
if (missing.length) {
  if (!embeddingsConfigured()) throw new Error("GEMINI_API_KEY needed to embed missing articles");
  console.log(`embedding ${missing.length} articles with no stored vector…`);
  const vecs = await embedDocuments(missing.map((a) => `${a.title}\n${a.body}`), {
    onProgress: (d, t) => d % 100 === 0 && console.log(`  embedded ${d}/${t}`),
  });
  missing.forEach((a, i) => {
    index.items[a.id] = { vec: vecs[i] };
  });
}

const rows = articles.map((a) => ({
  id: a.id,
  title: a.title || null,
  body: a.body || "",
  finish: a.finish || null,
  tags: a.tags || [],
  source: a.source || "manual",
  source_url: a.sourceUrl || null,
  updated_at: a.updatedAt || null,
  embedding: index.items[a.id]?.vec ? toVector(index.items[a.id].vec) : null,
}));

// the file-based KB can contain duplicate ids (ingestion artifacts) — keep the
// last one per id so upsert doesn't hit "affect row a second time"
const byId = new Map();
for (const r of rows) byId.set(r.id, r);
const deduped = [...byId.values()];
if (deduped.length !== rows.length)
  console.log(`deduped ${rows.length - deduped.length} duplicate ids → ${deduped.length} unique`);

// upsert in batches
const BATCH = 100;
let done = 0;
for (let i = 0; i < deduped.length; i += BATCH) {
  const slice = deduped.slice(i, i + BATCH);
  const { error } = await supabase.from("kb_articles").upsert(slice, { onConflict: "id" });
  if (error) throw new Error(`upsert failed at ${i}: ${error.message}`);
  done += slice.length;
  console.log(`  upserted ${done}/${deduped.length}`);
}

const { count } = await supabase.from("kb_articles").select("*", { count: "exact", head: true });
console.log(`\ndone. kb_articles now holds ${count} rows.`);
