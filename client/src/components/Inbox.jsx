import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FileViewer, { openViewer, fileKind, KIND_ICON, MailDropPeek } from "./FileViewer.jsx";
import { api } from "../api.js";
import { sanitizeEmailHtml } from "../sanitize.js";
import { translateHtmlSegments, translateMessage } from "../translateHtml.js";

// "view" values map to server-side filters. "all"/"active"/"closed" are
// computed; everything else is matched as an exact Zoho status. Built dynamically
// from the live status counts so custom statuses (Awaiting Response, Closed
// Wayfair, …) show up automatically.
// Mirrors Zoho's own views: "Open" = Zoho's "Open Tickets" (Open + Escalated,
// the open-TYPE statuses). The remaining chips are the real statuses with
// tickets in them (Open/Escalated excluded — they live inside "Open").
const FIXED_VIEWS = [
  { key: "open", label: "Open" },
  { key: "all", label: "All" },
];
const OPEN_TYPE_RE = /^(open|escalated)$/i;

const SORT_OPTIONS = [
  { key: "updated", label: "Last activity" },
  { key: "newest", label: "Newest first" },
  { key: "oldest", label: "Oldest first" },
  { key: "waiting", label: "Longest waiting" },
];

export default function Inbox({ signature = "", initialSearch = "" }) {
  const [tickets, setTickets] = useState([]);
  const [counts, setCounts] = useState({ all: 0, active: 0, closed: 0, byStatus: {} });
  const [total, setTotal] = useState(0);
  const [configured, setConfigured] = useState(true);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [err, setErr] = useState(null);
  const [syncWarning, setSyncWarning] = useState(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [picked, setPicked] = useState(new Set()); // bulk-action selection

  const [view, setView] = useState("open");
  const [sort, setSort] = useState("updated");
  const [newOpen, setNewOpen] = useState(false);

  // prune auto-saved drafts older than 14 days
  useEffect(() => {
    try {
      const cutoff = Date.now() - 14 * 86400000;
      for (const k of Object.keys(localStorage)) {
        if (!k.startsWith("draft:")) continue;
        const v = JSON.parse(localStorage.getItem(k) || "null");
        if (!v?.at || v.at < cutoff) localStorage.removeItem(k);
      }
    } catch { /* ignore */ }
  }, []);
  const [source, setSource] = useState("all"); // origin filter (Wayfair, RONA…)
  const [layout, setLayout] = useState(() => localStorage.getItem("inboxLayout") || "split");
  useEffect(() => { localStorage.setItem("inboxLayout", layout); }, [layout]);
  // customer panel (orders/shipping/phone) beside each ticket: hideable so the
  // email gets the width. Kept here, not in TicketRow — List mounts every row
  // once, so a per-row copy went stale when you opened the next ticket.
  const [sideOpen, setSideOpen] = useState(() => {
    try { return localStorage.getItem("ticketSide") !== "hidden"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("ticketSide", sideOpen ? "shown" : "hidden"); } catch { /* ignore */ }
  }, [sideOpen]);
  const toggleSide = useCallback(() => setSideOpen((v) => !v), []);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 50;

  // when arriving from the Calls tab with a caller to find
  useEffect(() => { if (initialSearch) setSearch(initialSearch); }, [initialSearch]);

  // debounce the search box so we don't query on every keystroke
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 350);
    return () => clearTimeout(id);
  }, [search]);

  // reset to page 1 whenever the filter, sort or search changes
  useEffect(() => { setPage(1); }, [view, sort, debounced]);

  // Bumped on every local count change (see moveCount), so a reload that was
  // already in flight can't put back counts from before the change.
  const countEdits = useRef(0);
  // Status saves still in flight. The server updates its counts before it
  // answers, so a reload landing meanwhile may already hold the change and
  // moveCount would then count it twice: counts are left alone until then.
  const statusPending = useRef(0);
  const statusStart = useCallback(() => { statusPending.current++; }, []);
  const statusFailed = useCallback(() => { statusPending.current = Math.max(0, statusPending.current - 1); }, []);
  // The ticket in the Peek pane stays there while its Undo is up, even once a
  // poll no longer lists it (just closed, in the Open view): { ticket, until }
  const kept = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    const edits = countEdits.current;
    try {
      const data = await api.inbox({ view, q: debounced, page, pageSize, sort });
      setConfigured(data.configured);
      setTickets(data.tickets || []);
      if (edits === countEdits.current && !statusPending.current) setCounts(data.counts || { byStatus: {} });
      setTotal(data.total || 0);
      setFetchedAt(data.fetchedAt);
      setErr(data.error || null);
      setSyncWarning(data.syncWarning || null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [view, debounced, page, sort]);

  // load on filter/search/page change + auto-refresh every 30s
  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  // A status change made in a ticket moves it from one chip to another. Move
  // it here rather than reloading: a reload drops a just-closed ticket from the
  // Open list, which shuts the peek pane and its Undo. The next poll brings
  // the server's numbers back anyway.
  const moveCount = useCallback((from, to, ticket) => {
    statusFailed(); // this save is done
    if (!from || !to || from === to) return;
    countEdits.current++;
    const closedType = (s) => (/closed/i.test(s) ? 1 : 0); // as the server counts it
    setCounts((c) => {
      const byStatus = { ...(c.byStatus || {}) };
      byStatus[from] = Math.max(0, (byStatus[from] || 0) - 1);
      byStatus[to] = (byStatus[to] || 0) + 1;
      const shift = closedType(to) - closedType(from); // +1 closing, -1 reopening
      return { ...c, byStatus, closed: (c.closed || 0) + shift, active: Math.max(0, (c.active || 0) - shift) };
    });
    // the "14 tickets · open" line follows the chip (the row itself stays)
    const inView = (s) =>
      view === "all" ? 1 : view === "open" ? +OPEN_TYPE_RE.test(s) : view === "active" ? 1 - closedType(s) : +(s === view);
    const d = inView(to) - inView(from);
    if (d) setTotal((t) => Math.max(0, t + d));
    if (ticket) kept.current = { ticket, until: Date.now() + 10000 };
  }, [view, statusFailed]);
  // spam / trash / merge: the ticket really is gone from the list
  const reload = useCallback(() => { kept.current = null; load(); }, [load]);

  if (!configured)
    return (
      <div className="banner warn">
        Zoho Desk is not configured. Add your credentials to <b>.env</b> and restart
        the server to load live tickets.
      </div>
    );

  // status chips, biggest first, after the two fixed views (Open/Escalated
  // are folded into the fixed "Open" chip, like Zoho's view)
  const statusViews = Object.entries(counts.byStatus || {})
    .filter(([status]) => !OPEN_TYPE_RE.test(status))
    .sort((a, b) => b[1] - a[1])
    .map(([status, n]) => ({ key: status, label: status, n }));
  const statusOptions = Object.keys(counts.byStatus || {});
  const openCount = Object.entries(counts.byStatus || {})
    .filter(([s]) => OPEN_TYPE_RE.test(s))
    .reduce((n, [, c]) => n + c, 0);
  const countFor = (key) =>
    key === "all" ? counts.all
    : key === "open" ? openCount
    : key === "active" ? counts.active
    : counts.byStatus?.[key] || 0;

  // origin filter is applied to the loaded page (badges show the source)
  const shown = source === "all" ? tickets : tickets.filter((t) => ticketSource(t).label === source);

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <>
      <div className="section-title">
        <h2>Tickets</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {syncWarning && (
            <span style={{ fontSize: 12, color: "#c8912a" }} title={syncWarning}>
              Live sync delayed (showing last saved)
            </span>
          )}
          <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>
            {loading ? "Syncing…" : `Auto-syncs every 30s · last ${fetchedAt ? new Date(fetchedAt).toLocaleTimeString() : "—"}`}
          </span>
          <div className="seg">
            <button className={layout === "split" ? "active" : ""} title="Peek view (list + side panel)" onClick={() => setLayout("split")}>Peek</button>
            <button className={layout === "list" ? "active" : ""} title="List view" onClick={() => setLayout("list")}>List</button>
          </div>
          <button className="btn sm" onClick={load}>↻ Refresh</button>
          <button className="btn sm primary" onClick={() => setNewOpen(true)}>+ New ticket</button>
        </div>
      </div>

      {/* ── filter bar ─────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        {/* status chips (Active / All / one per real Zoho status) */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {FIXED_VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className={`chip ${view === v.key ? "active" : ""}`}
            >
              {v.label} <span style={{ opacity: 0.6 }}>{countFor(v.key)}</span>
            </button>
          ))}
          {statusViews.length > 0 && (
            <span style={{ width: 1, height: 20, background: "var(--line)", margin: "0 4px" }} />
          )}
          {statusViews.map((v) => (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className={`chip ${view === v.key ? "active" : ""}`}
            >
              {v.label} <span style={{ opacity: 0.6 }}>{v.n}</span>
            </button>
          ))}
        </div>
        {/* search + sort */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <input
            className="field"
            style={{ flex: "1 1 200px", minWidth: 160, padding: "7px 11px", border: "1px solid var(--line)", borderRadius: 8, background: "#fffef9" }}
            placeholder="Search # / subject / customer / email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--ink-faint)" }}>
            Source:
            <select
              className="status-select"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              title="Filter by where the ticket came from"
            >
              <option value="all">All sources</option>
              {[...new Set(tickets.map((t) => ticketSource(t).label))].sort().map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--ink-faint)" }}>
            Sort:
            <select
              className="status-select"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              title="Order tickets"
            >
              {SORT_OPTIONS.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div style={{ fontSize: 13, color: "var(--ink-faint)", margin: "0 2px 10px" }}>
        {total} ticket{total === 1 ? "" : "s"}
        {view !== "all" && view !== "active" ? ` · ${view}` : view === "active" ? " · active" : ""}
        {debounced ? ` · matching “${debounced}”` : ""}
        {source !== "all" ? ` · showing ${shown.length} from ${source}` : ""}
      </div>

      {err && <div className="banner error">{err}</div>}

      {shown.length === 0 ? (
        <div className="empty">{loading ? "Loading…" : "No tickets match this view."}</div>
      ) : layout === "split" ? (
        <div className="peek">
          <div className="peek-list">
            {shown.map((t) => (
              <CompactRow key={t.id} ticket={t} selected={openId === t.id} onClick={() => setOpenId(t.id)} />
            ))}
          </div>
          <div className="peek-detail">
            {(() => {
              const k = kept.current;
              const sel = tickets.find((t) => t.id === openId) ||
                (k?.ticket.id === openId && Date.now() < k.until ? k.ticket : null);
              return sel ? (
                <AnyTicketRow
                  key={sel.id}
                  sideOpen={sideOpen}
                  onToggleSide={toggleSide}
                  ticket={sel}
                  statusOptions={statusOptions}
                  signature={signature}
                  open
                  peek
                  onToggle={() => {}}
                  onChanged={reload}
                  onStatusStart={statusStart}
                  onStatusChanged={moveCount}
                  onStatusFailed={statusFailed}
                />
              ) : (
                <div className="empty" style={{ marginTop: 40 }}>← Select a ticket to view it</div>
              );
            })()}
          </div>
        </div>
      ) : (
        <>
          <BulkBar
            ids={[...picked]}
            tickets={shown}
            onClear={() => setPicked(new Set())}
            onPickAll={(ids) => setPicked(new Set(ids))}
            onDone={(keep = []) => { setPicked(new Set(keep)); load(); }}
          />
          {shown.map((t) => (
            <AnyTicketRow
              key={t.id}
              sideOpen={sideOpen}
              onToggleSide={toggleSide}
              ticket={t}
              statusOptions={statusOptions}
              signature={signature}
              open={openId === t.id}
              onToggle={() => setOpenId(openId === t.id ? null : t.id)}
              onChanged={reload}
              onStatusStart={statusStart}
              onStatusChanged={moveCount}
              onStatusFailed={statusFailed}
              selected={picked.has(t.id)}
              onSelect={(id, on) =>
                setPicked((prev) => {
                  const next = new Set(prev);
                  on ? next.add(id) : next.delete(id);
                  return next;
                })
              }
            />
          ))}
        </>
      )}

      <FileViewer />

      {newOpen && (
        <NewTicketModal
          onClose={() => setNewOpen(false)}
          onCreated={(t) => { setNewOpen(false); load(); if (t?.id) setOpenId(t.id); }}
        />
      )}

      {/* ── pagination ─────────────────────────────────────── */}
      {total > pageSize && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14, margin: "18px 0 4px" }}>
          <button className="btn sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>← Prev</button>
          <span style={{ fontSize: 13, color: "var(--ink-faint)" }}>
            {from}–{to} of {total} · page {page} / {pages}
          </span>
          <button className="btn sm" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>Next →</button>
        </div>
      )}
    </>
  );
}

function fmtTime(t) {
  if (!t) return "";
  try {
    return new Date(t).toLocaleString();
  } catch {
    return "";
  }
}

function fmtDate(t) {
  if (!t) return "";
  try {
    return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

// compact "time ago" (e.g. 3h, 2d, 5mo) for the last-activity hint
function ago(t) {
  if (!t) return "";
  const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
  const m = s / 60, h = m / 60, d = h / 24;
  if (d >= 30) return `${Math.floor(d / 30)}mo ago`;
  if (d >= 1) return `${Math.floor(d)}d ago`;
  if (h >= 1) return `${Math.floor(h)}h ago`;
  if (m >= 1) return `${Math.floor(m)}m ago`;
  return "just now";
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// Live "waiting since the customer last wrote" timer, colour-coded by age.
function WaitTimer({ since, status }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  if (!since || /closed/i.test(status || "")) return null;
  const ms = now - new Date(since).getTime();
  const hours = ms / 3600000;
  const color = hours < 4 ? "#3b7a57" : hours < 24 ? "#c8912a" : "#c0392b";
  return (
    <span className="wait" style={{ color, borderColor: color }} title={`Customer waiting since ${fmtTime(since)}`}>
      {fmtDuration(ms)}
    </span>
  );
}

// Quotes too: the result also goes inside href="…" (plainToHtml)
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// Drop <img> tags whose src isn't a real web URL (broken blob:/data:/cid: from a
// pasted screenshot) so we never send a broken image to the customer.
function stripBrokenImgs(html) {
  return String(html || "").replace(/<img\b[^>]*>/gi, (tag) => {
    const m = tag.match(/\ssrc\s*=\s*["']([^"']*)["']/i);
    return m && /^https?:\/\//i.test(m[1]) ? tag : "";
  });
}
// AI draft is plain text → HTML for the rich editor (links + line breaks).
// A URL stops at a quote: that is punctuation around it, not part of it.
function plainToHtml(text) {
  return escapeHtml(text)
    .replace(/(https?:\/\/(?:(?!&quot;|&#39;)[^\s<])+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, "<br>");
}
// The model now returns formatted HTML; use it (sanitized — it goes straight
// into the editor and out to the customer). Fall back to plainToHtml only if
// it looks like plain text: a reply made only of <div>s (what the editor
// itself produces) is HTML too, not text to escape into literal tags.
function draftToHtml(draft) {
  const d = draft || "";
  return /<(p|div|span|font|ul|ol|li|strong|em|a|br|b|i|u|h[1-6]|table|blockquote|img)\b[^>]*>/i.test(d)
    ? sanitizeEmailHtml(d, { display: false })
    : plainToHtml(d);
}

// The editor still holds the AI's own draft, or nearly (under 5% of its words
// changed — feedback.js's "sent as is" line)? Notes made of it are the AI's.
function nearlyAiDraft(aiDraft, html) {
  const words = (s) =>
    s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
  const a = words(draftToHtml(aiDraft));
  const b = words(html);
  const left = new Map();
  for (const w of a) left.set(w, (left.get(w) || 0) + 1);
  let same = 0;
  for (const w of b) {
    if (left.get(w)) {
      left.set(w, left.get(w) - 1);
      same++;
    }
  }
  const n = Math.max(a.length, b.length, 1);
  return (n - same) / n < 0.05;
}

// Conversation + internal notes interleaved chronologically. Unless "Show
// earlier" was clicked only the last 4 items are shown (and translated).
function buildTimeline(conversation, notes, showAll) {
  const all = [
    ...(conversation || []).map((m) => ({ kind: "msg", m, t: m.createdTime || "" })),
    ...(notes || []).map((n) => ({ kind: "note", n, t: n.createdTime || "" })),
  ].sort((a, b) => (a.t > b.t ? 1 : -1));
  const hidden = !showAll && all.length > 4 ? all.length - 4 : 0;
  return { hidden, items: all.slice(hidden) };
}

// Minimal rich-text editor (contentEditable + execCommand). Uncontrolled: the
// content is set only when `docKey` changes (new/regenerated draft), so typing
// never resets the cursor. Parent reads the html via onChange.
function RichEditor({ docKey, initialHtml, disabled, onChange, onImagePaste }) {
  const ref = useRef(null);
  // The one way HTML gets into the editor (AI draft, forward, template,
  // signature, restored draft), so it is sanitized here: a forwarded email or
  // a model answer must never run in the app. The parent then holds what is
  // shown, which is what gets sent.
  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = sanitizeEmailHtml(initialHtml || "", { display: false });
    if (ref.current.innerHTML !== (initialHtml || "")) onChange?.(ref.current.innerHTML);
  }, [docKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const exec = (cmd, val) => {
    document.execCommand(cmd, false, val);
    ref.current?.focus();
    onChange?.(ref.current?.innerHTML || "");
  };
  const btn = (label, cmd, title) => (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()} // keep the editor selection
      onClick={() => exec(cmd)}
    >
      {label}
    </button>
  );

  const onPaste = (e) => {
    // Pasting an image (screenshot) → upload it as an attachment instead of
    // letting the browser insert a broken temporary <img>.
    const imgs = [];
    for (const it of e.clipboardData?.items || []) {
      if (it.kind === "file" && (it.type || "").startsWith("image/")) {
        const f = it.getAsFile();
        if (f) imgs.push(f);
      }
    }
    if (imgs.length) {
      e.preventDefault();
      onImagePaste?.(imgs);
      return;
    }
    // Pasting plain text that contains a URL → auto-convert it to a hyperlink.
    const html = e.clipboardData?.getData("text/html");
    const text = e.clipboardData?.getData("text/plain");
    if (html || !text || !/https?:\/\/\S/.test(text)) return; // let rich paste through
    e.preventDefault();
    document.execCommand("insertHTML", false, plainToHtml(text));
    onChange?.(ref.current?.innerHTML || "");
  };

  return (
    <div className="rich">
      <div className="rich-toolbar">
        {btn(<b>B</b>, "bold", "Bold")}
        {btn(<i>I</i>, "italic", "Italic")}
        {btn(<u>U</u>, "underline", "Underline")}
        <select
          title="Font size"
          defaultValue=""
          onMouseDown={(e) => e.preventDefault()}
          onChange={(e) => { if (e.target.value) exec("fontSize", e.target.value); e.target.value = ""; }}
          style={{ fontSize: 12, border: "1px solid var(--line)", borderRadius: 6, background: "var(--card)", color: "var(--ink)", cursor: "pointer", padding: "3px 4px" }}
        >
          <option value="" disabled>Size</option>
          <option value="2">Small</option>
          <option value="3">Normal</option>
          <option value="5">Large</option>
          <option value="6">Huge</option>
        </select>
        {btn("• List", "insertUnorderedList", "Bullet list")}
        {btn("1. List", "insertOrderedList", "Numbered list")}
        <button
          type="button"
          title="Insert link"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const url = prompt("Link URL:");
            if (url) exec("createLink", url);
          }}
        >
          Link
        </button>
        {btn("✕ Clear", "removeFormat", "Clear formatting")}
      </div>
      <div
        className="rich-editor"
        ref={ref}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onPaste={onPaste}
        onInput={() => onChange?.(ref.current?.innerHTML || "")}
      />
    </div>
  );
}

// Triage lane → colors. Nothing auto-sends; this just guides the reviewer.
const LANES = {
  ready: { bg: "#e7f4ec", border: "#3b7a57", text: "#205038", icon: "" },
  review: { bg: "#fdf4e3", border: "#c8912a", text: "#7a5712", icon: "" },
  sensitive: { bg: "#fdecec", border: "#c0392b", text: "#7a221a", icon: "" },
};

function LaneBanner({ triage }) {
  const l = LANES[triage.lane] || LANES.review;
  const pretty = (s) => (s || "").replace(/_/g, " ");
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 10, margin: "14px 0 8px",
        padding: "8px 12px", borderRadius: 8, background: l.bg,
        border: `1px solid ${l.border}`, color: l.text, fontSize: 13,
      }}
    >
      <span style={{ fontWeight: 700 }}>{l.icon} {triage.label}</span>
      <span style={{ opacity: 0.8 }}>· {pretty(triage.intent)} · confidence: {triage.confidence}</span>
    </div>
  );
}

function StatusSelect({ status, options = [], onChange, saving }) {
  const base = options.length ? options : ["Open", "Awaiting Response", "Closed"];
  const opts = base.includes(status) ? base : [status, ...base];
  return (
    <select
      className="status-select"
      value={status}
      disabled={saving}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value)}
      title="Change ticket status"
    >
      {opts.map((s) => (
        <option key={s} value={s}>{s}</option>
      ))}
    </select>
  );
}

// Create a new ticket by hand (phone/walk-in requests the team logs itself).
function NewTicketModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: "", email: "", phone: "", channel: "Phone", subject: "", description: "", cc: "", sendEmail: false });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [tpls, setTpls] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const inputStyle = { width: "100%", padding: "8px 11px", border: "1px solid var(--line)", borderRadius: 8, background: "#fffef9", fontSize: 13, boxSizing: "border-box" };
  useEffect(() => {
    api.templates().then((r) => setTpls((r.templates || []).slice().sort((a, b) => (a.title || "").localeCompare(b.title || "")))).catch(() => setTpls([]));
  }, []);
  const insertTemplate = (id) => {
    const t = (tpls || []).find((x) => x.id === id);
    if (!t) return;
    setForm((f) => ({ ...f, description: (f.description ? f.description + "\n\n" : "") + (t.body || "") }));
  };
  const submit = async () => {
    if (!form.subject.trim()) { setErr("Subject is required."); return; }
    if (!form.name.trim() && !form.email.trim()) { setErr("Enter at least the customer's name or email."); return; }
    if (form.sendEmail && !form.email.trim()) { setErr("An email is required to send the message to the customer."); return; }
    setSaving(true);
    setErr(null);
    try {
      const r = await api.createTicket(form);
      onCreated?.(r.ticket);
    } catch (e) {
      setErr(e.message);
      setSaving(false);
    }
  };
  return (
    <div className="lightbox" onClick={onClose} style={{ alignItems: "flex-start", paddingTop: "7vh" }}>
      <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 540, padding: 22, cursor: "default" }}>
        <h3 style={{ margin: "0 0 12px" }}>New ticket</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <label style={{ fontSize: 12, color: "var(--ink-soft)" }}>Customer name
            <input value={form.name} onChange={set("name")} style={inputStyle} placeholder="Jane Smith" />
          </label>
          <label style={{ fontSize: 12, color: "var(--ink-soft)" }}>Email
            <input type="email" value={form.email} onChange={set("email")} style={inputStyle} placeholder="jane@example.com" />
          </label>
          <label style={{ fontSize: 12, color: "var(--ink-soft)" }}>Phone (optional)
            <input value={form.phone} onChange={set("phone")} style={inputStyle} placeholder="+1 555 123 4567" />
          </label>
          <label style={{ fontSize: 12, color: "var(--ink-soft)" }}>Channel
            <select value={form.channel} onChange={set("channel")} style={inputStyle}>
              <option>Phone</option>
              <option>Email</option>
              <option>Web</option>
              <option>Chat</option>
            </select>
          </label>
        </div>
        <label style={{ display: "block", fontSize: 12, color: "var(--ink-soft)", marginTop: 10 }}>Subject *
          <input value={form.subject} onChange={set("subject")} style={inputStyle} placeholder="e.g. Missing strainer for S-823 sink" />
        </label>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
          <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>Description</span>
          <select
            value=""
            onChange={(e) => { insertTemplate(e.target.value); e.target.value = ""; }}
            style={{ fontSize: 11, padding: "3px 6px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--card)", color: "var(--ink-soft)", cursor: "pointer", maxWidth: 220 }}
          >
            <option value="" disabled>{tpls === null ? "Loading templates…" : "+ Insert a template…"}</option>
            {(tpls || []).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </div>
        <textarea rows={5} value={form.description} onChange={set("description")} style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit", marginTop: 4 }} placeholder="What the customer reported / asked for — or the message to send them…" />
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 13, color: "var(--ink)" }}>
          <input
            type="checkbox"
            checked={form.sendEmail}
            onChange={(e) => setForm((f) => ({ ...f, sendEmail: e.target.checked }))}
          />
          Also email this description to the customer (signature added automatically)
        </label>
        {form.sendEmail && (
          <label style={{ display: "block", fontSize: 12, color: "var(--ink-soft)", marginTop: 8 }}>Cc (optional, comma-separated)
            <input value={form.cc} onChange={set("cc")} style={inputStyle} placeholder="someone@company.com" />
          </label>
        )}
        {err && <div className="banner error" style={{ marginTop: 10 }}>{err}</div>}
        <div style={{ display: "flex", gap: 10, marginTop: 16, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={saving}>
            {saving ? <><span className="spin" /> Creating…</> : "Create ticket"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Compact row for the peek (split) view — click to open the ticket on the right.
function CompactRow({ ticket, selected, onClick }) {
  return (
    <div className={`peek-row ${selected ? "sel" : ""}`} onClick={onClick}>
      <div className="peek-subj">{ticket.subject}</div>
      <div className="peek-meta">
        <SourceBadge ticket={ticket} />
        <span className="mono">#{ticket.number}</span>
        <span className="peek-cust">{ticket.customerName}</span>
        <span style={{ marginLeft: "auto", flexShrink: 0 }}>
          <WaitTimer since={ticket.customerResponseTime} status={ticket.status} />
        </span>
      </div>
    </div>
  );
}

// A Best Buy Marketplace thread, rendered inside the same Inbox queue.
// Replies go back into Best Buy's own messaging via the Mirakl API.
function BestBuyTicketRow({ ticket, open, onToggle }) {
  const threadId = String(ticket.id).replace(/^bb:/, "");
  const [detail, setDetail] = useState(null);
  const [order, setOrder] = useState(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!open || detail || loading) return;
    setLoading(true);
    api.bbThread(threadId).then(setDetail).catch((e) => setErr(e.message)).finally(() => setLoading(false));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const generate = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.bbDraft(threadId);
      setDraft(r.draft || "");
      setOrder(r.order || null);
      if (r.thread) setDetail(r.thread);
    } catch (e) { setErr(`Draft failed: ${e.message}`); }
    finally { setBusy(false); }
  };
  const send = async () => {
    if (!draft.trim()) return;
    if (!confirm(`Send this reply to ${ticket.customerName} on Best Buy Marketplace?`)) return;
    setSending(true); setErr(null);
    try {
      await api.bbReply(threadId, draft);
      setSent(true);
      api.bbThread(threadId).then(setDetail).catch(() => {});
    } catch (e) { setErr(`Send failed: ${e.message}`); }
    finally { setSending(false); }
  };

  return (
    <div className="ticket">
      <div className="ticket-head" onClick={onToggle}>
        <div>
          <div className="ticket-subj">{ticket.subject}</div>
          <div className="ticket-meta">
            <SourceBadge ticket={ticket} />
            <span className="mono">#{ticket.number}</span>
            <span>{ticket.customerName}</span>
            {ticket.modifiedTime && <span>· {ago(ticket.modifiedTime)}</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          {!/closed/i.test(ticket.status || "") && (
            <span className="wait" style={{ color: "#c0392b", borderColor: "#c0392b" }}>awaiting reply</span>
          )}
        </div>
      </div>

      {open && (
        <div className="ticket-body">
          {err && <div className="banner error" style={{ marginTop: 12 }}>{err}</div>}
          {loading && <div style={{ padding: "14px 0", color: "var(--ink-faint)" }}><span className="spin" /> Loading the Best Buy conversation…</div>}
          {detail && (
            <>
              {order && (
                <div style={{ fontSize: 12, color: "var(--ink-soft)", background: "var(--paper)", borderRadius: 8, padding: "8px 10px", margin: "10px 0" }}>
                  Order {order.id} · {order.state} · {order.date} · {order.items.map((i) => `${i.sku} ×${i.qty}`).join(", ")}
                </div>
              )}
              <div className="convo">
                {detail.messages.map((m) => (
                  <div key={m.id} className={`msg ${m.from === "customer" ? "in" : "out"}`}>
                    <div className="who">
                      <span>{m.from === "customer" ? detail.customer : "Sinks Direct"}</span>
                      <span className="when">{fmtTime(m.date)}</span>
                    </div>
                    <div className="text">{m.text}</div>
                  </div>
                ))}
              </div>
              {sent ? (
                <div style={{ color: "var(--green)", fontSize: 13 }}>Reply sent to the customer on Best Buy.</div>
              ) : (
                <>
                  <textarea
                    rows={6}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Write the reply, or generate one with AI…"
                    style={{ width: "100%", padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 8, background: "#fffef9", fontSize: 13.5, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }}
                  />
                  <div className="draft-actions">
                    <button className="btn primary" onClick={generate} disabled={busy}>
                      {busy ? <><span className="spin" /> Drafting…</> : "Generate reply with AI"}
                    </button>
                    <button className="btn send" onClick={send} disabled={sending || !draft.trim()}>
                      {sending ? <><span className="spin" /> Sending…</> : "Send via Best Buy"}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Picks the right renderer: Zoho ticket or Best Buy marketplace thread.
// Bulk actions over the checked rows. Clearing a queue one ticket at a time is
// the slow part of triage, so this closes them in one pass — sequentially, to
// stay inside Zoho's rate limit, and it reports what failed instead of
// pretending everything worked.
function BulkBar({ ids, tickets, onClear, onPickAll, onDone }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [note, setNote] = useState(null);
  if (!ids.length) return null;

  const allIds = tickets.map((t) => t.id);
  const chosen = tickets.filter((t) => ids.includes(t.id));
  // Best Buy rows mirror marketplace threads, not Zoho tickets — they can't be
  // merged, so they're excluded rather than failing halfway through.
  const mergeable = chosen.filter((t) => !String(t.id).startsWith("bb:"));
  // the oldest ticket survives: it holds the original conversation
  const primary = [...mergeable].sort((a, b) => Number(a.number) - Number(b.number))[0];

  const closeAll = async () => {
    if (!window.confirm(`Close ${ids.length} ticket${ids.length > 1 ? "s" : ""}?`)) return;
    setBusy(true);
    setDone(0);
    setNote(null);
    const bad = [];
    for (const id of ids) {
      try { await api.setStatus(id, "Closed"); } catch { bad.push(id); }
      setDone((n) => n + 1);
    }
    setBusy(false);
    if (bad.length) setNote(`${bad.length} could not be closed`);
    // reload even after a partial failure, or the closed ones linger in the
    // list and the chips; the failures stay selected so the note still shows
    onDone(bad);
  };

  const mergeAll = async () => {
    const others = mergeable.filter((t) => t.id !== primary.id).map((t) => t.id);
    const skipped = chosen.length - mergeable.length;
    if (
      !window.confirm(
        `Merge ${others.length} ticket${others.length > 1 ? "s" : ""} INTO #${primary.number}?\n\n` +
          `Their messages move into #${primary.number} (the oldest of the selection) and the others go away. This cannot be undone.` +
          (skipped ? `\n\n${skipped} Best Buy thread(s) will be skipped — those can't be merged.` : "")
      )
    ) return;
    setBusy(true);
    setNote(null);
    try {
      await api.merge(primary.id, others);
      onDone();
    } catch (e) {
      setNote(`Merge failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bulk-bar">
      <strong>{ids.length} selected</strong>
      <button className="btn sm" onClick={() => onPickAll(allIds)} disabled={busy || ids.length === allIds.length}>
        Select all {allIds.length}
      </button>
      <button className="btn sm" onClick={onClear} disabled={busy}>Clear</button>
      {note && <span style={{ color: "var(--red)", fontSize: 12 }}>{note}</span>}
      <button
        className="btn sm"
        onClick={mergeAll}
        disabled={busy || mergeable.length < 2}
        title={mergeable.length < 2 ? "Select at least two Zoho tickets" : `Merge into #${primary.number}`}
        style={{ marginLeft: "auto" }}
      >
        {mergeable.length >= 2 ? `Merge into #${primary.number}` : "Merge"}
      </button>
      <button className="btn sm primary" onClick={closeAll} disabled={busy}>
        {busy ? `Working ${done}/${ids.length}…` : `Close ${ids.length}`}
      </button>
    </div>
  );
}

function AnyTicketRow(props) {
  return String(props.ticket.id).startsWith("bb:")
    ? <BestBuyTicketRow ticket={props.ticket} open={props.open} onToggle={props.onToggle} />
    : <TicketRow {...props} />;
}

function TicketRow({ ticket, open, onToggle, statusOptions = [], onChanged, onStatusStart, onStatusChanged, onStatusFailed, signature = "", peek = false, selected = false, onSelect = null, sideOpen = true, onToggleSide = null }) {
  const [conversation, setConversation] = useState(null);
  const [convoLoading, setConvoLoading] = useState(false);
  const [convoError, setConvoError] = useState(null);
  const [convoLoaded, setConvoLoaded] = useState(false);

  // conversation translation, per message and keyed by message id (never by
  // position, so a reload after send/merge/draft can't shift translations
  // onto the wrong bubble): xl["<msgId>|<lang>"] = {pending} | {html, partial} | {error}
  const [view, setView] = useState("orig");
  const [xl, setXl] = useState({});
  const xlBusy = useRef(new Set()); // keys with a request in flight

  // AI draft + triage (rich-text)
  const [draftHtml, setDraftHtml] = useState("");
  const [docKey, setDocKey] = useState(0);
  const [triage, setTriage] = useState(null);
  // the ORIGINAL AI draft + triage, kept unmutated so we can measure how much
  // the agent edited it when they send (the feedback loop).
  const [aiMeta, setAiMeta] = useState(null);
  // how the reply in the editor was built (AI from notes / Improve / a
  // template), sent along so the KB learns from the team's words, not the AI's
  const originRef = useRef({});
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState(null);

  // status
  const [status, setStatusState] = useState(ticket.status);
  const [statusSaving, setStatusSaving] = useState(false);
  // a poll can bring a status changed elsewhere (Zoho, a bulk close): follow
  // it, unless a change made here is still being saved
  useEffect(() => {
    if (!statusSaving) setStatusState(ticket.status);
  }, [ticket.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const [undoFrom, setUndoFrom] = useState(null);   // status to restore after a quick close
  const undoTimer = useRef(null);
  useEffect(() => () => clearTimeout(undoTimer.current), []);

  // editable subject (#8) — fix unhelpful subjects like "Fw: please see"
  const [subj, setSubj] = useState(ticket.subject);
  const [editingSubj, setEditingSubj] = useState(false);
  const saveSubject = async (next) => {
    setEditingSubj(false);
    const v = (next || "").trim();
    if (!v || v === subj) return;
    const prev = subj;
    setSubj(v);
    try {
      await api.setSubject(ticket.id, v);
    } catch (e) {
      setSubj(prev);
      alert(`Could not rename: ${e.message}`);
    }
  };

  // editable recipient (#2) — reply to a different/extra address when needed
  const [toEmail, setToEmail] = useState(ticket.customerEmail || "");

  // files to attach on the outgoing reply (#6)
  const [outFiles, setOutFiles] = useState([]); // [{id,name,size}]
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const uploadFiles = async (fileList) => {
    const files = [...(fileList || [])];
    if (!files.length) return;
    setUploading(true);
    setSendError(null);
    for (const f of files) {
      try {
        const up = await api.uploadAttachment(ticket.id, f);
        setOutFiles((prev) => [...prev, { ...up, file: f }]); // keep the File: the preview reads it locally
      } catch (err) {
        setSendError(`Could not attach ${f.name}: ${err.message}`);
      }
    }
    setUploading(false);
  };
  const onPickFiles = (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = ""; // allow re-picking the same file
    uploadFiles(files);
  };
  const onDropFiles = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
  };

  // merge with other tickets from the same customer (#10)
  const [mergeOpen, setMergeOpen] = useState(false);
  const [related, setRelated] = useState(null);
  const [mergeSel, setMergeSel] = useState(new Set());
  const [merging, setMerging] = useState(false);
  const openMerge = async () => {
    setMergeOpen((v) => !v);
    if (!related) {
      try {
        const r = await api.related(ticket.id);
        setRelated(r.tickets || []);
      } catch {
        setRelated([]);
      }
    }
  };
  const doMerge = async () => {
    const ids = [...mergeSel];
    if (!ids.length) return;
    if (!confirm(`Merge ${ids.length} ticket(s) into #${ticket.number}? Their messages move into this ticket. This cannot be undone.`)) return;
    setMerging(true);
    try {
      await api.merge(ticket.id, ids);
      setMergeOpen(false);
      setMergeSel(new Set());
      setRelated(null);
      setConvoLoaded(false); // re-pull the conversation (now includes merged threads)
      onChanged?.();
      loadConversation();
    } catch (e) {
      alert(`Merge failed: ${e.message}`);
    } finally {
      setMerging(false);
    }
  };

  // spam / trash
  const [acting, setActing] = useState(false);
  const actOn = async (kind) => {
    const msg =
      kind === "spam"
        ? `Mark #${ticket.number} as spam?\n\nIt will be hidden from the inbox (Zoho keeps it in the Spam view).`
        : `Delete #${ticket.number}?\n\nIt moves to the Zoho trash and can be restored from Zoho for ~60 days.`;
    if (!confirm(msg)) return;
    setActing(true);
    try {
      await (kind === "spam" ? api.markSpam(ticket.id) : api.trash(ticket.id));
      onChanged?.(); // reload the list — the ticket is gone from it
    } catch (e) {
      alert(`Could not ${kind === "spam" ? "mark as spam" : "delete"}: ${e.message}`);
    } finally {
      setActing(false);
    }
  };

  // send
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [cc, setCc] = useState("");          // extra recipients (#4)
  const [composing, setComposing] = useState(false); // manual / new reply mode
  const [improving, setImproving] = useState(false);
  const [xDraft, setXDraft] = useState(false); // translating the draft
  const [chatSending, setChatSending] = useState(false);
  const [chatSent, setChatSent] = useState(null);
  const sendAsWebsiteChat = async () => {
    const plain = draftHtml.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
    if (!plain || !toEmail.trim()) return;
    if (!confirm(`Send this reply into the WEBSITE CHAT for ${toEmail}?\n\nIt appears in the site's chat bubble (Wix also emails them if they left).`)) return;
    setChatSending(true);
    setSendError(null);
    try {
      const r = await api.wixChat(toEmail.trim(), plain);
      setChatSent(r.site || "Wix");
    } catch (e) {
      setSendError(`Website chat failed: ${e.message}`);
    } finally {
      setChatSending(false);
    }
  };

  // reply templates panel
  const [templates, setTemplates] = useState(null);
  const [tplOpen, setTplOpen] = useState(false);
  const [tplSearch, setTplSearch] = useState("");
  const toggleTemplates = async () => {
    setTplOpen((v) => !v);
    if (!templates) {
      try { const r = await api.templates(); setTemplates(r.templates || []); }
      catch { setTemplates([]); }
    }
  };
  const insertTemplate = (tpl) => {
    const html = plainToHtml(tpl.body || "");
    setDraftHtml((prev) => (prev && prev.replace(/<[^>]*>/g, "").trim() ? prev + "<br>" : "") + html);
    setDocKey((k) => k + 1);
    setComposing(true);
    setTplOpen(false);
    originRef.current = { ...originRef.current, template: true };
  };

  const improveCurrentDraft = async () => {
    if (!draftHtml.replace(/<[^>]*>/g, "").trim()) return;
    setImproving(true);
    setSendError(null);
    try {
      const r = await api.improveDraft(ticket.id, draftHtml);
      setDraftHtml(draftToHtml(r.reply));
      setDocKey((k) => k + 1);
      originRef.current = { ...originRef.current, improved: true };
    } catch (e) {
      setSendError(`Improve failed: ${e.message}`);
    } finally {
      setImproving(false);
    }
  };

  const translateCurrentDraft = async (target) => {
    if (!target || !draftHtml.replace(/<[^>]*>/g, "").trim()) return;
    setXDraft(true);
    setSendError(null);
    try {
      // Same segment translation as the conversation: the editor's own HTML
      // keeps its exact formatting and the model's text only becomes text.
      const r = await translateHtmlSegments(draftHtml, target, { skipQuoted: false });
      setDraftHtml(r.html);
      setDocKey((k) => k + 1);
      if (r.partial) setSendError("Part of the draft couldn't be translated — check it before sending.");
    } catch (e) {
      setSendError(`Translate failed: ${e.message}`);
    } finally {
      setXDraft(false);
    }
  };

  // ── auto-save the reply draft per ticket ─────────────────
  // Saved to localStorage while typing; restored when the ticket is reopened;
  // cleared on a successful send. Nothing typed is ever lost by navigating away.
  const draftKey = `draft:${ticket.id}`;
  const [draftRestored, setDraftRestored] = useState(false);
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!open || restoredRef.current) return;
    restoredRef.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) || "null");
      if (saved?.html && !draftHtml.replace(/<[^>]*>/g, "").trim()) {
        setDraftHtml(saved.html);
        // the AI draft it started from isn't kept, so edits to it can't be
        // measured — it still must not pass for the team's own words
        originRef.current = { ...(saved.origin || {}), aiRestored: Boolean(saved.ai) };
        if (saved.to) setToEmail(saved.to);
        if (saved.cc) setCc(saved.cc);
        setComposing(true);
        setDocKey((k) => k + 1);
        setDraftRestored(true);
      }
    } catch { /* ignore */ }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (sent) return;
    const id = setTimeout(() => {
      try {
        if (draftHtml.replace(/<[^>]*>/g, "").trim()) {
          localStorage.setItem(draftKey, JSON.stringify({ html: draftHtml, to: toEmail, cc, at: Date.now(), ai: Boolean(aiMeta || originRef.current.aiRestored), origin: originRef.current }));
        } else {
          localStorage.removeItem(draftKey);
        }
      } catch { /* storage full — skip */ }
    }, 800);
    return () => clearTimeout(id);
  }, [draftHtml, toEmail, cc, sent, draftKey]);

  // Reset the compose area for a fresh reply (used after a send + "write reply")
  const resetCompose = () => {
    setSent(false);
    setDraftHtml("");
    setDocKey((k) => k + 1);
    setAiMeta(null);
    originRef.current = {};
    setTriage(null);
    setOutFiles([]);
    setCc("");
    setSendError(null);
    setComposing(true);
  };

  // ticket attachments (#7)
  const [attachments, setAttachments] = useState([]);

  // Wayfair: PO details auto-loaded from CS/CA numbers in the ticket
  const [wayfairPos, setWayfairPos] = useState(null);

  // Bazaarvoice: retailer questions/reviews parsed from the alert + AI drafts
  const [bv, setBv] = useState(null);

  // Walmart: order details auto-loaded from long order numbers in the ticket
  const [walmartOrders, setWalmartOrders] = useState(null);

  // ShipStation: shipment lookup by order number (any channel)
  const [shipResults, setShipResults] = useState(null);
  const [shipQ, setShipQ] = useState("");
  const [shipLoading, setShipLoading] = useState(false);
  const searchShipment = async (num) => {
    const n = String(num ?? shipQ).trim();
    if (!n) return;
    setShipLoading(true);
    try { const r = await api.shipOrder(n); setShipResults(r.orders || []); }
    catch { setShipResults([]); }
    finally { setShipLoading(false); }
  };

  // RingCentral: phone history (calls / voicemails / SMS) + actions
  const [phoneHist, setPhoneHist] = useState(null);
  const [phoneVal, setPhoneVal] = useState("");
  const [phoneLoading, setPhoneLoading] = useState(false);
  const [smsText, setSmsText] = useState("");
  const [smsSending, setSmsSending] = useState(false);
  const loadPhone = async (override) => {
    setPhoneLoading(true);
    try {
      const r = await api.phoneHistory(ticket.id, override || phoneVal);
      setPhoneHist(r);
      if (r.phone && !phoneVal) setPhoneVal(r.phone);
    } catch { setPhoneHist({ calls: [], voicemails: [], sms: [] }); }
    finally { setPhoneLoading(false); }
  };
  const sendSms = async () => {
    if (!smsText.trim() || !phoneVal) return;
    setSmsSending(true);
    try { await api.rcSendSms(phoneVal, smsText); setSmsText(""); loadPhone(phoneVal); }
    catch (e) { alert(`SMS failed: ${e.message}`); }
    finally { setSmsSending(false); }
  };
  const callCustomer = async () => {
    let from = localStorage.getItem("agentPhone");
    if (!from) {
      from = prompt("Your phone number (RingCentral rings it first, then connects to the customer):");
      if (!from) return;
      localStorage.setItem("agentPhone", from);
    }
    try { await api.rcRingout(phoneVal, from); alert("Calling… your phone should ring now."); }
    catch (e) { alert(`Call failed: ${e.message}`); }
  };

  // Wix store: customer orders + product lookup
  const [orders, setOrders] = useState(null);
  const [ordersExpanded, setOrdersExpanded] = useState(false);
  const [showAllMsgs, setShowAllMsgs] = useState(false);
  const [prodQ, setProdQ] = useState("");
  const [prodResults, setProdResults] = useState(null);
  const [prodLoading, setProdLoading] = useState(false);
  const lookupProducts = async () => {
    if (!prodQ.trim()) return;
    setProdLoading(true);
    try { const r = await api.wixProducts(prodQ.trim()); setProdResults(r.products || []); }
    catch { setProdResults([]); }
    finally { setProdLoading(false); }
  };

  // private internal notes
  const [notes, setNotes] = useState([]);
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [noteFiles, setNoteFiles] = useState([]); // images/files to attach to the note
  const [noteUploading, setNoteUploading] = useState(false);
  const [noteDrag, setNoteDrag] = useState(false);
  const noteFileRef = useRef(null);
  const uploadNoteFiles = async (fileList) => {
    const files = [...(fileList || [])];
    if (!files.length) return;
    setNoteUploading(true);
    for (const f of files) {
      try { const up = await api.uploadAttachment(ticket.id, f); setNoteFiles((prev) => [...prev, { ...up, file: f }]); }
      catch (err) { alert(`Could not attach ${f.name}: ${err.message}`); }
    }
    setNoteUploading(false);
  };
  const onPickNoteFiles = (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    uploadNoteFiles(files);
  };
  const addNote = async () => {
    if (!noteText.trim() && !noteFiles.length) return;
    setSavingNote(true);
    try {
      await api.addNote(ticket.id, noteText, noteFiles.map((f) => f.id));
      setNoteText("");
      setNoteFiles([]);
      const r = await api.notes(ticket.id);
      setNotes(r.notes || []);
    } catch (e) {
      alert(`Could not save note: ${e.message}`);
    } finally {
      setSavingNote(false);
    }
  };

  // forward the customer's message to a colleague/supplier (reuses send)
  const forward = () => {
    const last = [...(conversation || [])].reverse().find((m) => m.direction !== "out");
    const orig = last?.html
      ? last.html
      : last?.text
      ? `<p>${escapeHtml(last.text).replace(/\n/g, "<br>")}</p>`
      : "";
    const header = `<p>---------- Forwarded message ----------<br>From: ${escapeHtml(ticket.customerName)} &lt;${escapeHtml(ticket.customerEmail || "")}&gt;<br>Subject: ${escapeHtml(subj)}</p>`;
    setComposing(true);
    setSent(false);
    setToEmail("");
    setCc("");
    setAiMeta(null);
    originRef.current = {};
    setTriage(null);
    setDraftHtml(`<p></p>${header}<blockquote>${orig}</blockquote>`);
    setDocKey((k) => k + 1);
  };

  const loadConversation = useCallback(async () => {
    setConvoLoading(true);
    setConvoError(null);
    // fetch the file list + notes + store orders in parallel — best-effort
    api.attachments(ticket.id).then((r) => setAttachments(r.attachments || [])).catch(() => {});
    api.notes(ticket.id).then((r) => setNotes(r.notes || [])).catch(() => {});
    if (ticket.customerEmail)
      api.wixOrders(ticket.customerEmail).then((r) => setOrders(r.orders || [])).catch(() => setOrders([]));
    else setOrders([]);
    // RingCentral phone history (auto by the ticket's phone)
    api.phoneHistory(ticket.id).then((r) => { setPhoneHist(r); if (r.phone) setPhoneVal(r.phone); }).catch(() => {});
    // Bazaarvoice alert? parse it and draft the public answers
    if (/bazaarvoice/i.test(ticket.customerEmail || "")) {
      setBv("loading");
      api.bazaarvoice(ticket.id).then((r) => setBv(r.items?.length ? r : null)).catch(() => setBv(null));
    }
    try {
      const res = await api.conversation(ticket.id);
      setConversation(res.conversation || []);
      setConvoLoaded(true);
      // auto-look up any order numbers mentioned in the ticket (ShipStation)
      const text = `${ticket.subject || ""} ${(res.conversation || []).filter((m) => m.direction !== "out").map((m) => m.text || "").join(" ")}`;
      const nums = extractOrderNums(text);
      if (nums.length) {
        // tell the server who this ticket is from — brands reuse order numbers,
        // and forwarded tickets hide the real address inside the body
        const who = {
          emails: [ticket.customerEmail, ...new Set(text.match(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g) || [])].filter(Boolean),
          names: [ticket.contactName].filter(Boolean),
        };
        Promise.all(nums.slice(0, 2).map((n) => api.shipOrder(n, who).then((r) => r.orders || []).catch(() => [])))
          .then((arr) => { const flat = arr.flat(); if (flat.length) setShipResults(flat); });
        const wfNums = nums.filter((n) => /^C[AS]\d{6,}$/i.test(n));
        if (wfNums.length) {
          api.wayfairPo(wfNums).then((r) => { if (r.pos?.length) setWayfairPos(r.pos); }).catch(() => {});
        }
      }
      // Walmart order ids are long numerics (12-18 digits)
      const wmNums = [...new Set((text.match(/\b\d{12,18}\b/g) || []))].slice(0, 3);
      if (wmNums.length) {
        api.walmartOrders(wmNums).then((r) => { if (r.orders?.length) setWalmartOrders(r.orders); }).catch(() => {});
      }
    } catch (e) {
      setConvoError(e.message);
    } finally {
      setConvoLoading(false);
    }
  }, [ticket.id]);

  useEffect(() => {
    if (open && !convoLoaded && !convoLoading) loadConversation();
  }, [open, convoLoaded, convoLoading, loadConversation]);

  const generate = useCallback(async (instructions, ownNotes = true) => {
    setDrafting(true);
    setDraftError(null);
    try {
      const res = await api.draft(ticket.id, ticket, typeof instructions === "string" ? instructions : undefined);
      if (res.conversation) {
        setConversation(res.conversation);
        setConvoLoaded(true);
      }
      setDraftHtml(draftToHtml(res.draft));
      setDocKey((k) => k + 1);
      setTriage({
        lane: res.lane, label: res.label, intent: res.intent,
        confidence: res.confidence, sensitive: res.sensitive,
      });
      setAiMeta({
        draft: res.draft, intent: res.intent, confidence: res.confidence,
        sensitive: res.sensitive, lane: res.lane, kbCovered: res.kbCovered,
        usedKb: res.usedKb,
      });
      // a fresh draft replaces the editor; "write from my notes" carries the
      // agent's own decision, so the KB may learn from it even if sent as-is
      originRef.current = { notes: typeof instructions === "string" && Boolean(instructions.trim()) && ownNotes };
    } catch (e) {
      setDraftError(e.message);
    } finally {
      setDrafting(false);
    }
  }, [ticket]);

  // Translate one message's own HTML segment by segment, so it keeps its
  // format (translateHtml.js). Its module-level cache dedupes requests across
  // remounts and StrictMode's double effects.
  const translateMsg = useCallback((m, lang) => {
    const key = `${m.id}|${lang}`;
    xlBusy.current.add(key);
    setXl((s) => ({ ...s, [key]: { pending: true } }));
    translateMessage(`${ticket.id}:${m.id}`, m.html || plainToHtml(m.text || ""), lang === "es" ? "Spanish" : "English").then(
      (r) => { xlBusy.current.delete(key); setXl((s) => ({ ...s, [key]: r })); },
      (e) => { xlBusy.current.delete(key); setXl((s) => ({ ...s, [key]: { error: e.message } })); }
    );
  }, [ticket.id]);

  // Only what's on screen is translated: the last few items, or all of them
  // once "Show earlier" is clicked. Newest first, at most 3 requests at once —
  // each one that lands re-runs this and starts the next. Messages that show
  // up after a send/merge/AI draft are picked up the same way.
  const timeline = useMemo(() => buildTimeline(conversation, notes, showAllMsgs), [conversation, notes, showAllMsgs]);
  const visibleMsgs = useMemo(
    () => timeline.items.filter((it) => it.kind === "msg" && (it.m.html || it.m.text)).map((it) => it.m),
    [timeline]
  );
  useEffect(() => {
    if (view === "orig") return;
    const todo = visibleMsgs.filter((m) => !xl[`${m.id}|${view}`] && !xlBusy.current.has(`${m.id}|${view}`)).reverse();
    for (const m of todo.slice(0, Math.max(0, 3 - xlBusy.current.size))) translateMsg(m, view);
  }, [view, visibleMsgs, xl, translateMsg]);
  const retryMsg = (m) => setXl((s) => { const n = { ...s }; delete n[`${m.id}|${view}`]; return n; });
  // every failed or partly translated message on screen, in one click
  const retryAll = () => setXl((s) => {
    const n = { ...s };
    for (const m of visibleMsgs) {
      const k = `${m.id}|${view}`;
      if (n[k]?.error || n[k]?.partial) delete n[k];
    }
    return n;
  });

  const translateTo = (lang) => setView(lang);
  // "Translating… (2 of 4)" → "Translated to Spanish · 1 couldn't be
  // translated · 1 partly translated", or "Couldn't translate…" when none worked
  const xlStatus = (() => {
    if (view === "orig") return { text: "Conversation" };
    const lang = view === "es" ? "Spanish" : "English";
    const st = visibleMsgs.map((m) => xl[`${m.id}|${view}`]);
    const done = st.filter((s) => s && !s.pending).length;
    const failed = st.filter((s) => s?.error).length;
    const partial = st.filter((s) => s?.partial).length;
    if (done < st.length) return { text: `Translating… (${done} of ${st.length})` };
    if (failed && failed === st.length)
      return { text: `Couldn't translate to ${lang} (${failed} of ${st.length})`, err: true, retry: true };
    const notes = [
      failed && `${failed} message${failed === 1 ? "" : "s"} couldn't be translated`,
      partial && `${partial} partly translated`,
    ].filter(Boolean);
    return { text: [`Translated to ${lang}`, ...notes].join(" · "), err: failed > 0, retry: notes.length > 0 };
  })();

  const changeStatus = async (next) => {
    const prev = status;
    setStatusState(next);
    setStatusSaving(true);
    onStatusStart?.();
    try {
      await api.setStatus(ticket.id, next);
      // keeps the chips right without a reload (covers quick close and Undo)
      onStatusChanged?.(prev, next, ticket);
      return true;
    } catch (e) {
      onStatusFailed?.();
      setStatusState(prev);
      setSendError(`Could not change status: ${e.message}`);
      return false;
    } finally {
      setStatusSaving(false);
    }
  };

  // One-click close, straight from the list — the queue is mostly tickets that
  // just need closing, and going through the status dropdown for each is slow.
  // Undo stays up for a few seconds so a misclick costs nothing.
  const quickClose = async () => {
    const prev = status;
    if (!(await changeStatus("Closed"))) return;
    setUndoFrom(prev);
    clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndoFrom(null), 10000);
  };

  const undoClose = async () => {
    clearTimeout(undoTimer.current);
    const back = undoFrom;
    setUndoFrom(null);
    await changeStatus(back);
  };

  const hasContent = draftHtml.replace(/<[^>]*>/g, "").trim().length > 0;

  const send = async () => {
    if (!hasContent) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toEmail.trim())) {
      setSendError("Enter a valid recipient email address.");
      return;
    }
    if (triage?.lane === "sensitive") {
      const ok = confirm(
        "This ticket was flagged as SENSITIVE (money, legal, or an upset customer). " +
          "Are you sure the reply is correct and ready to send to the customer?"
      );
      if (!ok) return;
    }
    setSending(true);
    setSendError(null);
    try {
      await api.send(
        ticket.id, toEmail.trim(), stripBrokenImgs(draftHtml), "html",
        aiMeta
          ? {
              aiDraft: aiMeta.draft, intent: aiMeta.intent,
              confidence: aiMeta.confidence, sensitive: aiMeta.sensitive,
              lane: aiMeta.lane, kbCovered: aiMeta.kbCovered,
              kbUsed: aiMeta.usedKb, ticketNumber: ticket.number,
            }
          : undefined,
        outFiles.map((f) => f.id),
        cc.trim(),
        originRef.current
      );
      setSent(true);
      setComposing(false);
      try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
      // refresh the thread so the reply we just sent shows up immediately
      setConvoLoaded(false);
      loadConversation();
    } catch (e) {
      setSendError(e.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={`ticket ${sent ? "sent" : ""}`}>
      <div className="ticket-head" onClick={onToggle}>
        {onSelect && (
          <input
            type="checkbox"
            className="pick"
            checked={selected}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onSelect(ticket.id, e.target.checked)}
            title="Select for bulk actions"
          />
        )}
        <div>
          <div className="ticket-subj" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {editingSubj ? (
              <input
                autoFocus
                defaultValue={subj}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveSubject(e.target.value);
                  if (e.key === "Escape") setEditingSubj(false);
                }}
                onBlur={(e) => saveSubject(e.target.value)}
                style={{ flex: 1, font: "inherit", padding: "2px 8px", border: "1px solid var(--line)", borderRadius: 6, background: "#fffef9" }}
              />
            ) : (
              <>
                <span>{subj}</span>
                <button
                  type="button"
                  title="Rename ticket"
                  onClick={(e) => { e.stopPropagation(); setEditingSubj(true); }}
                  style={{ border: "none", background: "none", cursor: "pointer", fontSize: 13, opacity: 0.45, padding: 2 }}
                >
                  ✎
                </button>
              </>
            )}
          </div>
          <div className="ticket-meta">
            <SourceBadge ticket={ticket} />
            <span className="mono">#{ticket.number}</span>
            <span>{ticket.customerName}</span>
            {ticket.customerEmail && <span>{ticket.customerEmail}</span>}
            {ticket.channel && <span>{ticket.channel}</span>}
            {ticket.createdTime && (
              <span title={`Created ${fmtTime(ticket.createdTime)}`}>{fmtDate(ticket.createdTime)}</span>
            )}
            {ticket.modifiedTime && (
              <span title={`Last activity ${fmtTime(ticket.modifiedTime)}`}>· updated {ago(ticket.modifiedTime)}</span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          {sent && <span className="badge sent">Sent</span>}
          <WaitTimer since={ticket.customerResponseTime} status={status} />
          <StatusSelect status={status} options={statusOptions} onChange={changeStatus} saving={statusSaving} />
          {undoFrom ? (
            <button
              className="btn sm"
              title={`Reopen — back to "${undoFrom}"`}
              disabled={statusSaving}
              onClick={(e) => { e.stopPropagation(); undoClose(); }}
              style={{ color: "var(--brass)", borderColor: "#e0cfa0" }}
            >
              Undo
            </button>
          ) : (
            !/^closed/i.test(status) && (
              <button
                className="btn sm"
                title="Close this ticket"
                disabled={statusSaving}
                onClick={(e) => { e.stopPropagation(); quickClose(); }}
                style={{ color: "#3b7a57", borderColor: "#bcd3c4" }}
              >
                Close
              </button>
            )
          )}
          {!/escalat/i.test(status) && (
            <button
              className="btn sm"
              title="Escalate this ticket"
              disabled={statusSaving}
              onClick={(e) => { e.stopPropagation(); changeStatus("Escalated"); }}
              style={{ color: "#c0392b", borderColor: "#e3b9b3" }}
            >
              Escalate
            </button>
          )}
          <button
            className="btn sm"
            title="Mark as spam (hide from inbox)"
            disabled={acting}
            onClick={(e) => { e.stopPropagation(); actOn("spam"); }}
          >
            Spam
          </button>
          <button
            className="btn sm"
            title="Delete (move to Zoho trash)"
            disabled={acting}
            onClick={(e) => { e.stopPropagation(); actOn("trash"); }}
          >
            Delete
          </button>
        </div>
      </div>

      {open && (
        <div className="ticket-body">
          {convoLoading && (
            <div style={{ padding: "16px 0", color: "var(--ink-faint)" }}>
              <span className="spin" /> Loading ticket…
            </div>
          )}

          {convoError && (
            <div className="banner error" style={{ marginTop: 14 }}>
              Could not load ticket: {convoError}
              <button className="btn sm" style={{ marginLeft: 10 }} onClick={loadConversation}>Retry</button>
            </div>
          )}

          {conversation && conversation.length === 0 && !convoLoading && (
            <div className="empty" style={{ textAlign: "left" }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>This ticket has no content — in Zoho either.</div>
              <div style={{ fontSize: 13, color: "var(--ink-faint)" }}>
                Zoho reports 0 messages, 0 comments and 0 attachments for it (usually a leftover from a
                merge/split or a mail-fetch glitch).{" "}
                {ticket.webUrl && (
                  <a href={ticket.webUrl} target="_blank" rel="noreferrer">Open it in Zoho</a>
                )}{" "}
                to confirm — if it's empty there too, you can safely delete or spam it from here.
              </div>
            </div>
          )}

          {/* the Hide/Show panel button lives in the conversation bar, so with
              no conversation to show (empty ticket, load error) the panel stays */}
          <div className={`ticket-cols${sideOpen || conversation?.length === 0 || convoError ? "" : " side-closed"}`}>
          <div className="ticket-main">
          {conversation && conversation.length > 0 && (
            <>
              <div className="convo-bar">
                <span className="xl-note" style={{ fontSize: 12, marginTop: 0, color: xlStatus.err ? "#c0392b" : "var(--ink-faint)" }}>
                  {xlStatus.text}
                  {xlStatus.retry && <> · <button type="button" onClick={retryAll}>Retry</button></>}
                </span>
                <div className="seg">
                  <button className={view === "orig" ? "active" : ""} onClick={() => translateTo("orig")}>Original</button>
                  <button className={view === "en" ? "active" : ""} onClick={() => translateTo("en")}>EN</button>
                  <button className={view === "es" ? "active" : ""} onClick={() => translateTo("es")}>ES</button>
                </div>
                {onToggleSide && (() => {
                  // count everything the panel holds, so hiding it never hides
                  // that there is an order or a call to look at
                  const calls = (phoneHist?.calls?.length || 0) + (phoneHist?.voicemails?.length || 0) + (phoneHist?.sms?.length || 0);
                  const parts = [
                    [orders?.length, "Wix order", "Wix orders"],
                    [wayfairPos?.length, "Wayfair PO", "Wayfair POs"],
                    [walmartOrders?.length, "Walmart order", "Walmart orders"],
                    [shipResults?.length, "shipment", "shipments"],
                    [calls, "call or SMS", "calls & SMS"],
                  ].filter(([k]) => k > 0);
                  const n = parts.reduce((s, [k]) => s + k, 0);
                  return (
                    <button
                      className="btn sm"
                      onClick={onToggleSide}
                      title={sideOpen
                        ? "Hide the customer panel so the email gets the full width"
                        : `Show orders, shipping and phone${parts.length ? ` — ${parts.map(([k, one, many]) => `${k} ${k === 1 ? one : many}`).join(" · ")}` : ""}`}
                    >
                      {sideOpen ? "Hide panel" : `Show panel${n ? ` (${n})` : ""}`}
                    </button>
                  );
                })()}
              </div>
              <div className="convo">
                {(() => {
                  // conversation + internal notes interleaved chronologically
                  const { hidden, items } = timeline;
                  return (
                    <>
                      {hidden > 0 && (
                        <button className="btn sm" onClick={() => setShowAllMsgs(true)} style={{ alignSelf: "center" }}>
                          ▾ Show {hidden} earlier item{hidden === 1 ? "" : "s"}
                        </button>
                      )}
                      {items.map((it) => {
                        if (it.kind === "note") {
                          const n = it.n;
                          const noteText = (n.content || "").replace(/<[^>]+>/g, " ").trim();
                          return (
                            <div key={"note-" + n.id} className="msg note-msg">
                              <div className="who">
                                <span>Internal note{n.author ? ` · ${n.author}` : ""}</span>
                                {n.createdTime && <span className="when">{fmtTime(n.createdTime)}</span>}
                              </div>
                              {noteText && <div className="text">{noteText}</div>}
                              <NoteAttachments ticketId={ticket.id} commentId={n.id} attachments={n.attachments} />
                            </div>
                          );
                        }
                        const m = it.m;
                        // translated: the message's own HTML with only its text swapped
                        const tx = view !== "orig" ? xl[`${m.id}|${view}`] : null;
                        const body = tx?.html || m.html || (m.text ? plainToHtml(m.text) : "");
                        return (
                          <div key={m.id} className={`msg ${m.direction === "out" ? "out" : "in"}`}>
                            <div className="who">
                              <span>{m.direction === "out" ? "Agent" : "Customer"}{m.author ? ` · ${m.author}` : ""}</span>
                              {m.createdTime && <span className="when">{fmtTime(m.createdTime)}</span>}
                            </div>
                            <div className="addrs">
                              <AddrLine label="From" value={m.from} />
                              <AddrLine label="To" value={m.to} />
                              <AddrLine label="Cc" value={m.cc} />
                            </div>
                            <div className="text">
                              {body ? (
                                <EmailHtml html={body} quotedNote={tx?.html ? "original language" : null} />
                              ) : (
                                "(no text)"
                              )}
                            </div>
                            {body && view !== "orig" && (!tx || tx.pending) && (
                              <div className="xl-note"><span className="spin" /> Translating…</div>
                            )}
                            {tx?.error && (
                              <div className="xl-note err" title={tx.error}>
                                Couldn't translate this message · <button type="button" onClick={() => retryMsg(m)}>Retry</button>
                              </div>
                            )}
                            {tx?.partial && (
                              <div className="xl-note">
                                Partly translated · <button type="button" onClick={() => retryMsg(m)}>Retry</button>
                              </div>
                            )}
                            <MessageAttachments ticketId={ticket.id} threadId={m.id} attachments={m.attachments} />
                          </div>
                        );
                      })}
                    </>
                  );
                })()}
              </div>
            </>
          )}

          {bv === "loading" && (
            <div style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 10 }}>
              <span className="spin" /> Reading the Bazaarvoice alert and drafting answers…
            </div>
          )}
          {bv && bv !== "loading" && <BazaarvoicePanel data={bv} />}

          <AttachmentStrip ticketId={ticket.id} attachments={attachments} />

          {/* ── add internal note (notes themselves show in the thread) ── */}
          <div style={{ marginTop: 10 }}>
            <button className="btn sm" onClick={() => setNotesOpen((v) => !v)}>
              Add internal note{notes.length ? ` (${notes.length})` : ""}{notesOpen ? " ▲" : ""}
            </button>
            {notesOpen && (
              <div
                className="card"
                style={{ marginTop: 8, padding: 12, outline: noteDrag ? "2px dashed var(--amber)" : "none", outlineOffset: 2 }}
                onDragOver={(e) => { e.preventDefault(); setNoteDrag(true); }}
                onDragLeave={() => setNoteDrag(false)}
                onDrop={(e) => { e.preventDefault(); setNoteDrag(false); if (e.dataTransfer?.files?.length) uploadNoteFiles(e.dataTransfer.files); }}
              >
                <div style={{ fontSize: 12, color: "var(--ink-faint)", marginBottom: 6 }}>
                  Private — the customer never sees notes. Drop images here or use the Image button.
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <textarea
                    rows={2}
                    value={noteText}
                    placeholder="Add a private note (internal only)… paste a screenshot to attach it"
                    onChange={(e) => setNoteText(e.target.value)}
                    onPaste={(e) => {
                      const imgs = [...(e.clipboardData?.items || [])]
                        .filter((it) => it.kind === "file" && (it.type || "").startsWith("image/"))
                        .map((it) => it.getAsFile())
                        .filter(Boolean);
                      if (imgs.length) { e.preventDefault(); uploadNoteFiles(imgs); }
                    }}
                    style={{ flex: 1, padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "#fffef9", fontSize: 13, fontFamily: "inherit", resize: "vertical" }}
                  />
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <input ref={noteFileRef} type="file" multiple accept="image/*,application/pdf" style={{ display: "none" }} onChange={onPickNoteFiles} />
                    <button className="btn sm" disabled={noteUploading} onClick={() => noteFileRef.current?.click()} title="Attach an image/screenshot">
                      {noteUploading ? "…" : "Image"}
                    </button>
                    <button className="btn sm primary" disabled={savingNote || (!noteText.trim() && !noteFiles.length)} onClick={addNote}>
                      {savingNote ? "Saving…" : "Add note"}
                    </button>
                  </div>
                </div>
                {noteFiles.length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                    {noteFiles.map((f) => (
                      <span key={f.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px", border: "1px solid var(--line)", borderRadius: 999, background: "#fffef9", fontSize: 11 }}>
                        <OutgoingName files={noteFiles} f={f} />
                        <button type="button" onClick={() => setNoteFiles((prev) => prev.filter((x) => x.id !== f.id))} style={{ border: "none", background: "none", cursor: "pointer", padding: 0, opacity: 0.6 }}>✕</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── merge with same-customer tickets (#10) ───────── */}
          <div style={{ marginTop: 10 }}>
            <button className="btn sm" onClick={openMerge}>
              Merge tickets{mergeOpen ? " ▲" : ""}
            </button>
            {mergeOpen && (
              <div className="card" style={{ marginTop: 8, padding: 12 }}>
                {!related ? (
                  <span style={{ fontSize: 13, color: "var(--ink-faint)" }}><span className="spin" /> Looking for tickets from {ticket.customerEmail}…</span>
                ) : related.length === 0 ? (
                  <span style={{ fontSize: 13, color: "var(--ink-faint)" }}>No other tickets from this customer.</span>
                ) : (
                  <>
                    <div style={{ fontSize: 12, color: "var(--ink-faint)", marginBottom: 8 }}>
                      Select tickets to merge INTO <b>#{ticket.number}</b> (their messages move here):
                    </div>
                    {related.map((r) => (
                      <label key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 2px", fontSize: 13, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={mergeSel.has(r.id)}
                          onChange={(e) => {
                            const next = new Set(mergeSel);
                            e.target.checked ? next.add(r.id) : next.delete(r.id);
                            setMergeSel(next);
                          }}
                        />
                        <span className="mono">#{r.number}</span>
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.subject}</span>
                        <span style={{ fontSize: 11, color: "var(--ink-faint)", flexShrink: 0 }}>{r.status} · {fmtDate(r.createdTime)}</span>
                      </label>
                    ))}
                    <button className="btn sm primary" style={{ marginTop: 8 }} disabled={!mergeSel.size || merging} onClick={doMerge}>
                      {merging ? <><span className="spin" /> Merging…</> : `Merge ${mergeSel.size || ""} into #${ticket.number}`}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {draftError && (
            <div className="banner error" style={{ marginTop: 14 }}>Draft failed: {draftError}</div>
          )}

          {!hasContent && !composing && !drafting && (
            <div className="draft-actions" style={{ marginTop: 14 }}>
              <button className="btn primary" onClick={generate} disabled={convoLoading}>
                Generate reply with AI
              </button>
              <button className="btn" onClick={() => setComposing(true)} disabled={convoLoading}>
                Write reply
              </button>
              <button className="btn" onClick={forward} disabled={convoLoading} title="Forward this email to a colleague or supplier">
                Forward
              </button>
              <button className="btn" onClick={toggleTemplates} disabled={convoLoading}>
                Templates
              </button>
              <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>AI uses the approved Knowledge Base.</span>
            </div>
          )}

          {tplOpen && (
            <div className="card" style={{ marginTop: 10, padding: 12 }}>
              <input
                className="field"
                placeholder="Search templates…"
                value={tplSearch}
                onChange={(e) => setTplSearch(e.target.value)}
                style={{ width: "100%", padding: "7px 11px", border: "1px solid var(--line)", borderRadius: 8, background: "#fffef9", marginBottom: 8, boxSizing: "border-box" }}
              />
              {!templates ? (
                <span style={{ fontSize: 13, color: "var(--ink-faint)" }}><span className="spin" /> Loading…</span>
              ) : (
                <div style={{ maxHeight: 280, overflowY: "auto" }}>
                  {templates
                    .filter((t) => !tplSearch || `${t.title} ${t.body}`.toLowerCase().includes(tplSearch.toLowerCase()))
                    .slice()
                    .sort((a, b) => (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base", numeric: true }))
                    .map((t) => (
                      <div
                        key={t.id}
                        onClick={() => insertTemplate(t)}
                        title="Click to insert into the reply"
                        style={{ padding: "8px 10px", borderRadius: 8, cursor: "pointer", borderBottom: "1px solid var(--line-soft)" }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--line-soft)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{t.title}</div>
                        <div style={{ fontSize: 12, color: "var(--ink-faint)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {(t.body || "").replace(/\s+/g, " ").slice(0, 120)}
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}

          {drafting && !hasContent && (
            <div style={{ padding: "16px 0", color: "var(--ink-faint)" }}>
              <span className="spin" /> Drafting reply from Knowledge Base…
            </div>
          )}

          {(hasContent || composing) && (
            <>
              {triage && <LaneBanner triage={triage} />}
              {draftRestored && !sent && (
                <div style={{ fontSize: 12, color: "var(--amber)", margin: "8px 0 4px" }}>
                  Restored your unsent draft — it auto-saves while you type.
                </div>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0 8px" }}>
                <label style={{ fontSize: 13, color: "var(--ink-soft)", flexShrink: 0 }}>To:</label>
                <input
                  type="email"
                  value={toEmail}
                  disabled={sent || sending}
                  onChange={(e) => setToEmail(e.target.value)}
                  style={{ flex: "0 1 340px", padding: "6px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "#fffef9", fontSize: 13 }}
                />
                {toEmail.trim() !== (ticket.customerEmail || "") && (
                  <button
                    type="button"
                    className="btn sm"
                    title={`Reset to ${ticket.customerEmail}`}
                    onClick={() => setToEmail(ticket.customerEmail || "")}
                  >
                    Reset
                  </button>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px" }}>
                <label style={{ fontSize: 13, color: "var(--ink-soft)", flexShrink: 0 }}>Cc:</label>
                <input
                  type="text"
                  value={cc}
                  disabled={sent || sending}
                  placeholder="comma-separated emails (optional)"
                  onChange={(e) => setCc(e.target.value)}
                  style={{ flex: "0 1 340px", padding: "6px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "#fffef9", fontSize: 13 }}
                />
              </div>
              <div
                onDragOver={(e) => { if (!sent) { e.preventDefault(); setDragOver(true); } }}
                onDragLeave={() => setDragOver(false)}
                onDrop={sent ? undefined : onDropFiles}
                style={{ position: "relative", outline: dragOver ? "2px dashed var(--brass)" : "none", outlineOffset: 2, borderRadius: 10 }}
              >
                <RichEditor
                  docKey={docKey}
                  initialHtml={draftHtml}
                  disabled={sent}
                  onChange={setDraftHtml}
                  onImagePaste={uploadFiles}
                />
                {dragOver && (
                  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(154,107,47,0.08)", borderRadius: 10, pointerEvents: "none", fontSize: 14, color: "var(--brass)", fontWeight: 600 }}>
                    Drop files to attach
                  </div>
                )}
              </div>
              {/* AI helpers on the draft (improve / translate) */}
              {!sent && (
                <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                  <button className="btn sm" disabled={improving || xDraft} onClick={improveCurrentDraft} title="Polish tone & grammar without changing the facts">
                    {improving ? <><span className="spin" /> Improving…</> : "Improve with AI"}
                  </button>
                  <button
                    className="btn sm"
                    disabled={drafting || improving || xDraft}
                    title="Write rough notes of what you want to say — the AI composes the full reply from them (with the ticket's context)"
                    onClick={() => {
                      const plain = draftHtml.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").trim();
                      // pressed on the AI's untouched draft, the "notes" are
                      // the AI's own words (a restored draft can't be measured)
                      const fromAi = aiMeta ? nearlyAiDraft(aiMeta.draft, draftHtml) : Boolean(originRef.current.aiRestored);
                      if (plain) generate(plain, !fromAi || Boolean(originRef.current.notes));
                    }}
                  >
                    {drafting ? <><span className="spin" /> Writing…</> : "AI: write from my notes"}
                  </button>
                  <button className="btn sm" onClick={toggleTemplates}>Templates</button>
                  {signature && (
                    <button
                      className="btn sm"
                      title="Insert your signature"
                      onClick={() => {
                        setDraftHtml((prev) => (prev && prev.replace(/<[^>]*>/g, "").trim() ? prev + "<br>" : "") + signature);
                        setDocKey((k) => k + 1);
                      }}
                    >
                      Signature
                    </button>
                  )}
                  <span style={{ fontSize: 12, color: "var(--ink-faint)", marginLeft: 4 }}>Translate to:</span>
                  <select
                    className="status-select"
                    value=""
                    disabled={improving || xDraft}
                    onChange={(e) => { translateCurrentDraft(e.target.value); e.target.value = ""; }}
                    title="Translate the draft"
                  >
                    <option value="" disabled>language…</option>
                    <option value="Spanish">Spanish</option>
                    <option value="French">French</option>
                    <option value="English">English</option>
                  </select>
                  {xDraft && <span className="spin" />}
                </div>
              )}
              {/* outgoing attachments (#6) */}
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={onPickFiles} />
                {!sent && (
                  <button className="btn sm" disabled={uploading || sending} onClick={() => fileInputRef.current?.click()}>
                    {uploading ? <><span className="spin" /> Uploading…</> : "Attach files"}
                  </button>
                )}
                {outFiles.map((f) => (
                  <span
                    key={f.id}
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", border: "1px solid var(--line)", borderRadius: 999, background: "#fffef9", fontSize: 12 }}
                  >
                    <OutgoingName files={outFiles} f={f} /> <span style={{ color: "var(--ink-faint)" }}>{fmtBytes(f.size)}</span>
                    {!sent && (
                      <button
                        type="button"
                        title="Remove"
                        onClick={() => setOutFiles((prev) => prev.filter((x) => x.id !== f.id))}
                        style={{ border: "none", background: "none", cursor: "pointer", padding: 0, opacity: 0.6 }}
                      >
                        ✕
                      </button>
                    )}
                  </span>
                ))}
              </div>
              {sendError && <div className="banner error" style={{ marginTop: 8 }}>{sendError}</div>}
              <div className="draft-actions">
                {!sent && (
                  <button className="btn send" onClick={send} disabled={sending || !hasContent || uploading}>
                    {sending ? <><span className="spin" /> Sending…</> : "Approve & Send to customer"}
                  </button>
                )}
                {!sent && (
                  <button className="btn" onClick={generate} disabled={drafting || sending}>
                    {drafting ? "Regenerating…" : "↻ Regenerate"}
                  </button>
                )}
                {!sent && (
                  <button
                    className="btn"
                    onClick={sendAsWebsiteChat}
                    disabled={chatSending || sending || !hasContent}
                    title="Send this reply into the Wix website chat instead of email"
                  >
                    {chatSending ? <><span className="spin" /> Sending…</> : "Send as website chat"}
                  </button>
                )}
                {chatSent && <span style={{ color: "var(--green)", fontSize: 13 }}>Sent to website chat ({chatSent})</span>}
                {sent && (
                  <>
                    <span style={{ color: "var(--green)", fontSize: 13 }}>Reply sent to {toEmail}</span>
                    <button className="btn" onClick={resetCompose}>Write another reply</button>
                  </>
                )}
              </div>
            </>
          )}
          </div>

          {/* ── right context sidebar: orders / product / shipping / phone ── */}
          <aside className="ticket-side">
            {orders && orders.length > 0 && (
              <div style={{ marginBottom: 6 }}>
                <div
                  style={{ fontSize: 12, color: "var(--ink-faint)", marginBottom: 6, cursor: orders.length > 2 ? "pointer" : "default", userSelect: "none" }}
                  onClick={() => orders.length > 2 && setOrdersExpanded((v) => !v)}
                >
                  Customer orders ({orders.length}){orders.length > 2 ? (ordersExpanded ? " ▲" : " ▾ show all") : ""}
                </div>
                {(ordersExpanded ? orders : orders.slice(0, 2)).map((o) => <OrderCard key={o.siteId + o.number} order={o} />)}
                {!ordersExpanded && orders.length > 2 && (
                  <button className="btn sm" onClick={() => setOrdersExpanded(true)}>+ {orders.length - 2} more orders</button>
                )}
              </div>
            )}
            <ProductLookup
              q={prodQ} setQ={setProdQ} results={prodResults} loading={prodLoading} onSearch={lookupProducts}
            />
            <ShipmentLookup
              q={shipQ} setQ={setShipQ} results={shipResults} loading={shipLoading} onSearch={() => searchShipment()}
            />
            {wayfairPos && wayfairPos.length > 0 && (
              <div style={{ margin: "10px 0 4px" }}>
                <div style={{ fontSize: 12, color: "var(--ink-faint)", marginBottom: 6 }}>Wayfair PO ({wayfairPos.length})</div>
                {wayfairPos.map((p) => <WayfairCard key={p.poNumber} po={p} />)}
              </div>
            )}
            {walmartOrders && walmartOrders.length > 0 && (
              <div style={{ margin: "10px 0 4px" }}>
                <div style={{ fontSize: 12, color: "var(--ink-faint)", marginBottom: 6 }}>Walmart order ({walmartOrders.length})</div>
                {walmartOrders.map((o) => (
                  <div key={o.poNumber} className="card" style={{ padding: "10px 12px", marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span className="mono" style={{ fontWeight: 700 }}>#{o.customerOrderId || o.poNumber}</span>
                      <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{o.customer}{o.city ? ` · ${o.city}` : ""}</span>
                      <span style={{ fontSize: 11, color: "var(--ink-faint)", marginLeft: "auto" }}>{o.date}</span>
                    </div>
                    {o.items.map((i, k) => (
                      <div key={k} style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 5 }}>
                        {i.sku}{i.qty > 1 ? ` ×${i.qty}` : ""} · <Pill text={i.status || "?"} color={/ship|deliver/i.test(i.status || "") ? "#3b7a57" : "#c8912a"} />
                        {i.tracking && (
                          <span style={{ marginLeft: 6 }}>
                            {i.carrier || "Tracking"}:{" "}
                            {i.trackingUrl ? <a href={i.trackingUrl} target="_blank" rel="noreferrer">{i.tracking}</a> : <span className="mono">{i.tracking}</span>}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <PhonePanel
              hist={phoneHist} phoneVal={phoneVal} setPhoneVal={setPhoneVal} loading={phoneLoading}
              onLookup={() => loadPhone(phoneVal)} onCall={callCustomer}
              smsText={smsText} setSmsText={setSmsText} smsSending={smsSending} onSendSms={sendSms}
            />
          </aside>
          </div>
        </div>
      )}
    </div>
  );
}

// Click any image inside an email → it enlarges in the in-app file viewer
// (FileViewer.jsx, one instance at the Inbox root). kind:'image' because these
// URLs carry no file name to tell the kind from.
const openLightbox = (url) => openViewer({ url, name: "", kind: "image", noDownload: true });

// Render a message's real email HTML (original or translated), with the quoted
// reply-chain collapsed behind a toggle so each bubble shows just the new part.
// Gmail/Zoho quotes and Outlook's "From:/Sent:" chains are tagged by
// sanitize.js; quotedNote labels them (e.g. "original language").
function EmailHtml({ html, quotedNote = null }) {
  const [showQuoted, setShowQuoted] = useState(false);
  // DOMPurify on every render — the server's regex pass alone is bypassable
  const safe = useMemo(() => sanitizeEmailHtml(html), [html]);
  const hasQuoted = /class="[^"]*\bsc-quoted\b/.test(safe);
  const onClick = (e) => {
    const t = e.target;
    // click any image in the email → enlarge it in-app
    if (t?.tagName === "IMG" && t.src) {
      e.preventDefault();
      e.stopPropagation();
      openLightbox(t.src);
      return;
    }
    // links open in a new tab — never navigate the app away
    const a = t?.closest?.("a[href]");
    const href = a?.getAttribute("href") || "";
    if (!a || href.startsWith("#") || /^(mailto|tel):/i.test(href)) return;
    e.preventDefault();
    window.open(a.href, "_blank", "noopener,noreferrer");
  };
  return (
    <>
      <div
        className={`email-html ${hasQuoted && !showQuoted ? "hide-quotes" : ""}`}
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: safe }}
      />
      {hasQuoted && (
        <button type="button" className="quote-toggle" onClick={() => setShowQuoted((v) => !v)}>
          {showQuoted ? "▲ Hide quoted text" : `··· Show quoted text${quotedNote ? ` (${quotedNote})` : ""}`}
        </button>
      )}
    </>
  );
}

function fmtBytes(n) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// Where a ticket came from — marketplace, carrier, website or direct contact.
// Keeps one queue in the Inbox while always showing the origin at a glance.
const SOURCES = [
  [/(^|\.)wayfair\.com$/i, "Wayfair", "#7a3fa0"],
  [/(^|\.)rona\.ca$/i, "RONA", "#0a6b3d"],
  [/(^|\.)lowes\.com$/i, "Lowe's", "#12457f"],
  [/bestbuy(canada)?\.(ca|com)$/i, "Best Buy", "#1c4fb8"],
  [/homedepot\.(ca|com)$/i, "Home Depot", "#c2571a"],
  [/(^|\.)(amazon|marketplace\.amazon)\.[a-z.]+$/i, "Amazon", "#b3701a"],
  [/walmart\.com$/i, "Walmart", "#1a5fa8"],
  [/menards\.com$/i, "Menards", "#8a6a1a"],
  [/bazaarvoice\.com$/i, "Bazaarvoice", "#9a3f6b"],
  [/(^|\.)ups(billing)?\.com$/i, "UPS", "#6b4a1a"],
  [/(fedex|purolator|canpar|canadapost)\./i, "Carrier", "#6b4a1a"],
  [/shipstation\.com$/i, "ShipStation", "#3b6a7a"],
  [/wixforms\.com$|wix\.com$/i, "Website", "#2a7a6a"],
];
function ticketSource(t) {
  if (String(t.id || "").startsWith("bb:") || /best ?buy/i.test(t.channel || "")) {
    return { label: "Best Buy", color: "#1c4fb8" };
  }
  const domain = (t.customerEmail || "").split("@")[1] || "";
  for (const [re, label, color] of SOURCES) if (re.test(domain)) return { label, color };
  if (/closed wayfair|^wayfair$/i.test(t.status || "")) return { label: "Wayfair", color: "#7a3fa0" };
  const ch = (t.channel || "").toLowerCase();
  if (ch === "chat") return { label: "Website chat", color: "#2a7a6a" };
  if (ch === "phone") return { label: "Phone", color: "#7a8b6f" };
  if (ch === "web") return { label: "Web form", color: "#2a7a6a" };
  return { label: "Email", color: "#8a857c" };
}
function SourceBadge({ ticket }) {
  const s = ticketSource(ticket);
  return (
    <span
      title={`Source: ${s.label}`}
      style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.03em", textTransform: "uppercase", padding: "1px 6px", borderRadius: 4, color: s.color, border: `1px solid ${s.color}`, whiteSpace: "nowrap", flexShrink: 0 }}
    >
      {s.label}
    </span>
  );
}

// Bubble thumbnails only for formats every <img> shows (HEIC opens in the viewer).
const IMAGE_RE = /\.(png|jpe?g|jfif|gif|webp|bmp|svg|avif)$/i;

// Zoho attachments → viewer items. One list per message / note / strip, so
// ‹ › in the viewer walks the files of the same message.
const toItems = (attachments, urlOf) =>
  attachments.map((a) => ({ id: a.id, name: a.name || "file", size: a.size, url: urlOf(a) }));

// Plain click → the in-app viewer. Ctrl/⌘/shift/middle-click keep the
// browser's new-tab behaviour, which is safe now that the proxy sandboxes
// every file it serves.
const viewOnClick = (item, list) => (e) => {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  openViewer(item, list);
};

// One attachment → image thumb / ▶ video tile / file chip, each with a
// download button. Videos load nothing until the agent presses play.
function Attachment({ item, list, thumbHeight = 74 }) {
  const { url, name, size } = item;
  const kind = fileKind(name);
  const dl = (
    <a href={api.dl(url)} download={name} title="Download" style={{ textDecoration: "none", color: "var(--ink-faint)", fontSize: 13, padding: "0 2px" }}>⬇</a>
  );
  if (kind === "video")
    return (
      <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
        <a href={url} onClick={viewOnClick(item, list)} title={`${name} · ${fmtBytes(size)} — click to play`} style={{ ...videoTileStyle, height: thumbHeight }}>
          <span style={playDotStyle}>▶</span>
        </a>
        <span style={{ display: "flex", gap: 4, maxWidth: 220, fontSize: 11, color: "var(--ink-faint)" }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name} · {fmtBytes(size)}</span>
          {dl}
        </span>
      </span>
    );
  if (IMAGE_RE.test(name || ""))
    return (
      <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
        <Thumb item={item} list={list} height={thumbHeight} />
        <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{dl} download</span>
      </span>
    );
  const chip = (
    <span style={fileChipStyle}>
      <a href={url} onClick={viewOnClick(item, list)} title="Preview" style={{ textDecoration: "none", color: "var(--ink)" }}>
        {KIND_ICON[kind]} {name}
      </a>
      <span style={{ color: "var(--ink-faint)", fontSize: 11 }}>{fmtBytes(size)}</span>
      {dl}
    </span>
  );
  // an iPhone's ATT0000N.htm part can be an iCloud Mail Drop card — say so here
  if (kind === "html" && /^ATT\d+\.html?$/i.test(name) && (!size || size < 8192))
    return <>{chip}<MailDropPeek url={url} /></>;
  return chip;
}

const fileChipStyle = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px",
  border: "1px solid var(--line)", borderRadius: 8, background: "#fffef9",
  fontSize: 12, textDecoration: "none", color: "var(--ink)",
};
const videoTileStyle = {
  display: "flex", alignItems: "center", justifyContent: "center", width: 128,
  borderRadius: 8, border: "1px solid var(--line)", textDecoration: "none",
  background: "linear-gradient(135deg, #4a443a, #1f1d1a)",
};
const playDotStyle = {
  display: "flex", alignItems: "center", justifyContent: "center", width: 34, height: 34,
  borderRadius: "50%", background: "rgba(255,255,255,.92)", color: "#1f1d1a",
  fontSize: 13, paddingLeft: 3, boxShadow: "0 2px 8px rgba(0,0,0,.35)",
};

// Image thumbnail: lazy-loaded over a soft placeholder, opens the viewer on
// click, and degrades to a file chip (still opening the viewer) if it can't load.
function Thumb({ item, list, height = 74 }) {
  const { url, name, size } = item;
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (failed)
    return (
      <a href={url} onClick={viewOnClick(item, list)} style={fileChipStyle}>
        {KIND_ICON.image} {name} <span style={{ color: "var(--ink-faint)", fontSize: 11 }}>{fmtBytes(size)}</span>
      </a>
    );
  return (
    <a
      href={url}
      title={`${name} · ${fmtBytes(size)} — click to enlarge`}
      onClick={viewOnClick(item, list)}
      style={{ display: "block" }}
    >
      <img
        src={url}
        alt={name}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        style={{
          height, minWidth: loaded ? 0 : 96, maxWidth: 160, objectFit: "cover",
          borderRadius: 8, border: "1px solid var(--line)", display: "block",
          cursor: "zoom-in", background: "var(--line-soft)",
          opacity: loaded ? 1 : 0.45, transition: "opacity .25s",
        }}
      />
    </a>
  );
}

// Strip of every file on the ticket: image thumbnails + download links (#7).
function AttachmentStrip({ ticketId, attachments }) {
  if (!attachments?.length) return null;
  const items = toItems(attachments, (a) => api.attachmentUrl(ticketId, a.id, a.name));
  return (
    <div style={{ margin: "12px 0 4px" }}>
      <div style={{ fontSize: 12, color: "var(--ink-faint)", marginBottom: 6 }}>
        Attachments ({attachments.length})
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {items.map((it) => (
          <Attachment key={it.id} item={it} list={items} thumbHeight={86} />
        ))}
      </div>
    </div>
  );
}

// Files attached to ONE message — rendered inside its bubble (like Zoho does).
function MessageAttachments({ ticketId, threadId, attachments }) {
  if (!attachments?.length) return null;
  const items = toItems(attachments, (a) => api.threadAttachmentUrl(ticketId, threadId, a.id, a.name));
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
      {items.map((it) => (
        <Attachment key={it.id} item={it} list={items} />
      ))}
    </div>
  );
}

// Files on an internal note — same thumbs / chips / viewer as a message's.
function NoteAttachments({ ticketId, commentId, attachments }) {
  if (!attachments?.length) return null;
  const items = toItems(attachments, (a) => api.noteAttachmentUrl(ticketId, commentId, a.id, a.name));
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
      {items.map((it) => (
        <Attachment key={it.id} item={it} list={items} thumbHeight={64} />
      ))}
    </div>
  );
}

// Name of a file the agent is about to send (reply or note). Clicking it
// previews the local File — Zoho's /uploads have no GET, and no round-trip
// is needed. FileViewer decides the kind itself, never from File.type.
function OutgoingName({ files, f }) {
  if (!f.file) return f.name;
  const open = () => {
    const local = files.filter((x) => x.file);
    const items = local.map((x) => ({ name: x.name, size: x.size || x.file.size, file: x.file }));
    openViewer(items[local.indexOf(f)], items);
  };
  return (
    <button
      type="button"
      title="Preview"
      onClick={open}
      style={{ border: "none", background: "none", padding: 0, cursor: "pointer", color: "inherit", font: "inherit", textDecoration: "underline dotted" }}
    >
      {KIND_ICON[fileKind(f.name)]} {f.name}
    </button>
  );
}

// ── Wix order card + product lookup ──────────────────────────
const FULFILL_COLOR = { FULFILLED: "#3b7a57", PARTIALLY_FULFILLED: "#c8912a", NOT_FULFILLED: "#8a857c" };
const PAY_COLOR = { PAID: "#3b7a57", NOT_PAID: "#c0392b", PARTIALLY_REFUNDED: "#c8912a", FULLY_REFUNDED: "#c0392b" };

function Pill({ text, color }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 7px", borderRadius: 999, color: color || "#666", border: `1px solid ${color || "#ccc"}` }}>
      {(text || "").replace(/_/g, " ").toLowerCase()}
    </span>
  );
}

function OrderCard({ order }) {
  return (
    <div className="card" style={{ padding: "10px 12px", marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="mono" style={{ fontWeight: 700 }}>#{order.number}</span>
        <Pill text={order.fulfillmentStatus} color={FULFILL_COLOR[order.fulfillmentStatus]} />
        <Pill text={order.paymentStatus} color={PAY_COLOR[order.paymentStatus]} />
        <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>{order.total}</span>
        <span style={{ fontSize: 11, color: "var(--ink-faint)", marginLeft: "auto" }}>{order.site} · {fmtDate(order.date)}</span>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 5 }}>
        {order.items.map((i) => `${i.name}${i.qty > 1 ? ` ×${i.qty}` : ""}`).join(" · ")}
      </div>
      {order.tracking.map((t, i) => (
        <div key={i} style={{ fontSize: 12, marginTop: 4 }}>
          {t.carrier || "Tracking"}:{" "}
          {t.url ? <a href={t.url} target="_blank" rel="noreferrer">{t.number}</a> : <span className="mono">{t.number}</span>}
        </div>
      ))}
    </div>
  );
}

// order numbers mentioned in a ticket (mirror of the server-side extractor)
function extractOrderNums(text) {
  const t = String(text || "");
  const s = new Set();
  for (const m of t.matchAll(/\b\d{3}-\d{7}-\d{7}\b/g)) s.add(m[0]);
  for (const m of t.matchAll(/\b(?:CS|CA|PO)[#\s]?\d{6,}\b/gi)) s.add(m[0].replace(/[#\s]/g, ""));
  for (const m of t.matchAll(/\b\d{5,9}\b/g)) s.add(m[0]);
  return [...s].slice(0, 3);
}

const SHIP_STATUS_COLOR = { shipped: "#3b7a57", "partially shipped": "#c8912a", "awaiting shipment": "#c8912a", "on hold": "#c8912a", cancelled: "#c0392b", canceled: "#c0392b" };

// Zoho hands these over raw — `"Customer Service"<care@stylishkb.com>` or a
// bare `<a@b.com>`. Normalise to `Name <email>` / `email`.
function fmtAddr(s) {
  const t = String(s).replace(/["']/g, "").trim();
  const m = t.match(/^(.*?)\s*<([^>]+)>$/);
  if (!m) return t;
  const name = m[1].trim();
  const email = m[2].trim();
  return !name || name.toLowerCase() === email.toLowerCase() ? email : `${name} <${email}>`;
}

// Split a recipient list without breaking on commas inside a display name or
// inside the angle brackets ("Doe, John" <j@d.com>, b@c.com → two addresses).
function splitAddrs(raw) {
  const out = [];
  let cur = "", angle = 0, quoted = false;
  for (const ch of String(raw || "")) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<") angle++;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    else if ((ch === "," || ch === ";") && !angle && !quoted) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map(fmtAddr).filter(Boolean);
}

// From / To / Cc on every message. "Agent"/"Customer" alone doesn't say who
// actually wrote to whom once a thread is forwarded or has several parties.
function AddrLine({ label, value }) {
  const [open, setOpen] = useState(false);
  const parts = splitAddrs(value);
  if (!parts.length) return null;
  const shown = open ? parts : parts.slice(0, 2);
  const rest = parts.length - shown.length;
  return (
    <div className="addr">
      <span className="addr-k">{label}</span>
      <span className="addr-v" title={parts.join(", ")}>
        {shown.join(", ")}
        {rest > 0 && (
          <button type="button" className="addr-more" onClick={() => setOpen(true)}>
            +{rest} more
          </button>
        )}
      </span>
    </div>
  );
}

function ShipmentCard({ s }) {
  // brands number orders independently, so the same # can belong to someone
  // else entirely — dim those and say so rather than showing them as equals
  const other = !!s.otherCustomer;
  return (
    <div
      className="card"
      style={{ padding: "10px 12px", marginBottom: 8, ...(other ? { opacity: 0.62, borderStyle: "dashed" } : null) }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="mono" style={{ fontWeight: 700 }}>#{s.orderNumber}</span>
        <Pill text={s.status} color={SHIP_STATUS_COLOR[s.status]} />
        <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{s.channel}{s.account ? ` · ${s.account}` : ""}</span>
        <span style={{ fontSize: 11, color: "var(--ink-faint)", marginLeft: "auto" }}>{s.date || ""}</span>
      </div>
      {s.recipient && (
        <div style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 3 }}>{s.recipient}</div>
      )}
      {other && (
        <div style={{ fontSize: 11.5, color: "#b06a2c", marginTop: 4 }}>
          Different customer — same order number in another brand's store. Not this ticket.
        </div>
      )}
      {s.items?.length > 0 && (
        <div style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 5 }}>
          {s.items.map((i) => `${i.name}${i.qty > 1 ? ` ×${i.qty}` : ""}`).join(" · ")}
        </div>
      )}
      {s.tracking.map((t, i) => (
        <div key={i} style={{ fontSize: 12, marginTop: 4 }}>
          {t.carrier || "Tracking"}:{" "}
          {t.url ? <a href={t.url} target="_blank" rel="noreferrer">{t.number}</a> : <span className="mono">{t.number}</span>}
          {t.shipDate && <span style={{ color: "var(--ink-faint)" }}> · shipped {t.shipDate}</span>}
        </div>
      ))}
    </div>
  );
}

const CALL_COLOR = { Accepted: "#3b7a57", Missed: "#c0392b", Voicemail: "#c8912a", Rejected: "#c0392b", Busy: "#c8912a" };
function fmtCallDur(s) {
  if (!s) return "0s";
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

// RingCentral panel: phone history (calls + voicemails + SMS) + call/SMS actions.
function PhonePanel({ hist, phoneVal, setPhoneVal, loading, onLookup, onCall, smsText, setSmsText, smsSending, onSendSms }) {
  const [open, setOpen] = useState(false);
  const calls = hist?.calls || [], vms = hist?.voicemails || [], sms = hist?.sms || [];
  const total = calls.length + vms.length + sms.length;
  return (
    <div style={{ margin: "10px 0 4px" }}>
      <button className="btn sm" onClick={() => setOpen((v) => !v)}>
        Calls & SMS{total ? ` (${total})` : ""}{open ? " ▲" : ""}
      </button>
      {open && (
        <div className="card" style={{ marginTop: 8, padding: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <input
              className="field"
              placeholder="Customer phone…"
              value={phoneVal}
              onChange={(e) => setPhoneVal(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onLookup()}
              style={{ flex: "0 1 200px", padding: "6px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "#fffef9", fontSize: 13 }}
            />
            <button className="btn sm" onClick={onLookup} disabled={loading || !phoneVal.trim()}>{loading ? <span className="spin" /> : "Look up"}</button>
            <button className="btn sm" onClick={onCall} disabled={!phoneVal.trim()} title="RingOut — rings your phone, then connects">Call</button>
          </div>

          {/* Calls */}
          {calls.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: "var(--ink-faint)", marginBottom: 4 }}>Calls</div>
              {calls.map((c) => (
                <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "3px 0" }}>
                  <span>{c.direction === "Inbound" ? "" : ""}</span>
                  <span style={{ width: 96, color: "var(--ink-faint)" }}>{fmtDate(c.time)}</span>
                  <Pill text={c.result} color={CALL_COLOR[c.result]} />
                  <span style={{ color: "var(--ink-soft)" }}>{fmtCallDur(c.durationSec)}</span>
                  {c.recordingId && <audio controls src={api.rcRecordingUrl(c.recordingId)} style={{ height: 30, marginLeft: "auto", maxWidth: 220 }} />}
                </div>
              ))}
            </div>
          )}

          {/* Voicemails */}
          {vms.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: "var(--ink-faint)", marginBottom: 4 }}>Voicemails</div>
              {vms.map((v) => (
                <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "3px 0" }}>
                  <span></span>
                  <span style={{ width: 96, color: "var(--ink-faint)" }}>{fmtDate(v.time)}</span>
                  <span style={{ color: "var(--ink-soft)" }}>{v.durationSec ? `${v.durationSec}s` : ""}</span>
                  {v.audioId && <audio controls src={api.rcVoicemailUrl(v.id, v.audioId)} style={{ height: 30, marginLeft: "auto", maxWidth: 220 }} />}
                </div>
              ))}
            </div>
          )}

          {/* SMS thread + send */}
          <div>
            <div style={{ fontSize: 11, color: "var(--ink-faint)", marginBottom: 4 }}>SMS</div>
            {sms.length > 0 ? (
              <div style={{ maxHeight: 160, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, marginBottom: 6 }}>
                {sms.map((m) => (
                  <div key={m.id} style={{ alignSelf: m.direction === "Outbound" ? "flex-end" : "flex-start", maxWidth: "80%", padding: "5px 9px", borderRadius: 8, fontSize: 12.5, background: m.direction === "Outbound" ? "#fbf7ee" : "#fff", border: "1px solid var(--line-soft)" }}>
                    {m.text}
                    <div style={{ fontSize: 10, color: "var(--ink-faint)", marginTop: 2 }}>{fmtTime(m.time)}</div>
                  </div>
                ))}
              </div>
            ) : <div style={{ fontSize: 12, color: "var(--ink-faint)", marginBottom: 6 }}>No SMS yet.</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="field"
                placeholder="Send an SMS…"
                value={smsText}
                onChange={(e) => setSmsText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onSendSms()}
                style={{ flex: 1, padding: "6px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "#fffef9", fontSize: 13 }}
              />
              <button className="btn sm primary" onClick={onSendSms} disabled={smsSending || !smsText.trim() || !phoneVal.trim()}>
                {smsSending ? "…" : "Send"}
              </button>
            </div>
          </div>

          {total === 0 && !loading && <div style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 8 }}>No phone history for this number.</div>}
        </div>
      )}
    </div>
  );
}

// Bazaarvoice: retailer product-page questions/reviews from a Connections
// alert, each with an AI-drafted public answer to review, copy and post.
function BazaarvoicePanel({ data }) {
  const [drafts, setDrafts] = useState(() => data.items.map((i) => i.draft || ""));
  const [copied, setCopied] = useState(null);
  const copy = (i) => {
    const ok = navigator.clipboard?.writeText(drafts[i] || "");
    setCopied(i);
    setTimeout(() => setCopied((c) => (c === i ? null : c)), 2000);
    return ok || Promise.resolve();
  };
  // one click: copy the answer, then open that item's response form in BV
  const copyAndOpen = (i, link) => {
    copy(i).finally(() => window.open(link, "_blank", "noopener"));
  };
  return (
    <div className="card" style={{ marginTop: 12, padding: 14, borderColor: "var(--brass)" }}>
      <div style={{ fontSize: 12, color: "var(--ink-faint)", marginBottom: 8 }}>
        Bazaarvoice · {data.items.length} {data.kind === "review" ? "review" : "question"}
        {data.items.length === 1 ? "" : "s"} awaiting a public response
      </div>
      {data.items.map((it, i) => (
        <div key={i} style={{ borderTop: i ? "1px solid var(--line-soft)" : "none", paddingTop: i ? 12 : 0, marginTop: i ? 12 : 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11, color: "var(--ink-faint)" }}>
            <span style={{ fontWeight: 700, color: "var(--brass)" }}>{it.retailer}</span>
            <span>{it.product}</span>
            {it.rating != null && (
              <span style={{ color: it.rating <= 2 ? "var(--red)" : "var(--amber)" }}>{"★".repeat(it.rating)}{"☆".repeat(5 - it.rating)}</span>
            )}
          </div>
          {it.title && <div style={{ fontWeight: 600, fontSize: 13.5, marginTop: 4 }}>{it.title}</div>}
          <div style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 4, whiteSpace: "pre-wrap" }}>{it.text}</div>
          <textarea
            rows={4}
            value={drafts[i]}
            onChange={(e) => setDrafts((d) => d.map((x, j) => (j === i ? e.target.value : x)))}
            placeholder="AI draft…"
            style={{ width: "100%", marginTop: 8, padding: "8px 11px", border: "1px solid var(--line)", borderRadius: 8, background: "#fffef9", fontSize: 13, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn sm" onClick={() => copy(i)}>{copied === i ? "Copied" : "Copy answer"}</button>
            {it.link && (
              <button
                className="btn sm primary"
                onClick={() => copyAndOpen(i, it.link)}
                title="Copies the answer and opens this item's response form in Bazaarvoice — paste and submit there"
              >
                Copy &amp; open in Bazaarvoice →
              </button>
            )}
            <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>paste &amp; submit in Bazaarvoice</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// Wayfair dropship PO details (auto-loaded from PO numbers found in the ticket).
function WayfairCard({ po }) {
  return (
    <div className="card" style={{ padding: "10px 12px", marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="mono" style={{ fontWeight: 700 }}>#{po.poNumber}</span>
        <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{po.channel}{po.region ? ` ${po.region}` : ""}</span>
        <span style={{ fontSize: 11, color: "var(--ink-faint)", marginLeft: "auto" }}>{po.date}</span>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 5 }}>
        {po.products.map((x) => `${x.partNumber}${x.qty > 1 ? ` ×${x.qty}` : ""}${x.cancelled ? " (cancelled)" : ""}`).join(" · ")}
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 4 }}>
        {po.estimatedShipDate && <>Est. ship {po.estimatedShipDate}</>}
        {po.carrier && <> · {po.carrier}</>}
        {po.warehouse && <> · from {po.warehouse}</>}
      </div>
    </div>
  );
}

function ShipmentLookup({ q, setQ, results, loading, onSearch }) {
  return (
    <div style={{ margin: "10px 0 4px" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>ShipStation</span>
        <input
          className="field"
          placeholder="Track by order # (Amazon, Wayfair, direct…)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSearch()}
          style={{ flex: "0 1 300px", padding: "6px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "#fffef9", fontSize: 13 }}
        />
        <button className="btn sm" onClick={onSearch} disabled={loading || !q.trim()}>
          {loading ? <span className="spin" /> : "Look up"}
        </button>
      </div>
      {results && (
        <div style={{ marginTop: 6 }}>
          {results.length === 0 ? (
            <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>No shipment found for that order number.</span>
          ) : (
            results.map((s, i) => <ShipmentCard key={i} s={s} />)
          )}
        </div>
      )}
    </div>
  );
}

function ProductLookup({ q, setQ, results, loading, onSearch }) {
  return (
    <div style={{ margin: "10px 0 4px" }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          className="field"
          placeholder="Look up a product (e.g. K-131G)…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSearch()}
          style={{ flex: "0 1 320px", padding: "7px 11px", border: "1px solid var(--line)", borderRadius: 8, background: "#fffef9", fontSize: 13 }}
        />
        <button className="btn sm" onClick={onSearch} disabled={loading || !q.trim()}>
          {loading ? <span className="spin" /> : "Search"}
        </button>
      </div>
      {results && (
        <div style={{ marginTop: 6 }}>
          {results.length === 0 ? (
            <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>No products found.</span>
          ) : (
            results.slice(0, 8).map((p, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 12.5, borderBottom: "1px solid var(--line-soft)" }}>
                {p.url ? <a href={p.url} target="_blank" rel="noreferrer" style={{ flex: 1 }}>{p.name}</a> : <span style={{ flex: 1 }}>{p.name}</span>}
                {p.price && <span style={{ color: "var(--ink-soft)" }}>{p.price}</span>}
                <Pill text={p.inStock ? `in stock${p.quantity != null ? ` (${p.quantity})` : ""}` : "out of stock"} color={p.inStock ? "#3b7a57" : "#c0392b"} />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
