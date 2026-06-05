// server/routes/translate.js
import { Router } from "express";
import { translateTexts } from "../translate.js";

const router = Router();

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
