// server/bestbuy.js
// Best Buy Canada Marketplace (runs on Mirakl) — customer message threads,
// their order context, AI-drafted replies and sending the reply back.
// Shop: Sinks Direct (id 2893). Auth is a raw Mirakl API key header.

import { retrieveRelevant } from "./retrieval.js";

const BASE = process.env.BESTBUY_MIRAKL_URL || "https://marketplace.bestbuy.ca/api";
const KEY = process.env.BESTBUY_MIRAKL_KEY;
const { GEMINI_API_KEY } = process.env;
const MODEL = process.env.GEMINI_FLASH_MODEL || "gemini-2.5-flash";

export function bestbuyConfigured() {
  return Boolean(KEY);
}

// Mirakl rate-limits hard (429) — back off and retry a couple of times.
async function mk(path, options = {}, attempt = 0) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: KEY,
      Accept: "application/json",
      "User-Agent": "WeCare/1.0 (Stylish International; care@stylishkb.com)",
      ...(options.headers || {}),
    },
  });
  if (res.status === 429 && attempt < 2) {
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    return mk(path, options, attempt + 1);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Best Buy (Mirakl) ${res.status}: ${txt.slice(0, 160)}`);
  }
  if (res.status === 204) return null;
  // Mirakl answers HTML (a block/login page) when the caller's IP isn't
  // allowlisted for API access — surface that instead of a JSON parse error.
  const ct = res.headers.get("content-type") || "";
  if (!/json/i.test(ct)) {
    const txt = (await res.text().catch(() => "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    throw new Error(
      `Mirakl returned ${ct || "non-JSON"} instead of data — the server's IP is likely not allowlisted for API access in the Best Buy Marketplace settings. Response: ${txt.slice(0, 120)}`
    );
  }
  return res.json();
}

const stripHtml = (h) =>
  String(h || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

function normalizeThread(t) {
  const customer = (t.authorized_participants || []).find((p) => p.type === "CUSTOMER");
  const order = (t.entities || []).find((e) => e.type === "MMP_ORDER");
  const md = t.metadata || {};
  return {
    id: t.id,
    topic: t.topic?.value || "(no subject)",
    customer: customer?.display_name || "Customer",
    customerId: customer?.id || null,
    orderId: order?.id || null,
    createdAt: t.date_created,
    updatedAt: t.date_updated,
    // Mirakl's own flag: set while the SHOP still owes a reply
    needsReply: Boolean(md.shop_reply_needed_since),
    waitingSince: md.shop_reply_needed_since || null,
    lastAt: md.last_message_date || t.date_updated,
    lastFrom: md.last_sender?.type || null,
    lastSender: md.last_sender?.display_name || null,
    messageCount: md.total_count ?? null,
  };
}

// Threads, ones awaiting our reply first. Single API call — the list's
// metadata already carries who spoke last and whether we owe a reply.
export async function listThreads({ limit = 30 } = {}) {
  if (!bestbuyConfigured()) return [];
  const data = await mk(`/inbox/threads?max=${limit}`);
  return (data?.data || [])
    .map(normalizeThread)
    .sort((a, b) => (a.needsReply === b.needsReply ? (a.lastAt < b.lastAt ? 1 : -1) : a.needsReply ? -1 : 1));
}

// Mirror Best Buy threads into the same `tickets` table so they live in the
// one Inbox queue (search, filters, pagination all work unchanged). Their ids
// are prefixed "bb:" so the Zoho reconciler never touches them.
export async function syncThreadsToTickets(upsertTickets, { limit = 50 } = {}) {
  if (!bestbuyConfigured()) return 0;
  const threads = await listThreads({ limit });
  if (!threads.length) return 0;
  const rows = threads.map((t) => ({
    id: `bb:${t.id}`,
    number: t.orderId || t.id.slice(0, 8),
    subject: t.topic,
    status: t.needsReply ? "Open" : "Closed Best Buy",
    channel: "Best Buy",
    customerName: t.customer,
    customerEmail: "",
    createdTime: t.createdAt,
    modifiedTime: t.lastAt || t.updatedAt,
    closedTime: null,
    customerResponseTime: t.waitingSince || t.lastAt,
    webUrl: null,
  }));
  await upsertTickets(rows);
  return rows.length;
}

export async function getThread(threadId) {
  const t = await mk(`/inbox/threads/${threadId}`);
  const msgs = (t?.messages?.data || t?.messages || []).map((m) => ({
    id: m.id,
    from: /CUSTOMER/i.test(m.from?.type || "") ? "customer" : "shop",
    author: m.from?.display_name || "",
    date: m.date_created,
    text: stripHtml(m.body),
  }));
  return { ...normalizeThread(t), messages: msgs, participants: t.current_participants || [] };
}

// The order behind a thread (items, status, dates) for context.
export async function getOrder(orderId) {
  if (!orderId) return null;
  const data = await mk(`/orders?order_ids=${encodeURIComponent(orderId)}`).catch(() => null);
  const o = data?.orders?.[0];
  if (!o) return null;
  return {
    id: o.order_id || o.commercial_id,
    state: o.order_state,
    date: (o.created_date || "").slice(0, 10),
    total: o.total_price != null ? `${o.total_price} ${o.currency_iso_code || ""}`.trim() : null,
    customer: [o.customer?.firstname, o.customer?.lastname].filter(Boolean).join(" ") || null,
    items: (o.order_lines || []).map((l) => ({
      sku: l.offer_sku || l.product_sku,
      name: l.product_title,
      qty: l.quantity,
      state: l.order_line_state,
    })),
  };
}

const PROMPT = `You are a customer care specialist for Stylish International Inc. replying to a customer on the BEST BUY CANADA MARKETPLACE (shop: Sinks Direct), inside Best Buy's own messaging.

Style:
- Warm, professional and concise: 2-5 short sentences, plain text (no HTML, no markdown, no links).
- Reply in the SAME language the customer used (many are French — answer in French then).
- Open by acknowledging their specific situation; address every point they raised.
- Sign off with a brief closing and "Sinks Direct Customer Care" on the last line.

Accuracy:
- Use ONLY the Knowledge Base excerpts and the order details provided. Never invent policies, dates, prices, specs, tracking numbers or outcomes.
- Marketplace rules: refunds/returns/cancellations on Best Buy are handled through Best Buy's process. You may explain the next step, but never promise a refund, credit, replacement or cancellation as already approved — say the team is checking and will confirm.
- If the answer isn't covered, say the team is looking into it and will follow up shortly. Don't guess.

Return JSON: { "reply": string }`;

const SCHEMA = { type: "object", properties: { reply: { type: "string" } }, required: ["reply"] };

export async function draftThreadReply(threadId) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
  const thread = await getThread(threadId);
  const order = await getOrder(thread.orderId).catch(() => null);
  const lastCustomer = [...thread.messages].reverse().find((m) => m.from === "customer");
  const kb = await retrieveRelevant(
    {
      ticket: { subject: thread.topic },
      conversation: thread.messages.filter((m) => m.from === "customer").map((m) => ({ direction: "in", text: m.text })),
    },
    6
  ).catch(() => []);

  const user = `Best Buy Marketplace thread
Topic: ${thread.topic}
Customer: ${thread.customer}
${order ? `Order ${order.id} (${order.date}, ${order.state}): ${order.items.map((i) => `${i.sku} ${i.name || ""} x${i.qty} [${i.state}]`).join("; ")}\n` : thread.orderId ? `Order: ${thread.orderId}\n` : ""}
=== CONVERSATION (oldest first) ===
${thread.messages.map((m) => `${m.from === "customer" ? "Customer" : "Us"}: ${m.text}`).join("\n\n")}

=== KNOWLEDGE BASE ===
${kb.map((a, i) => `Article ${i + 1} — ${a.title}\n${(a.body || "").slice(0, 1000)}`).join("\n\n---\n\n") || "(none)"}

Write the reply to the customer's latest message now.`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: PROMPT }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        maxOutputTokens: 700,
        temperature: 0.4,
        thinkingConfig: /^gemini-3/.test(MODEL) ? { thinkingLevel: "low" } : { thinkingBudget: 0 },
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini error (${res.status}): ${data?.error?.message || "unknown"}`);
  const raw = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  let reply = "";
  try { reply = JSON.parse(raw).reply || ""; } catch { reply = ""; }
  reply = reply.replace(/https?:\/\/\S+/g, "").trim(); // no links inside marketplace messaging
  return { thread, order, draft: reply, lastCustomerMessage: lastCustomer?.text || "" };
}

// Send the reply back into the Best Buy thread. Mirakl expects multipart with
// a JSON part named `message_input`.
export async function replyToThread(threadId, body) {
  if (!body?.trim()) throw new Error("Empty reply");
  const thread = await mk(`/inbox/threads/${threadId}`);
  const to = (thread.current_participants || [])
    .filter((p) => p.type !== "SHOP")
    .map((p) => ({ id: p.id, type: p.type }))
    .filter((p) => p.id);
  const fd = new FormData();
  fd.append(
    "message_input",
    new Blob([JSON.stringify({ body: body.trim(), to })], { type: "application/json" })
  );
  const res = await fetch(`${BASE}/inbox/threads/${threadId}/message`, {
    method: "POST",
    headers: { Authorization: KEY },
    body: fd,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Best Buy reply failed (${res.status}): ${txt.slice(0, 200)}`);
  }
  return { ok: true };
}
