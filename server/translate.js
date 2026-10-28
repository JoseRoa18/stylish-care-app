// server/translate.js
// Translate emails with Gemini so an agent can read a foreign-language ticket
// in English or Spanish, and send a reply in the customer's language.
// translateSegments is the one the app uses: the client sends the email's
// text in segments (formatting as numbered placeholders) and rebuilds the
// HTML itself, so the model never writes markup.

const { GEMINI_API_KEY } = process.env;
const MODEL = process.env.GEMINI_TRANSLATE_MODEL || "gemini-2.5-flash";

export const TRANSLATE_TARGETS = new Set(["English", "Spanish", "French"]);

function thinkingFor(model) {
  return /^gemini-3/.test(model) ? { thinkingLevel: "low" } : { thinkingBudget: 0 };
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

const LANG_CODE = { English: "en", Spanish: "es", French: "fr" };
const PLACEHOLDER = /<\/?g\d+>|<i\d+\s*\/>|<br\s*\/?>/gi;
const norm = (s) => s.replace(/\s+/g, " ").trim();
const wordCount = (s) => (s.replace(PLACEHOLDER, " ").match(/\p{L}{2,}/gu) || []).length;

// Output budget from the input: a translation is about as long as its source,
// so twice the input's tokens is plenty. A model that loops (on filler it
// echoes back) then stops in a few seconds instead of running to 8192 tokens
// (~30 s, holding one of the client's request slots all that time).
function outputBudget(items) {
  const s = JSON.stringify(items);
  const ascii = s.replace(/[^\x00-\x7f]/g, "").length;
  const tokens = ascii / 3 + (s.length - ascii); // worse than 3 chars a token outside ASCII
  return Math.min(8192, Math.ceil(512 + 2 * tokens + 16 * items.length));
}

async function askGemini(items, target, { alone = false } = {}) {
  const code = LANG_CODE[target];
  const context = alone
    ? `Each item is a separate text: translate each one on its own.`
    : `The items are consecutive fragments of ONE email, in reading order — use them as context for each other. Fragments can be in different languages (for example an English form or chat template with the customer's own words in French): every fragment that is not written in ${target} must be translated — form answers, chat messages and the customer's own words included. Only a fragment already written in ${target} stays unchanged.`;
  const prompt = `Translate the text of each item into ${target}. ${context} Each item has an "id" and a text "t". Return a JSON array with exactly one {"id","t","lang"} object per input id, where "lang" is the ISO 639-1 code of the language the item is written in ("${code}" when it is already in ${target}, or holds nothing to translate: only names, codes, numbers or addresses). Markup rules — <gN>…</gN> wraps formatted text (bold, link, colour…). Keep every pair, with the same N, around the translated words it belongs to; you may move it to fit the grammar. Never invent new N values. <iN/> is an image and <br/> a line break; keep each one, in the matching position. Do not add any other markup, quotes, notes or explanations. &lt; and &amp; are literal characters of the text; keep them as written. Keep URLs, email addresses, phone numbers, model numbers, order numbers, promo codes and people's names exactly as written.

${JSON.stringify(items)}`;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: outputBudget(items),
          temperature: 0,
          thinkingConfig: thinkingFor(MODEL),
          responseMimeType: "application/json",
          responseSchema: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "integer" }, t: { type: "string" }, lang: { type: "string" } },
              required: ["id", "t", "lang"],
            },
          },
        },
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw httpError(res.status, `Gemini translate error (${res.status}): ${data?.error?.message || "unknown"}`);
  const cand = data?.candidates?.[0];
  // MAX_TOKENS / SAFETY / RECITATION → a cut or empty answer, not a translation.
  // .code MAX_TOKENS tells the client to split the request and try again.
  if (cand?.finishReason !== "STOP") {
    const why = cand?.finishReason || data?.promptFeedback?.blockReason || "no answer";
    throw Object.assign(httpError(502, `Translation stopped early (${why})`), { code: why === "MAX_TOKENS" ? why : undefined });
  }
  const arr = salvageArray((cand.content?.parts || []).map((p) => p.text || "").join(""));
  if (!Array.isArray(arr)) throw httpError(502, "Translation came back unreadable");
  const wanted = new Set(items.map((it) => it.id));
  const out = {};
  for (const x of arr) {
    if (x && wanted.has(x.id) && typeof x.t === "string")
      out[x.id] = { t: x.t, lang: String(x.lang || "").slice(0, 2).toLowerCase() };
  }
  return out;
}

// items: [{ id, t }] — consecutive fragments of ONE email, in reading order.
// Returns { [id]: translated t } for the ids that came back. Throws (with
// .status; Gemini's 429 is kept so the client can back off) instead of
// quietly returning the originals as if they were a translation.
export async function translateSegments(items, target) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set in .env");
  if (!TRANSLATE_TARGETS.has(target)) throw httpError(400, `Unsupported target language: ${target}`);
  const code = LANG_CODE[target];
  const got = await askGemini(items, target);
  // In a mixed email (an English form around the customer's French words) the
  // model can hand a fragment back untranslated. Those (a few words or more,
  // unchanged, in another language) are asked again on their own; one still
  // unchanged is left out, so the client shows "Partly translated · Retry"
  // instead of passing the original off as a translation.
  const missed = items.filter(({ id, t }) => {
    const g = got[id];
    return g && g.lang && g.lang !== code && norm(g.t) === norm(t) && wordCount(t) >= 2;
  });
  if (missed.length) {
    const again = await askGemini(missed, target, { alone: true }).catch(() => ({}));
    for (const { id, t } of missed) {
      const g = again[id];
      if (g && norm(g.t) !== norm(t)) got[id] = g;
      else if (!(g && g.lang === code)) delete got[id];
    }
  }
  const out = {};
  for (const [id, g] of Object.entries(got)) out[id] = g.t;
  return out;
}

// Cap each message so a giant quoted/spam chain can't blow past the output
// budget (which truncates the JSON and breaks the whole batch).
const PER_ITEM = Number(process.env.TRANSLATE_MAX_CHARS || 2500);

// Salvage a JSON array from a response that has extra prose or got truncated.
function salvageArray(text) {
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }
  const s = text.indexOf("[");
  const e = text.lastIndexOf("]");
  if (s !== -1 && e > s) {
    try {
      return JSON.parse(text.slice(s, e + 1));
    } catch {
      /* give up */
    }
  }
  return null;
}

// DEPRECATED — the draft translator now uses translateSegments. Kept for one
// deploy so tabs still running the old bundle keep working; then delete it
// with POST /api/translate/html.
// Translate the VISIBLE text of an HTML email into `target`, keeping the tags
// and structure intact. Used to translate a drafted reply before sending.
export async function translateHtml(html, target = "Spanish") {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set in .env");
  const src = String(html || "");
  if (!src.trim()) return "";
  const prompt = `Translate the visible text of this HTML email into ${target}.
Rules:
- Keep ALL HTML tags, structure and attributes EXACTLY; translate only the human-readable text between tags.
- Preserve URLs, email addresses, product/model numbers, names and promo codes verbatim.
- Output ONLY the translated HTML — no explanations, no markdown code fences.

${src.slice(0, 9000)}`;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.2, thinkingConfig: thinkingFor(MODEL) },
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini translate error (${res.status}): ${data?.error?.message || "unknown"}`);
  const out = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  // strip a stray ```html ... ``` fence if the model added one
  return out.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim() || src;
}

// DEPRECATED — the conversation view now uses translateSegments. Kept for one
// deploy so tabs still running the old bundle keep working; then delete it
// with POST /api/translate.
export async function translateTexts(texts, target = "English") {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set in .env");
  const full = (texts || []).map((t) => String(t ?? ""));
  if (!full.length) return [];
  const list = full.map((t) => (t.length > PER_ITEM ? t.slice(0, PER_ITEM) + "…" : t));

  const prompt = `Translate each item of the following JSON array into ${target}.
Return ONLY a JSON array of the translated strings, in the same order and the same length.
Rules:
- If an item is already in ${target}, return it unchanged.
- Preserve URLs, email addresses, model numbers, order numbers and names verbatim.
- CRITICAL: keep each item's internal structure EXACTLY — every line break (\\n) stays where it is, paragraphs stay separate, list items stay on their own lines, greetings and signatures stay on their own lines. Translate the words only; never reflow, merge or reorder lines.

${JSON.stringify(list)}`;

  let data;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 8192,
            temperature: 0,
            thinkingConfig: thinkingFor(MODEL),
            responseMimeType: "application/json",
            responseSchema: { type: "array", items: { type: "string" } },
          },
        }),
      }
    );
    data = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(`Gemini translate error (${res.status}): ${data?.error?.message || "unknown"}`);
  } catch (err) {
    // network/HTTP problem → best-effort: show originals rather than an error
    return full;
  }

  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("");
  const arr = salvageArray(text);
  // Best-effort: if parsing still fails (e.g. truncated), fall back to the
  // original text for any item we couldn't translate — never throw.
  if (!Array.isArray(arr)) return full;
  return full.map((orig, i) => (typeof arr[i] === "string" ? arr[i] : orig));
}
