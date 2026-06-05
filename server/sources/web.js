// server/sources/web.js
// Ingests the public support/policy pages from the Stylish websites into
// the Knowledge Base. Pages are fetched server-side, stripped of chrome
// (nav/footer/scripts), and split into readable chunks. Each chunk becomes
// a KB article tagged source:"web" with its source URL.

import * as cheerio from "cheerio";

// Pages worth grounding customer replies on. Override with WEB_KB_URLS in
// .env (comma-separated) to add sinksdirect.ca pages or more product pages.
const DEFAULT_URLS = [
  "https://stylishkb.com/faqs",
  "https://stylishkb.com/returns",
  "https://stylishkb.com/warranty",
  "https://stylishkb.com/shipping-policy",
  "https://stylishkb.com/product-care",
  "https://stylishkb.com/kitchen-sink-installation-options",
];

const MAX_CHUNK = 1400; // characters per article chunk
const MIN_LINE = 25; // drop shorter lines (nav items, button labels, etc.)

export function webUrls() {
  const fromEnv = (process.env.WEB_KB_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_URLS;
}

function slugFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
    return last.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  } catch {
    return "page";
  }
}

// "product-care" → "Product Care" (title fallback when the page has no h1)
function humanize(slug) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Pull readable text out of a Wix-style page: drop chrome, keep block text.
function extractText(html) {
  const $ = cheerio.load(html);
  $(
    "script, style, noscript, svg, iframe, head, header, footer, nav, form, button"
  ).remove();

  const title =
    ($("h1").first().text() || $("title").first().text() || "").trim();

  // Insert newlines at block boundaries so words don't run together.
  $("br").replaceWith("\n");
  $("p, li, h1, h2, h3, h4, h5, div, td, section").each((_, el) => {
    $(el).append("\n");
  });

  const raw = $("body").text();
  const seen = new Set();
  const lines = [];
  for (let line of raw.split("\n")) {
    line = line.replace(/\s+/g, " ").trim();
    if (line.length < MIN_LINE) continue; // skip nav/labels/short noise
    if (seen.has(line)) continue; // dedupe repeated chrome
    seen.add(line);
    lines.push(line);
  }
  return { title, lines };
}

// Group cleaned lines into ~MAX_CHUNK-sized chunks on line boundaries.
function chunkLines(lines) {
  const chunks = [];
  let buf = "";
  for (const line of lines) {
    if (buf && buf.length + line.length + 1 > MAX_CHUNK) {
      chunks.push(buf.trim());
      buf = "";
    }
    buf += (buf ? "\n" : "") + line;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (StylishCareBot)" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Ingest all configured pages. Returns an array of KB articles
// (NOT yet persisted — the caller hands them to kb.replaceSource).
export async function ingestWeb({ urls } = {}) {
  const list = urls && urls.length ? urls : webUrls();
  const articles = [];
  const stamp = new Date().toISOString();
  const errors = [];

  for (const url of list) {
    try {
      const html = await fetchPage(url);
      const { title, lines } = extractText(html);
      const chunks = chunkLines(lines);
      const slug = slugFromUrl(url);
      const pageTitle = title || humanize(slug);
      chunks.forEach((body, i) => {
        articles.push({
          id: `WEB-${slug}${chunks.length > 1 ? `-${i + 1}` : ""}`,
          title:
            chunks.length > 1 ? `${pageTitle} (${i + 1}/${chunks.length})` : pageTitle,
          body,
          finish: null,
          tags: ["web", slug],
          sourceUrl: url,
          updatedAt: stamp,
        });
      });
    } catch (err) {
      errors.push({ url, error: err.message });
    }
  }

  return { articles, errors };
}
