// server/chatbot.js
// Website chat brain: answers Zoho SalesIQ (Zobot webhook) visitor messages
// using the same KB + Gemini the ticket AI uses — tuned for chat (short,
// friendly, plain text) — and escalates to a human operator when it should.
//
// Chat history is kept per-conversation in the shared app_state table so it
// survives serverless instance churn. Sessions expire after ~2h.

import { retrieveRelevant } from "./retrieval.js";
import { supabase } from "./supabase.js";

const { GEMINI_API_KEY } = process.env;
const MODEL = process.env.GEMINI_CHAT_MODEL || process.env.GEMINI_FLASH_MODEL || "gemini-2.5-flash";
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

const CHAT_PROMPT = `You are the website chat assistant for Stylish International Inc. (kitchen & bath: sinks and faucets; brands STYLISH and Sinks Direct; sites stylishkb.com and sinksdirect.ca).

You are chatting LIVE with a website visitor. Style:
- Short and conversational: 1-3 sentences per reply, plain text only (no HTML, no markdown headers). Simple lists with dashes are OK.
- Warm and helpful, never robotic. Reply in the visitor's language (English/French/Spanish).
- Answer ONLY from the Knowledge Base excerpts provided. Never invent products, prices, policies, timelines or availability.
- If a KB article is a video tutorial (source: youtube) that directly helps, you may share its exact URL. Never any other link, and never invent a URL.
- Do not mention the Knowledge Base or that you are an AI unless asked; if asked, be honest that you're an automated assistant.

ESCALATE to a human (set "escalate": true, with a brief handoff reply like "Let me connect you with our team so they can check that for you.") when:
- the visitor asks about a SPECIFIC order, delivery, tracking, invoice or account (you can't look those up)
- refunds, returns of a specific purchase, warranty claims, damage reports, or anything involving money
- the visitor is upset, asks for a human, or the KB doesn't cover their question
- anything legal or a complaint
Otherwise answer normally with "escalate": false.

Return JSON: { "reply": string, "escalate": boolean }`;

const SCHEMA = {
  type: "object",
  properties: { reply: { type: "string" }, escalate: { type: "boolean" } },
  required: ["reply", "escalate"],
};

function thinkingFor(model) {
  return /^gemini-3/.test(model) ? { thinkingLevel: "low" } : { thinkingBudget: 0 };
}

// ── per-conversation history in app_state ────────────────────
async function loadHistory(convId) {
  if (!supabase || !convId) return [];
  try {
    const { data } = await supabase.from("app_state").select("value,updated_at").eq("key", `chat:${convId}`).maybeSingle();
    if (!data?.value?.turns) return [];
    if (Date.now() - new Date(data.updated_at).getTime() > SESSION_TTL_MS) return [];
    return data.value.turns;
  } catch {
    return [];
  }
}
async function saveHistory(convId, turns) {
  if (!supabase || !convId) return;
  try {
    await supabase.from("app_state").upsert({
      key: `chat:${convId}`,
      value: { turns: turns.slice(-12) },
      updated_at: new Date().toISOString(),
    });
  } catch { /* best-effort */ }
}

function kbToText(kb) {
  return kb
    .map((a, i) => {
      const meta = [a.source ? `source: ${a.source}` : null, a.source === "youtube" && a.sourceUrl ? `url: ${a.sourceUrl}` : null]
        .filter(Boolean).join(", ");
      return `Article ${i + 1} — ${a.title}${meta ? ` [${meta}]` : ""}\n${(a.body || "").slice(0, 1200)}`;
    })
    .join("\n\n---\n\n");
}

// Strip any URL the model didn't copy from the retrieved KB (same safety net
// as ticket replies — a hallucinated link must never reach a visitor).
function sanitizeChatLinks(text, kb) {
  const allowed = new Set(kb.filter((a) => a.source === "youtube" && a.sourceUrl).map((a) => a.sourceUrl.trim().toLowerCase()));
  return String(text || "").replace(/https?:\/\/[^\s"'<>)\]]+/gi, (u) =>
    allowed.has(u.replace(/[.,;!?]+$/, "").toLowerCase()) ? u : ""
  ).replace(/\s+([.,;:])/g, "$1");
}

export async function answerVisitorChat({ convId, question, visitorName }) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
  const q = String(question || "").trim().slice(0, 2000);
  if (!q) return { reply: "Hi! How can I help you today?", escalate: false };

  const history = await loadHistory(convId);
  const historyText = history.map((t) => `${t.role === "user" ? "Visitor" : "Assistant"}: ${t.text}`).join("\n");

  // retrieve KB using the question plus recent visitor context
  const recentUser = history.filter((t) => t.role === "user").slice(-2).map((t) => t.text).join(" ");
  const kb = await retrieveRelevant(
    { ticket: { subject: q }, conversation: [{ direction: "in", text: `${recentUser} ${q}` }] },
    6
  ).catch(() => []);

  const userContent = `${visitorName ? `Visitor name: ${visitorName}\n` : ""}${historyText ? `=== CHAT SO FAR ===\n${historyText}\n\n` : ""}=== VISITOR'S NEW MESSAGE ===\n${q}\n\n=== KNOWLEDGE BASE ===\n${kbToText(kb) || "(no relevant articles found)"}\n\nAnswer now as JSON.`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: CHAT_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userContent }] }],
      generationConfig: {
        maxOutputTokens: 512,
        temperature: 0.4,
        thinkingConfig: thinkingFor(MODEL),
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini chat error (${res.status}): ${data?.error?.message || "unknown"}`);
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();

  let parsed;
  try { parsed = JSON.parse(text); }
  catch { parsed = { reply: "Let me connect you with our team so they can help you with that.", escalate: true }; }

  const reply = sanitizeChatLinks(parsed.reply || "", kb).trim() ||
    "Let me connect you with our team so they can help you with that.";
  const escalate = Boolean(parsed.escalate);

  await saveHistory(convId, [...history, { role: "user", text: q }, { role: "bot", text: reply }]);
  return { reply, escalate };
}
