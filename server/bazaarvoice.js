// server/bazaarvoice.js
// BazaarVoice without API access: their Connections alert emails already land
// as tickets and contain every question/review in full (text, retailer,
// product) plus a deep link straight to the response form. We parse those,
// draft an on-brand public answer from the KB with Gemini, and hand the agent
// a copy-and-go workflow. (If BV ever enables API access, the same drafts can
// be submitted programmatically instead.)

import { retrieveRelevant } from "./retrieval.js";

const { GEMINI_API_KEY } = process.env;
const MODEL = process.env.GEMINI_FLASH_MODEL || "gemini-2.5-flash";

export function isBazaarvoiceAlert(ticket, conversation = []) {
  const from = `${ticket?.customerEmail || ""} ${conversation.map((m) => m.from || "").join(" ")}`;
  return /bazaarvoice\.com/i.test(from) || /bazaarvoice connections/i.test(conversation[0]?.text || "");
}

// Pull the response deep-links (they open the exact question/review in BV).
function responseLinks(html) {
  const seen = new Set();
  for (const m of String(html || "").matchAll(/href=["'](https:\/\/response\.bazaarvoice\.com\/[^"']+)["']/gi)) {
    seen.add(m[1].replace(/&amp;/g, "&"));
  }
  return [...seen];
}

const strip = (h) =>
  String(h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, " ").trim();

// Parse the alert into individual questions / reviews. Works off the HTML,
// which keeps each item in its own block (title/stars, "Published on
// {retailer} • {product}", body, and the response CTA).
export function parseAlert(conversation = []) {
  const msg = conversation[0] || {};
  const html = String(msg.html || "");
  const plain = String(msg.text || "");
  const kind = /Review Alert|New Review/i.test(plain + html)
    ? "review"
    : /Question Alert|New Question/i.test(plain + html)
    ? "question"
    : null;
  if (!kind || !html) return { kind, items: [] };

  // Each item ENDS with its own "Respond to Question/Review" CTA — use those
  // as block delimiters so headers/footers never bleed into an item.
  const ctas = [...html.matchAll(/<a[^>]*href=["'](https:\/\/response\.bazaarvoice\.com\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .filter((m) => /respond to/i.test(strip(m[2])));
  const items = [];
  let from = 0;
  for (const cta of ctas) {
    const block = html.slice(from, cta.index);
    from = cta.index + cta[0].length;
    const pubAt = block.search(/Published on/i);
    if (pubAt === -1) continue;

    const head = block.slice(0, pubAt);
    const tail = block.slice(pubAt);
    const retailer = strip((tail.match(/Published on\s*([^•]*)•/i) || [])[1] || "");
    const product = strip((tail.match(/•[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || "");
    // body: whatever follows the "Published on …" paragraph
    const closeAt = tail.search(/<\/p>/i);
    const body = closeAt === -1 ? "" : strip(tail.slice(closeAt + 4));
    // the item's own heading is the LAST <h3> in the block (earlier ones are
    // the alert header); filled stars render in an orange span
    const hAt = head.toLowerCase().lastIndexOf("<h3");
    const headingHtml = hAt === -1 ? "" : head.slice(hAt);
    const rating = (headingHtml.match(/color:\s*orange[^>]*>([^<]*)</i)?.[1]?.match(/★/g) || []).length || null;
    const title = strip(headingHtml).replace(/★/g, "").trim();

    const text = kind === "review" ? body || title : title || body;
    if (!text || !product) continue;
    items.push({
      type: kind,
      retailer,
      product,
      rating: kind === "review" ? rating : null,
      title: kind === "review" ? title || null : null,
      text,
      link: cta[1].replace(/&amp;/g, "&"),
    });
  }
  return { kind, items };
}

const PROMPT = `You write PUBLIC responses for Stylish International Inc. (brands STYLISH and Sinks Direct) on retailer product pages (Lowe's, Home Depot, Wayfair, Amazon) via Bazaarvoice.

These are seen by every future shopper, so:
- Warm, professional, concise: 2-4 sentences. Plain text only (no HTML, no markdown).
- Answer ONLY from the Knowledge Base excerpts. Never invent dimensions, materials, compatibility, part numbers, prices or availability.
- If the KB doesn't cover it, don't guess: acknowledge the question and invite them to contact Customer Care for the exact detail — never fabricate a spec.
- For a QUESTION: answer it directly and helpfully; mention the relevant part number/spec only if it's in the KB.
- For a REVIEW: thank them genuinely, acknowledge their specific point, and briefly offer the useful fact or next step. Never argue, never blame the customer, never admit a product defect.
- Sign off as "Stylish Customer Care" on its own last line. No links, no email addresses, no phone numbers.

Return JSON: { "reply": string }`;

const SCHEMA = { type: "object", properties: { reply: { type: "string" } }, required: ["reply"] };

export async function draftPublicResponse(item) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
  const query = `${item.product} ${item.text}`;
  const kb = await retrieveRelevant(
    { ticket: { subject: item.product }, conversation: [{ direction: "in", text: item.text }] },
    6
  ).catch(() => []);
  const kbText = kb
    .map((a, i) => `Article ${i + 1} — ${a.title}\n${(a.body || "").slice(0, 1200)}`)
    .join("\n\n---\n\n");

  const user = `Type: ${item.type === "review" ? `customer REVIEW${item.rating ? ` (${item.rating} stars)` : ""}` : "customer QUESTION"}
Retailer: ${item.retailer}
Product: ${item.product}
${item.title ? `Review title: ${item.title}\n` : ""}Customer wrote: ${item.text}

=== KNOWLEDGE BASE ===
${kbText || "(no relevant articles found)"}

Write the public response now.`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: PROMPT }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        maxOutputTokens: 512,
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
  // public responses never carry links
  reply = reply.replace(/https?:\/\/\S+/g, "").replace(/\s{2,}/g, " ").trim();
  return { ...item, draft: reply, kbUsed: kb.map((a) => ({ id: a.id, title: a.title })) };
}

export async function parseAndDraft(conversation) {
  const { kind, items } = parseAlert(conversation);
  if (!items.length) return { kind, items: [] };
  const drafted = await Promise.all(
    items.slice(0, 6).map((it) => draftPublicResponse(it).catch(() => ({ ...it, draft: "", error: true })))
  );
  return { kind, items: drafted };
}
