// Label historical tickets with their issue category, so the dashboard's
// "Tickets by issue" chart is useful from day one instead of filling up slowly.
//
//   node server/scripts/backfill-categories.mjs --months 2
//   node server/scripts/backfill-categories.mjs --months 2 --redo   (re-label)
//
// Most tickets are decided from the subject alone. When the subject is too thin
// to tell ("Re", "question", a bare part number) the first customer message is
// fetched from Zoho — that is the 8% that would otherwise land in "Other".
//
// Requires supabase/categories.sql to have been run.

import "dotenv/config";
import { supabase } from "../supabase.js";
import { getConversation } from "../zoho.js";
import { categorizeTickets, quickCategory, writeCategories } from "../categorize.js";

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const MONTHS = Number(arg("months", 2));
const REDO = process.argv.includes("--redo");
const DEEP_CONCURRENCY = 4;

const since = new Date();
since.setMonth(since.getMonth() - MONTHS);

// Supabase caps a select at 1000 rows. Without paging a big backfill silently
// does the first thousand and reports success, leaving the rest unlabelled.
const PAGE = 1000;
const rows = [];
for (let page = 0; ; page++) {
  let q = supabase
    .from("tickets")
    .select("id,subject")
    .gte("created_time", since.toISOString())
    .order("id")
    .range(page * PAGE, page * PAGE + PAGE - 1);
  if (!REDO) q = q.is("category", null);
  const { data, error } = await q;
  if (error) {
    console.error(
      /category/.test(error.message)
        ? "La columna 'category' no existe todavia — corre supabase/categories.sql primero."
        : error.message
    );
    process.exit(1);
  }
  if (!data?.length) break;
  rows.push(...data);
  if (data.length < PAGE) break;
}
console.log(`tickets a categorizar (ultimos ${MONTHS} meses): ${rows.length}`);
if (!rows.length) process.exit(0);

// A subject this thin can't be classified on its own — go read the message.
const thin = (s) => {
  const t = String(s || "").trim();
  return t.length < 22 || /^(re|fwd?|hello|hi|question|help|info|sink|urgent)\b[\s:.-]*$/i.test(t);
};

const needsBody = rows.filter((r) => !quickCategory(r.subject) && thin(r.subject));
console.log(`  de esos, ${needsBody.length} tienen asunto vago → leo el primer mensaje`);

let fetched = 0;
for (let i = 0; i < needsBody.length; i += DEEP_CONCURRENCY) {
  await Promise.all(
    needsBody.slice(i, i + DEEP_CONCURRENCY).map(async (r) => {
      try {
        // Enough threads to reach the opening message: asking for one returns
        // the LATEST, which is usually our own reply — classifying a ticket by
        // what WE wrote ("your order has shipped") mislabels it every time.
        const convo = await getConversation(r.id, { maxThreads: 6 });
        const first = (convo || []).find((m) => m.direction !== "out");
        // no inbound message at all → the subject alone is still better than
        // handing the model our own words
        if (first?.text) { r.text = first.text; fetched++; }
      } catch {
        /* no body available — the subject alone will have to do */
      }
    })
  );
  if (i % 40 === 0) process.stdout.write(`\r  leidos ${fetched}/${needsBody.length}`);
}
if (needsBody.length) console.log(`\r  leidos ${fetched}/${needsBody.length}`);

console.log("categorizando…");
const map = await categorizeTickets(rows);
const written = await writeCategories(map);

const counts = {};
for (const c of map.values()) counts[c] = (counts[c] || 0) + 1;
console.log(`\nescritos ${written} de ${rows.length}`);
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)}  ${k}`);
}
const missed = rows.length - map.size;
if (missed) console.log(`  ${missed} sin categoria (se reintentan solos en el proximo refresh)`);
