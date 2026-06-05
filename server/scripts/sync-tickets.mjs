// Full Zoho → Supabase ticket backfill. Run locally once (then the app keeps
// it fresh incrementally). Run: node server/scripts/sync-tickets.mjs
import "dotenv/config";
import { syncAll } from "../tickets-sync.js";
import { supabase } from "./../supabase.js";

const t0 = Date.now();
const secs = () => Math.round((Date.now() - t0) / 1000);

const total = await syncAll({
  onPage: (status, from, n, running) => {
    if (from % 1000 === 0 || n < 100)
      console.log(`  [${status}] from ${from}: +${n} (running ${running}, ${secs()}s)`);
  },
});

const { count } = await supabase.from("tickets").select("*", { count: "exact", head: true });
console.log(`\ndone. synced ${total} pages-of-rows · tickets table now holds ${count} rows · ${secs()}s`);
