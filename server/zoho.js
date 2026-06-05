// server/zoho.js
// Thin wrapper over the Zoho Desk REST API.
// Handles OAuth token refresh + caching, and exposes the few
// operations the Care tool needs: list tickets, read a ticket's
// conversation, and send a reply directly to the customer.

const {
  ZOHO_API_BASE,
  ZOHO_ACCOUNTS_BASE,
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
  ZOHO_ORG_ID,
  ZOHO_DEPARTMENT_ID,
  ZOHO_FROM_ADDRESS,
  ZOHO_TICKET_STATUS,
} = process.env;

const STATUSES = (ZOHO_TICKET_STATUS || "Open")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ── access token cache ───────────────────────────────────────
let _token = null; // { value, expiresAt }

function configured() {
  return Boolean(ZOHO_CLIENT_ID && ZOHO_CLIENT_SECRET && ZOHO_REFRESH_TOKEN);
}

async function getAccessToken() {
  if (!configured()) {
    throw new Error(
      "Zoho is not configured. Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REFRESH_TOKEN in .env"
    );
  }
  // reuse cached token until ~1 min before expiry
  if (_token && _token.expiresAt - 60_000 > Date.now()) {
    return _token.value;
  }

  const url =
    `${ZOHO_ACCOUNTS_BASE}/token` +
    `?refresh_token=${encodeURIComponent(ZOHO_REFRESH_TOKEN)}` +
    `&client_id=${encodeURIComponent(ZOHO_CLIENT_ID)}` +
    `&client_secret=${encodeURIComponent(ZOHO_CLIENT_SECRET)}` +
    `&grant_type=refresh_token`;

  const res = await fetch(url, { method: "POST" });
  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.access_token) {
    throw new Error(
      `Zoho token refresh failed (${res.status}): ${JSON.stringify(data)}`
    );
  }

  _token = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return _token.value;
}

async function zohoFetch(path, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${ZOHO_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      orgId: ZOHO_ORG_ID,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  // 204 = no content (e.g. no tickets)
  if (res.status === 204) return null;

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const msg =
      (body && (body.message || body.errorCode)) || `HTTP ${res.status}`;
    throw new Error(`Zoho Desk error: ${msg}`);
  }
  return body;
}

// ── public operations ────────────────────────────────────────

// List tickets, newest first. Pass `statuses` (array) to override the default
// set — e.g. include "Closed"/"Escalated" so the UI can show & filter them.
export async function listTickets({ limit = 25, statuses } = {}) {
  const wanted = statuses && statuses.length ? statuses : STATUSES.length ? STATUSES : ["Open"];
  const params = new URLSearchParams({
    departmentId: ZOHO_DEPARTMENT_ID,
    sortBy: "-modifiedTime",
    limit: String(limit),
    include: "contacts",
    // Zoho omits modifiedTime/closedTime from the list by default — request
    // them explicitly so we can compute wait & resolution times.
    fields:
      "ticketNumber,subject,status,channel,email,contactName,createdTime,modifiedTime,closedTime,customerResponseTime,webUrl",
  });
  // Zoho accepts a single status param; query each and merge.
  const all = [];
  const seen = new Set();
  for (const status of wanted) {
    const p = new URLSearchParams(params);
    p.set("status", status);
    const data = await zohoFetch(`/tickets?${p.toString()}`);
    for (const t of data?.data || []) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        all.push(normalizeTicket(t));
      }
    }
  }
  all.sort((a, b) => (a.modifiedTime < b.modifiedTime ? 1 : -1));
  // With multiple statuses, recently-closed tickets would otherwise crowd out
  // the active ones (they sort newest by modifiedTime). Keep ALL active tickets
  // and only cap the Closed ones, so the inbox always shows what's awaiting.
  if (wanted.length > 1) {
    const closedRe = /closed/i;
    const active = all.filter((t) => !closedRe.test(t.status));
    const closed = all.filter((t) => closedRe.test(t.status)).slice(0, limit);
    return [...active, ...closed];
  }
  return all.slice(0, limit);
}

// Update a ticket's status (Open | On Hold | Escalated | Closed | ...).
export async function updateTicketStatus(ticketId, status) {
  if (!status) throw new Error("Missing status");
  return zohoFetch(`/tickets/${ticketId}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

function normalizeTicket(t) {
  const contact = t.contact || {};
  return {
    id: t.id,
    number: t.ticketNumber,
    subject: t.subject || "(no subject)",
    status: t.status,
    channel: t.channel,
    customerName:
      [contact.firstName, contact.lastName].filter(Boolean).join(" ") ||
      t.contactName ||
      "Customer",
    customerEmail: t.email || contact.email || "",
    createdTime: t.createdTime,
    modifiedTime: t.modifiedTime,
    closedTime: t.closedTime || null,
    // when the customer last wrote — used for the "awaiting reply" timer
    customerResponseTime: t.customerResponseTime || t.createdTime,
    webUrl: t.webUrl,
  };
}

// Trim the quoted reply chain / forwarded original from an email body so each
// message shows only its NEW content (the prior emails are already their own
// threads). Keeps the signal, drops the bloat — helps both the UI and the AI.
function stripQuoted(text) {
  if (!text) return "";
  let t = text.replace(/\r\n/g, "\n");
  const markers = [
    /On .{1,200}? wrote:/is, // Gmail: "On <date>, <name> wrote:"
    /-{2,}\s*Original Message\s*-{2,}/i, // Outlook
    /\nFrom:.+\nSent:.+/is, // Outlook header block
    /\n_{5,}\n/, // long underscore separators
    /\n>{1,}.*/s, // first quoted (">") line and everything after
  ];
  let cut = t.length;
  for (const re of markers) {
    const m = t.match(re);
    if (m && m.index < cut) cut = m.index;
  }
  return t.slice(0, cut).trim();
}

// Read a ticket's recent conversation as plain text.
export async function getConversation(ticketId, { maxThreads = 12 } = {}) {
  const list = await zohoFetch(
    `/tickets/${ticketId}/threads?limit=${maxThreads}`
  );
  const threads = list?.data || [];
  const out = [];
  // fetch full content for each thread (most recent last)
  for (const th of threads) {
    try {
      const full = await zohoFetch(
        `/tickets/${ticketId}/threads/${th.id}?include=plainText`
      );
      out.push({
        id: th.id,
        direction: full.direction || th.direction, // "in" | "out"
        from: full.fromEmailAddress || th.fromEmailAddress || "",
        author: full.author?.name || th.author?.name || "",
        createdTime: full.createdTime || th.createdTime,
        text: stripQuoted(full.plainText || full.summary || th.summary || ""),
      });
    } catch {
      out.push({
        id: th.id,
        direction: th.direction,
        from: th.fromEmailAddress || "",
        author: th.author?.name || "",
        createdTime: th.createdTime,
        text: (th.summary || "").trim(),
      });
    }
  }
  // chronological order
  out.sort((a, b) => (a.createdTime > b.createdTime ? 1 : -1));
  return out;
}

// Send a reply directly to the customer (not a draft). `contentType` is
// "html" by default so rich-text (bold/italic/lists) is preserved.
export async function sendReply(ticketId, { to, content, contentType = "html" }) {
  if (!to) throw new Error("Missing customer email address for reply.");
  const body = {
    channel: "EMAIL",
    fromEmailAddress: ZOHO_FROM_ADDRESS,
    to,
    content,
    contentType,
  };
  return zohoFetch(`/tickets/${ticketId}/sendReply`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ── Zoho templates → KB ingestion ────────────────────────────
// Pulls the team's reply templates out of Zoho Desk so the AI can ground
// replies in the wording the team already uses. Requires the OAuth client
// to include the `Desk.settings.READ` scope.
//
// NOTE: the exact endpoint varies by Zoho edition. Override with
// ZOHO_TEMPLATES_PATH in .env once verified against the live API. Default
// targets the email-templates collection.
const TEMPLATES_PATH = process.env.ZOHO_TEMPLATES_PATH || "/emailTemplates";

function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function ingestZohoTemplates() {
  if (!configured()) {
    return { articles: [], errors: [{ error: "Zoho not configured" }] };
  }
  const stamp = new Date().toISOString();
  const articles = [];
  const errors = [];

  let data;
  try {
    const p = new URLSearchParams({ departmentId: ZOHO_DEPARTMENT_ID });
    data = await zohoFetch(`${TEMPLATES_PATH}?${p.toString()}`);
  } catch (err) {
    return {
      articles: [],
      errors: [
        {
          error: `${err.message}. Ensure the OAuth scope includes Desk.settings.READ and ZOHO_TEMPLATES_PATH is correct.`,
        },
      ],
    };
  }

  const templates = data?.data || data?.templates || [];
  for (const t of templates) {
    const name = t.name || t.subject || `Template ${t.id}`;
    const bodyHtml = t.content || t.body || t.message || "";
    const body = htmlToText(bodyHtml);
    if (!body) {
      errors.push({ template: name, error: "empty content" });
      continue;
    }
    const slug = String(t.id || name).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    articles.push({
      id: `TPL-${slug}`,
      title: name,
      body: t.subject && t.subject !== name ? `Subject: ${t.subject}\n${body}` : body,
      finish: null,
      tags: ["template", "zoho"],
      sourceUrl: null,
      updatedAt: stamp,
    });
  }

  return { articles, errors };
}

export const zohoConfigured = configured;
