// server/shipstation.js
// Read-only ShipStation lookups. ShipStation is the brand's central fulfillment
// hub across ALL channels (Amazon, Wayfair, Home Depot, RONA, Best Buy, eBay,
// Walmart + the direct stores), so it answers "where is order X / has it
// shipped / what's the tracking" for orders Wix can't see (marketplaces).
//
// Two regional accounts (Canada now, USA later) — each its own API key/secret.

const ACCOUNTS = [
  { region: "CA", key: process.env.SHIPSTATION_CA_KEY, secret: process.env.SHIPSTATION_CA_SECRET },
  { region: "US", key: process.env.SHIPSTATION_US_KEY, secret: process.env.SHIPSTATION_US_SECRET },
].filter((a) => a.key && a.secret);

export function shipstationConfigured() {
  return ACCOUNTS.length > 0;
}

function authHeader(acc) {
  return "Basic " + Buffer.from(`${acc.key}:${acc.secret}`).toString("base64");
}

async function ssGet(acc, path) {
  const res = await fetch(`https://ssapi.shipstation.com${path}`, {
    headers: { Authorization: authHeader(acc) },
  });
  if (res.status === 429) throw new Error("ShipStation rate limit");
  if (!res.ok) throw new Error(`ShipStation ${res.status}`);
  return res.json();
}

// storeId → store name, cached (the human channel label, e.g. "WAYFAIR CANADA").
const _stores = new Map(); // region → { at, map }
async function storeMap(acc) {
  const cached = _stores.get(acc.region);
  if (cached && Date.now() - cached.at < 3600_000) return cached.map;
  const map = new Map();
  try {
    const data = await ssGet(acc, "/stores?showInactive=true");
    for (const s of Array.isArray(data) ? data : []) map.set(s.storeId, s.storeName);
  } catch {
    /* leave empty */
  }
  _stores.set(acc.region, { at: Date.now(), map });
  return map;
}

function prettyCarrier(c) {
  if (!c) return null;
  const base = String(c).split(/[_\s]/)[0].toLowerCase();
  return { ups: "UPS", fedex: "FedEx", usps: "USPS", dhl: "DHL", purolator: "Purolator", canpar: "Canpar", canada: "Canada Post", canadapost: "Canada Post" }[base] || c;
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
    purolator: `https://www.purolator.com/en/shipping/tracker?pin=${n}`,
    canpar: `https://www.canpar.com/en/track/TrackingAction.do?reference=${n}`,
    canada: `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${n}`,
    canadapost: `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${n}`,
  }[base] || null;
}

const fmtStatus = (s) => (s || "").replace(/_/g, " ");

async function lookupInAccount(acc, orderNumber) {
  const enc = encodeURIComponent(orderNumber);
  const [ordersData, shipData, stores] = await Promise.all([
    ssGet(acc, `/orders?orderNumber=${enc}`).catch(() => ({ orders: [] })),
    ssGet(acc, `/shipments?orderNumber=${enc}&includeShipmentItems=false`).catch(() => ({ shipments: [] })),
    storeMap(acc),
  ]);
  const shipments = (shipData.shipments || []).filter((s) => !s.voided);
  const tracking = shipments
    .filter((s) => s.trackingNumber)
    .map((s) => ({ number: s.trackingNumber, carrier: prettyCarrier(s.carrierCode), url: trackingUrl(s.carrierCode, s.trackingNumber), shipDate: (s.shipDate || "").slice(0, 10) }));

  const out = [];
  for (const o of ordersData.orders || []) {
    out.push({
      account: acc.region,
      orderNumber: o.orderNumber,
      channel: stores.get(o.advancedOptions?.storeId) || o.advancedOptions?.source || "—",
      status: fmtStatus(o.orderStatus),          // awaiting_shipment / shipped / cancelled
      date: (o.orderDate || "").slice(0, 10),
      total: o.orderTotal != null ? `$${o.orderTotal}` : null,
      recipient: o.shipTo?.name || null,
      items: (o.items || []).map((i) => ({ name: i.name, qty: i.quantity, sku: i.sku })),
      tracking,
    });
  }
  // shipped but the order record wasn't returned (rare) → synthesize from shipment
  if (!out.length && shipments.length) {
    const s = shipments[0];
    out.push({
      account: acc.region,
      orderNumber: s.orderNumber,
      channel: stores.get(s.advancedOptions?.storeId) || "—",
      status: "shipped",
      date: (s.createDate || "").slice(0, 10),
      total: null,
      recipient: s.shipTo?.name || null,
      items: [],
      tracking,
    });
  }
  return out;
}

// The same order number is mirrored across several Odoo stores in ShipStation;
// collapse them into one row per account+number (union tracking, best status).
const STATUS_RANK = { shipped: 5, "partially shipped": 4, "awaiting shipment": 3, "on hold": 2, pending: 1, cancelled: 0, canceled: 0 };
function collapse(results) {
  const byKey = new Map();
  for (const r of results) {
    const key = `${r.account}:${r.orderNumber}`;
    const ex = byKey.get(key);
    if (!ex) { byKey.set(key, { ...r, tracking: [...r.tracking] }); continue; }
    const seen = new Set(ex.tracking.map((t) => t.number));
    for (const t of r.tracking) if (!seen.has(t.number)) { ex.tracking.push(t); seen.add(t.number); }
    if ((STATUS_RANK[r.status] ?? 0) > (STATUS_RANK[ex.status] ?? 0)) {
      ex.status = r.status; ex.channel = r.channel; ex.date = r.date || ex.date;
      if (r.items.length) ex.items = r.items;
    }
  }
  return [...byKey.values()];
}

// Look up one order number across all configured accounts.
export async function lookupOrder(orderNumber) {
  if (!shipstationConfigured() || !String(orderNumber || "").trim()) return [];
  const num = String(orderNumber).trim();
  const results = await Promise.all(
    ACCOUNTS.map((acc) => lookupInAccount(acc, num).catch(() => []))
  );
  return collapse(results.flat());
}

// Look up several order numbers (e.g. the ones found in a ticket), de-duped.
export async function lookupOrders(numbers) {
  const uniq = [...new Set((numbers || []).map((n) => String(n).trim()).filter(Boolean))].slice(0, 4);
  const results = await Promise.all(uniq.map((n) => lookupOrder(n)));
  const seen = new Set();
  return results.flat().filter((r) => {
    const k = `${r.account}:${r.orderNumber}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Candidate order numbers mentioned in a ticket's subject/body. Covers direct
// (5-6 digits) and marketplace formats (Amazon 3-7-7, Wayfair CS/CA…, etc.).
export function extractOrderNumbers(text) {
  const t = String(text || "");
  const found = new Set();
  for (const m of t.matchAll(/\b(\d{3}-\d{7}-\d{7})\b/g)) found.add(m[1]);          // Amazon
  for (const m of t.matchAll(/\b((?:CS|CA|PO)[#\s]?\d{6,})\b/gi)) found.add(m[1].replace(/[#\s]/g, "")); // Wayfair PO
  for (const m of t.matchAll(/\b(\d{5,9})\b/g)) found.add(m[1]);                     // direct / generic
  return [...found].slice(0, 5);
}

export function shipmentsToText(results) {
  if (!results.length) return "";
  return results
    .map((r) => {
      const track = r.tracking.length
        ? ` Tracking: ${r.tracking.map((t) => `${t.carrier || ""} ${t.number}${t.shipDate ? ` (shipped ${t.shipDate})` : ""}`.trim()).join(", ")}.`
        : "";
      const items = r.items.length ? ` Items: ${r.items.map((i) => `${i.name}${i.qty > 1 ? ` x${i.qty}` : ""}`).join("; ")}.` : "";
      return `Order #${r.orderNumber} (${r.channel}, ${r.account}): ${r.status}.${items}${track}`;
    })
    .join("\n");
}
