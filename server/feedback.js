// server/feedback.js
// The "feedback loop": every time an agent sends an AI-assisted reply, record
// how much they changed the draft. That diff is the signal for where the AI is
// trusted vs rewritten — used to measure quality and to surface KB gaps.
//
// Storage is deliberately light: we always keep the small metrics, but only
// keep the full draft + sent text when the reply was actually edited (the cases
// worth learning from). Sent-as-is rows are tiny.

import { supabase } from "./supabase.js";

function htmlToPlain(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// Levenshtein distance, two-row DP, capped so a huge paste can't blow up CPU.
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1);
    cur[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

// 0 = identical, 1 = fully rewritten. Compares plain text (formatting-only
// tweaks like bolding don't count as a rewrite).
export function editRatio(aiHtml, sentHtml) {
  const a = htmlToPlain(aiHtml).slice(0, 4000);
  const b = htmlToPlain(sentHtml).slice(0, 4000);
  if (!a && !b) return 0;
  const dist = levenshtein(a, b);
  return Math.min(1, dist / Math.max(a.length, b.length, 1));
}

export function classify(ratio) {
  if (ratio < 0.05) return "as_is";
  if (ratio < 0.3) return "light";
  return "heavy";
}

// Best-effort: callers wrap in try/catch so a failure never blocks the send.
export async function recordFeedback({
  ticket, aiDraft, sentText, intent, confidence, lane, sensitive, kbCovered, kbUsed,
}) {
  if (!supabase || !aiDraft) return null;
  const ratio = editRatio(aiDraft, sentText);
  const cls = classify(ratio);
  const keepText = cls !== "as_is"; // only store full texts for edited replies
  const row = {
    ticket_id: ticket?.id || null,
    ticket_number: ticket?.number != null ? String(ticket.number) : null,
    intent: intent || null,
    confidence: confidence || null,
    lane: lane || null,
    sensitive: Boolean(sensitive),
    kb_covered: Boolean(kbCovered),
    kb_used: Array.isArray(kbUsed) ? kbUsed.slice(0, 12) : [],
    ai_chars: htmlToPlain(aiDraft).length,
    sent_chars: htmlToPlain(sentText).length,
    edit_ratio: Number(ratio.toFixed(4)),
    edit_class: cls,
    ai_draft: keepText ? aiDraft : null,
    sent_text: keepText ? sentText : null,
  };
  const { error } = await supabase.from("reply_feedback").insert(row);
  if (error) throw new Error(error.message);
  return { editClass: cls, editRatio: row.edit_ratio };
}

export async function feedbackMetrics(days = 90) {
  if (!supabase) return { total: 0 };
  // Degrade gracefully if the table/RPC isn't created yet (run feedback.sql) —
  // the dashboard then just shows the empty state instead of erroring.
  const { data, error } = await supabase.rpc("reply_feedback_metrics", { num_days: days });
  if (error) return { total: 0, pending: true };
  return data || { total: 0 };
}
