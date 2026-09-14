// server/models.js
// Which product a ticket is about, so the team can ask "which model has cost us
// the most spare parts" and "which model comes back defective most often".
//
// The model is matched against the REAL SKUs imported from the storefronts, not
// guessed: a value here is a code the customer actually typed. That makes the
// report defensible — a model only appears because someone named it — at the
// cost of missing tickets that describe a product without naming it ("my 30
// inch sink"). Those are left blank rather than inferred, because a
// manufacturing report built on guesses is worse than a smaller honest one.

import { supabase } from "./supabase.js";

let cache = null; // { at, skus: [{ sku, re }] }

// Load the catalogue's SKUs. Longest first so "S-401-3" wins over "S-401".
async function skuList() {
  if (cache && Date.now() - cache.at < 3600_000) return cache.skus;
  const { data } = await supabase
    .from("kb_articles")
    .select("tags")
    .eq("source", "product")
    .limit(2000);
  const seen = new Set();
  for (const row of data || []) {
    for (const t of row.tags || []) {
      const s = String(t).trim().toUpperCase();
      // a SKU looks like K-131S, S-401-3, B-102C, G-401, H-05, A-916DG
      if (/^[A-Z]{1,3}-\d{2,4}[A-Z0-9-]{0,6}$/.test(s)) seen.add(s);
    }
  }
  const skus = [...seen]
    .sort((a, b) => b.length - a.length)
    .map((sku) => ({
      sku,
      // tolerate the ways people write them: k131s, K 131 S, K-131-S
      re: new RegExp(`(?<![A-Z0-9])${sku.replace(/-/g, "[\\s-]?")}(?![A-Z0-9-])`, "i"),
    }));
  cache = { at: Date.now(), skus };
  return skus;
}

export async function knownSkuCount() {
  return (await skuList()).length;
}

// The model a piece of text is about, or null. First (longest) match wins.
export async function detectModel(text) {
  const t = String(text || "");
  if (t.length < 3) return null;
  for (const { sku, re } of await skuList()) if (re.test(t)) return sku;
  return null;
}

// Label tickets that have no model yet. Subject-only by default: the subject is
// where a model code almost always appears, and reading every conversation
// would mean one Zoho call per ticket.
export async function detectPending({ limit = 500, redo = false } = {}) {
  if (!supabase) return { scanned: 0, matched: 0 };
  let q = supabase
    .from("tickets")
    .select("id,subject")
    .order("created_time", { ascending: false })
    .limit(limit);
  if (!redo) q = q.is("model", null);
  const { data, error } = await q;
  if (error || !data?.length) return { scanned: 0, matched: 0 };

  const now = new Date().toISOString();
  let matched = 0;
  for (const t of data) {
    const model = await detectModel(t.subject);
    if (!model) continue;
    const { error: e } = await supabase
      .from("tickets")
      .update({ model, model_at: now })
      .eq("id", t.id);
    if (!e) matched++;
  }
  return { scanned: data.length, matched };
}

// The two reports: which models generate spare-part/warranty demand, and which
// come back defective. Both are counts of TICKETS, not units shipped — so they
// say where the support load is, not a failure rate.
export async function modelReport({ days = 0, categories = [] } = {}) {
  let q = supabase.from("tickets").select("model,category,created_time").not("model", "is", null);
  if (days > 0) q = q.gte("created_time", new Date(Date.now() - days * 86400000).toISOString());
  if (categories.length) q = q.in("category", categories);
  const { data, error } = await q;
  // the column only exists once supabase/surveys.sql has been run — an empty
  // report is the right answer until then, not a broken dashboard
  if (error) {
    if (/model/.test(error.message)) return [];
    throw new Error(error.message);
  }
  const counts = new Map();
  for (const r of data || []) counts.set(r.model, (counts.get(r.model) || 0) + 1);
  return [...counts.entries()]
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count);
}
