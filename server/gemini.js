// server/gemini.js
// Generates a customer-care reply grounded in the approved Knowledge Base AND
// triages the ticket (intent / confidence / coverage / sensitivity), using
// Google's Gemini API with structured JSON output. Nothing is auto-sent — a
// human always approves; the triage just tells them how much care it needs.

import { ordersToText } from "./wix.js";
import { shipmentsToText } from "./shipstation.js";
import { wayfairToText } from "./wayfair.js";
import { walmartToText } from "./walmart.js";

const { GEMINI_API_KEY, GEMINI_MODEL } = process.env;
const MODEL = GEMINI_MODEL || "gemini-3.1-pro-preview";

export function geminiConfigured() {
  return Boolean(GEMINI_API_KEY);
}

// Intents that ALWAYS go to careful human review, never the fast lane —
// even at high confidence (per the team's policy: money + legal).
const SENSITIVE_INTENTS = ["refund_or_compensation", "legal"];

const INTENTS = [
  "order_status",
  "shipping",
  "returns",
  "warranty",
  "product_care",
  "installation",
  "product_info",
  "refund_or_compensation",
  "complaint_or_damage",
  "legal",
  "other",
];

// Keep "thinking" minimal so it doesn't eat the output budget or add latency.
// Gemini 3.x uses thinkingLevel ("low"/"high") and REQUIRES thinking mode;
// Gemini 2.5 used thinkingBudget (0 = off). Pick the right knob per model.
function thinkingConfigFor(model) {
  if (/^gemini-3/.test(model)) return { thinkingLevel: "low" };
  return { thinkingBudget: 0 };
}

const SYSTEM_PROMPT = `You are a customer care agent for Stylish International Inc., a kitchens and bath manufacturer (brands: STYLISH and Sinks Direct) selling through Wayfair, RONA, Lowe's, Amazon and direct channels.

Do TWO things and return them in the structured JSON output:

1) "reply": Write the reply to the customer's most recent message, grounded ONLY in the approved Knowledge Base articles (or facts already stated earlier in this conversation).

TONE & VOICE — write like a real, experienced customer-care specialist, never like a bot or a template:
- Sound warm, human and genuinely helpful. Avoid stiff, generic or robotic phrasing.
- Open by acknowledging the customer's SPECIFIC situation in your own words — reference what they actually asked about (the exact product/model, their real concern). Do not open with a generic "Thank you for reaching out."
- Show sincere empathy when the customer is worried, frustrated, or inconvenienced — briefly and naturally.
- Be clear and concise: get to the point, no filler, no repeated sentences, no corporate boilerplate.
- Address the customer by their first name when you know it.
- SIGN-OFF: do NOT add any closing or sign-off at all — no "Regards", "Thank you,", name, title, company, phone or links. End with your last content sentence. The system appends the official signature (which already includes the closing) automatically after your reply.
- Vary your wording; never reuse the same stock sentences across replies.

ACCURACY (never sacrifice this for tone):
- Use ONLY facts present in the Knowledge Base or already stated earlier in the thread. Never invent policy, prices, timelines, outcomes, specifications, materials, or part details.
- Articles tagged "source: zoho-template" are EXAMPLE replies the team has used for similar situations. Treat them as REFERENCE for tone, policy and structure — do NOT copy them word-for-word. Adapt the wording to THIS customer and their specific details, and combine information from several articles when it helps. Fill in specifics (order numbers, names, amounts) only when you actually have them.
- Articles tagged "source: resolved-ticket" are generalized summaries of how the team actually handled similar PAST cases ("Situation … / How we resolved it …"). Use them as REFERENCE for the right approach, policy and tone for this kind of case — never copy them, and never assume this customer's specifics match the past case (the summaries are anonymized and carry no real names, orders or amounts).
- Do NOT assert regulatory or compliance claims (e.g. "lead-free", NSF/ANSI, cUPC, certifications) unless those exact claims appear in the Knowledge Base. If a customer asks about them and the KB doesn't confirm, treat it as not covered and escalate.
- CUSTOMER PHOTOS: when the customer's attached photos are included with this request, look at them and use what is CLEARLY visible to tailor the reply (identify the product/part, acknowledge what they show — it reassures the customer that their photos were reviewed). Observations are context only: never draw a definitive fault/cause/defect conclusion from a photo alone, and never promise an outcome based on it — the formal review still applies (see WARRANTY below).
- CUSTOMER ORDERS: a "CUSTOMER ORDERS (from store)" section may list this customer's real direct-store orders, a "SHIPMENTS (ShipStation)" section may list orders matched by number across all channels (Amazon, Wayfair, Home Depot, etc.) with their shipment status, carrier and tracking, and a "WAYFAIR PURCHASE ORDERS" section may show the Wayfair-side details of a PO (items, estimated ship date, carrier, warehouse). Use them to answer order/shipping questions precisely — confirm the order number, status, what shipped, and share the tracking number/carrier when present. Only use entries whose details clearly match what the customer is asking about; if none match, don't guess — ask which order they mean. Never invent an order number, tracking number or status that isn't in these sections.
- ANSWER THE LATEST MESSAGE: build your reply around the customer's MOST RECENT message and what it actually asks for — not an earlier point in the thread that has since been resolved or superseded.
- RECONCILE the specifics the customer gives against the order/shipment data. If they mention an order number, find it. If they reference a tracking number, compare it to the tracking on their orders: when it doesn't match any of their shipments, say so plainly and give the correct tracking from the data (e.g. "The number you mentioned doesn't match your orders — it may be a typo; your [items] shipped on order #X under [carrier] [tracking].").
- A "FULFILLED"/"shipped" status means the order was DISPATCHED — not a guarantee every item physically arrived. Respect what the thread and the customer establish: if a human agent or the customer says a specific item is still missing, backordered, or didn't arrive, treat that as true and honor it, even if the order shows fulfilled. Use the data to help (confirm what tracking covers which items), never to contradict a real issue the customer is reporting.
- If the articles don't cover the question, don't guess. Reassure the customer, let them know the team will follow up, and be specific about what will be clarified and what happens next. (See CONTINUITY below — don't introduce a new, unnamed "specialist" unless the thread already did.)
- If a Knowledge Base article is a video tutorial (source: youtube) that directly helps, you MAY include its exact URL (e.g. "Here's a quick video that walks you through it: <url>"). Only ever share YouTube video URLs — never any other article's URL or internal links.
- NEVER invent, guess, or reconstruct a URL. A video URL may ONLY be copied character-for-character from the "url:" field of a youtube article in the Knowledge Base below. If an article mentions that a video exists but no youtube article with a url is provided, do NOT include any link — describe the steps in words instead.
- Do not mention the Knowledge Base, internal article IDs, or that you are an AI.
- Reply in the SAME language the customer wrote in (e.g. English, Spanish or French). No subject line.

CONTINUITY (stay consistent with the thread):
- Do NOT introduce a new, unnamed "specialist" as a hand-off unless the thread already did. Stay consistent with who owns the case.
- Honor commitments already made earlier in the thread. If a previous reply gave a timeline, an owner or a next step, restate it consistently — never weaken a concrete timeline (e.g. "by Monday") into a vague one ("as soon as possible").

ADDRESS EVERYTHING:
- Respond to every concrete point in the customer's latest message: each question, each symptom or detail they describe, and any specific offer or request they make. Never silently drop a detail they took the time to raise.
- If the customer signals a broader concern (for example, they resell or recommend the product to their own clients), acknowledge it directly and take it seriously.

AGENT INSTRUCTIONS (when present):
- If the request includes an "AGENT INSTRUCTIONS" section, the human agent is telling you WHAT the reply should say — rough notes, bullet points or a quick draft. Turn them into the full, polished reply: expand them naturally, keep the ticket's context and tone rules, and use the Knowledge Base for supporting details.
- Every specific the agent gives there (resolutions, replacements, refunds, timelines, amounts) is AUTHORIZED by the human and must be kept exactly — those instructions override the caution rules below. Do not add commitments the agent didn't give.

WARRANTY / DEFECT / COMPLAINT:
- Validate the customer's experience, but do NOT admit fault, assign a cause, or concede the product is defective — especially while any inspection, factory report or internal review is pending. Treat the customer's care practices as helpful context for the review, not as proof of cause.
- Do not promise a replacement, refund, credit or any other resolution. Those decisions are made by a human.

FORMATTING — the reply is an HTML email body, so make it easy to read, never one giant wall of text:
- Break the reply into short paragraphs, one idea each, using <p>…</p>. Always separate the greeting, the body points, and the sign-off into their own paragraphs.
- Use <strong> to highlight the few genuinely important details (amounts, deadlines, key actions, promo codes, addresses). Don't over-bold.
- When you give steps, options, or a list of items, use <ol><li>…</li></ol> (ordered steps) or <ul><li>…</li></ul> (bullet points) instead of cramming them into a sentence.
- Put links as <a href="URL">descriptive text</a>.
- Keep it clean: ONLY use these tags — <p>, <strong>, <em>, <ul>, <ol>, <li>, <a>, <br>. No headings, colors, inline styles, classes, images, tables, or <html>/<body> wrappers. Match the amount of formatting to the message — a short answer may just be 2–3 short paragraphs; a how-to should use a numbered list.

2) Triage the ticket:
- "intent": the single best-fitting category.
- "confidence": "high" only if the Knowledge Base clearly and fully answers the customer; "medium" if partially; "low" if barely or not at all.
- "kb_covered": true only if the approved articles actually contain the answer.
- "sensitive": true if the message involves money (refunds, compensation, chargebacks), legal threats/complaints, or an upset customer reporting damage. When unsure, set true.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    intent: { type: "string", enum: INTENTS },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    kb_covered: { type: "boolean" },
    sensitive: { type: "boolean" },
  },
  required: ["reply", "intent", "confidence", "kb_covered", "sensitive"],
};

function kbToText(kb) {
  return kb
    .map((a, i) => {
      const meta = [
        a.finish ? `finish: ${a.finish}` : null,
        a.source ? `source: ${a.source}` : null,
        // expose the URL only for video tutorials, the one link type we allow
        a.source === "youtube" && a.sourceUrl ? `url: ${a.sourceUrl}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `Article ${i + 1} — ${a.title}${meta ? ` [${meta}]` : ""}\n${a.body}`;
    })
    .join("\n\n---\n\n");
}

function conversationToText(conversation) {
  return conversation
    .map((t) => {
      const who = t.direction === "out" ? "Agent" : "Customer";
      return `${who} (${t.author || t.from}):\n${t.text}`;
    })
    .join("\n\n");
}

// ── link safety net ──────────────────────────────────────────
// The model is told to only copy video URLs verbatim from the KB, but a
// hallucinated link (e.g. youtube.com/watch?v=example) reaching a customer is
// bad enough that we also enforce it deterministically: any URL in the draft
// that is not (a) a youtube URL from the retrieved KB articles or (b) a URL the
// customer/agent already used in this conversation gets stripped out.
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi;

function normalizeUrl(u) {
  return String(u || "").trim().replace(/[.,;!?]+$/, "").toLowerCase();
}

export function sanitizeReplyLinks(replyHtml, kb = [], conversation = []) {
  const allowed = new Set();
  for (const a of kb) {
    if (a.source === "youtube" && a.sourceUrl) allowed.add(normalizeUrl(a.sourceUrl));
  }
  for (const m of conversation) {
    for (const u of String(m.text || "").match(URL_RE) || []) allowed.add(normalizeUrl(u));
  }

  let removed = 0;
  let out = String(replyHtml || "");
  // unwrap anchors whose href is not allowed (keep the label text, drop the link)
  out = out.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
    if (allowed.has(normalizeUrl(href))) return m;
    removed++;
    // if the visible label is itself a URL, drop it entirely
    return URL_RE.test(label) ? "" : label;
  });
  // then strip any bare URL that isn't allowed
  out = out.replace(URL_RE, (u) => {
    if (allowed.has(normalizeUrl(u))) return u;
    removed++;
    return "";
  });
  // tidy leftovers like "video: ." or empty parentheses from a removed link
  if (removed) out = out.replace(/\(\s*\)/g, "").replace(/\s+([.,;:])/g, "$1").replace(/:\s*([.,;])/g, "$1");
  return { reply: out, removedLinks: removed };
}

// Decide which review lane the ticket belongs in. Nothing auto-sends; this is
// purely guidance for the human reviewer.
export function routeReply({ intent, confidence, kbCovered, sensitive }) {
  const isSensitive = sensitive || SENSITIVE_INTENTS.includes(intent);
  if (isSensitive)
    return { lane: "sensitive", label: "Sensitive — review carefully" };
  if (!kbCovered || confidence === "low")
    return { lane: "review", label: "Needs review — not fully covered" };
  return { lane: "ready", label: "Ready — high confidence" };
}

// Polish an agent's hand-written (or edited) draft WITHOUT changing its meaning.
// Uses the fast model — this is an editing task, not retrieval.
const IMPROVE_MODEL = process.env.GEMINI_FLASH_MODEL || "gemini-2.5-flash";
const IMPROVE_PROMPT = `You are an expert customer-care editor for Stylish International Inc. (kitchen & bath; brands STYLISH and Sinks Direct).
Improve the agent's DRAFT reply below. Make it warm, professional, clear and well-structured — like an experienced support specialist wrote it.

STRICT RULES — do NOT change the substance:
- Keep every fact, commitment, name, number, amount, date, link and policy EXACTLY as written. Never add new facts, promises, prices, timelines, links or claims.
- Fix grammar, spelling, tone and flow only. Don't pad with filler or boilerplate.
- Reply in the SAME language the draft is written in.
- Format as clean HTML: short <p> paragraphs, <strong> for the few key details, <ul>/<ol> for steps. Allowed tags: <p>, <strong>, <em>, <ul>, <ol>, <li>, <a>, <br>. No subject line, no commentary.
Output ONLY the improved reply HTML.`;

export async function improveDraft({ draft }) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set in .env");
  const src = String(draft || "").trim();
  if (!src) throw new Error("Nothing to improve — the draft is empty.");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${IMPROVE_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: IMPROVE_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: `DRAFT:\n${src}` }] }],
        generationConfig: {
          maxOutputTokens: 2048,
          temperature: 0.3,
          thinkingConfig: thinkingConfigFor(IMPROVE_MODEL),
        },
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini improve error (${res.status}): ${data?.error?.message || "unknown"}`);
  let out = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  out = out.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
  // keep only links that were already in the agent's draft (don't strip theirs,
  // don't let the editor invent new ones)
  const allowed = (src.match(/https?:\/\/[^\s"'<>)\]]+/gi) || []);
  const { reply } = sanitizeReplyLinks(out, [], [{ text: allowed.join(" ") }]);
  return { reply: reply.trim() || src };
}

export async function generateDraft({ ticket, conversation, kb, images = [], orders = [], shipments = [], wayfairPos = [], walmartOrders = [], instructions = "" }) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set in .env");
  }

  const ordersBlock = orders.length
    ? `\n=== CUSTOMER ORDERS (from store) ===\n${ordersToText(orders)}\n`
    : "";
  const shipBlock = shipments.length
    ? `\n=== SHIPMENTS (ShipStation) ===\n${shipmentsToText(shipments)}\n`
    : "";
  const wayfairBlock = wayfairPos.length
    ? `\n=== WAYFAIR PURCHASE ORDERS ===\n${wayfairToText(wayfairPos)}\n`
    : "";
  const walmartBlock = walmartOrders.length
    ? `\n=== WALMART ORDERS ===\n${walmartToText(walmartOrders)}\n`
    : "";
  const instructionsBlock = instructions
    ? `\n=== AGENT INSTRUCTIONS (write the reply saying this) ===\n${instructions.slice(0, 4000)}\n`
    : "";

  const userContent = `Customer: ${ticket.customerName} <${ticket.customerEmail}>
Subject: ${ticket.subject}
Channel: ${ticket.channel || "Email"}

=== CONVERSATION (oldest first) ===
${conversationToText(conversation)}
${images.length ? `\n[The customer attached ${images.length} photo(s) — included after this text: ${images.map((i) => i.name).join(", ")}]\n` : ""}${ordersBlock}${shipBlock}${wayfairBlock}${walmartBlock}${instructionsBlock}
=== APPROVED KNOWLEDGE BASE ===
${kbToText(kb)}

Write the reply and triage the ticket now.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  const parts = [
    { text: userContent },
    ...images.map((im) => ({ inline_data: { mime_type: im.mime, data: im.data } })),
  ];

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY,
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.3,
        thinkingConfig: thinkingConfigFor(MODEL),
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Gemini API error (${res.status}): ${
        data?.error?.message || JSON.stringify(data)
      }`
    );
  }

  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();

  if (!text) {
    const reason = candidate?.finishReason || "no content returned";
    throw new Error(`Gemini returned no text (${reason})`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Gemini returned malformed JSON");
  }

  const triage = {
    intent: parsed.intent || "other",
    confidence: parsed.confidence || "low",
    kbCovered: Boolean(parsed.kb_covered),
    sensitive: Boolean(parsed.sensitive),
  };
  let route = routeReply(triage);

  // Hard safety net: strip any URL the model didn't copy verbatim from the KB
  // (or the conversation). If we had to remove one, the draft loses fast-lane
  // status so a human double-checks the now-linkless sentence.
  const { reply, removedLinks } = sanitizeReplyLinks(parsed.reply || "", kb, conversation);
  if (removedLinks && route.lane === "ready") {
    route = { lane: "review", label: "Needs review — removed an unverified link" };
  }

  return {
    draft: reply.trim(),
    ...triage,
    ...route, // lane, label
    removedLinks,
    // kept for backward-compat with existing UI/consumers
    needsHuman: route.lane !== "ready",
  };
}
