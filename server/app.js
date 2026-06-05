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

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.use("/api/tickets", ticketsRouter);
  app.use("/api/kb", kbRouter);
  app.use("/api/translate", translateRouter);

  // Inbox now reads the FULL synced history from Supabase (server-side filter,
  // search and pagination), not a capped live Zoho fetch. Per-ticket actions
  // (conversation, draft, send, status) still go live to Zoho by id.
  app.get("/api/inbox", async (req, res) => {
    try {
      await maybeSync(); // keep the table fresh during normal use (throttled)
      const view = req.query.view || "active";
      const q = req.query.q || "";
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || 50));
      const [{ tickets, total }, counts] = await Promise.all([
        queryTickets({ view, q, page, pageSize }),
        ticketCounts(),
      ]);
      res.json({
        configured: zohoConfigured(),
        tickets,
        total,
        page,
        pageSize,
        counts,
        fetchedAt: new Date().toISOString(),
        error: null,
      });
    } catch (err) {
      res.status(502).json({ configured: zohoConfigured(), tickets: [], error: err.message });
    }
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

  app.get("/api/health", (_req, res) =>
    res.json({
      ok: true,
      zoho: zohoConfigured(),
      dropbox: dropboxConfigured(),
      gemini: geminiConfigured(),
    })
  );

  return app;
}
