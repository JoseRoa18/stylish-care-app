// server/routes/kb.js
import { Router } from "express";
import {
  listArticles,
  createArticle,
  updateArticle,
  deleteArticle,
  replaceSource,
  sourceCounts,
} from "../kb.js";
import { ingestWeb } from "../sources/web.js";
import { ingestYouTube, youtubeConfigured } from "../sources/youtube.js";
import { ingestTemplates, templatesConfigured } from "../sources/templates.js";
import { ingestDropbox, dropboxConfigured } from "../dropbox.js";
import { ingestWixProducts, wixProductsConfigured } from "../sources/wix-products.js";
import { zohoConfigured } from "../zoho.js";
import { buildIndex } from "../kb-index.js";
import { embeddingsConfigured } from "../embeddings.js";
import { learnPending, learningStatus } from "../resolved-tickets.js";
import { maybeSync } from "../tickets-sync.js";

const router = Router();

router.get("/", async (_req, res) => {
  res.json({ articles: await listArticles() });
});

// counts per source — drives the KB header / dashboard
router.get("/sources", async (_req, res) => {
  const [counts, learning] = await Promise.all([
    sourceCounts(),
    // the KB tab's "last learned · +N this week" line; never blocks the counts
    learningStatus().catch(() => null),
  ]);
  res.json({
    ...counts,
    learning,
    connectors: {
      dropbox: dropboxConfigured(),
      zoho: zohoConfigured(),
      youtube: youtubeConfigured(),
      templates: templatesConfigured(),
      "wix-products": wixProductsConfigured(),
    },
  });
});

router.post("/", async (req, res) => {
  const { title, body } = req.body;
  if (!title?.trim() || !body?.trim())
    return res.status(400).json({ error: "Title and body are required" });
  res.json({ article: await createArticle(req.body) });
});

router.put("/:id", async (req, res) => {
  try {
    res.json({ article: await updateArticle(req.params.id, req.body) });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    res.json(await deleteArticle(req.params.id));
  } catch (err) {
    // e.g. a learned case whose "never learn again" mark couldn't be saved
    res.status(502).json({ error: err.message });
  }
});

// ── ingestion ────────────────────────────────────────────────
const INGESTERS = {
  web: { run: ingestWeb, source: "web" },
  youtube: { run: ingestYouTube, source: "youtube" },
  dropbox: { run: ingestDropbox, source: "dropbox" },
  "zoho-templates": { run: ingestTemplates, source: "zoho-template" },
  "wix-products": { run: ingestWixProducts, source: "product" },
};

// Ingestion runs as a single background job (it can take many minutes for
// Dropbox + OCR), so the HTTP request returns immediately and the client
// polls /ingest/status. Only one job runs at a time.
let job = null; // { running, keys, done, total, file, startedAt, finishedAt, results, reindex, error }

function publicJob() {
  if (!job) return { running: false };
  const { running, keys, done, total, file, startedAt, finishedAt, results, reindex, error } = job;
  return { running, keys, done, total, file, startedAt, finishedAt, results, reindex, error };
}

async function ingestOne(key, onProgress) {
  const ing = INGESTERS[key];
  const { articles, errors } = await ing.run({ onProgress });
  let result = { added: 0 };
  if (articles.length) result = await replaceSource(ing.source, articles);
  return { key, source: ing.source, ...result, ingested: articles.length, errors };
}

async function runJob(keys) {
  job = {
    running: true, keys, done: 0, total: 0, file: null,
    startedAt: Date.now(), finishedAt: null, results: [], reindex: null, error: null,
  };
  try {
    for (const key of keys) {
      job.done = 0; job.total = 0; job.file = `starting ${key}…`;
      const onProgress = (d, t, name) => { job.done = d; job.total = t; job.file = name; };
      try {
        job.results.push(await ingestOne(key, onProgress));
      } catch (err) {
        job.results.push({ key, error: err.message });
      }
    }
    // rebuild the embedding index once, after all sources are persisted
    if (embeddingsConfigured()) {
      job.file = "rebuilding search index…";
      try {
        job.reindex = await buildIndex();
      } catch (err) {
        job.reindex = { error: err.message };
      }
    }
  } finally {
    job.running = false;
    job.finishedAt = Date.now();
  }
}

// POST /api/kb/learn — "Learn now": learn from tickets closed since the last
// run. Awaited within a budget instead of the background `job` above, which a
// serverless instance can drop after the response; the tab calls again while
// `pending` is above zero. The same run happens three times a day by cron.
router.post("/learn", async (_req, res) => {
  const t0 = Date.now();
  try {
    try { await maybeSync(); } catch { /* learn from what the table already has */ }
    const r = await learnPending({ budgetMs: Math.max(5000, 45000 - (Date.now() - t0)), trigger: "button" });
    res.json(r.busy ? { ...r, ...(await learningStatus().catch(() => ({}))) } : r);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/kb/reindex — rebuild the embedding index on demand
router.post("/reindex", async (_req, res) => {
  if (!embeddingsConfigured())
    return res.status(400).json({ error: "GEMINI_API_KEY not set" });
  try {
    res.json(await buildIndex());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/kb/ingest/status — progress of the current/last ingestion job
router.get("/ingest/status", (_req, res) => res.json(publicJob()));

// POST /api/kb/ingest/:key — start ingesting one source (runs in background)
router.post("/ingest/:key", (req, res) => {
  const key = req.params.key;
  if (!INGESTERS[key])
    return res.status(400).json({ error: `Unknown source "${key}"` });
  if (job?.running)
    return res.status(409).json({ error: "An ingestion is already running", job: publicJob() });
  runJob([key]); // fire and forget — client polls /ingest/status
  res.json({ started: true, key });
});

// POST /api/kb/ingest — start ingesting every source (runs in background)
router.post("/ingest", (_req, res) => {
  if (job?.running)
    return res.status(409).json({ error: "An ingestion is already running", job: publicJob() });
  runJob(Object.keys(INGESTERS));
  res.json({ started: true, keys: Object.keys(INGESTERS) });
});

export default router;
