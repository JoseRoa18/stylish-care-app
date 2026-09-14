// server/dashboard.js
// Dashboard aggregates, computed in JS from one read of the tickets table.
//
// They used to be SQL functions with no parameters, which is why only two cards
// had a period selector — every other number was all-time and could not be
// filtered. The table is a few thousand rows, so fetching it once and
// aggregating here costs nothing and lets every panel answer the same two
// questions: over what period, and with or without automated mail.
//
// That second filter matters more than it sounds. 75% of September's tickets
// were automated notifications (back-in-stock alerts, RA numbers, marketing),
// so "18 tickets today" meant two real customers. Excluding them is the default.

import { supabase } from "./supabase.js";

export const PERIODS = {
  "7d": 7, "30d": 30, "90d": 90, "180d": 180, "365d": 365, all: 0,
};

const DAY = 86400000;

// The whole table, briefly cached. Switching periods re-aggregates the same
// rows, so re-reading a few thousand of them each time is pure latency — this
// makes the period buttons feel instant while staying fresh enough for a
// dashboard that also polls every 30s.
let cache = null; // { at, rows }
const CACHE_MS = 20_000;

// Same idea for anything that doesn't change with the period: the KB count, the
// settings, the call log and the 8-week resolution query were all being redone
// on every click of a period button.
const memos = new Map();
export function memo(key, ms, fn) {
  const hit = memos.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = Promise.resolve(fn()).catch((e) => {
    memos.delete(key); // don't cache a failure
    throw e;
  });
  memos.set(key, { at: Date.now(), value });
  return value;
}

async function allRows() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const rows = await fetchRows();
  cache = { at: Date.now(), rows };
  return rows;
}

// Rows for the window, plus the ones still open (an old open ticket belongs in
// "avg wait" no matter which period is selected).
async function fetchRows() {
  // `model` only exists once supabase/surveys.sql has been run — ask for it,
  // and drop back to the rest of the columns until then
  const WITH = "id,number,subject,status,channel,category,model,created_time,closed_time,customer_response_time";
  const WITHOUT = WITH.replace(",model", "");
  const rows = [];
  let fields = WITH;
  for (let page = 0; ; page++) {
    let { data, error } = await supabase
      .from("tickets").select(fields).order("id").range(page * 1000, page * 1000 + 999);
    if (error && fields === WITH && /model/.test(error.message)) {
      fields = WITHOUT;
      ({ data, error } = await supabase
        .from("tickets").select(fields).order("id").range(page * 1000, page * 1000 + 999));
    }
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

async function load({ days, includeNotifications }) {
  const rows = await allRows();
  const since = days > 0 ? Date.now() - days * DAY : null;
  const keep = (r) =>
    (includeNotifications || r.category !== "notification") &&
    (!since || new Date(r.created_time).getTime() >= since);
  return { all: rows, window: rows.filter(keep) };
}

const isOpenType = (s) => /^(open|escalated)$/i.test(s || "");
const isClosed = (s) => /closed/i.test(s || "");

function tally(rows, key, fallback = "Other") {
  const out = {};
  for (const r of rows) {
    const k = r[key] || fallback;
    out[k] = (out[k] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

// New tickets per day/week/month across the window, zero-filled.
function series(rows, days) {
  const step = days === 0 || days > 180 ? "month" : days > 45 ? "week" : "day";
  const bucketOf = (d) => {
    const dt = new Date(d);
    if (step === "month") return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-01`;
    if (step === "week") {
      const w = new Date(dt);
      w.setUTCDate(w.getUTCDate() - ((w.getUTCDay() + 6) % 7));
      return w.toISOString().slice(0, 10);
    }
    return dt.toISOString().slice(0, 10);
  };
  const counts = new Map();
  for (const r of rows) {
    if (!r.created_time) continue;
    const b = bucketOf(r.created_time);
    counts.set(b, (counts.get(b) || 0) + 1);
  }
  // fill the gaps so a quiet day reads as zero rather than vanishing
  const keys = [...counts.keys()].sort();
  if (!keys.length) return [];
  const out = [];
  const cur = new Date(keys[0] + "T00:00:00Z");
  const end = new Date(keys[keys.length - 1] + "T00:00:00Z");
  while (cur <= end) {
    const k = cur.toISOString().slice(0, 10);
    out.push({ date: k, count: counts.get(k) || 0 });
    if (step === "month") cur.setUTCMonth(cur.getUTCMonth() + 1);
    else cur.setUTCDate(cur.getUTCDate() + (step === "week" ? 7 : 1));
  }
  const fmt = step === "month"
    ? { month: "short", year: "2-digit" }
    : { month: "short", day: "numeric" };
  return out.map((p) => ({ ...p, label: new Date(p.date + "T00:00:00").toLocaleDateString(undefined, fmt) }));
}

export async function dashboardData({ period = "90d", includeNotifications = false } = {}) {
  const days = PERIODS[period] ?? PERIODS["90d"];
  const { all, window } = await load({ days, includeNotifications });

  const openRows = all.filter(
    (r) => isOpenType(r.status) && (includeNotifications || r.category !== "notification")
  );
  const waits = openRows
    .map((r) => (r.customer_response_time ? Date.now() - new Date(r.customer_response_time).getTime() : null))
    .filter((ms) => ms != null && ms >= 0);

  const resolved = window.filter((r) => isClosed(r.status) && r.closed_time && r.created_time);
  const durations = resolved
    .map((r) => new Date(r.closed_time) - new Date(r.created_time))
    .filter((ms) => ms >= 0)
    .sort((a, b) => a - b);

  const avg = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null);

  return {
    period,
    includeNotifications,
    windowDays: days,
    total: window.length,
    openNow: openRows.length,
    closed: window.filter((r) => isClosed(r.status)).length,
    // how much of the window was automated mail — shown so the filter is honest
    // about what it is hiding rather than quietly shrinking every number
    notifications: all.filter(
      (r) => r.category === "notification" && (!days || new Date(r.created_time).getTime() >= Date.now() - days * DAY)
    ).length,
    uncategorized: window.filter((r) => !r.category).length,
    byStatus: tally(window, "status", "Unknown"),
    byChannel: tally(window, "channel"),
    byCategory: tally(window, "category", "uncategorized"),
    awaitingByCategory: tally(window.filter((r) => /awaiting/i.test(r.status || "")), "category", "uncategorized"),
    avgWaitMs: avg(waits),
    oldestWaitMs: waits.length ? Math.max(...waits) : null,
    avgResolutionMs: avg(durations),
    medianResolutionMs: durations.length ? durations[Math.floor(durations.length / 2)] : null,
    resolvedSample: durations.length,
    perDay: series(window, days),
  };
}
