// server/app.js
// Builds the Express app with all API routes. Used by BOTH the local server
// (server/index.js, which adds static hosting + listen) and the Vercel
// serverless function (api/index.js, which just exports this app).
//
// There is NO background polling here (serverless has no always-on process).
// Instead a short-lived in-memory TTL cache de-dupes Zoho fetches across
// requests on a warm instance; the first request after the TTL refreshes it.

import express from "express";
import cors from "cors";

import ticketsRouter from "./routes/tickets.js";
import kbRouter from "./routes/kb.js";
import translateRouter from "./routes/translate.js";
import { zohoConfigured } from "./zoho.js";
import { listManuals, dropboxConfigured } from "./dropbox.js";
import { sourceCounts } from "./kb.js";
import { geminiConfigured } from "./gemini.js";
import { supabase } from "./supabase.js";
import { maybeSync, queryTickets, ticketCounts } from "./tickets-sync.js";
import {
  authEnabled,
  checkPassword,
  isAuthed,
  requireAuth,
  setSessionCookie,
  clearSessionCookie,
} from "./auth.js";

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  // ── auth (shared team password) ──────────────────────────────
  // Public endpoints first, then everything under /api requires a session.
  app.post("/api/login", (req, res) => {
    if (!authEnabled()) return res.json({ ok: true }); // gate disabled
    if (checkPassword(req.body?.password)) {
      setSessionCookie(req, res);
      return res.json({ ok: true });
    }
    res.status(401).json({ error: "Incorrect password" });
  });

  app.post("/api/logout", (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get("/api/me", (req, res) =>
    res.json({ authed: isAuthed(req), authEnabled: authEnabled() })
  );

  app.get("/api/health", (_req, res) =>
    res.json({
      ok: true,
      zoho: zohoConfigured(),
      dropbox: dropboxConfigured(),
      gemini: geminiConfigured(),
    })
  );

  // Everything below this line needs a valid session.
  app.use("/api", requireAuth);

  app.use("/api/tickets", ticketsRouter);
  app.use("/api/kb", kbRouter);
  app.use("/api/translate", translateRouter);

  // Inbox now reads the FULL synced history from Supabase (server-side filter,
  // search and pagination), not a capped live Zoho fetch. Per-ticket actions
  // (conversation, draft, send, status) still go live to Zoho by id.
  app.get("/api/inbox", async (req, res) => {
    const view = req.query.view || "active";
    const q = req.query.q || "";
    const sort = req.query.sort || "updated";
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || 50));

    // Refresh from Zoho but NEVER let a sync hiccup break the list — the inbox
    // is served entirely from Supabase. A failed sync is a soft warning.
    let syncError = null;
    try { await maybeSync(); } catch (e) { syncError = e.message; }

    // Tickets and counts are fetched independently so one failing never blanks
    // the other (e.g. the status chips must not vanish on a transient error).
    let tickets = [], total = 0;
    let counts = { all: 0, active: 0, closed: 0, byStatus: {} };
    let error = null;
    try {
      const r = await queryTickets({ view, q, page, pageSize, sort });
      tickets = r.tickets; total = r.total;
    } catch (e) { error = e.message; }
    try { counts = await ticketCounts(); } catch (e) { error = error || e.message; }

    res.json({
      configured: zohoConfigured(),
      tickets, total, page, pageSize, counts,
      fetchedAt: new Date().toISOString(),
      error,
      syncWarning: syncError, // surfaced softly; data still shows
    });
  });

  app.get("/api/dashboard", async (_req, res) => {
    try {
      await maybeSync(); // keep the tickets table fresh (throttled to ~2 min)
      const [kb, metrics, byStatusRows, byChannelRows, perDayRows] = await Promise.all([
        sourceCounts(),
        supabase.rpc("ticket_metrics"),
        supabase.rpc("tickets_by_status"),
        supabase.rpc("tickets_by_channel"),
        supabase.rpc("tickets_per_day", { num_days: 7 }),
      ]);
      const m = metrics.data || {};
      const round = (x) => (x != null ? Math.round(Number(x)) : null);
      const byStatus = Object.fromEntries(
        (byStatusRows.data || []).map((r) => [r.status, Number(r.count)])
      );
      const byChannel = Object.fromEntries(
        (byChannelRows.data || []).map((r) => [r.channel, Number(r.count)])
      );
      const perDay = (perDayRows.data || []).map((r) => ({
        label: new Date(r.day + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        count: Number(r.count),
      }));

      res.json({
        zoho: zohoConfigured(),
        dropbox: dropboxConfigured(),
        gemini: geminiConfigured(),
        kbArticles: kb.total,
        total: m.total || 0,
        active: m.active || 0,
        closed: m.closed || 0,
        byStatus,
        byChannel,
        avgWaitMs: round(m.avgWaitMs),
        oldestWaitMs: round(m.oldestWaitMs),
        avgResolutionMs: round(m.avgResolutionMs),
        resolvedSample: m.resolvedSample || 0,
        perDay,
        lastFetch: new Date().toISOString(),
        error: null,
      });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get("/api/dropbox/manuals", async (_req, res) => {
    try {
      res.json(await listManuals());
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return app;
}
