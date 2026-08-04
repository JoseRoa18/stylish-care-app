// server/walmart.js
// Walmart Marketplace API (OAuth client-credentials). Gives the order behind a
// Walmart ticket: items, status, carrier and tracking — so Care (and the AI)
// answer "where is my order" without leaving the app.
//
// Note: Walmart's API exposes orders/returns, not customer messaging — the
// customer's own emails already arrive as tickets via the relay address.

import crypto from "crypto";

const BASE = process.env.WALMART_API_BASE || "https://marketplace.walmartapis.com";
const ID = process.env.WALMART_CLIENT_ID;
const SECRET = process.env.WALMART_CLIENT_SECRET;

export function walmartConfigured() {
  return Boolean(ID && SECRET);
}

const basic = () => "Basic " + Buffer.from(`${ID}:${SECRET}`).toString("base64");

let _token = null; // { value, exp }
async function getToken() {
  if (_token && _token.exp - 60_000 > Date.now()) return _token.value;
  const res = await fetch(`${BASE}/v3/token`, {
    method: "POST",
    headers: {
      Authorization: basic(),
      "WM_SVC.NAME": "Walmart Marketplace",
      "WM_QOS.CORRELATION_ID": crypto.randomUUID(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    throw new Error(`Walmart auth failed (${res.status}): ${j.error?.[0]?.info || "unknown"}`);
  }
  _token = { value: j.access_token, exp: Date.now() + (j.expires_in || 900) * 1000 };
  return _token.value;
}

async function wm(path) {
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: basic(),
      "WM_SEC.ACCESS_TOKEN": token,
      "WM_SVC.NAME": "Walmart Marketplace",
      "WM_QOS.CORRELATION_ID": crypto.randomUUID(),
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Walmart ${res.status}: ${t.slice(0, 140)}`);
  }
  return res.json();
}

const CARRIERS = { UPS: "UPS", FEDEX: "FedEx", USPS: "USPS", OnTrac: "OnTrac", LASERSHIP: "LaserShip" };
function trackingUrl(carrier, number) {
  if (!number) return null;
  const c = String(carrier || "").toUpperCase();
  if (c.includes("UPS")) return `https://www.ups.com/track?tracknum=${encodeURIComponent(number)}`;
  if (c.includes("FEDEX")) return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(number)}`;
  if (c.includes("USPS")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(number)}`;
  return null;
}

function normalizeOrder(o) {
  const addr = o.shippingInfo?.postalAddress || {};
  const lines = o.orderLines?.orderLine || [];
  return {
    poNumber: o.purchaseOrderId,
    customerOrderId: o.customerOrderId,
    date: o.orderDate ? new Date(Number(o.orderDate) || o.orderDate).toISOString().slice(0, 10) : null,
    customer: addr.name || null,
    city: [addr.city, addr.state].filter(Boolean).join(", ") || null,
    country: addr.country || null,
    shipMethod: o.shippingInfo?.methodCode || null,
    items: lines.map((l) => {
      const st = l.orderLineStatuses?.orderLineStatus?.[0] || {};
      const tn = st.trackingInfo?.trackingNumber || null;
      const carrier = st.trackingInfo?.carrierName?.carrier || st.trackingInfo?.carrierName?.otherCarrier || null;
      return {
        sku: l.item?.sku,
        name: l.item?.productName,
        qty: Number(l.orderLineQuantity?.amount) || 1,
        status: st.status || null,
        carrier: CARRIERS[carrier] || carrier,
        tracking: tn,
        trackingUrl: trackingUrl(carrier, tn),
      };
    }),
  };
}

// Look up a Walmart order by its purchase order id or the customer order id
// (both are the long numeric ids customers quote).
export async function lookupWalmartOrder(number) {
  if (!walmartConfigured()) return null;
  const n = String(number || "").replace(/\D/g, "");
  if (n.length < 12) return null;
  // purchase order id first, then customer order id
  for (const path of [`/v3/orders/${n}`, `/v3/orders?customerOrderId=${n}`]) {
    try {
      const data = await wm(path);
      const o = data?.order || data?.list?.elements?.order?.[0];
      if (o) return normalizeOrder(o);
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

export async function lookupWalmartOrders(numbers) {
  const uniq = [...new Set((numbers || []).map((x) => String(x).replace(/\D/g, "")).filter((x) => x.length >= 12))].slice(0, 3);
  const found = await Promise.all(uniq.map((n) => lookupWalmartOrder(n).catch(() => null)));
  return found.filter(Boolean);
}

// Order numbers Walmart uses are 12-18 digit numbers — pull candidates out of
// a ticket's subject/body.
export function extractWalmartNumbers(text) {
  return [...new Set((String(text || "").match(/\b\d{12,18}\b/g) || []))].slice(0, 3);
}

export function walmartToText(orders) {
  if (!orders.length) return "";
  return orders
    .map((o) => {
      const items = o.items
        .map((i) => `${i.sku}${i.name ? ` (${i.name})` : ""} x${i.qty} — ${i.status}${i.tracking ? `, ${i.carrier || "carrier"} ${i.tracking}` : ""}`)
        .join("; ");
      return `Walmart order ${o.customerOrderId || o.poNumber} (${o.date}): ${items}.`;
    })
    .join("\n");
}
