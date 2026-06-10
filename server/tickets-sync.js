// server/tickets-sync.js
// Syncs Zoho tickets (metadata only) into the Supabase `tickets` table so the
// inbox + dashboard can report the FULL history and every new ticket is captured.
//
// IMPORTANT: we sync with NO status filter. The department uses custom statuses
// ("Awaiting Response", "Closed Wayfair", "Wayfair", "Pending Return", …) — an
// earlier per-status sync silently dropped ~30% of tickets. A no-filter pass
// captures every status and is future-proof against new ones.
//
//  • syncAll    — full backfill (paginate the whole list to the end). Run locally.
//  • syncRecent — newest-modified first page(s). Cheap; fired on app loads.
//  • maybeSync  — throttled syncRecent (serverless-safe; awaited, not detached).
//  • queryTickets / ticketCounts — read the table back for the inbox.

import { supabase } from "./supabase.js";
import { fetchTicketsPage, fetchTicketById } from "./zoho.js";

function toRow(t) {
  return {
    id: t.id,
    number: t.number,
    subject: t.subject,
    status: t.status,
    channel: t.channel,
    customer_name: t.customerName,
    customer_email: t.customerEmail,
    created_time: t.createdTime || null,
    modified_time: t.modifiedTime || null,
    closed_time: t.closedTime || null,
    customer_response_time: t.customerResponseTime || null,
    web_url: t.webUrl || null,
    synced_at: new Date().toISOString(),
  };
}

// DB row → the ticket shape the client/inbox expects.
export function rowToTicket(r) {
  return {
    id: r.id,
    number: r.number,
    subject: r.subject || "(no subject)",
    status: r.status,
    channel: r.channel,
    customerName: r.customer_name || "Customer",
    customerEmail: r.customer_email || "",
    createdTime: r.created_time,
    modifiedTime: r.modified_time,
    closedTime: r.closed_time,
    customerResponseTime: r.customer_response_time || r.created_time,
    webUrl: r.web_url,
  };
}

export async function upsertTickets(tickets) {
  if (!tickets.length) return 0;
  const byId = new Map();
  for (const t of tickets) byId.set(t.id, t);
  const rows = [...byId.values()].map(toRow);
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase
      .from("tickets")
      .upsert(rows.slice(i, i + 200), { onConflict: "id" });
    if (error) throw new Error(error.message);
  }
  return rows.length;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Full history backfill — paginates the WHOLE list (all statuses) to the end.
// Sorted by createdTime so pagination is stable even as tickets get modified.
export async function syncAll({ onPage, pageDelayMs = 250, maxPages = 5000 } = {}) {
  let total = 0;
  for (let page = 0; page < maxPages; page++) {
    const from = page * 100;
    let tickets;
    try {
      tickets = await fetchTicketsPage({ from, limit: 100, sortBy: "-createdTime" });
    } catch (e) {
      console.error(`  from ${from} error: ${e.message}`);
      break; // Zoho may cap very deep pagination — stop, keep what we have
    }
    if (!tickets.length) break;
    await upsertTickets(tickets);
    total += tickets.length;
    if (onPage) onPage(from, tickets.length, total);
    if (tickets.length < 100) break;
    await sleep(pageDelayMs);
  }
  return total;
}

// Incremental refresh — newest-modified first, across all statuses. Catches new
// tickets AND status/field changes regardless of which status they land in.
export async function syncRecent({ pages = 1 } = {}) {
  let total = 0;
  for (let page = 0; page < pages; page++) {
    const tickets = await fetchTicketsPage({
      from: page * 100,
      limit: 100,
      sortBy: "-modifiedTime",
    });
    if (!tickets.length) break;
    total += await upsertTickets(tickets);
    if (tickets.length < 100) break;
  }
  return total;
}

// All rows we currently hold as active (paginated past the 1000-row cap).
async function activeRows(fields = "id,status") {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("tickets")
      .select(fields)
      .not("status", "ilike", "%closed%")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

// Reconcile our ACTIVE rows against Zoho. Tickets that get spam-marked,
// trashed, merged or moved INSIDE Zoho vanish from its list responses, so a
// plain sync never updates them — they'd sit here as ghost "Open" rows forever.
// Strategy: re-list every active status we hold (refreshing those rows), then
// resolve the leftovers one-by-one: still exists → update; gone → delete row.
export async function reconcileActive() {
  const rows = await activeRows();
  if (!rows.length) return { active: 0, removed: 0, fixed: 0 };

  const seen = new Set();
  for (const status of [...new Set(rows.map((r) => r.status))]) {
    for (let from = 0; from < 2000; from += 100) {
      const page = await fetchTicketsPage({ status, from, limit: 100 });
      if (page.length) {
        await upsertTickets(page);
        for (const t of page) seen.add(t.id);
      }
      if (page.length < 100) break;
    }
  }

  let removed = 0, fixed = 0;
  for (const r of rows.filter((x) => !seen.has(x.id))) {
    const t = await fetchTicketById(r.id);
    if (t) {
      await upsertTickets([t]); // e.g. it was closed — refresh the row
      fixed++;
    } else {
      await removeTicketRow(r.id); // spam / trashed / merged / moved
      removed++;
    }
  }
  return { active: rows.length, removed, fixed };
}

// Full mirror pass (script/cron): refresh everything Zoho lists, then delete
// any row Zoho no longer returns. Heavier than reconcileActive — also cleans
// closed-history rows that were trashed/merged inside Zoho.
export async function reconcileFull({ onPage } = {}) {
  const seen = new Set();
  let total = 0;
  for (let page = 0; page < 5000; page++) {
    const from = page * 100;
    let tickets;
    try {
      tickets = await fetchTicketsPage({ from, limit: 100, sortBy: "-createdTime" });
    } catch (e) {
      console.error(`  reconcile page ${from} error: ${e.message}`);
      break;
    }
    if (!tickets.length) break;
    await upsertTickets(tickets);
    for (const t of tickets) seen.add(t.id);
    total += tickets.length;
    if (onPage) onPage(from, tickets.length, total);
    if (tickets.length < 100) break;
    await sleep(250);
  }
  if (!seen.size) throw new Error("reconcileFull aborted: Zoho returned no tickets");

  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("tickets").select("id,number,subject,status").range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const stale = all.filter((r) => !seen.has(r.id));
  for (let i = 0; i < stale.length; i += 100) {
    const ids = stale.slice(i, i + 100).map((r) => r.id);
    const { error } = await supabase.from("tickets").delete().in("id", ids);
    if (error) throw new Error(error.message);
  }
  return { synced: total, removed: stale.length, removedTickets: stale };
}

// Throttled refresh used on inbox/dashboard loads. Awaited (serverless kills
// detached work after the response) but only actually hits Zoho every `minMs`.
// Every ~15 min it also runs the deeper active-row reconcile, so tickets the
// team spams/trashes/merges inside Zoho disappear here too.
let _lastSync = 0;
let _lastReconcile = 0;
export async function maybeSync(minMs = 120000) {
  if (Date.now() - _lastSync < minMs) return;
  _lastSync = Date.now();
  try {
    await syncRecent();
  } catch {
    /* ignore — the table still serves the last good snapshot */
  }
  if (Date.now() - _lastReconcile > 15 * 60000) {
    _lastReconcile = Date.now();
    try {
      await reconcileActive();
    } catch {
      /* ignore — next pass will catch up */
    }
  }
}

// Reflect a change we just made in Zoho immediately, so the inbox list (read
// from this table) stays consistent before the next full sync. No-op if the
// row isn't synced yet — the next sync will insert it.
export async function touchTicket(ticketId, fields) {
  const now = new Date().toISOString();
  await supabase
    .from("tickets")
    .update({ ...fields, modified_time: now, synced_at: now })
    .eq("id", ticketId);
}

export const touchStatus = (ticketId, status) => touchTicket(ticketId, { status });

// Remove a ticket from the synced table. Used after marking spam / trashing in
// Zoho: those tickets vanish from Zoho's normal lists, so the row would
// otherwise sit stale forever (counted as an active "Open" ticket).
export async function removeTicketRow(ticketId) {
  const { error } = await supabase.from("tickets").delete().eq("id", ticketId);
  if (error) throw new Error(error.message);
}

// ── read the table back for the inbox (server-side filter + search + paging) ──
// sort: updated (last activity), newest (created), oldest (created), waiting
// (longest since the customer last wrote — oldest first).
const SORTS = {
  updated: { col: "modified_time", asc: false },
  newest: { col: "created_time", asc: false },
  oldest: { col: "created_time", asc: true },
  waiting: { col: "customer_response_time", asc: true },
};

export async function queryTickets({ view = "active", q = "", page = 1, pageSize = 50, sort = "updated" } = {}) {
  const offset = (Math.max(1, page) - 1) * pageSize;
  let query = supabase.from("tickets").select("*", { count: "exact" });

  if (view === "active") query = query.not("status", "ilike", "%closed%");
  // "open" mirrors Zoho's "Open Tickets" view: open-TYPE statuses
  else if (view === "open") query = query.in("status", ["Open", "Escalated"]);
  else if (view === "closed") query = query.ilike("status", "%closed%");
  else if (view && view !== "all") query = query.eq("status", view);

  const s = String(q || "").trim().replace(/[%,()]/g, " ").trim();
  if (s) {
    query = query.or(
      [
        `number.ilike.%${s}%`,
        `subject.ilike.%${s}%`,
        `customer_name.ilike.%${s}%`,
        `customer_email.ilike.%${s}%`,
      ].join(",")
    );
  }

  const o = SORTS[sort] || SORTS.updated;
  query = query.order(o.col, { ascending: o.asc, nullsFirst: false })
    .range(offset, offset + pageSize - 1);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { tickets: (data || []).map(rowToTicket), total: count || 0 };
}

// Other tickets from the SAME customer (for the merge picker) — most recent
// first, active ones floated to the top.
export async function relatedTickets(ticketId, limit = 20) {
  const { data: me, error } = await supabase
    .from("tickets").select("customer_email").eq("id", ticketId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!me?.customer_email) return [];
  const { data, error: e2 } = await supabase
    .from("tickets")
    .select("*")
    .eq("customer_email", me.customer_email)
    .neq("id", ticketId)
    .order("modified_time", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (e2) throw new Error(e2.message);
  const rows = (data || []).map(rowToTicket);
  const closed = (t) => /closed/i.test(t.status || "");
  return [...rows.filter((t) => !closed(t)), ...rows.filter(closed)];
}

// Chip counts: All, Active, Closed, and one per real status (dynamic).
export async function ticketCounts() {
  const { data, error } = await supabase.rpc("tickets_by_status");
  if (error) throw new Error(error.message);
  const byStatus = {};
  let all = 0, active = 0, closed = 0;
  for (const r of data || []) {
    const n = Number(r.count);
    byStatus[r.status] = n;
    all += n;
    if (/closed/i.test(r.status || "")) closed += n;
    else active += n;
  }
  return { all, active, closed, byStatus };
}
