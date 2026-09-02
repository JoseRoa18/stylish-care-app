// Move a flood of look-alike tickets to the Zoho recycle bin.
//
// A notification list (review alerts, order confirmations…) pointed at the
// support mailbox can dump thousands of tickets in one night. This clears them
// by subject + date window, in batches, and drops the mirrored Supabase rows.
//
// Dry run (default — prints what it WOULD delete, touches nothing):
//   node server/scripts/purge-tickets.mjs --subject "You got a new review" --from 2026-08-31 --to 2026-09-01
// Really do it:
//   … --apply
//
// Zoho keeps trashed tickets in the recycle bin for ~60 days, so a mistake here
// is recoverable from the Zoho UI.

import "dotenv/config";
import { supabase } from "../supabase.js";
import { moveTicketsToTrash } from "../zoho.js";

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const SUBJECT = arg("subject");
const FROM = arg("from");
const TO = arg("to");
const BATCH = Number(arg("batch", 50));
const APPLY = has("apply");

if (!SUBJECT || !FROM || !TO) {
  console.error('usage: --subject "text" --from YYYY-MM-DD --to YYYY-MM-DD [--apply] [--batch 50]');
  process.exit(1);
}

// Supabase caps a select at 1000 rows, so page through the whole match set.
async function findMatches() {
  const rows = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from("tickets")
      .select("id,number,subject,status")
      .ilike("subject", `%${SUBJECT}%`)
      .gte("created_time", FROM)
      .lt("created_time", TO)
      .order("id")
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

const rows = await findMatches();

console.log(`asunto contiene: "${SUBJECT}"`);
console.log(`creados entre:   ${FROM} y ${TO}`);
console.log(`coincidencias:   ${rows.length}`);
if (!rows.length) process.exit(0);

// show a sample so a wrong filter is obvious before anything is destroyed
const byStatus = rows.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
console.log(`por estado:      ${JSON.stringify(byStatus)}`);
console.log("muestra:");
for (const r of rows.slice(0, 3)) console.log(`  #${r.number} | ${r.status} | ${r.subject}`);

if (!APPLY) {
  console.log(`\nSIMULACION — no se borro nada. Agrega --apply para ejecutarlo de verdad.`);
  process.exit(0);
}

async function purge(batchRows) {
  let done = 0;
  for (let i = 0; i < batchRows.length; i += BATCH) {
    const chunk = batchRows.slice(i, i + BATCH).map((r) => r.id);
    try {
      await moveTicketsToTrash(chunk);
      await supabase.from("tickets").delete().in("id", chunk);
      done += chunk.length;
    } catch (e) {
      failed.push(...chunk);
      console.log(`  lote ${Math.floor(i / BATCH) + 1} fallo: ${e.message.slice(0, 100)}`);
      await new Promise((r) => setTimeout(r, 4000)); // back off, keep going
    }
    if (Math.floor(i / BATCH) % 10 === 0 || i + BATCH >= batchRows.length)
      console.log(`  ${done}/${batchRows.length} a papelera${failed.length ? ` (${failed.length} fallidos)` : ""}`);
  }
  return done;
}

// Re-query and repeat until nothing matches. A single pass can leave stragglers
// behind — more mail lands while it runs, and the paged listing is taken before
// the deletes start — so trusting one pass silently leaves tickets in the inbox.
const failed = [];
let trashed = 0;
let pending = rows;
for (let pass = 1; pending.length && pass <= 10; pass++) {
  if (pass > 1) console.log(`\npasada ${pass}: quedan ${pending.length}`);
  trashed += await purge(pending);
  pending = (await findMatches()).filter((r) => !failed.includes(r.id));
}
if (pending.length) console.log(`\naviso: ${pending.length} siguen sin borrarse tras 10 pasadas`);
console.log(`\nlisto — ${trashed} a la papelera de Zoho, ${failed.length} fallidos`);
