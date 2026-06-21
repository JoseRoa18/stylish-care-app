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
import { feedbackMetrics } from "./feedback.js";
import { wixConfigured, searchOrdersByEmail, searchProducts } from "./wix.js";
import { shipstationConfigured, lookupOrder } from "./shipstation.js";
import {
  authEnabled,
  checkPassword,
  isAuthed,
  requireAuth,
  setSessionCookie,
  clearSessionCookie,
} from "./auth.js";

// Monday (UTC) of the week containing `d`.
function weekStartUTC(d) {
  const dt = new Date(d);
  const dow = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - dow);
  dt.setUTCHours(0, 0, 0, 0);
  return dt;
}

// Average resolution time bucketed by the week a ticket was CLOSED, last N weeks.
function weeklyResolution(rows, weeks) {
  const now = Date.now();
  const buckets = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const ws = weekStartUTC(new Date(now - i * 7 * 86400000));
    buckets.push({ start: ws, key: ws.toISOString().slice(0, 10), sum: 0, n: 0 });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const r of rows) {
    if (!r.closed_time || !r.created_time) continue;
    const b = byKey.get(weekStartUTC(r.closed_time).toISOString().slice(0, 10));
    if (!b) continue;
    const ms = new Date(r.closed_time) - new Date(r.created_time);
    if (ms >= 0) { b.sum += ms; b.n += 1; }
  }
  return buckets.map((b) => ({
    label: b.start.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    avgMs: b.n ? Math.round(b.sum / b.n) : null,
    count: b.n,
  }));
}

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
      wix: wixConfigured(),
      shipstation: shipstationConfigured(),
    })
  );

  // Daily keep-alive (Vercel cron) — runs a tiny DB query so the free Supabase
  // project never pauses after 7 idle days, and piggybacks a sync+reconcile so
  // the tickets table stays fresh even on days nobody opens the app. Public so
  // the cron can reach it; if CRON_SECRET is set, Vercel's Bearer is required.
  app.get("/api/cron/keepalive", async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== `Bearer ${secret}`) {
      return res.status(401).json({ error: "unauthorized" });
    }
    try {
      const { count, error } = await supabase
        .from("tickets")
        .select("*", { count: "exact", head: true });
      if (error) throw new Error(error.message);
      try { await maybeSync(0); } catch { /* keepalive still counts as alive */ }
      res.json({ ok: true, pinged: "tickets", count: count ?? null, at: new Date().toISOString() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

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
      const [kb, metrics, byStatusRows, byChannelRows, perDayRows, openWaitRows] = await Promise.all([
        sourceCounts(),
        supabase.rpc("ticket_metrics"),
        supabase.rpc("tickets_by_status"),
        supabase.rpc("tickets_by_channel"),
        supabase.rpc("tickets_per_day", { num_days: 7 }),
        // wait times for open-TYPE tickets only — Awaiting Response means the
        // ball is in the CUSTOMER's court, so it doesn't belong in "avg wait"
        supabase.from("tickets").select("customer_response_time").in("status", ["Open", "Escalated"]),
      ]);
      const m = metrics.data || {};
      const round = (x) => (x != null ? Math.round(Number(x)) : null);
      const byStatus = Object.fromEntries(
        (byStatusRows.data || []).map((r) => [r.status, Number(r.count)])
      );
      const byChannel = Object.fromEntries(
        (byChannelRows.data || []).map((r) => [r.channel, Number(r.count)])
      );
      // What Zoho's "Open Tickets" view counts: open-TYPE statuses (Open +
      // Escalated). Awaiting Response / Wayfair / Pending Return are
      // on-hold-type there, so they don't belong in the headline number.
      const openNow = Object.entries(byStatus)
        .filter(([s]) => /^(open|escalated)$/i.test(s))
        .reduce((n, [, c]) => n + c, 0);
      const waits = (openWaitRows.data || [])
        .filter((r) => r.customer_response_time)
        .map((r) => Date.now() - new Date(r.customer_response_time).getTime())
        .filter((ms) => ms >= 0);
      const openAvgWaitMs = waits.length ? waits.reduce((s, x) => s + x, 0) / waits.length : null;
      const openOldestWaitMs = waits.length ? Math.max(...waits) : null;
      const perDay = (perDayRows.data || []).map((r) => ({
        label: new Date(r.day + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        count: Number(r.count),
      }));

      // weekly avg resolution (last 8 weeks) — computed in JS, no migration
      const weeksBack = 8;
      const since = new Date(Date.now() - weeksBack * 7 * 86400000).toISOString();
      const { data: resRows } = await supabase
        .from("tickets")
        .select("created_time,closed_time")
        .ilike("status", "%closed%")
        .gte("closed_time", since)
        .not("closed_time", "is", null);
      const resolutionByWeek = weeklyResolution(resRows || [], weeksBack);

      res.json({
        zoho: zohoConfigured(),
        dropbox: dropboxConfigured(),
        gemini: geminiConfigured(),
        kbArticles: kb.total,
        total: m.total || 0,
        active: m.active || 0,
        openNow,
        closed: m.closed || 0,
        byStatus,
        byChannel,
        avgWaitMs: round(openAvgWaitMs),
        oldestWaitMs: round(openOldestWaitMs),
        avgResolutionMs: round(m.avgResolutionMs),
        resolvedSample: m.resolvedSample || 0,
        perDay,
        resolutionByWeek,
        lastFetch: new Date().toISOString(),
        error: null,
      });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Wix store lookups — customer orders (by email) + product search.
  app.get("/api/wix/orders", async (req, res) => {
    try {
      res.json({ orders: await searchOrdersByEmail(req.query.email || "") });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
  app.get("/api/wix/products", async (req, res) => {
    try {
      res.json({ products: await searchProducts(req.query.q || "") });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ShipStation — look up a shipment/order by number (any channel).
  app.get("/api/shipstation/order", async (req, res) => {
    try {
      res.json({ orders: await lookupOrder(req.query.number || "") });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Reply templates (the team's Zoho templates, already in the KB) — for the
  // copy/paste panel in the inbox.
  app.get("/api/templates", async (_req, res) => {
    try {
      const { data, error } = await supabase
        .from("kb_articles")
        .select("id,title,body")
        .eq("source", "zoho-template")
        .order("title");
      if (error) throw new Error(error.message);
      res.json({ templates: data || [] });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get("/api/feedback/metrics", async (req, res) => {
    try {
      const days = Math.min(365, Math.max(7, Number(req.query.days) || 90));
      res.json(await feedbackMetrics(days));
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
