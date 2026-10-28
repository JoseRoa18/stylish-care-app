// Learn from RESOLVED Zoho tickets into reusable KB entries (anonymized),
// through the same ledger and rules as the automatic runs
// (server/resolved-tickets.js): nothing is learned twice, AI drafts sent as-is
// are not learned from, and an entry the team deleted never comes back.
//
// A DRY RUN unless --write is given: it distills and prints, and writes
// nothing (no KB entry, no ledger row). Use it to review a sample first:
//
//   node server/scripts/ingest-resolved-tickets.mjs                    first 20 entries, newest first
//   node server/scripts/ingest-resolved-tickets.mjs --limit 20 --random   20 spread over the window
//   node server/scripts/ingest-resolved-tickets.mjs --since 2026-08-01 --until 2026-09-01
//
// Once the sample is approved, learn the backlog for real:
//
//   node server/scripts/ingest-resolved-tickets.mjs --write [--limit N]
//
// The default window is the backlog the automatic runs leave alone: tickets
// closed from 2026-06-22 (the newest entry learned the old way) up to
// LEARN_START. Pass --since / --until to look elsewhere.
import "dotenv/config";
import { learnPending, LEARN_START } from "../resolved-tickets.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

const write = flag("write");
const dryRun = !write;
const since = opt("since", "2026-06-22T00:00:00Z");
const until = opt("until", LEARN_START);
const limit = Number(opt("limit", dryRun ? 20 : 0)) || Infinity;
const random = flag("random");

const t0 = Date.now();
const secs = () => Math.round((Date.now() - t0) / 1000);
const indent = (s) => String(s).replace(/\n+/g, "\n    ");

console.log(
  `${dryRun ? "DRY RUN — nothing is written" : "WRITING to the Knowledge Base"} · closed ${since} → ${until}` +
    ` · ${limit === Infinity ? "no limit" : `stop after ${limit} entries`}${random ? " · random order" : ""}\n`
);

// Ctrl-C finishes the ticket in hand and lets go of the lock — killed outright,
// the lock would keep the cron and "Learn now" out for hours. A second Ctrl-C
// quits at once.
const stop = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (stop.signal.aborted) process.exit(130);
    console.log("\nStopping after this ticket… (Ctrl-C again to quit now)");
    stop.abort();
  });
}

const stats = await learnPending({
  dryRun,
  since,
  until,
  limit,
  random,
  budgetMs: Infinity,
  trigger: "script",
  signal: stop.signal,
  onTicket: (row, r) => {
    const head = `#${row.number ?? row.id} · closed ${String(row.closed_time).slice(0, 10)}`;
    const turns = r.turns ? ` · ${r.turns.join(" ")}` : "";
    if (!r.article) {
      console.log(`${head} · ${r.outcome === "error" ? "ERROR" : "skip"}: ${r.reason}${turns}`);
      return;
    }
    const a = r.article;
    const exception = a.tags.includes("one-off-exception");
    console.log(`\n${head}${turns}`);
    console.log(`  ${dryRun ? "WOULD LEARN" : "LEARNED"} ${a.id}${exception ? "  [one-off exception]" : ""}  (${r.value?.provenance})`);
    console.log(`  ${a.title}`);
    console.log(`    ${indent(a.body)}`);
    console.log(`    tags: ${a.tags.join(", ")}${a.finish ? ` · finish: ${a.finish}` : ""}\n`);
  },
});

if (stats.busy) {
  console.log("Another learning run holds the lock (cron or the KB tab). Try again in a few minutes.");
  process.exit(1);
}
console.log(`\ndone in ${secs()}s`);
console.log(JSON.stringify(stats, null, 2));
