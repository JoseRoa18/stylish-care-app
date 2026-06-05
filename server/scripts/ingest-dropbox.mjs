// One-off / re-runnable Dropbox ingestion with progress logging.
// Run: node server/scripts/ingest-dropbox.mjs
import "dotenv/config";
import { ingestDropbox } from "../dropbox.js";
import { replaceSource, sourceCounts } from "../kb.js";
import { buildIndex } from "../kb-index.js";

const t0 = Date.now();
let lastLog = 0;

const { articles, errors, scanned, ingestedFiles } = await ingestDropbox({
  onProgress: (done, total, name) => {
    // log every 10 files (and the last one)
    if (done - lastLog >= 10 || done === total) {
      lastLog = done;
      const secs = Math.round((Date.now() - t0) / 1000);
      console.log(`  [${done}/${total}] ${secs}s · ${name}`);
    }
  },
});

console.log(`\nScanned ${scanned} files, targeted ${ingestedFiles} docs.`);
console.log(`Extracted ${articles.length} KB chunks, ${errors.length} errors.`);

if (articles.length) {
  const r = await replaceSource("dropbox", articles);
  console.log("persisted:", JSON.stringify(r));
  console.log("rebuilding embedding index…");
  const idx = await buildIndex({
    onProgress: (d, t) => {
      if (d % 200 === 0 || d === t) console.log(`  embedded ${d}/${t}`);
    },
  });
  console.log("index:", JSON.stringify(idx));
}
console.log("counts:", JSON.stringify((await sourceCounts()).bySource));

// show a few representative error reasons
const reasons = {};
for (const e of errors) {
  const key = (e.error || "").slice(0, 40);
  reasons[key] = (reasons[key] || 0) + 1;
}
console.log("error reasons:", JSON.stringify(reasons, null, 0));
console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s`);
