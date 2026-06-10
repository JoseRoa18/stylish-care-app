// server/translate.js
// Translate a batch of texts (e.g. the messages of a ticket) into a target
// language using Gemini. Used so an agent can read a foreign-language ticket
// in English or Spanish. Returns the translations in the same order.

const { GEMINI_API_KEY } = process.env;
const MODEL = process.env.GEMINI_TRANSLATE_MODEL || "gemini-2.5-flash";

function thinkingFor(model) {
  return /^gemini-3/.test(model) ? { thinkingLevel: "low" } : { thinkingBudget: 0 };
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

export async function translateTexts(texts, target = "English") {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set in .env");
  const full = (texts || []).map((t) => String(t ?? ""));
  if (!full.length) return [];
  const list = full.map((t) => (t.length > PER_ITEM ? t.slice(0, PER_ITEM) + "…" : t));

  const prompt = `Translate each item of the following JSON array into ${target}.
Return ONLY a JSON array of the translated strings, in the same order and the same length.
If an item is already in ${target}, return it unchanged. Preserve URLs, model numbers and names verbatim.

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
