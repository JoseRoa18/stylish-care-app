// server/resolved-tickets.js
// Turns RESOLVED Zoho tickets into reusable Knowledge Base entries
// ("situation → how we resolved it"), so the AI can ground replies in real,
// on-brand resolutions instead of only generic templates.
//
// Privacy is non-negotiable: the distiller STRIPS all personal/identifying data
// (names, emails, phone, order/PO/RA/tracking numbers, addresses) and generalizes
// the case, so nothing about one customer can leak into another's reply. A
// deterministic scrub runs on its output as a second gate.
//
// Continuous: learnPending() runs three times a day (vercel.json → /api/cron/learn)
// and from the KB tab's "Learn now" button. A ledger remembers every ticket it
// looked at, so a run never redoes work, never learns twice, and never brings
// back an entry the team deleted. Each entry has a stable id `RT-<ticketId>`.

import crypto from "node:crypto";
import { supabase, toVector } from "./supabase.js";
import { embedDocuments } from "./embeddings.js";
import { getTicketForLearning, getThreadsForLearning, listTicketComments } from "./zoho.js";

const { GEMINI_API_KEY, GEMINI_FLASH_MODEL } = process.env;
const MODEL = GEMINI_FLASH_MODEL || "gemini-2.5-flash";
const SOURCE = "resolved-ticket";

// Automatic learning only looks at tickets closed from this moment on. The
// June–October backlog waits until the team has reviewed a sample of it
// (node server/scripts/ingest-resolved-tickets.mjs, a dry run by default).
export const LEARN_START = process.env.LEARN_START || "2026-10-20T00:00:00Z";

// A learned case that was a one-off goodwill or money decision, not policy.
// Kept in the entry's tags so retrieval carries it to the drafter (gemini.js)
// without another query, and spelled out in the body for every other reader.
export const EXCEPTION_TAG = "one-off-exception";
const EXCEPTION_NOTE =
  "One-off exception: a goodwill decision made for this case, not standard policy. Never offer it unprompted.";

const INTENTS = [
  "order_status", "shipping", "returns", "warranty", "product_care",
  "installation", "product_info", "refund_or_compensation",
  "complaint_or_damage", "legal", "other",
];

// Shared by the distiller and the backfill of cases learned before the flag.
// Free warranty parts are the everyday process, and calling them exceptions
// would keep drafts from offering them.
const EXCEPTION_RULE = `set "is_exception" true when the outcome was a goodwill or money decision made for this case rather than the standard policy any customer in the same situation gets: a refund or partial refund given as goodwill (not a normal return), a credit, discount or price adjustment, a free gift or free item the policy doesn't cover, a replacement outside the warranty or the claim window, a waived fee, or compensation approved by a manager. The standard policy is NOT an exception: free parts or replacements under the warranty (including the free spare-part promo code), return labels and refunds under the normal return policy, and re-sending a lost, missing or wrong item.`;

const DISTILL_PROMPT = `You are building a reusable customer-care knowledge base from a RESOLVED support ticket for Stylish International Inc. (kitchen & bath manufacturer; brands STYLISH and Sinks Direct).

Read the conversation and extract a GENERALIZED, reusable entry that captures the customer's SITUATION and HOW THE TEAM RESOLVED IT — so a future agent can handle a similar case.

STRICT PRIVACY — remove ALL personal or identifying data and generalize it:
- No customer names, company names, emails, phone numbers, addresses.
- No order numbers, PO numbers, RA/RMA numbers, tracking numbers, invoice numbers, amounts, or dates specific to this customer.
- Replace specifics with general phrasing ("the customer's order", "their faucet", "the affected unit").
- Never include any string that could identify a specific person, order or shipment.

WHO WROTE WHAT — every message carries a label:
- "OUR TEAM → CUSTOMER (written by our team)", "(our team's text, polished by AI)", "(built by our team from a saved template)", "(AI draft edited by our team)" or "(AI draft written from our team's own notes)": the team's real decisions. Base the resolution on these.
- "OUR TEAM → CUSTOMER (AI draft sent unchanged)": an AI assistant's reply the team sent as it was. It only repeats existing knowledge — read it for context, never take the resolution from it.
- Messages to or from a THIRD PARTY (supplier, dealer, carrier) or a COLLEAGUE, and the INTERNAL NOTES, are internal context: use them to understand what was decided, but the resolution is what the CUSTOMER was told and given. Never put supplier or dealer names, internal costs or internal discussion in the entry.
- All team replies come from one shared account: write them as the team's voice, never an agent's name.

ONE-OFF EXCEPTIONS — ${EXCEPTION_RULE} Then write the resolution as what was done once ("as a one-off goodwill gesture, the team …"), never as policy. Otherwise set it false.

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
- is_exception: boolean (see ONE-OFF EXCEPTIONS)
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
    is_exception: { type: "boolean" },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["usable", "title", "intent", "situation", "resolution", "is_exception", "tags"],
};

const EXCEPTION_PROMPT = `You review one entry of a customer-care knowledge base for Stylish International Inc. (kitchen & bath manufacturer). The entry summarizes how the team resolved a past case ("Situation … / How we resolved it …").

Return JSON with "is_exception": ${EXCEPTION_RULE} Otherwise false — explaining a policy, including one that refuses a refund or a waiver, is not an exception.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function askGemini(system, text, schema, { retries = 2 } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: {
      maxOutputTokens: 1024,
      temperature: 0.2,
      thinkingConfig: /^gemini-3/.test(MODEL) ? { thinkingLevel: "low" } : { thinkingBudget: 0 },
      responseMimeType: "application/json",
      responseSchema: schema,
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
    const out = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
    if (!out) throw new Error("empty Gemini answer");
    return JSON.parse(out);
  }
}

const distill = (text) => askGemini(DISTILL_PROMPT, `${text}\n\nExtract the reusable entry now.`, DISTILL_SCHEMA);

// ── who said what ────────────────────────────────────────────
const EMAIL_RE = /[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g;
const OUR_DOMAIN_RE = /@(?:[\w-]+\.)*(?:stylishkb\.com|sinksdirect\.ca|sinksdirect\.com|sinksdirectusa\.com|zohodesk\.com)$/i;
const emailsIn = (s) => (String(s || "").match(EMAIL_RE) || []).map((e) => e.toLowerCase());
const isOurs = (e) => OUR_DOMAIN_RE.test(e);

// The satisfaction survey goes out as a reply (surveys.js): it is neither a
// resolution nor a new reply worth re-learning a ticket for.
const isSurvey = (th) => th.direction === "out" && /wrapped up your case|survey\.html\?t=/i.test(th.summary || "");

// Outbound mail to someone who isn't the customer (a supplier, a dealer, a
// colleague) carries internal details — costs, part requests — that must never
// read as what the customer was told. The customer is the ticket's contact plus
// whoever opened it; when our own mailbox opened it (the website's contact
// form, a colleague's forward), it is the first outside address in the thread.
function labelTurns(ticket, threads) {
  const customer = new Set(emailsIn(ticket.email).filter((e) => !isOurs(e)));
  const opener = threads.find((t) => t.direction !== "out");
  for (const e of emailsIn(opener?.from)) if (!isOurs(e)) customer.add(e);
  const viaUs = !customer.size;
  if (viaUs) {
    const first = [opener?.to, ...threads.filter((t) => t.direction === "out").map((t) => t.to)]
      .flatMap(emailsIn)
      .find((e) => !isOurs(e));
    if (first) customer.add(first);
  }
  return threads.map((t) => {
    // the form submission / forward carries the customer's question
    if (viaUs && t === opener) return { ...t, side: "request" };
    if (t.direction !== "out") {
      const from = emailsIn(t.from);
      // a colleague answering the customer from their own mailbox (the desk
      // copied) wrote a team reply by hand, like one sent from Zoho
      if (from.some(isOurs) && emailsIn(t.to).some((e) => customer.has(e))) {
        return { ...t, direction: "out", side: "customer", author: "team" };
      }
      const side = from.some(isOurs) ? "colleague" : !from.length || from.some((e) => customer.has(e)) ? "customer" : "other";
      return { ...t, side };
    }
    const to = emailsIn(t.to);
    const side = !to.length || to.some((e) => customer.has(e)) ? "customer" : to.every(isOurs) ? "colleague" : "third_party";
    return { ...t, side };
  });
}

// Who wrote each reply the customer got. The app records every send it makes
// (feedback.js recordSend, keyed by the Zoho thread); sends from before that
// only have reply_feedback, which covers AI drafts and is matched by ticket and
// time. A reply with neither was written by hand (in the app or in Zoho).
async function sendHistory(ticketId) {
  const [sent, fb] = await Promise.all([
    supabase.from("app_state").select("value").eq("key", `sent:${ticketId}`).maybeSingle(),
    supabase.from("reply_feedback").select("created_at,edit_class").eq("ticket_id", ticketId),
  ]);
  // without these an AI draft sent as-is would pass as the team's own words
  if (sent.error) throw new Error(sent.error.message);
  if (fb.error) throw new Error(fb.error.message);
  return { sends: sent.data?.value?.sends || [], feedback: fb.data || [] };
}

const NEAR_MS = 10 * 60000;
function nearest(list, time, at, used) {
  let best = null;
  for (const x of list) {
    if (used.has(x)) continue;
    const d = Math.abs(Date.parse(at(x)) - time);
    if (d <= NEAR_MS && (!best || d < best.d)) best = { x, d };
  }
  return best?.x || null;
}

// team | improved | template | edited | notes | ai — "ai" is an AI draft that
// went out as the AI wrote it, the one kind the KB must not learn from (it would
// learn from itself). "improved" and "template" are the team's own reply with AI
// polish or saved wording: their decision, not wholly their words.
function authorship(turn, history, used) {
  const time = Date.parse(turn.createdTime);
  // a record that knows its thread matches only that thread; by time only
  // when Zoho returned no id for the send
  const send =
    history.sends.find((s) => s.thread && String(s.thread) === String(turn.id) && !used.has(s)) ||
    nearest(history.sends.filter((s) => !s.thread), time, (s) => s.at, used);
  if (send) {
    used.add(send);
    if (send.ai) {
      const fb = nearest(history.feedback, time, (f) => f.created_at, used);
      if (fb) used.add(fb);
    }
    if (!send.ai) return send.improved ? "improved" : send.template ? "template" : "team";
    if (send.notes) return "notes";
    // Improve rewrites the whole draft, so the edit measure can't tell what the team changed
    if (send.improved) return "ai";
    return send.editClass === "light" || send.editClass === "heavy" ? "edited" : "ai";
  }
  const fb = nearest(history.feedback, time, (f) => f.created_at, used);
  if (fb) {
    used.add(fb);
    return fb.edit_class === "as_is" ? "ai" : "edited";
  }
  return "team";
}

const AUTHOR_LABEL = {
  team: "written by our team",
  improved: "our team's text, polished by AI",
  template: "built by our team from a saved template",
  edited: "AI draft edited by our team",
  notes: "AI draft written from our team's own notes",
  ai: "AI draft sent unchanged",
};
const LEARNABLE = new Set(["team", "improved", "template", "edited", "notes"]);

function turnHeader(t) {
  if (t.direction !== "out") {
    if (t.side === "request") return "CUSTOMER'S REQUEST (came in through our own mailbox: the website form or a colleague's forward)";
    if (t.side === "colleague") return "COLLEAGUE (internal)";
    if (t.side === "other") return "THIRD PARTY (not the customer)";
    return "CUSTOMER";
  }
  if (t.side === "colleague") return "OUR TEAM → COLLEAGUE (internal context)";
  if (t.side === "third_party") return "OUR TEAM → THIRD PARTY (supplier, dealer or carrier — internal context, not what the customer was told)";
  return `OUR TEAM → CUSTOMER (${AUTHOR_LABEL[t.author]})`;
}

const plain = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();

function toDistillText(ticket, turns, notes) {
  const convo = turns
    .map((t) => `[${String(t.createdTime || "").slice(0, 10)}] ${turnHeader(t)}:\n${t.text || ""}`)
    .join("\n\n");
  const noteText = notes
    .slice()
    .sort((a, b) => (a.createdTime > b.createdTime ? 1 : -1))
    .slice(-6)
    .map((n) => `[${String(n.createdTime || "").slice(0, 10)}] ${plain(n.content).slice(0, 700)}`)
    .filter((l) => l.length > 14)
    .join("\n");
  return `=== TICKET ===\nSubject: ${ticket.subject}\n\n=== CONVERSATION (oldest first) ===\n${convo}` +
    (noteText ? `\n\n=== INTERNAL NOTES (the team's private record) ===\n${noteText}` : "");
}

// Second privacy gate after the model: anything that still looks like contact
// details, an order/tracking reference or an amount is replaced outright.
// Product SKUs (K-131S, S-401-3) are short and hyphenated, so they survive.
// Store order numbers are 5 digits, so a number named as an order, PO, RA… goes
// from 4 digits up.
function scrub(s) {
  return String(s || "")
    .replace(EMAIL_RE, "[email]")
    .replace(/https?:\/\/\S+/gi, (u) => (/^https?:\/\/(?:www\.)?(?:stylishkb\.com|sinksdirect\.ca|sinksdirectusa\.com)(?:\/[^\s?#]*)?$/i.test(u) ? u : "[link]"))
    .replace(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[phone]")
    .replace(/\b(order|P\.?O|RA|RMA|invoice|ticket|case|claim|tracking)\s*(?:no\.?|number)?\s*[:#]?\s*[A-Z0-9-]*\d{4,}[A-Z0-9-]*/gi, "$1 [number]")
    .replace(/\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/g, "[postal code]")
    .replace(/\b\d{5}-\d{4}\b/g, "[postal code]")
    .replace(/#\s?[A-Z0-9-]*\d[A-Z0-9-]*/gi, "[number]")
    .replace(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10,}\b/g, "[reference]")
    .replace(/\b\d{6,}\b/g, "[number]")
    .replace(/(?:(?:US|CA|C)?\$\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|CAD|dollars)\b)/gi, "[amount]")
    .trim();
}

// Wording that only describes a one-off decision. The model sometimes writes
// "the team waived the restocking fee" and still says it isn't an exception.
// Not when negated or conditional ("the fee cannot be waived", "can be waived
// if they buy another product" are the policy), and "courtesy" only next to
// money or an item ("kept the wrong items as a courtesy", not "a courtesy
// reminder").
const EXCEPTION_WORDS = /\b(?:waiv(?:e|ed|es|ing)|goodwill|as an exception|one-time exception|one-off)\b/gi;
const COURTESY = /\bcourtesy\b/gi;
const MONEY_OR_ITEM = /\b(?:refund\w*|credit\w*|discount\w*|free|gift\w*|replac\w*|keep|kept|compensat\w*|reimburs\w*|fees?|no (?:charge|cost))\b/i;
const NEGATED = /\b(?:not|no|never|cannot|can't|couldn't|won't|wouldn't|unable to|can|could|may|might)\s+(?:[\w'-]+\s+){0,3}$/i;

export function looksLikeException(text) {
  for (const sentence of String(text || "").split(/(?<=[.!?;])\s+/)) {
    const hits = [...sentence.matchAll(EXCEPTION_WORDS)];
    if (MONEY_OR_ITEM.test(sentence)) hits.push(...sentence.matchAll(COURTESY));
    if (hits.some((m) => !NEGATED.test(sentence.slice(0, m.index)))) return true;
  }
  return false;
}

// Flagged when learned; the word check also covers cases learned before the
// flag existed, until scripts/flag-exception-cases.mjs has tagged them.
export function isExceptionCase(a) {
  if ((a.tags || []).includes(EXCEPTION_TAG)) return true;
  return a.source === SOURCE && looksLikeException(String(a.body || "").split("How we resolved it:")[1]);
}

function toArticle(ticket, d, caseDate) {
  const exception = Boolean(d.is_exception) || looksLikeException(d.resolution);
  const body =
    `Situation: ${scrub(d.situation)}\n\nHow we resolved it: ${scrub(d.resolution)}` +
    (exception ? `\n\n${EXCEPTION_NOTE}` : "");
  const tags = [...new Set([d.intent, ...(d.tags || []).map(scrub)].filter((t) => t && t !== EXCEPTION_TAG))];
  if (exception) tags.push(EXCEPTION_TAG);
  const finish = (d.finish || "").trim();
  return {
    id: `RT-${ticket.id}`,
    title: scrub(d.title) || "Resolved ticket",
    body,
    finish: finish && !/^(none|n\/?a)$/i.test(finish) ? finish : null,
    tags,
    source: SOURCE,
    // internal link back to the ticket for the KB tab; never shown to the
    // drafter (gemini.js only exposes youtube URLs, and desk.zoho.com isn't a
    // trusted link host)
    sourceUrl: ticket.webUrl || null,
    // the case's own date: retrieval prefers recent resolutions by it
    updatedAt: caseDate || new Date().toISOString(),
  };
}

async function upsertArticle(a) {
  const [vec] = await embedDocuments([`${a.title}\n${a.body}`]);
  const { error } = await supabase.from("kb_articles").upsert({
    id: a.id, title: a.title, body: a.body, finish: a.finish, tags: a.tags,
    source: a.source, source_url: a.sourceUrl, updated_at: a.updatedAt,
    embedding: toVector(vec),
  }, { onConflict: "id" });
  if (error) throw new Error(error.message);
}

// For cases learned before the exception flag (scripts/flag-exception-cases.mjs):
// the model's verdict on a stored entry, and the tag + note it then gets. The
// case keeps its date (updated_at), which retrieval ranks by.
export async function judgeException(a) {
  const d = await askGemini(EXCEPTION_PROMPT, `${a.title}\n\n${a.body}`, {
    type: "object", properties: { is_exception: { type: "boolean" } }, required: ["is_exception"],
  });
  return Boolean(d.is_exception);
}

export async function flagException(a) {
  const body = a.body.includes(EXCEPTION_NOTE) ? a.body : `${a.body}\n\n${EXCEPTION_NOTE}`;
  const tags = [...new Set([...(a.tags || []), EXCEPTION_TAG])];
  const [vec] = await embedDocuments([`${a.title}\n${body}`]);
  const { error } = await supabase
    .from("kb_articles").update({ body, tags, embedding: toVector(vec) }).eq("id", a.id);
  if (error) throw new Error(error.message);
}

// ── the ledger ───────────────────────────────────────────────
// One app_state row per ticket the learner has looked at, key `learn:<ticketId>`
// (app_state already keeps per-key rows like chat:<id>, so no new table):
//   outcome     learned | skipped | deleted | error
//   reason      why it was skipped or failed (no_reply, ai_only, …)
//   closedSeen  the ticket's close time when last checked — a later close
//               (reopened, then closed again) makes it a candidate again
//   humanSeen   the newest team-written reply the entry was learned from; a
//               re-close only re-learns when the team wrote something newer
//   articleId   set while the ticket has an entry; editedByTeam once someone
//               edited that entry in the KB tab (the learner won't overwrite it)
const LEDGER = "learn:";
const STATE_KEY = "learn_state";
const LOCK_KEY = "learn_lock";
const MAX_ATTEMPTS = 3;

// Cases learned before the ledger existed. closedSeen is the entry's own date
// (the close date at the time it was learned), NOT the ticket's current close
// time, so the tickets reopened and closed again since get looked at once more.
const seedValue = (r) => ({
  outcome: "learned", seeded: true, articleId: r.id, closedSeen: r.updated_at, humanSeen: r.updated_at,
});

async function readLedger(ids) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { data, error } = await supabase
      .from("app_state").select("key,value").in("key", chunk.map((id) => LEDGER + id));
    if (error) throw new Error(error.message);
    for (const r of data) map.set(r.key.slice(LEDGER.length), r.value || {});
  }
  // before the one-off seed has run (and in a dry run), a ticket that has an
  // entry but no row was learned the old way
  const missing = ids.filter((id) => !map.has(id));
  for (let i = 0; i < missing.length; i += 100) {
    const { data, error } = await supabase
      .from("kb_articles").select("id,updated_at").in("id", missing.slice(i, i + 100).map((id) => `RT-${id}`));
    if (error) throw new Error(error.message);
    for (const r of data) map.set(r.id.slice(3), seedValue(r));
  }
  return map;
}

async function writeLedger(ticketId, value) {
  const { error } = await supabase.from("app_state").upsert({
    key: LEDGER + ticketId, value, updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

// For the KB tab (kb.js): a deleted entry must never be learned again, and an
// edited one must not be overwritten by a re-learn.
// Starts from what readLedger knows, so marking a case learned the old way
// (no row yet) keeps its articleId and dates instead of a bare flag.
export async function markLedger(ticketId, patch) {
  if (!supabase || !ticketId) return;
  const current = (await readLedger([ticketId])).get(ticketId) || {};
  await writeLedger(ticketId, { ...current, ...patch, markedAt: new Date().toISOString() });
}

async function readState() {
  const { data, error } = await supabase.from("app_state").select("value").eq("key", STATE_KEY).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.value || {};
}

async function seedLedger(state) {
  if (state.seededAt) return;
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("kb_articles").select("id,updated_at").eq("source", SOURCE).range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const now = new Date().toISOString();
  const recs = rows
    .filter((r) => r.id.startsWith("RT-"))
    .map((r) => ({ key: LEDGER + r.id.slice(3), value: seedValue(r), updated_at: now }));
  for (let i = 0; i < recs.length; i += 500) {
    // never over a row a run or the KB tab already wrote
    const { error } = await supabase
      .from("app_state").upsert(recs.slice(i, i + 500), { onConflict: "key", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  }
  state.seededAt = now;
  state.seeded = recs.length;
}

// One run at a time (the cron and the button can overlap). Taking it is an
// insert that does nothing when the row exists; a holder that died (function
// timeout) leaves a row whose `until` has passed, which the next run clears.
async function takeLock(ms, by) {
  const now = new Date();
  await supabase.from("app_state").delete().eq("key", LOCK_KEY).lt("value->>until", now.toISOString());
  const id = crypto.randomUUID();
  // an unbounded run (the backlog script) still lets go after a few hours
  const until = new Date(now.getTime() + (Number.isFinite(ms) ? ms : 4 * 3600000) + 120000).toISOString();
  const { data, error } = await supabase
    .from("app_state")
    .upsert({ key: LOCK_KEY, value: { id, until, by }, updated_at: now.toISOString() }, { onConflict: "key", ignoreDuplicates: true })
    .select("key");
  if (error) throw new Error(error.message);
  return data?.length ? id : null;
}

async function releaseLock(id) {
  await supabase.from("app_state").delete().eq("key", LOCK_KEY).eq("value->>id", id);
}

const after = (a, b) => !b || Date.parse(a) > Date.parse(b) + 1000;

function isCandidate(row, prior) {
  if (!prior) return true;
  if (prior.outcome === "deleted") return false; // the team removed it: never again
  // a failure, or a ticket Zoho said was gone, gets a few more looks
  if ((prior.outcome === "error" || prior.reason === "gone") && (prior.attempts || 0) < MAX_ATTEMPTS) return true;
  return after(row.closed_time, prior.closedSeen);
}

// Tickets to look at, most recently closed first: status exactly "Closed"
// ("Closed Wayfair" is automated RA mail), closed inside the window, and never
// seen, closed again since, or a failed attempt worth a retry. Reads only our
// own tables — no Zoho call — so the KB tab can show the count.
async function candidates({ since = LEARN_START, until } = {}) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase
      .from("tickets").select("id,number,closed_time")
      .eq("status", "Closed").gte("closed_time", since)
      .order("closed_time", { ascending: false }).range(from, from + 999);
    if (until) q = q.lt("closed_time", until);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const zohoRows = rows.filter((r) => !String(r.id).startsWith("bb:"));
  const ledger = await readLedger(zohoRows.map((r) => r.id));
  return zohoRows
    .map((r) => ({ ...r, prior: ledger.get(r.id) || null }))
    .filter((r) => isCandidate(r, r.prior));
}

// Look at one ticket and decide. Pure apart from reads: returns the ledger
// value to store and, when there is something to learn, the entry.
async function learnTicket(row, prior) {
  const now = new Date().toISOString();
  const base = { ...(prior || {}), number: row.number != null ? String(row.number) : prior?.number ?? null, checkedAt: now };
  delete base.seeded;
  // a re-check that adds nothing leaves an existing entry as it is
  const skip = (reason, closedSeen = row.closed_time, extra = {}) => {
    const outcome = base.articleId ? "learned" : "skipped";
    return { outcome, reason, value: { ...base, outcome, reason, closedSeen, attempts: 0 }, ...extra };
  };

  const t = await getTicketForLearning(row.id);
  if (!t) {
    const r = skip("gone");
    r.value.attempts = (prior?.reason === "gone" ? prior.attempts || 0 : 0) + 1;
    return r;
  }
  if (t.status !== "Closed") return skip("not_closed");
  const closed = t.closedTime || row.closed_time;
  if (base.articleId && base.editedByTeam) return skip("edited_by_team", closed);
  if (t.isSpam) return skip("spam", closed);
  if (t.threadCount < 2) return skip("single_thread", closed);

  const [{ threads }, history, notes] = await Promise.all([
    getThreadsForLearning(t.id, { skip: isSurvey }),
    sendHistory(t.id),
    t.commentCount > 0 ? listTicketComments(t.id).catch(() => []) : [],
  ]);
  const used = new Set();
  const turns = labelTurns(t, threads).map((x) =>
    x.direction === "out" && x.side === "customer" && !x.author ? { ...x, author: authorship(x, history, used) } : x
  );
  const replies = turns.filter((x) => x.author);
  const learnable = replies.filter((x) => LEARNABLE.has(x.author));
  // for the dry run's printout: ←customer →team →ai →third_party …
  const info = { turns: turns.map((x) => (x.direction === "out" ? `→${x.author || x.side}` : `←${x.side}`)) };
  if (!replies.length) return skip("no_reply", closed, info);
  // decision: the AI must not learn from itself
  if (!learnable.length) return skip("ai_only", closed, info);

  const humanAt = learnable.reduce((m, x) => (x.createdTime > m ? x.createdTime : m), "");
  if (base.articleId && !after(humanAt, base.humanSeen)) return skip("no_new_reply", closed, info);
  const asked = turns.some((x) => x.direction !== "out" && (x.side === "customer" || x.side === "request") && (x.text || "").trim().length > 20);
  const answered = learnable.some((x) => (x.text || "").trim().length > 40);
  if (!asked || !answered) return skip("too_short", closed, info);

  const d = await distill(toDistillText(t, turns, notes));
  if (!d.usable) return skip("not_usable", closed, info);
  const article = toArticle(t, d, closed);
  const provenance = [...new Set(learnable.map((x) => x.author))].sort().join("+");
  return {
    outcome: "learned",
    reason: null,
    article,
    ...info,
    value: {
      ...base, outcome: "learned", reason: null, closedSeen: closed, humanSeen: humanAt,
      learnedAt: now, articleId: article.id, provenance, exception: article.tags.includes(EXCEPTION_TAG), attempts: 0,
    },
  };
}

// Store what learnTicket decided. The run read the ledger when it started, and
// the KB tab may have deleted or edited this case since (or does so while the
// entry is being saved): what the team did there wins.
async function save(row, r) {
  const current = async () => (await readLedger([row.id])).get(row.id) || null;
  let now = await current();
  if (now?.outcome === "deleted") return { outcome: "skipped", reason: "deleted", value: null };
  if (r.article && now?.editedByTeam) {
    const { seeded, ...kept } = now;
    r = {
      ...r, article: null, outcome: "learned", reason: "edited_by_team",
      value: { ...kept, outcome: "learned", reason: "edited_by_team", closedSeen: r.value.closedSeen, checkedAt: r.value.checkedAt, attempts: 0 },
    };
  }
  if (r.article) {
    await upsertArticle(r.article);
    now = await current();
    // deleted while it was being embedded and saved: take it out again
    if (now?.outcome === "deleted") {
      await supabase.from("kb_articles").delete().eq("id", r.article.id);
      return { outcome: "skipped", reason: "deleted", value: null };
    }
  }
  if (r.value) await writeLedger(row.id, now?.editedByTeam ? { ...r.value, editedByTeam: true } : r.value);
  return r;
}

// The driver for the cron, the "Learn now" button and the script. Stops
// STARTING tickets once `budgetMs` is spent (the caller keeps the margin for
// the one in flight) or `signal` aborts (Ctrl-C in the script). `dryRun` reads
// and distills but writes nothing — no entry, no ledger, no lock. `limit`
// stops after that many entries.
export async function learnPending({
  budgetMs = 45000,
  since = LEARN_START,
  until,
  limit = Infinity,
  dryRun = false,
  random = false,
  trigger = "button",
  signal,
  onTicket,
} = {}) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
  if (!supabase) throw new Error("Supabase is not configured");
  const t0 = Date.now();
  const lock = dryRun ? null : await takeLock(budgetMs, trigger);
  if (!dryRun && !lock) return { busy: true };
  try {
    const state = dryRun ? {} : await readState();
    if (!dryRun) await seedLedger(state);
    const list = await candidates({ since, until });
    // a review sample should span the window, not just its newest days
    for (let i = list.length - 1; random && i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }

    const stats = { processed: 0, learned: 0, skipped: 0, errors: 0, reasons: {}, total: list.length };
    for (const row of list) {
      if (stats.learned >= limit || Date.now() - t0 > budgetMs || signal?.aborted) break;
      stats.processed++;
      let r;
      try {
        r = await learnTicket(row, row.prior);
        if (!dryRun) r = await save(row, r);
        if (r.article) stats.learned++;
        else stats.skipped++;
        if (r.reason) stats.reasons[r.reason] = (stats.reasons[r.reason] || 0) + 1;
      } catch (e) {
        // A failed Zoho login fails every ticket alike: stop the run and mark
        // none of them, so they are all still there once the login is fixed.
        if (e.auth) throw new Error(`Zoho sign-in failed, so learning stopped (the tickets wait for the next run): ${e.message}`);
        stats.errors++;
        r = { outcome: "error", reason: e.message };
        if (!dryRun) {
          const now = (await readLedger([row.id]).catch(() => null))?.get(row.id) || row.prior;
          const sameClose = !after(row.closed_time, now?.closedSeen);
          if (now?.outcome !== "deleted") {
            await writeLedger(row.id, {
              ...(now || {}), outcome: "error", reason: String(e.message).slice(0, 300),
              closedSeen: row.closed_time, checkedAt: new Date().toISOString(),
              attempts: (sameClose && now?.outcome === "error" ? now.attempts || 0 : 0) + 1,
            }).catch(() => {});
          }
        }
      }
      if (onTicket) onTicket(row, r);
    }

    if (dryRun) return { ...stats, dryRun: true, pending: list.length - stats.processed };
    const at = new Date().toISOString();
    await supabase.from("app_state").upsert({
      key: STATE_KEY,
      value: {
        ...state,
        lastRunAt: at,
        lastLearnedAt: stats.learned ? at : state.lastLearnedAt || null,
        lastRun: { trigger, at, ms: Date.now() - t0, ...stats },
      },
      updated_at: at,
    });
    return { ...stats, pending: (await candidates({ since, until })).length };
  } finally {
    if (lock) await releaseLock(lock).catch(() => {});
  }
}

// For the KB tab: when the learner last ran / last added something, how many
// cases it added in the past 7 days, and how many closed tickets still wait.
export async function learningStatus() {
  if (!supabase) return null;
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const [state, week, pending] = await Promise.all([
    readState(),
    supabase
      .from("app_state").select("key", { count: "exact", head: true })
      .like("key", `${LEDGER}%`).eq("value->>outcome", "learned").gte("value->>learnedAt", weekAgo),
    candidates(),
  ]);
  if (week.error) throw new Error(week.error.message);
  return {
    since: LEARN_START,
    lastRunAt: state.lastRunAt || null,
    lastLearnedAt: state.lastLearnedAt || null,
    addedThisWeek: week.count || 0,
    pending: pending.length,
  };
}

export { SOURCE as RESOLVED_TICKET_SOURCE };
