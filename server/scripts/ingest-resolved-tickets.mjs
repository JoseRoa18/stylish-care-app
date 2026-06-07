// Distill RESOLVED Zoho tickets into reusable KB entries (anonymized).
// Resumable: re-running skips tickets already ingested.
//
//   node server/scripts/ingest-resolved-tickets.mjs [limit]
//
// Pass a small limit first (e.g. 15) to validate quality, then run with no
// limit to process the full closed-ticket history.
import "dotenv/config";
import { ingestResolvedTickets } from "../resolved-tickets.js";

const limit = Number(process.argv[2]) || Infinity;
const t0 = Date.now();
const secs = () => Math.round((Date.now() - t0) / 1000);

let lastLog = 0;
const stats = await ingestResolvedTickets({
  limit,
  onProgress: (s) => {
    const now = Date.now();
    if (now - lastLog > 2000) {
      lastLog = now;
      process.stdout.write(
        `\r  scanned ${s.scanned}/${s.total} · ingested ${s.ingested} · skip(existing) ${s.skippedExisting} · not-usable ${s.notUsable} · no-thread ${s.noThread} · err ${s.errors} · ${secs()}s   `
      );
    }
  },
});

console.log("\n\ndone in", secs() + "s");
console.log(JSON.stringify(stats, null, 2));
