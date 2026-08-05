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

const asTrack = (s) => ({
  number: s.trackingNumber,
  carrier: prettyCarrier(s.carrierCode),
  url: trackingUrl(s.carrierCode, s.trackingNumber),
  shipDate: (s.shipDate || "").slice(0, 10),
});

async function lookupInAccount(acc, orderNumber) {
  const enc = encodeURIComponent(orderNumber);
  const [ordersData, shipData, stores] = await Promise.all([
    ssGet(acc, `/orders?orderNumber=${enc}`).catch(() => ({ orders: [] })),
    ssGet(acc, `/shipments?orderNumber=${enc}&includeShipmentItems=false`).catch(() => ({ shipments: [] })),
    storeMap(acc),
  ]);
  const shipments = (shipData.shipments || []).filter((s) => !s.voided && s.trackingNumber);

  const out = [];
  for (const o of ordersData.orders || []) {
    out.push({
      account: acc.region,
      orderId: o.orderId,
      orderNumber: o.orderNumber,
      channel: stores.get(o.advancedOptions?.storeId) || o.advancedOptions?.source || "—",
      status: fmtStatus(o.orderStatus),          // awaiting_shipment / shipped / cancelled
      date: (o.orderDate || "").slice(0, 10),
      total: o.orderTotal != null ? `$${o.orderTotal}` : null,
      recipient: o.shipTo?.name || null,
      email: (o.customerEmail || "").toLowerCase().trim() || null,
      items: (o.items || []).map((i) => ({ name: i.name, qty: i.quantity, sku: i.sku })),
      // ONLY this order's own shipments. The same number exists in several
      // stores for DIFFERENT customers, so pasting every shipment of the
      // number onto every order shows someone else's tracking.
      tracking: shipments.filter((s) => s.orderId === o.orderId).map(asTrack),
    });
  }
  // shipped but the order record wasn't returned (rare) → synthesize from shipment
  const covered = new Set(out.map((o) => o.orderId));
  for (const s of shipments) {
    if (covered.has(s.orderId)) continue;
    covered.add(s.orderId);
    out.push({
      account: acc.region,
      orderId: s.orderId,
      orderNumber: s.orderNumber,
      channel: stores.get(s.advancedOptions?.storeId) || "—",
      status: "shipped",
      date: (s.createDate || "").slice(0, 10),
      total: null,
      recipient: s.shipTo?.name || null,
      email: null,
      items: [],
      tracking: [asTrack(s)],
    });
  }
  return out;
}

// The same order number is mirrored across several Odoo stores in ShipStation;
// collapse those into one row (union tracking, best status). But the brands
// number orders independently — Sinks Direct #16600 and Stylish Int #16600 are
// DIFFERENT orders for different people — so the customer is part of the key.
const STATUS_RANK = { shipped: 5, "partially shipped": 4, "awaiting shipment": 3, "on hold": 2, pending: 1, cancelled: 0, canceled: 0 };
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const custKey = (r) => norm(r.recipient) || (r.email || "");

function collapse(results) {
  const byKey = new Map();
  for (const r of results) {
    const key = `${r.account}:${r.orderNumber}:${custKey(r)}`;
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

// Several brands can share an order number, so when we know who the ticket is
// from, flag the rows that are actually theirs and put them first. Rows for a
// different customer stay visible (they explain the collision) but are marked.
function markOwner(rows, who = {}) {
  const emails = new Set((who.emails || []).map((e) => String(e).toLowerCase().trim()).filter(Boolean));
  const names = (who.names || []).map(norm).filter(Boolean);
  if (!emails.size && !names.length) return rows;
  for (const r of rows) r.match = !!((r.email && emails.has(r.email)) || (r.recipient && names.includes(norm(r.recipient))));
  if (!rows.some((r) => r.match)) {
    for (const r of rows) delete r.match;  // nothing matched — don't imply a judgement
    return rows;
  }
  for (const r of rows) if (!r.match) r.otherCustomer = true;
  return rows.sort((a, b) => (b.match ? 1 : 0) - (a.match ? 1 : 0));
}

// Look up one order number across all configured accounts.
export async function lookupOrder(orderNumber, who) {
  if (!shipstationConfigured() || !String(orderNumber || "").trim()) return [];
  const num = String(orderNumber).trim();
  const results = await Promise.all(
    ACCOUNTS.map((acc) => lookupInAccount(acc, num).catch(() => []))
  );
  return markOwner(collapse(results.flat()), who);
}

// Look up several order numbers (e.g. the ones found in a ticket), de-duped.
export async function lookupOrders(numbers, who) {
  const uniq = [...new Set((numbers || []).map((n) => String(n).trim()).filter(Boolean))].slice(0, 4);
  const results = await Promise.all(uniq.map((n) => lookupOrder(n, who)));
  const seen = new Set();
  return results.flat().filter((r) => {
    const k = `${r.account}:${r.orderNumber}:${custKey(r)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Every email address mentioned in a ticket — the customer often writes in from
// a forwarded address (info@sinksdirect.ca), with their real one in the body.
export function extractEmails(text) {
  const found = new Set();
  for (const m of String(text || "").matchAll(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g)) found.add(m[0].toLowerCase());
  return [...found].slice(0, 8);
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
  // once we know which rows belong to this customer, hide the rest — a
  // same-numbered order from another brand must never reach the draft
  const rows = results.some((r) => r.match) ? results.filter((r) => r.match) : results;
  if (!rows.length) return "";
  return rows
    .map((r) => {
      const track = r.tracking.length
        ? ` Tracking: ${r.tracking.map((t) => `${t.carrier || ""} ${t.number}${t.shipDate ? ` (shipped ${t.shipDate})` : ""}`.trim()).join(", ")}.`
        : "";
      const items = r.items.length ? ` Items: ${r.items.map((i) => `${i.name}${i.qty > 1 ? ` x${i.qty}` : ""}`).join("; ")}.` : "";
      const to = r.recipient ? ` shipping to ${r.recipient}` : "";
      return `Order #${r.orderNumber} (${r.channel}, ${r.account})${to}, ordered ${r.date || "?"}: ${r.status}.${items}${track}`;
    })
    .join("\n");
}
