// server/translate.js
// Translate a batch of texts (e.g. the messages of a ticket) into a target
// language using Gemini. Used so an agent can read a foreign-language ticket
// in English or Spanish. Returns the translations in the same order.

const { GEMINI_API_KEY } = process.env;
const MODEL = process.env.GEMINI_TRANSLATE_MODEL || "gemini-2.5-flash";

function thinkingFor(model) {
  return /^gemini-3/.test(model) ? { thinkingLevel: "low" } : { thinkingBudget: 0 };
}

export async function translateTexts(texts, target = "English") {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set in .env");
  const list = (texts || []).map((t) => String(t ?? ""));
  if (!list.length) return [];

  const prompt = `Translate each item of the following JSON array into ${target}.
Return ONLY a JSON array of the translated strings, in the same order and the same length.
If an item is already in ${target}, return it unchanged. Preserve URLs, model numbers and names verbatim.

${JSON.stringify(list)}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 4096,
          temperature: 0,
          thinkingConfig: thinkingFor(MODEL),
          responseMimeType: "application/json",
          responseSchema: { type: "array", items: { type: "string" } },
        },
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(`Gemini translate error (${res.status}): ${data?.error?.message || "unknown"}`);

  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("");
  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    throw new Error("translation returned malformed JSON");
  }
  // guard: always return one string per input, in order
  return list.map((orig, i) => (typeof arr[i] === "string" ? arr[i] : orig));
}
