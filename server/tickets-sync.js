// server/tickets-sync.js
// Syncs Zoho tickets (metadata only) into the Supabase `tickets` table so the
// dashboard can report full history and every new ticket is captured.
//  • syncAll  — full backfill (paginate every status to the end). Run locally.
//  • syncRecent — pull the newest activity (first page per status). Cheap;
//    fired on dashboard loads so the table stays fresh during normal use.

import { supabase } from "./supabase.js";
import { fetchTicketsPage } from "./zoho.js";

const STATUSES = (process.env.ZOHO_SYNC_STATUSES || "Open,On Hold,Escalated,Closed")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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

// Full history backfill — paginates each status to the end.
export async function syncAll({ onPage, pageDelayMs = 250, maxPages = 2000 } = {}) {
  let total = 0;
  for (const status of STATUSES) {
    for (let page = 0; page < maxPages; page++) {
      const from = page * 100;
      let tickets;
      try {
        tickets = await fetchTicketsPage({ status, from, limit: 100 });
      } catch (e) {
        console.error(`  [${status}] from ${from} error: ${e.message}`);
        break; // Zoho may cap deep pagination — stop this status, keep the rest
      }
      if (!tickets.length) break;
      await upsertTickets(tickets);
      total += tickets.length;
      if (onPage) onPage(status, from, tickets.length, total);
      if (tickets.length < 100) break;
      await sleep(pageDelayMs);
    }
  }
  return total;
}

// Incremental refresh — newest-modified first page per status (new + changed).
export async function syncRecent({ pages = 1 } = {}) {
  let total = 0;
  for (const status of STATUSES) {
    for (let page = 0; page < pages; page++) {
      const tickets = await fetchTicketsPage({ status, from: page * 100, limit: 100 });
      if (!tickets.length) break;
      total += await upsertTickets(tickets);
      if (tickets.length < 100) break;
    }
  }
  return total;
}
