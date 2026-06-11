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
// Two layers: in-memory (warm instance) + a SHARED row in Supabase, so every
// serverless instance and script reuses ONE token instead of each minting its
// own — Zoho rate-limits refresh-token usage ("too many requests") hard.
let _token = null; // { value, expiresAt }

function configured() {
  return Boolean(ZOHO_CLIENT_ID && ZOHO_CLIENT_SECRET && ZOHO_REFRESH_TOKEN);
}

function tokenFresh(t) {
  return t && t.value && t.expiresAt - 60_000 > Date.now();
}

async function readSharedToken() {
  try {
    const { supabase } = await import("./supabase.js");
    if (!supabase) return null;
    const { data } = await supabase
      .from("app_state").select("value").eq("key", "zoho_token").maybeSingle();
    return tokenFresh(data?.value) ? data.value : null;
  } catch {
    return null; // table may not exist yet — memory-only mode
  }
}

async function writeSharedToken(tok) {
  try {
    const { supabase } = await import("./supabase.js");
    if (!supabase) return;
    await supabase
      .from("app_state")
      .upsert({ key: "zoho_token", value: tok, updated_at: new Date().toISOString() });
  } catch {
    /* best-effort */
  }
}

async function mintToken(attempt = 0) {
  const url =
    `${ZOHO_ACCOUNTS_BASE}/token` +
    `?refresh_token=${encodeURIComponent(ZOHO_REFRESH_TOKEN)}` +
    `&client_id=${encodeURIComponent(ZOHO_CLIENT_ID)}` +
    `&client_secret=${encodeURIComponent(ZOHO_CLIENT_SECRET)}` +
    `&grant_type=refresh_token`;
  const res = await fetch(url, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // Throttled? Another instance may have minted meanwhile — reuse theirs,
    // else back off briefly and retry.
    if (/too many requests/i.test(data.error_description || "") && attempt < 2) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      const shared = await readSharedToken();
      if (shared) return shared;
      return mintToken(attempt + 1);
    }
    throw new Error(`Zoho token refresh failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
}

async function getAccessToken() {
  if (!configured()) {
    throw new Error(
      "Zoho is not configured. Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REFRESH_TOKEN in .env"
    );
  }
  if (tokenFresh(_token)) return _token.value;
  const shared = await readSharedToken();
  if (shared) {
    _token = shared;
    return _token.value;
  }
  _token = await mintToken();
  await writeSharedToken(_token);
  return _token.value;
}

async function zohoFetch(path, options = {}, _retried = false) {
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
    // On serverless, a warm instance can hold an access token that Zoho already
    // invalidated (another instance refreshed). Force a fresh token and retry once.
    const invalidToken =
      res.status === 401 ||
      body?.errorCode === "INVALID_OAUTH" ||
      /oauth token/i.test(body?.message || "");
    if (invalidToken && !_retried) {
      // force-mint (the shared cached token is the invalid one) and retry once
      _token = await mintToken();
      await writeSharedToken(_token);
      return zohoFetch(path, options, true);
    }
    const msg =
      (body && (body.message || body.errorCode)) || `HTTP ${res.status}`;
    throw new Error(`Zoho Desk error: ${msg}`);
  }
  return body;
}

// ── public operations ────────────────────────────────────────

// Zoho omits modifiedTime/closedTime from the list by default — request them
// explicitly so we can compute wait & resolution times.
const TICKET_FIELDS =
  "ticketNumber,subject,status,channel,email,contactName,createdTime,modifiedTime,closedTime,customerResponseTime,webUrl";

// One page of tickets (used by the Supabase sync to paginate the full history).
// Pass no `status` to get EVERY status — the department uses custom ones
// ("Awaiting Response", "Closed Wayfair", …) so filtering by status drops rows.
// Returns normalized tickets; empty array when past the end.
export async function fetchTicketsPage({ status, from = 0, limit = 100, sortBy = "-modifiedTime" } = {}) {
  const p = new URLSearchParams({
    departmentId: ZOHO_DEPARTMENT_ID,
    sortBy,
    from: String(from),
    limit: String(limit),
    include: "contacts",
    fields: TICKET_FIELDS,
  });
  if (status) p.set("status", status);
  const data = await zohoFetch(`/tickets?${p.toString()}`);
  return (data?.data || []).map(normalizeTicket);
}

// Fetch ONE ticket by id. Returns null when the ticket is effectively gone for
// our inbox: not found, marked spam, trashed, or moved to another department.
// Used by the reconciler to resolve rows that vanished from Zoho's lists.
export async function fetchTicketById(ticketId) {
  let t;
  try {
    t = await zohoFetch(`/tickets/${ticketId}?include=contacts`);
  } catch (err) {
    if (/not.?found|invalid|does not exist/i.test(err.message)) return null;
    throw err;
  }
  if (!t || t.isSpam || t.isDeleted) return null;
  if (t.departmentId && String(t.departmentId) !== String(ZOHO_DEPARTMENT_ID)) return null;
  return normalizeTicket(t);
}

// List tickets, newest first. Pass `statuses` (array) to override the default
// set — e.g. include "Closed"/"Escalated" so the UI can show & filter them.
export async function listTickets({ limit = 25, statuses } = {}) {
  const wanted = statuses && statuses.length ? statuses : STATUSES.length ? STATUSES : ["Open"];
  const params = new URLSearchParams({
    departmentId: ZOHO_DEPARTMENT_ID,
    sortBy: "-modifiedTime",
    limit: String(limit),
    include: "contacts",
    fields: TICKET_FIELDS,
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

// Rename a ticket (the team fixes unhelpful subjects like "Fw: please see").
export async function updateTicketSubject(ticketId, subject) {
  if (!subject?.trim()) throw new Error("Missing subject");
  return zohoFetch(`/tickets/${ticketId}`, {
    method: "PATCH",
    body: JSON.stringify({ subject: subject.trim() }),
  });
}

// Mark a ticket as spam. Spam tickets disappear from all normal Zoho ticket
// views (they live in the separate Spam view) — exactly "hide this noise".
export async function markTicketSpam(ticketId, isSpam = true) {
  return zohoFetch(`/tickets/markSpam`, {
    method: "POST",
    body: JSON.stringify({ ids: [String(ticketId)], isSpam }),
  });
}

// Move a ticket to the Zoho recycle bin (restorable from Zoho for ~60 days).
export async function moveTicketToTrash(ticketId) {
  return zohoFetch(`/tickets/moveToTrash`, {
    method: "POST",
    body: JSON.stringify({ ticketIds: [String(ticketId)] }),
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

// Sanitize an email's HTML so it's safe to render in the app: drop scripts,
// styles, frames, event handlers and javascript: URLs; unwrap full-document
// shells; remove cid: inline images (they can't load outside the mail client —
// the real files show up in the Attachments strip instead).
function sanitizeEmailHtml(html) {
  let s = String(html || "");
  if (!s.trim()) return "";
  s = s
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<\/?(html|body)[^>]*>/gi, "")
    .replace(/<(script|style|iframe|object|embed|title)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|style|iframe|object|embed|link|meta|base|form|input|button)[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"')
    .replace(/<img[^>]*src=["']?cid:[^>]*>/gi, "");
  // Inline images come with Zoho-relative signed URLs that only work inside
  // Zoho's own UI — route them through our authenticated proxy instead.
  s = s.replace(/src=["'](\/supportapi\/api\/v1\/threads\/\d+\/inlineImages\/[^"']+)["']/gi, (_m, path) => {
    const clean = path.replace(/&amp;/g, "&");
    return `src="/api/tickets/inline-image?src=${encodeURIComponent(clean)}"`;
  });
  // Any other relative-src image can never load outside Zoho — drop it.
  s = s.replace(/<img[^>]*src=["']\/(?!api\/tickets\/inline-image)[^"']*["'][^>]*>/gi, "");
  return s.trim();
}

// Read a ticket's recent conversation. Each message carries BOTH:
//  • text — quoted-chain-stripped plain text (what the AI and translator use)
//  • html — the sanitized original email HTML (what the inbox renders, so
//    formatting/tables/links survive instead of a mangled wall of text)
//  • attachments — name/size/id of files on that message
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
        html: sanitizeEmailHtml(full.content || ""),
        attachments: (full.attachments || th.attachments || []).map((a) => ({
          id: a.id,
          name: a.name,
          size: a.size,
        })),
      });
    } catch {
      out.push({
        id: th.id,
        direction: th.direction,
        from: th.fromEmailAddress || "",
        author: th.author?.name || "",
        createdTime: th.createdTime,
        text: (th.summary || "").trim(),
        html: "",
        attachments: [],
      });
    }
  }
  // No email threads (web-form/phone tickets, or tickets Zoho holds no content
  // for): fall back to the ticket's own description as the opening message.
  if (!out.length) {
    try {
      const tk = await zohoFetch(`/tickets/${ticketId}`);
      if (tk?.description) {
        out.push({
          id: "description",
          direction: "in",
          from: tk.email || "",
          author: tk.contact ? [tk.contact.firstName, tk.contact.lastName].filter(Boolean).join(" ") : "",
          createdTime: tk.createdTime,
          text: htmlToText(tk.description),
          html: sanitizeEmailHtml(tk.description),
          attachments: [],
        });
      }
    } catch {
      /* truly empty ticket — the client shows a helpful empty state */
    }
  }

  // chronological order
  out.sort((a, b) => (a.createdTime > b.createdTime ? 1 : -1));
  return out;
}

// Send a reply directly to the customer (not a draft). `contentType` is
// "html" by default so rich-text (bold/italic/lists) is preserved. Pass
// `attachmentIds` (from uploadTicketAttachment) to attach files.
export async function sendReply(ticketId, { to, content, contentType = "html", attachmentIds }) {
  if (!to) throw new Error("Missing customer email address for reply.");
  const body = {
    channel: "EMAIL",
    fromEmailAddress: ZOHO_FROM_ADDRESS,
    to,
    content,
    contentType,
  };
  if (Array.isArray(attachmentIds) && attachmentIds.length) {
    body.attachmentIds = attachmentIds.map(String);
  }
  return zohoFetch(`/tickets/${ticketId}/sendReply`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ── ticket attachments (view + upload) ───────────────────────

// All files attached to a ticket (Zoho aggregates them across the thread).
export async function listTicketAttachments(ticketId) {
  const data = await zohoFetch(`/tickets/${ticketId}/attachments?limit=50`);
  return (data?.data || []).map((a) => ({
    id: a.id,
    name: a.name,
    size: Number(a.size) || 0,
    createdTime: a.createdTime,
  }));
}

// Binary content of one attachment (the app proxies this to the browser —
// Zoho's own links need the OAuth header, which a browser can't send).
export async function downloadTicketAttachment(ticketId, attachmentId) {
  const token = await getAccessToken();
  const res = await fetch(
    `${ZOHO_API_BASE}/tickets/${ticketId}/attachments/${attachmentId}/content`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}`, orgId: ZOHO_ORG_ID } }
  );
  if (!res.ok) throw new Error(`Zoho attachment download failed (${res.status})`);
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") || "application/octet-stream",
  };
}

// Binary content of an attachment that belongs to ONE message (thread) — these
// live in a different namespace than ticket-level attachments.
export async function downloadThreadAttachment(ticketId, threadId, attachmentId) {
  const token = await getAccessToken();
  const res = await fetch(
    `${ZOHO_API_BASE}/tickets/${ticketId}/threads/${threadId}/attachments/${attachmentId}/content`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}`, orgId: ZOHO_ORG_ID } }
  );
  if (!res.ok) throw new Error(`Zoho thread attachment download failed (${res.status})`);
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") || "application/octet-stream",
  };
}

// Photos the CUSTOMER attached to their recent messages, as base64 for the
// AI's multimodal draft (newest first; capped so the request stays light).
const AI_IMAGE_RE = /\.(png|jpe?g|webp)$/i;
export async function fetchConversationImages(
  ticketId,
  conversation,
  { maxImages = 4, maxBytesEach = 6_000_000 } = {}
) {
  const images = [];
  for (const m of [...conversation].reverse()) {
    if (m.direction === "out") continue;
    for (const a of m.attachments || []) {
      if (images.length >= maxImages) return images;
      if (!AI_IMAGE_RE.test(a.name || "")) continue;
      if (a.size && a.size > maxBytesEach) continue;
      try {
        const { buffer, contentType } = await downloadThreadAttachment(ticketId, m.id, a.id);
        images.push({
          name: a.name,
          mime: (contentType || "image/jpeg").split(";")[0],
          data: buffer.toString("base64"),
        });
      } catch {
        /* photo unavailable — the draft just proceeds without it */
      }
    }
  }
  return images;
}

// Upload a file onto the ticket; returns { id } to reference in sendReply.
export async function uploadTicketAttachment(ticketId, { buffer, filename, mime }) {
  const token = await getAccessToken();
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([buffer], { type: mime || "application/octet-stream" }),
    filename || "attachment"
  );
  const res = await fetch(`${ZOHO_API_BASE}/tickets/${ticketId}/attachments`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, orgId: ZOHO_ORG_ID },
    body: fd, // fetch sets the multipart boundary header itself
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    throw new Error(
      `Zoho attachment upload failed (${res.status}): ${data.message || data.errorCode || "unknown"}`
    );
  }
  return { id: data.id, name: data.name || filename, size: Number(data.size) || buffer.length };
}

// Inline image from an email body (signed Zoho path, needs our OAuth header).
// The path is validated strictly so this can only proxy Zoho inline images.
export async function fetchInlineImage(srcPath) {
  if (!/^\/supportapi\/api\/v1\/threads\/\d+\/inlineImages\/[A-Za-z0-9]+(\?[^\s]*)?$/.test(srcPath)) {
    throw new Error("Invalid inline image path");
  }
  const token = await getAccessToken();
  const url = `${ZOHO_API_BASE}${srcPath.replace("/supportapi/api/v1", "")}`;
  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}`, orgId: ZOHO_ORG_ID },
  });
  if (!res.ok) throw new Error(`Zoho inline image fetch failed (${res.status})`);
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") || "image/png",
  };
}

// ── merge tickets ────────────────────────────────────────────
// Merge `secondaryIds` INTO `primaryId` (Zoho folds their threads in; the
// secondaries then disappear from all ticket lists).
export async function mergeTickets(primaryId, secondaryIds) {
  if (!secondaryIds?.length) throw new Error("No tickets selected to merge");
  return zohoFetch(`/tickets/${primaryId}/merge`, {
    method: "POST",
    body: JSON.stringify({ ids: secondaryIds.map(String) }),
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
