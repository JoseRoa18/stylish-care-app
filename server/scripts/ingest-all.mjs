// Sequential, single-writer ingestion to avoid concurrent kb-data.json /
// embeddings writes: templates first (fast, embedded immediately so they're
// searchable right away), then Dropbox (slow, with OCR), then a final
// incremental reindex. Run: node server/scripts/ingest-all.mjs
import "dotenv/config";
import { ingestTemplates } from "../sources/templates.js";
import { ingestDropbox } from "../dropbox.js";
import { replaceSource, sourceCounts } from "../kb.js";
import { buildIndex } from "../kb-index.js";

const t0 = Date.now();
const secs = () => Math.round((Date.now() - t0) / 1000);

// ── 1) Zoho templates (fast) ─────────────────────────────────
console.log("[templates] importing…");
const tpl = await ingestTemplates();
console.log(`[templates] parsed ${tpl.articles.length}, errors ${tpl.errors.length}`);
if (tpl.articles.length) {
  console.log("[templates] persisted:", JSON.stringify(await replaceSource("zoho-template", tpl.articles)));
  console.log("[templates] reindex:", JSON.stringify(await buildIndex())); // templates now searchable
}

// ── 2) Dropbox manuals + spec sheets (slow, OCR on image PDFs) ─
console.log(`[dropbox] importing… (${secs()}s)`);
let last = 0;
const dbx = await ingestDropbox({
  onProgress: (done, total, name) => {
    if (done - last >= 10 || done === total) {
      last = done;
      console.log(`[dropbox] ${done}/${total} ${secs()}s · ${name}`);
    }
  },
});
console.log(`[dropbox] parsed ${dbx.articles.length}, errors ${dbx.errors.length}`);
if (dbx.articles.length) {
  console.log("[dropbox] persisted:", JSON.stringify(await replaceSource("dropbox", dbx.articles)));
}

// ── 3) final incremental reindex (only new/changed docs embed) ─
console.log("[index] rebuilding…");
console.log("[index]", JSON.stringify(await buildIndex()));
console.log("counts:", JSON.stringify((await sourceCounts()).bySource));
console.log(`done in ${secs()}s`);
