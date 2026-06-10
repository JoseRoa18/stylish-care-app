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
import { fetchTicketsPage } from "./zoho.js";

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

// Throttled refresh used on inbox/dashboard loads. Awaited (serverless kills
// detached work after the response) but only actually hits Zoho every `minMs`.
let _lastSync = 0;
export async function maybeSync(minMs = 120000) {
  if (Date.now() - _lastSync < minMs) return;
  _lastSync = Date.now();
  try {
    await syncRecent();
  } catch {
    /* ignore — the table still serves the last good snapshot */
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
