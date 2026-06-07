// server/resolved-tickets.js
// Turns RESOLVED Zoho tickets into reusable Knowledge Base entries
// ("situation → how we resolved it"), so the AI can ground replies in real,
// on-brand resolutions instead of only generic templates.
//
// Privacy is non-negotiable: the distiller STRIPS all personal/identifying data
// (names, emails, phone, order/PO/RA/tracking numbers, addresses) and generalizes
// the case, so nothing about one customer can leak into another's reply.
//
// Resumable: each entry has a stable id `RT-<ticketId>`; a re-run skips tickets
// already ingested. Run via server/scripts/ingest-resolved-tickets.mjs.

import { supabase, toVector } from "./supabase.js";
import { embedDocuments } from "./embeddings.js";
import { getConversation } from "./zoho.js";

const { GEMINI_API_KEY, GEMINI_FLASH_MODEL } = process.env;
const MODEL = GEMINI_FLASH_MODEL || "gemini-2.5-flash";
const SOURCE = "resolved-ticket";

const INTENTS = [
  "order_status", "shipping", "returns", "warranty", "product_care",
  "installation", "product_info", "refund_or_compensation",
  "complaint_or_damage", "legal", "other",
];

const DISTILL_PROMPT = `You are building a reusable customer-care knowledge base from a RESOLVED support ticket for Stylish International Inc. (kitchen & bath manufacturer; brands STYLISH and Sinks Direct).

Read the conversation and extract a GENERALIZED, reusable entry that captures the customer's SITUATION and HOW THE TEAM RESOLVED IT — so a future agent can handle a similar case.

STRICT PRIVACY — remove ALL personal or identifying data and generalize it:
- No customer names, company names, emails, phone numbers, addresses.
- No order numbers, PO numbers, RA/RMA numbers, tracking numbers, invoice numbers, or dates specific to this customer.
- Replace specifics with general phrasing ("the customer's order", "their faucet", "the affected unit").
- Never include any string that could identify a specific person, order or shipment.

USABILITY — set "usable" to false (and leave the rest empty) when the ticket is NOT worth reusing:
- spam, marketing, automated notifications, calendar invites, out-of-office;
- internal-only chatter, or a thread with no real customer question;
- no substantive agent resolution (the team never actually answered/helped).
Set "usable" true only when there is a clear customer problem/question AND a substantive, reusable resolution.

Capture the REUSABLE KNOWLEDGE — the policy, steps, decision, or explanation the team applied — not the one-off specifics. Be concise and factual. Write in English even if the ticket was in another language.

Return JSON:
- usable: boolean
- title: short label of the situation (e.g. "Cracked granite sink reported within warranty window")
- intent: one of [${INTENTS.join(", ")}]
- finish: product finish if clearly central to the case, else ""
- situation: 1–2 sentences describing the generalized problem/question
- resolution: the generalized answer/policy/steps the team gave — the reusable part
- tags: 2–6 short keywords`;

const DISTILL_SCHEMA = {
  type: "object",
  properties: {
    usable: { type: "boolean" },
    title: { type: "string" },
    intent: { type: "string", enum: INTENTS },
    finish: { type: "string" },
    situation: { type: "string" },
    resolution: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["usable", "title", "intent", "situation", "resolution", "tags"],
};

function convoToText(conversation) {
  return conversation
    .map((t) => `${t.direction === "out" ? "Agent" : "Customer"}: ${t.text || ""}`)
    .join("\n\n");
}

// True only if the thread has a real customer ask AND a substantive agent reply
// — cheap pre-filter so we don't spend a model call on dead threads.
function worthDistilling(conversation) {
  const hasCustomer = conversation.some((m) => m.direction !== "out" && (m.text || "").trim().length > 20);
  const hasAgent = conversation.some((m) => m.direction === "out" && (m.text || "").trim().length > 40);
  return hasCustomer && hasAgent;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function distill(conversation, { retries = 2 } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const body = {
    system_instruction: { parts: [{ text: DISTILL_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: `=== TICKET CONVERSATION ===\n${convoToText(conversation)}\n\nExtract the reusable entry now.` }] }],
    generationConfig: {
      maxOutputTokens: 1024,
      temperature: 0.2,
      thinkingConfig: /^gemini-3/.test(MODEL) ? { thinkingLevel: "low" } : { thinkingBudget: 0 },
      responseMimeType: "application/json",
      responseSchema: DISTILL_SCHEMA,
    },
  };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
    if (res.status === 429 && attempt < retries) {
      await sleep(2000 * (attempt + 1)); // back off on rate limit
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${data?.error?.message || "error"}`);
    const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
    if (!text) throw new Error("empty distill");
    return JSON.parse(text);
  }
}

function toArticle(ticketId, d) {
  const body = `Situation: ${d.situation}\n\nHow we resolved it: ${d.resolution}`;
  const tags = [...new Set([d.intent, ...(d.tags || [])].filter(Boolean))];
  return {
    id: `RT-${ticketId}`,
    title: d.title || "Resolved ticket",
    body,
    finish: d.finish && d.finish.trim() && !/^(none|n\/?a)$/i.test(d.finish.trim()) ? d.finish.trim() : null,
    tags,
    source: SOURCE,
    sourceUrl: null,
    updatedAt: new Date().toISOString(),
  };
}

async function upsertArticles(articles) {
  if (!articles.length) return 0;
  const vecs = await embedDocuments(articles.map((a) => `${a.title}\n${a.body}`));
  const rows = articles.map((a, i) => ({
    id: a.id, title: a.title, body: a.body, finish: a.finish, tags: a.tags,
    source: a.source, source_url: a.sourceUrl, updated_at: a.updatedAt,
    embedding: toVector(vecs[i]),
  }));
  const { error } = await supabase.from("kb_articles").upsert(rows, { onConflict: "id" });
  if (error) throw new Error(error.message);
  return rows.length;
}

// Ticket ids worth mining, newest first. Defaults to status EXACTLY "Closed":
// those are the genuine support resolutions (customer ↔ agent). The custom
// "Closed Wayfair" status is mostly automated RA/return/marketing notifications
// with no agent reply — noise for the KB — so it's excluded by default.
async function closedTicketIds(limit, statuses = ["Closed"]) {
  const ids = [];
  const PAGE = 1000;
  for (let from = 0; ids.length < limit; from += PAGE) {
    const { data, error } = await supabase
      .from("tickets")
      .select("id")
      .in("status", statuses)
      .order("created_time", { ascending: false, nullsFirst: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    ids.push(...data.map((r) => r.id));
    if (data.length < PAGE) break;
  }
  return ids.slice(0, limit);
}

async function alreadyIngested() {
  const set = new Set();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("kb_articles").select("id").eq("source", SOURCE).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const r of data) set.add(r.id);
    if (data.length < PAGE) break;
  }
  return set;
}

// Main driver. Resumable + throttled. Reports progress via onProgress(stat).
export async function ingestResolvedTickets({
  limit = Infinity,
  flushEvery = 10,
  delayMs = 200,
  skipExisting = true,
  maxThreads = 8,
  statuses = ["Closed"],
  onProgress,
} = {}) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");

  const ids = await closedTicketIds(limit === Infinity ? 1e9 : limit, statuses);
  const done = skipExisting ? await alreadyIngested() : new Set();

  const stats = { scanned: 0, skippedExisting: 0, noThread: 0, notUsable: 0, ingested: 0, errors: 0, total: ids.length };
  let buffer = [];

  for (const id of ids) {
    if (skipExisting && done.has(`RT-${id}`)) { stats.skippedExisting++; continue; }
    stats.scanned++;
    try {
      const conversation = await getConversation(id, { maxThreads });
      if (!worthDistilling(conversation)) { stats.noThread++; }
      else {
        const d = await distill(conversation);
        if (!d.usable) stats.notUsable++;
        else { buffer.push(toArticle(id, d)); }
      }
    } catch (e) {
      stats.errors++;
      if (onProgress) onProgress({ ...stats, lastError: e.message });
    }
    if (buffer.length >= flushEvery) {
      stats.ingested += await upsertArticles(buffer);
      buffer = [];
    }
    if (onProgress) onProgress({ ...stats });
    if (delayMs) await sleep(delayMs);
  }
  if (buffer.length) stats.ingested += await upsertArticles(buffer);
  return stats;
}

export { SOURCE as RESOLVED_TICKET_SOURCE };
