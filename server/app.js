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
      const kb = await sourceCounts();
      const c = await getTickets();
      const tickets = c.data;
      const now = Date.now();
      const isClosed = (s) => /closed/i.test(s || "");
      const ms = (t) => (t ? new Date(t).getTime() : null);

      const byStatus = {};
      const byChannel = {};
      let waitSum = 0, waitN = 0, oldestWait = 0;
      let resSum = 0, resN = 0;

      const dayBuckets = {};
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now - i * 86400000);
        const key = d.toISOString().slice(0, 10);
        dayBuckets[key] = 0;
        days.push({ key, label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) });
      }

      for (const t of tickets) {
        byStatus[t.status] = (byStatus[t.status] || 0) + 1;
        byChannel[t.channel || "Other"] = (byChannel[t.channel || "Other"] || 0) + 1;
        if (!isClosed(t.status)) {
          const since = ms(t.customerResponseTime);
          if (since) {
            const w = now - since;
            waitSum += w; waitN++;
            if (w > oldestWait) oldestWait = w;
          }
        } else {
          const c0 = ms(t.createdTime), closed = ms(t.closedTime || t.modifiedTime);
          if (c0 && closed && closed >= c0) { resSum += closed - c0; resN++; }
        }
        const ck = t.createdTime ? new Date(t.createdTime).toISOString().slice(0, 10) : null;
        if (ck && ck in dayBuckets) dayBuckets[ck]++;
      }

      res.json({
        zoho: zohoConfigured(),
        dropbox: dropboxConfigured(),
        gemini: geminiConfigured(),
        kbArticles: kb.total,
        total: tickets.length,
        active: tickets.filter((t) => !isClosed(t.status)).length,
        closed: tickets.filter((t) => isClosed(t.status)).length,
        byStatus,
        byChannel,
        avgWaitMs: waitN ? Math.round(waitSum / waitN) : null,
        oldestWaitMs: oldestWait || null,
        avgResolutionMs: resN ? Math.round(resSum / resN) : null,
        resolvedSample: resN,
        perDay: days.map((d) => ({ label: d.label, count: dayBuckets[d.key] })),
        lastFetch: c.at ? new Date(c.at).toISOString() : null,
        error: c.error,
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
