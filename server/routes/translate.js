// server/routes/translate.js
import { Router } from "express";
import { translateTexts, translateHtml } from "../translate.js";

const router = Router();

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
