// Import Zoho ticket templates from the export file into the KB, then rebuild
// the embedding index. Run: node server/scripts/ingest-templates.mjs
import "dotenv/config";
import { ingestTemplates } from "../sources/templates.js";
import { replaceSource, sourceCounts } from "../kb.js";
import { buildIndex } from "../kb-index.js";

const { articles, errors } = await ingestTemplates();
console.log(`parsed ${articles.length} template articles, ${errors.length} skipped`);
if (errors.length) console.log("errors:", JSON.stringify(errors.slice(0, 5)));

if (articles.length) {
  console.log("persisted:", JSON.stringify(await replaceSource("zoho-template", articles)));
  console.log("rebuilding embedding index…");
  console.log("index:", JSON.stringify(await buildIndex()));
}
console.log("counts:", JSON.stringify((await sourceCounts()).bySource));
console.log("\nsample titles:");
for (const a of articles.slice(0, 15)) console.log(" -", a.title);
