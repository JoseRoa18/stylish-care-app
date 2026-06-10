// server/routes/tickets.js
import { Router } from "express";
import { listTickets, getConversation, sendReply, updateTicketStatus, zohoConfigured } from "../zoho.js";
import { generateDraft } from "../gemini.js";
import { retrieveRelevant } from "../retrieval.js";
import { touchStatus } from "../tickets-sync.js";
import { recordFeedback } from "../feedback.js";

const router = Router();

// GET /api/tickets — awaiting-response tickets
router.get("/", async (req, res) => {
  if (!zohoConfigured()) {
    return res.json({ configured: false, tickets: [] });
  }
  try {
    const tickets = await listTickets({ limit: Number(req.query.limit) || 25 });
    res.json({ configured: true, tickets, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/tickets/:id/conversation
router.get("/:id/conversation", async (req, res) => {
  try {
    const conversation = await getConversation(req.params.id);
    res.json({ conversation });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/tickets/:id/draft  { ticket }
router.post("/:id/draft", async (req, res) => {
  try {
    const ticket = req.body.ticket;
    if (!ticket) return res.status(400).json({ error: "Missing ticket payload" });
    const conversation = await getConversation(req.params.id);
    // retrieve only the KB articles relevant to this ticket (semantic + fallback)
    const kb = await retrieveRelevant({ ticket, conversation }, 8);
    const result = await generateDraft({ ticket, conversation, kb });
    res.json({
      ...result, // draft, needsHuman, intent, confidence, kbCovered, sensitive, lane, label
      conversation,
      usedKb: kb.map((a) => ({ id: a.id, title: a.title, source: a.source, score: a._score })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/tickets/:id/send  { to, content, contentType?, feedback? }
router.post("/:id/send", async (req, res) => {
  try {
    const { to, content, contentType, feedback } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: "Empty reply" });
    const result = await sendReply(req.params.id, { to, content, contentType });
    // Feedback loop: record how much the agent changed the AI draft. Best-effort
    // — a failure here must never affect the customer-facing send.
    if (feedback?.aiDraft) {
      try {
        await recordFeedback({
          ticket: { id: req.params.id, number: feedback.ticketNumber },
          aiDraft: feedback.aiDraft,
          sentText: content,
          intent: feedback.intent,
          confidence: feedback.confidence,
          lane: feedback.lane,
          sensitive: feedback.sensitive,
          kbCovered: feedback.kbCovered,
          kbUsed: feedback.kbUsed,
        });
      } catch { /* ignore — sending already succeeded */ }
    }
    res.json({ sent: true, result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/tickets/:id/status  { status }
router.post("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!status?.trim()) return res.status(400).json({ error: "Missing status" });
    const result = await updateTicketStatus(req.params.id, status);
    const next = result?.status || status;
    // Mirror it into the synced table so the inbox list stays consistent.
    try { await touchStatus(req.params.id, next); } catch { /* next sync fixes it */ }
    res.json({ ok: true, status: next });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

export default router;
