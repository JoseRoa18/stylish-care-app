// Build/refresh the KB embedding index.
// Run: node server/scripts/build-embeddings.mjs
import "dotenv/config";
import { buildIndex } from "../kb-index.js";

const t0 = Date.now();
let last = 0;
const r = await buildIndex({
  onProgress: (done, total) => {
    if (done - last >= 100 || done === total) {
      last = done;
      console.log(`  embedded ${done}/${total} (${Math.round((Date.now() - t0) / 1000)}s)`);
    }
  },
});
console.log("result:", JSON.stringify(r));
console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s`);
