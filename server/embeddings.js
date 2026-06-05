// server/embeddings.js
// Semantic embeddings via Google's gemini-embedding-001. Used to retrieve the
// KB articles most relevant to a customer message by MEANING (so "install" ~
// "installation", and verbose marketing text can't keyword-stuff its way to
// the top). Document and query embeddings use the matching task types.

const { GEMINI_API_KEY, GEMINI_EMBED_MODEL } = process.env;
const MODEL = GEMINI_EMBED_MODEL || "gemini-embedding-001";
const DIM = Number(process.env.GEMINI_EMBED_DIM || 768);
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export function embeddingsConfigured() {
  return Boolean(GEMINI_API_KEY);
}

async function call(method, body) {
  const res = await fetch(`${BASE}/${MODEL}:${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Embedding API ${res.status}: ${data?.error?.message || "unknown"}`
    );
  }
  return data;
}

// Embed a single query string (task type tuned for search queries).
export async function embedQuery(text) {
  const data = await call("embedContent", {
    content: { parts: [{ text: text || "" }] },
    taskType: "RETRIEVAL_QUERY",
    outputDimensionality: DIM,
  });
  return normalize(data.embedding?.values || []);
}

// Embed many documents in batches. Returns an array of vectors aligned to
// `texts`. onProgress(done, total) is optional.
export async function embedDocuments(texts, { onProgress, batchSize = 50 } = {}) {
  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize);
    const data = await call("batchEmbedContents", {
      requests: slice.map((t) => ({
        model: `models/${MODEL}`,
        content: { parts: [{ text: t || "" }] },
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: DIM,
      })),
    });
    for (const e of data.embeddings || []) out.push(normalize(e.values || []));
    if (onProgress) onProgress(Math.min(i + batchSize, texts.length), texts.length);
  }
  return out;
}

// L2-normalize so cosine similarity is just a dot product.
function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

// Dot product of two L2-normalized vectors == cosine similarity.
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
