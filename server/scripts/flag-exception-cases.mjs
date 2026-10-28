// One-off: flag the resolved cases learned BEFORE the "one-off exception" flag
// existed (refunds, credits, gifts, waived fees, goodwill replacements), so
// drafts never present them as policy. Cases learned since are flagged as they
// are learned (server/resolved-tickets.js).
//
// Each unflagged case is judged by the model (the same rule the learner uses)
// and by the word check; either one flags it. A DRY RUN unless --write is
// given: it prints the cases it would flag and changes nothing.
//
//   node server/scripts/flag-exception-cases.mjs              list what would be flagged
//   node server/scripts/flag-exception-cases.mjs --limit 50   only look at 50 cases
//   node server/scripts/flag-exception-cases.mjs --write      tag them (+ the body note)
//
// A flagged case keeps its date, so retrieval ranks it as before.
import "dotenv/config";
import { supabase } from "../supabase.js";
import {
  RESOLVED_TICKET_SOURCE, EXCEPTION_TAG, looksLikeException, judgeException, flagException,
} from "../resolved-tickets.js";

const args = process.argv.slice(2);
const write = args.includes("--write");
const i = args.indexOf("--limit");
const limit = (i >= 0 && Number(args[i + 1])) || Infinity;

const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase
    .from("kb_articles").select("id,title,body,tags").eq("source", RESOLVED_TICKET_SOURCE)
    .order("id").range(from, from + 999);
  if (error) throw new Error(error.message);
  rows.push(...data);
  if (data.length < 1000) break;
}
const todo = rows.filter((a) => !(a.tags || []).includes(EXCEPTION_TAG)).slice(0, limit);
console.log(
  `${write ? "WRITING" : "DRY RUN — nothing is written"} · ${rows.length} resolved cases, ` +
    `${rows.length - todo.length} already flagged, checking ${todo.length}\n`
);

const stats = { checked: 0, flagged: 0, byModel: 0, byWords: 0, errors: 0 };
let next = 0;
const worker = async () => {
  while (next < todo.length) {
    const a = todo[next++];
    try {
      const words = looksLikeException(String(a.body || "").split("How we resolved it:")[1]);
      const model = await judgeException(a);
      stats.checked++;
      if (!words && !model) continue;
      stats.flagged++;
      if (model) stats.byModel++;
      if (words) stats.byWords++;
      if (write) await flagException(a);
      const how = (a.body.split("How we resolved it:")[1] || a.body).trim().replace(/\s+/g, " ");
      console.log(`${write ? "FLAGGED" : "WOULD FLAG"} ${a.id} (${[model && "model", words && "words"].filter(Boolean).join(" + ")})`);
      console.log(`  ${a.title}`);
      console.log(`    ${how.slice(0, 400)}${how.length > 400 ? "…" : ""}\n`);
    } catch (e) {
      stats.errors++;
      console.log(`ERROR ${a.id}: ${e.message}`);
    }
  }
};
await Promise.all(Array.from({ length: 4 }, worker));

console.log(JSON.stringify(stats, null, 2));
process.exit(0);
