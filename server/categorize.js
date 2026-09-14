// server/categorize.js
// Labels each ticket with WHAT went wrong, so the dashboard can report which
// problems actually drive volume instead of just which channel they arrived on.
//
// The taxonomy is deliberately fixed and small: a free-form label per ticket
// would never group into a usable chart. It came out of reading two months of
// real subjects — `notification` exists because ~39% of the inbox is automated
// mail (back-in-stock, RA numbers, marketing) that is not a customer issue.

import { supabase } from "./supabase.js";

const { GEMINI_API_KEY } = process.env;
const MODEL = process.env.GEMINI_FLASH_MODEL || "gemini-2.5-flash";

export const CATEGORIES = {
  shipping: "Shipping & delivery",
  defective: "Defective product",
  missing_parts: "Missing parts",
  packaging: "Packaging / wrong item",
  parts_warranty: "Spare part & warranty",
  return_refund: "Return & refund",
  product_question: "Product question",
  billing_order: "Billing & order",
  notification: "Automated notification",
  other: "Other",
};

export const CATEGORY_KEYS = Object.keys(CATEGORIES);

// Automated mail is the bulk of the volume and is perfectly recognisable from
// the subject alone. Matching it here keeps it out of the model entirely —
// cheaper, faster, and it can't be mislabelled as a real issue.
const AUTOMATED = [
  /back in stock request/i,
  /you got a new review/i,
  /stylish alert/i,
  /contacts form got/i,
  /return shipment notification/i,
  /ra number notification/i,
  /is now cancelled/i,
  /new submission/i,
  /^review stylish/i,            // our own outbound "please leave a review" mail
  /reviews rejected/i,
  /question posted by customer/i, // Bazaarvoice alert
  /out of office|automatic reply|undeliverable|delivery has failed/i,
  /unsubscribe|newsletter|webinar|black friday|busy season|best discounts/i,
];

export function quickCategory(subject) {
  const s = String(subject || "");
  return AUTOMATED.some((re) => re.test(s)) ? "notification" : null;
}

export function geminiReady() {
  return Boolean(GEMINI_API_KEY);
}

const PROMPT = `You classify customer-care tickets for Stylish International Inc. (kitchen & bath sinks and faucets; brands STYLISH and Sinks Direct), sold direct and through marketplaces (Amazon, Wayfair, Home Depot, RONA, Lowe's, Best Buy, Walmart).

For EACH ticket you are given, choose exactly ONE category id describing WHAT the issue is:

- shipping — late, lost, stuck or undelivered orders; delivery scheduling; damage that happened in transit; tracking questions
- defective — the product itself is faulty, leaking, scratched or broken out of the box
- missing_parts — the order arrived but something is missing from it (a strainer, grid, hardware, one item of several)
- packaging — the wrong item was sent, or it was packed incorrectly
- parts_warranty — asking for a spare/replacement part, or making a warranty claim
- return_refund — returns, RA numbers, exchanges, refunds, cancellations requested by the customer
- product_question — pre-sale or how-to questions: dimensions, compatibility, finish, installation, cleaning, availability
- billing_order — invoices, payment, pricing, purchase orders, changing or confirming order details
- notification — automated system mail or marketing, NOT a person with a problem
- other — a real message that fits none of the above

Rules:
- Judge by what the CUSTOMER needs, not by who sent it.
- If a ticket mentions several things, pick the primary reason they wrote.
- When a ticket is too vague to tell (e.g. just "Hello" or a bare part number), use "other". Do not guess.
- Return one entry for every ticket id you were given, and use only the ids listed.`;

const SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          category: { type: "string", enum: CATEGORY_KEYS },
        },
        required: ["id", "category"],
      },
    },
  },
  required: ["results"],
};

async function classifyBatch(items) {
  const lines = items.map(
    (t) => `id: ${t.id}\nsubject: ${String(t.subject || "(none)").slice(0, 180)}${
      t.text ? `\nmessage: ${String(t.text).replace(/\s+/g, " ").slice(0, 400)}` : ""
    }`
  );
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: PROMPT }] },
        contents: [{ role: "user", parts: [{ text: `TICKETS:\n\n${lines.join("\n\n")}` }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 4096,
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini categorize error (${res.status}): ${data?.error?.message || "unknown"}`);
  const raw = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Gemini returned a non-JSON categorisation");
  }
  const out = new Map();
  const wanted = new Set(items.map((t) => String(t.id)));
  for (const r of parsed?.results || []) {
    const id = String(r?.id || "");
    // the model occasionally echoes an id that wasn't asked for — drop those
    // rather than writing a category onto the wrong ticket
    if (wanted.has(id) && CATEGORIES[r?.category]) out.set(id, r.category);
  }
  return out;
}

// Categorise a list of {id, subject, text?}. Obvious automated mail is matched
// locally; the rest goes to Gemini in batches. Returns Map(id → category).
export async function categorizeTickets(tickets, { batchSize = 25 } = {}) {
  const result = new Map();
  const needsModel = [];
  for (const t of tickets || []) {
    const quick = quickCategory(t.subject);
    if (quick) result.set(String(t.id), quick);
    else needsModel.push(t);
  }
  if (needsModel.length && !geminiReady()) return result; // leave the rest unlabelled
  for (let i = 0; i < needsModel.length; i += batchSize) {
    const chunk = needsModel.slice(i, i + batchSize);
    try {
      for (const [id, cat] of await classifyBatch(chunk)) result.set(id, cat);
    } catch {
      // a failed batch just stays uncategorised — it gets picked up next pass
    }
  }
  return result;
}

async function writeCategories(map) {
  const now = new Date().toISOString();
  let written = 0;
  for (const [id, category] of map) {
    const { error } = await supabase
      .from("tickets")
      .update({ category, category_at: now })
      .eq("id", id);
    if (!error) written++;
  }
  return written;
}

// Label tickets that have no category yet. Safe to call repeatedly — it is how
// newly synced tickets get their category, a few at a time, without slowing
// the sync itself down.
export async function categorizePending({ limit = 60 } = {}) {
  if (!supabase) return 0;
  const { data, error } = await supabase
    .from("tickets")
    .select("id,subject")
    .is("category", null)
    .order("created_time", { ascending: false })
    .limit(limit);
  if (error || !data?.length) return 0;
  return writeCategories(await categorizeTickets(data));
}

export { writeCategories };
