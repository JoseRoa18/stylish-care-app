// server/gemini.js
// Generates a customer-care reply grounded in the approved Knowledge Base AND
// triages the ticket (intent / confidence / coverage / sensitivity), using
// Google's Gemini API with structured JSON output. Nothing is auto-sent — a
// human always approves; the triage just tells them how much care it needs.

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
- SIGN-OFF: if a specific agent has already replied in this thread (their name appears in an earlier reply or its signature, e.g. "Eddy V."), close with THAT SAME name to keep continuity — e.g. "Regards, Eddy V. — Customer Care, Stylish International Inc." A B2B customer trusts continuing with the same person more than a generic mailbox. Only when NO agent name is established anywhere in the thread, sign off generically as "Stylish Customer Care".
- Vary your wording; never reuse the same stock sentences across replies.

ACCURACY (never sacrifice this for tone):
- Use ONLY facts present in the Knowledge Base or already stated earlier in the thread. Never invent policy, prices, timelines, outcomes, specifications, materials, or part details.
- Articles tagged "source: zoho-template" are EXAMPLE replies the team has used for similar situations. Treat them as REFERENCE for tone, policy and structure — do NOT copy them word-for-word. Adapt the wording to THIS customer and their specific details, and combine information from several articles when it helps. Fill in specifics (order numbers, names, amounts) only when you actually have them.
- Articles tagged "source: resolved-ticket" are generalized summaries of how the team actually handled similar PAST cases ("Situation … / How we resolved it …"). Use them as REFERENCE for the right approach, policy and tone for this kind of case — never copy them, and never assume this customer's specifics match the past case (the summaries are anonymized and carry no real names, orders or amounts).
- Do NOT assert regulatory or compliance claims (e.g. "lead-free", NSF/ANSI, cUPC, certifications) unless those exact claims appear in the Knowledge Base. If a customer asks about them and the KB doesn't confirm, treat it as not covered and escalate.
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

export async function generateDraft({ ticket, conversation, kb }) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set in .env");
  }

  const userContent = `Customer: ${ticket.customerName} <${ticket.customerEmail}>
Subject: ${ticket.subject}
Channel: ${ticket.channel || "Email"}

=== CONVERSATION (oldest first) ===
${conversationToText(conversation)}

=== APPROVED KNOWLEDGE BASE ===
${kbToText(kb)}

Write the reply and triage the ticket now.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY,
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userContent }] }],
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
