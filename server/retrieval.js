// server/retrieval.js
// Lightweight keyword retrieval over the Knowledge Base. Picks the few
// most relevant articles for a given customer message so we ground the
// AI reply on just those, instead of stuffing the whole KB into the prompt.
//
// Scoring: TF-IDF-ish token overlap with a title boost. No external API.
// The public shape (retrieve / buildQuery) is what an embeddings-based
// implementation would later replace — callers won't change.

const STOPWORDS = new Set(
  `a an the and or but if then else for to of in on at by with from into about as is are was were be been being do does did have has had i you he she it we they my your our their this that these those not no yes can could would should will just please hi hello thanks thank regards hola gracias el la los las un una unos unas de del y o si para por con en es son fue al lo que se su sus mi mis tu tus me te nos`.split(
    /\s+/
  )
);

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

import { semanticSearch, keywordSearch } from "./kb-index.js";

// Pull a wider candidate pool than k, then diversify so one source can't
// monopolise the final set. With 500+ resolved-ticket entries, a query can
// otherwise return k near-duplicate past cases and crowd out the one video
// tutorial or reply template that would help.
const POOL = Number(process.env.RETRIEVAL_POOL || 40);
const RESERVE_SOURCES = ["youtube", "zoho-template"];
const RESERVE_MARGIN = Number(process.env.RETRIEVAL_RESERVE_MARGIN || 0.1); // within this of the top score
const RESERVE_FLOOR = Number(process.env.RETRIEVAL_RESERVE_FLOOR || 0.6); // and at least this similar absolutely

// Preferred entry point: semantic (pgvector) search, falling back to a Postgres
// keyword search if embeddings are unavailable. Both hit Supabase directly, so
// no need to load the whole KB into memory.
export async function retrieveRelevant({ ticket, conversation }, k = 8) {
  const query = buildQuery({ ticket, conversation });
  try {
    const pool = await semanticSearch(query, null, Math.max(POOL, k));
    if (pool && pool.length) return diversify(pool, k);
  } catch {
    // embedding unavailable/errored → keyword fallback below
  }
  try {
    return await keywordSearch(query, k);
  } catch {
    return [];
  }
}

// Guarantee the final set keeps a slot for the best video tutorial and the best
// reply template WHEN they're clearly relevant (close to the top match), then
// fill the rest by score. A reserved item that isn't relevant enough is simply
// not forced in — so we never inject an off-topic video. Items already in the
// natural top-k cost no extra slot (deduped by id).
export function diversify(pool, k) {
  if (pool.length <= k) return pool;
  const top = pool[0]?._score ?? 0;
  const floor = Math.max(RESERVE_FLOOR, top - RESERVE_MARGIN);
  const chosen = new Map();
  for (const src of RESERVE_SOURCES) {
    if (chosen.size >= k) break;
    const best = pool.find((a) => a.source === src && (a._score ?? 0) >= floor);
    if (best) chosen.set(best.id, best);
  }
  for (const a of pool) {
    if (chosen.size >= k) break;
    chosen.set(a.id, a);
  }
  return [...chosen.values()]
    .sort((x, y) => (y._score ?? 0) - (x._score ?? 0))
    .slice(0, k);
}

// Build a search query from the ticket: subject + the customer's words.
// Agent (outbound) messages are ignored so we match on what the customer asks.
export function buildQuery({ ticket, conversation }) {
  const subject = ticket?.subject || "";
  const customerText = (conversation || [])
    .filter((m) => m.direction !== "out")
    .map((m) => m.text || "")
    .join(" ");
  return `${subject} ${customerText}`.trim();
}

// Returns the top-k articles most relevant to `query`, each annotated with
// a `_score`. Falls back to the first k articles if nothing matches, so the
// model always has *some* grounding to work with.
export function retrieve(query, articles, k = 8) {
  const qTokens = [...new Set(tokenize(query))];
  if (!articles.length) return [];
  if (!qTokens.length) return articles.slice(0, k);

  // document frequency for IDF
  const docTokens = articles.map(
    (a) => new Set(tokenize(`${a.title} ${a.body} ${(a.tags || []).join(" ")}`))
  );
  const N = articles.length;
  const df = {};
  for (const tok of qTokens) {
    df[tok] = docTokens.reduce((n, s) => n + (s.has(tok) ? 1 : 0), 0);
  }

  const scored = articles.map((a, i) => {
    const titleToks = new Set(tokenize(a.title));
    const bodyToks = docTokens[i];
    let score = 0;
    for (const tok of qTokens) {
      if (!bodyToks.has(tok)) continue;
      const idf = Math.log(1 + N / (1 + df[tok]));
      score += idf * (titleToks.has(tok) ? 2.5 : 1);
    }
    return { article: a, score };
  });

  scored.sort((x, y) => y.score - x.score);
  const hits = scored.filter((s) => s.score > 0).slice(0, k);
  const chosen = hits.length ? hits : scored.slice(0, k);
  return chosen.map((s) => ({ ...s.article, _score: Number(s.score.toFixed(3)) }));
}
