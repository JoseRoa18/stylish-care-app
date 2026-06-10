// Full Zoho ↔ Supabase reconciliation: refresh every ticket Zoho lists and
// remove rows Zoho no longer returns (spam/trashed/merged/moved tickets).
// Run: node server/scripts/reconcile-tickets.mjs
import "dotenv/config";
import { reconcileFull, ticketCounts } from "../tickets-sync.js";

const t0 = Date.now();
const { synced, removed, removedTickets } = await reconcileFull({
  onPage: (from, n, total) => {
    if (from % 500 === 0) console.log(`  from ${from}: +${n} (running ${total})`);
  },
});

console.log(`\nsynced ${synced} tickets · removed ${removed} stale rows · ${Math.round((Date.now() - t0) / 1000)}s`);
if (removedTickets.length) {
  console.log("\nremoved (no longer in Zoho lists):");
  for (const r of removedTickets)
    console.log(`  #${r.number} [${r.status}] ${(r.subject || "").slice(0, 60)}`);
}

const c = await ticketCounts();
console.log("\ncounts now → all:", c.all, "| active:", c.active, "| closed:", c.closed);
console.log("byStatus:", JSON.stringify(c.byStatus));
