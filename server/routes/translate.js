// server/routes/translate.js
import { Router } from "express";
import { translateTexts, translateHtml, translateSegments, TRANSLATE_TARGETS } from "../translate.js";

const router = Router();

// POST /api/translate/segments  { segments: [{ id, t }], target }
// The email translator (conversation view and reply draft): text segments with
// numbered placeholder tags, never HTML — the client rebuilds the markup.
router.post("/segments", async (req, res) => {
  const { segments, target } = req.body || {};
  if (!TRANSLATE_TARGETS.has(target))
    return res.status(400).json({ error: "target must be English, Spanish or French" });
  if (!Array.isArray(segments) || !segments.length || segments.length > 300)
    return res.status(400).json({ error: "segments must be an array of 1-300 items" });
  const seen = new Set();
  let chars = 0;
  for (const s of segments) {
    if (!s || !Number.isInteger(s.id) || s.id < 0 || seen.has(s.id) || typeof s.t !== "string")
      return res.status(400).json({ error: "each segment needs a unique integer id and a text t" });
    seen.add(s.id);
    chars += s.t.length;
  }
  if (chars > 20000) return res.status(413).json({ error: "Too much text in one request" });
  try {
    const translations = await translateSegments(segments.map(({ id, t }) => ({ id, t })), target);
    res.json({ translations });
  } catch (err) {
    // keep Gemini's 429 so the client can back off and retry once, and
    // MAX_TOKENS so it can split the request
    res.status(err.status === 429 ? 429 : 502).json({ error: err.message, code: err.code });
  }
});

// DEPRECATED (old bundle only) — remove next deploy along with translateHtml.
// POST /api/translate/html  { html, target } — translate a drafted reply,
// keeping its HTML formatting.
router.post("/html", async (req, res) => {
  try {
    const { html, target } = req.body;
    res.json({ html: await translateHtml(html || "", target || "Spanish") });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// DEPRECATED (old bundle only) — remove next deploy along with translateTexts.
// POST /api/translate  { texts: string[], target: "English" | "Spanish" }
router.post("/", async (req, res) => {
  try {
    const { texts, target } = req.body;
    if (!Array.isArray(texts))
      return res.status(400).json({ error: "texts must be an array" });
    const translations = await translateTexts(texts, target || "English");
    res.json({ translations });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

export default router;
