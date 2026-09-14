// server/surveys.js
// Post-resolution satisfaction survey: three closed questions, emailed to the
// customer when their ticket is closed, answered in one click from the mail.
//
// Three deliberate constraints:
//  - No free-text box. Every extra field costs responses, and the team already
//    has the ticket thread if they want the story.
//  - The link carries an opaque token, not the ticket id, so a customer can
//    never reach another customer's ticket by editing the URL.
//  - One row per ticket. Closing a ticket twice re-sends nothing; a customer
//    who answers twice updates their answer rather than skewing the average.

import crypto from "node:crypto";
import { supabase } from "./supabase.js";
import { sendReply } from "./zoho.js";

export const QUESTIONS = {
  resolved: { label: "Did we resolve your issue?", options: ["yes", "partly", "no"] },
  satisfaction: { label: "How satisfied are you with the support you received?", stars: 5 },
  speed: { label: "How quickly did we get back to you?", stars: 5 },
};

// Tickets that must never receive a survey: automated mail has no human on the
// other end, and without an address there is nowhere to send it.
function eligible(ticket) {
  if (!ticket) return { ok: false, why: "no ticket" };
  if (String(ticket.id).startsWith("bb:")) return { ok: false, why: "marketplace thread" };
  if (ticket.category === "notification") return { ok: false, why: "automated notification" };
  const email = String(ticket.customer_email || ticket.customerEmail || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, why: "no customer email" };
  if (/^(no-?reply|do-?not-?reply|postmaster|mailer-daemon)@/i.test(email)) return { ok: false, why: "no-reply address" };
  // our own mailboxes — a forwarded ticket carries them as the sender
  if (/@(stylishkb|sinksdirect|sinksdirectusa)\.(com|ca)$/i.test(email)) return { ok: false, why: "internal address" };
  return { ok: true, email };
}

function surveyUrl(token) {
  const base = (process.env.PUBLIC_APP_URL || "https://stylish-care-app.vercel.app").replace(/\/+$/, "");
  return `${base}/survey.html?t=${token}`;
}

function mailHtml({ name, token }) {
  const url = surveyUrl(token);
  const star = (n) =>
    `<a href="${url}&q=satisfaction&v=${n}" style="text-decoration:none;font-size:26px;color:#c8a24a;padding:0 3px">&#9733;</a>`;
  return `<p>Hi${name ? ` ${String(name).split(" ")[0]}` : ""},</p>
<p>We've just wrapped up your case. Would you tell us how we did? It takes one click.</p>
<p style="font-size:15px;margin:18px 0 6px"><strong>How satisfied are you with the support you received?</strong></p>
<p style="margin:0 0 18px">${[1, 2, 3, 4, 5].map(star).join("")}</p>
<p style="font-size:13px;color:#666">Or <a href="${url}">open the short form</a> — three questions, no typing.</p>
<p>Thank you,</p>`;
}

// Create (or find) the survey for a ticket and email it. Returns why it was
// skipped rather than throwing, so closing a ticket never fails over a survey.
export async function sendSurvey(ticket) {
  const check = eligible(ticket);
  if (!check.ok) return { sent: false, skipped: check.why };
  if (!supabase) return { sent: false, skipped: "no database" };

  const { data: existing } = await supabase
    .from("surveys").select("token,sent_at").eq("ticket_id", ticket.id).maybeSingle();
  if (existing) return { sent: false, skipped: "already sent", token: existing.token };

  const token = crypto.randomBytes(18).toString("base64url");
  const name = ticket.customer_name || ticket.customerName || null;
  const { error } = await supabase.from("surveys").insert({
    token,
    ticket_id: ticket.id,
    ticket_number: String(ticket.number || ""),
    customer_email: check.email,
    customer_name: name,
  });
  if (error) return { sent: false, skipped: `db: ${error.message}` };

  try {
    await sendReply(ticket.id, {
      to: check.email,
      content: mailHtml({ name, token }),
      contentType: "html",
    });
    return { sent: true, token };
  } catch (e) {
    // the row stays, so a retry re-uses the same link instead of a second one
    return { sent: false, skipped: `mail: ${e.message}`, token };
  }
}

export async function getSurvey(token) {
  if (!supabase || !token) return null;
  const { data } = await supabase
    .from("surveys")
    .select("token,ticket_number,customer_name,answered_at,resolved,satisfaction,speed")
    .eq("token", token)
    .maybeSingle();
  return data || null;
}

// Record an answer. Partial answers are allowed — a customer who only clicks a
// star from the email still counts, and can finish the rest on the page.
export async function answerSurvey(token, { resolved, satisfaction, speed } = {}) {
  if (!supabase || !token) throw new Error("Missing survey");
  const patch = { answered_at: new Date().toISOString() };
  if (QUESTIONS.resolved.options.includes(resolved)) patch.resolved = resolved;
  const star = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
  };
  if (star(satisfaction)) patch.satisfaction = star(satisfaction);
  if (star(speed)) patch.speed = star(speed);
  if (Object.keys(patch).length === 1) throw new Error("Nothing to record");

  const { data, error } = await supabase
    .from("surveys").update(patch).eq("token", token).select("token").maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Survey not found");
  return { ok: true };
}

export async function surveyMetrics(days = 90) {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("survey_metrics", { num_days: days });
  if (error) return null; // migration not run yet
  return data;
}
