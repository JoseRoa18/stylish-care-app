// server/wayfair.js
// Wayfair Partner API (GraphQL) — dropship purchase-order lookup, so tickets
// that mention a Wayfair PO ("CS662757326") show what it is, what shipped and
// when, straight from Wayfair.
//
// NOTE: the current application is a SANDBOX app. Wayfair's sandbox mirrors
// the supplier's real recent POs with the customer's PII masked — good enough
// for care (PO status/products/carrier are real). When a Production app is
// approved, set WAYFAIR_ENV=production and it switches over.

const { WAYFAIR_CLIENT_ID, WAYFAIR_CLIENT_SECRET } = process.env;
const ENV = (process.env.WAYFAIR_ENV || "sandbox").toLowerCase();
const API_HOST = ENV === "production" ? "https://api.wayfair.com" : "https://sandbox.api.wayfair.com";

export function wayfairConfigured() {
  return Boolean(WAYFAIR_CLIENT_ID && WAYFAIR_CLIENT_SECRET);
}

let _token = null; // { value, exp }
async function getToken() {
  if (_token && _token.exp - 60_000 > Date.now()) return _token.value;
  const res = await fetch("https://sso.auth.wayfair.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: WAYFAIR_CLIENT_ID,
      client_secret: WAYFAIR_CLIENT_SECRET,
      audience: `${API_HOST}/`,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    throw new Error(`Wayfair auth failed (${res.status}): ${j.error_description || j.error || "unknown"}`);
  }
  _token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return _token.value;
}

async function gql(query, variables) {
  const token = await getToken();
  const res = await fetch(`${API_HOST}/v1/graphql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.errors) {
    throw new Error(`Wayfair ${res.status}: ${j.errors?.[0]?.message || "error"}`);
  }
  return j.data;
}

const CARRIERS = { FDEG: "FedEx Ground", FEDEX: "FedEx", UPSN: "UPS", UPS: "UPS", USPS: "USPS", XPOL: "XPO", RBTW: "R+L", ODFL: "Old Dominion" };

function normalizePo(po) {
  return {
    poNumber: po.poNumber,
    date: (po.poDate || "").slice(0, 10),
    estimatedShipDate: (po.estimatedShipDate || "").slice(0, 10) || null,
    scheduledDeliveryDate: (po.scheduledDeliveryDate || "").slice(0, 10) || null,
    channel: po.salesChannelName || "Wayfair",
    warehouse: po.warehouse?.name || null,
    carrier: CARRIERS[po.shippingInfo?.carrierCode] || po.shippingInfo?.carrierCode || null,
    shipSpeed: po.shippingInfo?.shipSpeed || null,
    customer: po.customerName || null, // masked in sandbox
    products: (po.products || []).map((p) => ({
      partNumber: p.partNumber,
      name: p.name || null,
      qty: Number(p.quantity) || 1,
      price: p.price != null ? Number(p.price) : null,
      cancelled: Boolean(p.isCancelled),
    })),
  };
}

const PO_FIELDS = `
  poNumber poDate estimatedShipDate scheduledDeliveryDate salesChannelName customerName
  warehouse { name }
  shippingInfo { shipSpeed carrierCode }
  products { partNumber name quantity price isCancelled }
`;

// Look up specific Wayfair PO numbers (e.g. from a ticket's subject/body).
export async function lookupWayfairPos(poNumbers) {
  if (!wayfairConfigured()) return [];
  const nums = [...new Set((poNumbers || []).map((n) => String(n).trim().toUpperCase()).filter((n) => /^C[AS]\d{6,}$/.test(n)))].slice(0, 4);
  if (!nums.length) return [];
  const data = await gql(
    `query ($nums: [String!]) { getDropshipPurchaseOrders(poNumbers: $nums, limit: 10) { ${PO_FIELDS} } }`,
    { nums }
  ).catch(() => null);
  return (data?.getDropshipPurchaseOrders || []).map(normalizePo);
}

// Recent POs with cancelled items (Wayfair's orderCancellations query 500s
// server-side, so we derive cancellations from the PO feed's isCancelled).
export async function getRecentCancellations({ days = 14 } = {}) {
  if (!wayfairConfigured()) return { poCount: 0, cancellations: [] };
  const fromDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const data = await gql(
    `query { getDropshipPurchaseOrders(limit: 200, fromDate: "${fromDate}", sortOrder: DESC) { ${PO_FIELDS} } }`
  ).catch(() => null);
  const pos = (data?.getDropshipPurchaseOrders || []).map(normalizePo);
  const cancellations = pos
    .filter((p) => p.products.some((x) => x.cancelled))
    .map((p) => ({
      poNumber: p.poNumber,
      date: p.date,
      customer: p.customer,
      items: p.products.filter((x) => x.cancelled).map((x) => x.partNumber),
    }));
  return { poCount: pos.length, cancellations };
}

// Compact text block for the AI prompt.
export function wayfairToText(pos) {
  if (!pos.length) return "";
  return pos
    .map((p) => {
      const items = p.products.map((x) => `${x.partNumber}${x.name ? ` (${x.name})` : ""}${x.qty > 1 ? ` x${x.qty}` : ""}${x.cancelled ? " [CANCELLED]" : ""}`).join("; ");
      return `Wayfair PO #${p.poNumber} (${p.date}): items: ${items}. Est. ship ${p.estimatedShipDate || "?"} via ${p.carrier || "?"}${p.warehouse ? ` from ${p.warehouse}` : ""}.`;
    })
    .join("\n");
}
