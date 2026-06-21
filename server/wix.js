// server/wix.js
// Read-only Wix Stores / eCommerce lookups across the brand's storefronts, so
// Care can see a customer's real orders (status, items, tracking) and look up
// product availability — and feed that to the AI draft.
//
// Auth: an account-level Wix API key (WIX_API_KEY) + WIX_ACCOUNT_ID, with the
// per-request `wix-site-id` header selecting a storefront.

const { WIX_API_KEY, WIX_ACCOUNT_ID } = process.env;

// The brand's storefronts. `domain` is used to build product page links.
const SITES = [
  { name: "Sinks Direct CA", id: "a4b3f611-7e41-4b75-93df-f869cf376e0c", domain: "https://www.sinksdirect.ca" },
  { name: "Sinks Direct USA", id: "bf567955-60ed-4ca8-9a5c-89810dc6fbcf", domain: "https://www.sinksdirectusa.com" },
  { name: "Stylish (stylishkb.com)", id: "2c055557-06fe-401c-b0b7-9593c6e5a34e", domain: "https://www.stylishkb.com" },
  { name: "Stylish USA", id: "467de3bb-6702-4201-a816-a4fbe5bd3ecf", domain: null },
];

export function wixConfigured() {
  return Boolean(WIX_API_KEY && WIX_ACCOUNT_ID);
}

function headers(siteId) {
  return {
    Authorization: WIX_API_KEY,
    "wix-account-id": WIX_ACCOUNT_ID,
    "wix-site-id": siteId,
    "Content-Type": "application/json",
  };
}

async function wixPost(siteId, url, body) {
  const res = await fetch(url, { method: "POST", headers: headers(siteId), body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Wix ${res.status}: ${txt.slice(0, 120)}`);
  }
  return res.json();
}

function normalizeOrder(o, site) {
  return {
    site: site.name,
    siteId: site.id,
    id: o.id,
    number: o.number,
    date: o.createdDate || o.purchasedDate || null,
    status: o.status,                       // APPROVED / CANCELED / …
    paymentStatus: o.paymentStatus,         // PAID / NOT_PAID / REFUNDED / …
    fulfillmentStatus: o.fulfillmentStatus, // FULFILLED / NOT_FULFILLED / PARTIALLY_FULFILLED
    total: o.priceSummary?.total?.formattedAmount || null,
    email: o.buyerInfo?.email || null,
    customerName: [o.billingInfo?.contactDetails?.firstName, o.billingInfo?.contactDetails?.lastName].filter(Boolean).join(" ") || null,
    items: (o.lineItems || []).map((li) => ({
      name: li.productName?.original || li.productName?.translated || "Item",
      qty: li.quantity,
      sku: li.physicalProperties?.sku || li.catalogReference?.catalogItemId || null,
    })),
    tracking: [],
  };
}

// "ups_walleted" → "UPS"; build a tracking link when the carrier is known.
function prettyCarrier(c) {
  if (!c) return null;
  const base = String(c).split(/[_\s]/)[0].toLowerCase();
  return { ups: "UPS", fedex: "FedEx", usps: "USPS", dhl: "DHL", canadapost: "Canada Post", canpar: "Canpar", purolator: "Purolator" }[base] || c;
}
function trackingUrl(carrier, number) {
  if (!number) return null;
  const base = String(carrier || "").split(/[_\s]/)[0].toLowerCase();
  const n = encodeURIComponent(number);
  return {
    ups: `https://www.ups.com/track?tracknum=${n}`,
    fedex: `https://www.fedex.com/fedextrack/?trknbr=${n}`,
    usps: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
    dhl: `https://www.dhl.com/en/express/tracking.html?AWB=${n}`,
    canadapost: `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${n}`,
  }[base] || null;
}

async function attachTracking(order) {
  try {
    const res = await fetch(
      `https://www.wixapis.com/ecom/v1/fulfillments/orders/${order.id}`,
      { headers: headers(order.siteId) }
    );
    if (!res.ok) return order;
    const data = await res.json();
    const fulfillments = data?.orderWithFulfillments?.fulfillments || [];
    order.tracking = fulfillments
      .map((f) => f.trackingInfo)
      .filter(Boolean)
      .map((t) => ({
        number: t.trackingNumber || null,
        carrier: prettyCarrier(t.shippingProvider),
        url: t.trackingLink || trackingUrl(t.shippingProvider, t.trackingNumber),
      }))
      .filter((t) => t.number || t.url);
  } catch {
    /* tracking optional */
  }
  return order;
}

// All orders for a customer email, newest first, across every storefront.
export async function searchOrdersByEmail(email, { perSite = 5 } = {}) {
  if (!wixConfigured() || !email) return [];
  const results = await Promise.all(
    SITES.map(async (site) => {
      try {
        const data = await wixPost(site.id, "https://www.wixapis.com/ecom/v1/orders/search", {
          search: {
            filter: { "buyerInfo.email": email.toLowerCase() },
            sort: [{ fieldName: "createdDate", order: "DESC" }],
            cursorPaging: { limit: perSite },
          },
        });
        return (data.orders || []).map((o) => normalizeOrder(o, site));
      } catch {
        return [];
      }
    })
  );
  const orders = results.flat().sort((a, b) => (a.date < b.date ? 1 : -1));
  // enrich fulfilled/partially-fulfilled orders with tracking
  await Promise.all(orders.filter((o) => /FULFILLED/.test(o.fulfillmentStatus || "")).map(attachTracking));
  return orders;
}

function normalizeProduct(p, site) {
  const slug = p.slug;
  const url =
    p.productPageUrl?.base && p.productPageUrl?.path
      ? p.productPageUrl.base.replace(/\/$/, "") + p.productPageUrl.path
      : site.domain && slug
      ? `${site.domain}/product-page/${slug}`
      : null;
  return {
    site: site.name,
    name: p.name,
    sku: p.sku || null,
    price: p.price?.formatted?.price || p.priceData?.formatted?.price || null,
    inStock: p.stock?.inStock ?? null,
    quantity: p.stock?.quantity ?? null,
    url,
  };
}

// Product lookup by name/model across storefronts (e.g. "B-124N", "K-131G").
export async function searchProducts(query, { perSite = 4 } = {}) {
  if (!wixConfigured() || !query?.trim()) return [];
  const q = query.trim();
  const results = await Promise.all(
    SITES.map(async (site) => {
      try {
        const data = await wixPost(site.id, "https://www.wixapis.com/stores-reader/v1/products/query", {
          query: { filter: JSON.stringify({ name: { $contains: q } }), paging: { limit: perSite } },
          includeVariants: false,
        });
        return (data.products || []).map((p) => normalizeProduct(p, site));
      } catch {
        return [];
      }
    })
  );
  // de-dupe identical SKUs across sites (same product, multiple storefronts)
  const seen = new Set();
  return results.flat().filter((p) => {
    const k = `${p.sku || p.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Compact text block of a customer's orders for the AI prompt.
export function ordersToText(orders) {
  if (!orders.length) return "";
  return orders
    .slice(0, 6)
    .map((o) => {
      const items = o.items.map((i) => `${i.name}${i.qty > 1 ? ` x${i.qty}` : ""}`).join("; ");
      const track = o.tracking.length
        ? ` Tracking: ${o.tracking.map((t) => `${t.carrier || ""} ${t.number || ""}`.trim()).join(", ")}.`
        : "";
      return `Order #${o.number} (${o.site}, ${(o.date || "").slice(0, 10)}): ${o.fulfillmentStatus}, payment ${o.paymentStatus}, total ${o.total}. Items: ${items}.${track}`;
    })
    .join("\n");
}
