// server/sources/wix-products.js
// Imports the storefront catalogue into the Knowledge Base.
//
// Why: product questions were the AI's weakest area — 36% of those drafts were
// generated with NO knowledge-base coverage at all, so the model had nothing to
// answer "will this fit a 30 inch cabinet" or "which grid goes with S-401" from.
// The catalogue already holds exactly that, in the DIMENSIONS, FEATURES and
// RECOMMENDED ACCESSORIES sections of every product page.
//
// One article per SKU, not per storefront: the same sink is listed on up to
// four sites, and four near-identical articles would crowd out everything else
// in retrieval.

const { WIX_API_KEY, WIX_ACCOUNT_ID } = process.env;

const SITES = [
  { name: "Sinks Direct CA", id: "a4b3f611-7e41-4b75-93df-f869cf376e0c" },
  { name: "Sinks Direct USA", id: "bf567955-60ed-4ca8-9a5c-89810dc6fbcf" },
  { name: "Stylish", id: "2c055557-06fe-401c-b0b7-9593c6e5a34e" },
  { name: "Stylish USA", id: "467de3bb-6702-4201-a816-a4fbe5bd3ecf" },
];

// Sections worth keeping. DOCUMENTS TO DOWNLOAD and WHERE TO BUY are lists of
// link labels with no prose, so they add tokens and no answers.
const KEEP_SECTIONS = new Set(["DIMENSIONS", "FEATURES", "RECOMMENDED ACCESSORIES", "SPECIFICATIONS", "MATERIALS"]);

export function wixProductsConfigured() {
  return Boolean(WIX_API_KEY && WIX_ACCOUNT_ID);
}

const strip = (s) =>
  String(s || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    // the accessories lists come out as runs of whitespace-only lines, which
    // `\n{3,}` alone doesn't catch because each "blank" line holds a space
    .replace(/(?:[ \t]*\n){2,}/g, "\n\n")
    .trim();

function pageUrl(p) {
  const base = p.productPageUrl?.base;
  const path = p.productPageUrl?.path;
  if (!base || !path) return null;
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

async function fetchPage(siteId, offset, limit) {
  const res = await fetch("https://www.wixapis.com/stores-reader/v1/products/query", {
    method: "POST",
    headers: {
      Authorization: WIX_API_KEY,
      "wix-account-id": WIX_ACCOUNT_ID,
      "wix-site-id": siteId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: { paging: { limit, offset } }, includeVariants: false }),
  });
  if (!res.ok) throw new Error(`Wix ${res.status}: ${(await res.text().catch(() => "")).slice(0, 120)}`);
  return res.json();
}

function toArticle(p, sites, stamp) {
  const sku = (p.sku || "").trim();
  const name = (p.name || "").trim();
  if (!name) return null;

  // Cut the description at a sentence boundary: the opening lines say what the
  // product IS, the rest is marketing prose that dilutes retrieval. The spec
  // sections below are what actually answer a customer's question, so those
  // stay whole — except the accessory list, which is long and repetitive.
  const clip = (s, max) => {
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
    return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut).trim() + "…";
  };

  const parts = [];
  const desc = strip(p.description);
  if (desc) parts.push(clip(desc, 600));

  for (const s of p.additionalInfoSections || []) {
    const title = String(s.title || "").trim().toUpperCase();
    if (!KEEP_SECTIONS.has(title)) continue;
    const body = strip(s.description);
    if (!body) continue;
    parts.push(`${title}:\n${clip(body, title === "RECOMMENDED ACCESSORIES" ? 450 : 1200)}`);
  }

  // finishes and other buying options, when the product has them
  const options = (p.productOptions || [])
    .map((o) => `${o.name}: ${(o.choices || []).map((c) => c.value || c.description).filter(Boolean).join(", ")}`)
    .filter((l) => !/:\s*$/.test(l));
  if (options.length) parts.push(`OPTIONS:\n${options.join("\n")}`);

  const price = p.priceData?.formatted?.price || p.price?.formatted?.price;
  const facts = [
    sku ? `SKU: ${sku}` : null,
    price ? `Price: ${price}` : null,
    p.stock?.inStock === false ? "Currently out of stock" : null,
    `Sold on: ${sites.join(", ")}`,
  ].filter(Boolean);
  parts.push(facts.join(" · "));

  const body = parts.join("\n\n").trim();
  if (body.length < 40) return null; // nothing worth retrieving

  return {
    id: `WIXPROD-${(sku || p.slug || p.id).toUpperCase()}`,
    title: sku ? `${name} (${sku})` : name,
    body,
    finish: null,
    tags: ["product", sku, p.brand].filter(Boolean),
    sourceUrl: pageUrl(p),
    updatedAt: stamp,
  };
}

export async function ingestWixProducts({ onProgress } = {}) {
  if (!wixProductsConfigured()) {
    return { articles: [], errors: [{ error: "Wix is not configured (WIX_API_KEY / WIX_ACCOUNT_ID)" }] };
  }
  const errors = [];
  const stamp = new Date().toISOString();
  const bySku = new Map(); // sku (or slug) -> { product, sites[] }

  for (const site of SITES) {
    let offset = 0;
    const LIMIT = 100;
    for (;;) {
      let data;
      try {
        data = await fetchPage(site.id, offset, LIMIT);
      } catch (err) {
        errors.push({ site: site.name, error: err.message });
        break;
      }
      const products = data.products || [];
      for (const p of products) {
        if (p.visible === false) continue;
        const key = (p.sku || p.slug || p.id || "").trim().toUpperCase();
        if (!key) continue;
        const seen = bySku.get(key);
        if (seen) {
          // same SKU on another storefront — record where, keep the richest copy
          if (!seen.sites.includes(site.name)) seen.sites.push(site.name);
          const richer = (p.additionalInfoSections || []).length > (seen.product.additionalInfoSections || []).length;
          if (richer) seen.product = p;
        } else {
          bySku.set(key, { product: p, sites: [site.name] });
        }
      }
      onProgress?.(bySku.size, data.totalResults || 0, `${site.name} · ${bySku.size} SKUs`);
      offset += LIMIT;
      if (products.length < LIMIT || offset >= (data.totalResults || 0)) break;
    }
  }

  const articles = [];
  for (const { product, sites } of bySku.values()) {
    const a = toArticle(product, sites, stamp);
    if (a) articles.push(a);
  }
  return { articles, errors };
}
