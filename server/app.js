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
import { listTickets, zohoConfigured } from "./zoho.js";
import { listManuals, dropboxConfigured } from "./dropbox.js";
import { sourceCounts } from "./kb.js";
import { geminiConfigured } from "./gemini.js";
import { supabase } from "./supabase.js";
import { syncRecent } from "./tickets-sync.js";

const INBOX_STATUSES = (process.env.ZOHO_INBOX_STATUSES ||
  "Open,On Hold,Escalated,Closed")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ── short-lived ticket cache (replaces the old setInterval poll) ──
const TTL = Number(process.env.TICKET_CACHE_TTL_MS || 25000);
let _cache = { data: [], at: 0, error: null };

async function getTickets() {
  if (_cache.at && Date.now() - _cache.at < TTL) return _cache;
  if (!zohoConfigured()) return { data: [], at: Date.now(), error: null };
  try {
    const data = await listTickets({ limit: 60, statuses: INBOX_STATUSES });
    _cache = { data, at: Date.now(), error: null };
  } catch (err) {
    _cache = { data: _cache.data, at: Date.now(), error: err.message };
  }
  return _cache;
}

// Keep the synced tickets table fresh on use. Awaited (not fire-and-forget)
// because serverless kills background work after the response — but throttled
// so it only actually syncs once every couple of minutes.
let _lastSync = 0;
async function maybeSync() {
  if (Date.now() - _lastSync < 120000) return;
  _lastSync = Date.now();
  try {
    await syncRecent();
  } catch {
    /* ignore — dashboard still renders from the last sync */
  }
}

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.use("/api/tickets", ticketsRouter);
  app.use("/api/kb", kbRouter);
  app.use("/api/translate", translateRouter);

  app.get("/api/inbox", async (_req, res) => {
    const c = await getTickets();
    res.json({
      configured: zohoConfigured(),
      tickets: c.data,
      fetchedAt: c.at ? new Date(c.at).toISOString() : null,
      error: c.error,
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
