import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";

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

export default function Inbox({ signature = "" }) {
  const [tickets, setTickets] = useState([]);
  const [counts, setCounts] = useState({ all: 0, active: 0, closed: 0, byStatus: {} });
  const [total, setTotal] = useState(0);
  const [configured, setConfigured] = useState(true);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [err, setErr] = useState(null);
  const [syncWarning, setSyncWarning] = useState(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState(null);

  const [view, setView] = useState("open");
  const [sort, setSort] = useState("updated");
  const [layout, setLayout] = useState(() => localStorage.getItem("inboxLayout") || "split");
  useEffect(() => { localStorage.setItem("inboxLayout", layout); }, [layout]);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 50;

  // debounce the search box so we don't query on every keystroke
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 350);
    return () => clearTimeout(id);
  }, [search]);

  // reset to page 1 whenever the filter, sort or search changes
  useEffect(() => { setPage(1); }, [view, sort, debounced]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.inbox({ view, q: debounced, page, pageSize, sort });
      setConfigured(data.configured);
      setTickets(data.tickets || []);
      setCounts(data.counts || { byStatus: {} });
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
              ⚠ Live sync delayed (showing last saved)
            </span>
          )}
          <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>
            {loading ? "Syncing…" : `Auto-syncs every 30s · last ${fetchedAt ? new Date(fetchedAt).toLocaleTimeString() : "—"}`}
          </span>
          <div className="seg">
            <button className={layout === "split" ? "active" : ""} title="Peek view (list + side panel)" onClick={() => setLayout("split")}>◫ Peek</button>
            <button className={layout === "list" ? "active" : ""} title="List view" onClick={() => setLayout("list")}>☰ List</button>
          </div>
          <button className="btn sm" onClick={load}>↻ Refresh</button>
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
      </div>

      {err && <div className="banner error">{err}</div>}

      {tickets.length === 0 ? (
        <div className="empty">{loading ? "Loading…" : "No tickets match this view."}</div>
      ) : layout === "split" ? (
        <div className="peek">
          <div className="peek-list">
            {tickets.map((t) => (
              <CompactRow key={t.id} ticket={t} selected={openId === t.id} onClick={() => setOpenId(t.id)} />
            ))}
          </div>
          <div className="peek-detail">
            {(() => {
              const sel = tickets.find((t) => t.id === openId);
              return sel ? (
                <TicketRow
                  key={sel.id}
                  ticket={sel}
                  statusOptions={statusOptions}
                  signature={signature}
                  open
                  peek
                  onToggle={() => {}}
                  onChanged={load}
                />
              ) : (
                <div className="empty" style={{ marginTop: 40 }}>← Select a ticket to view it</div>
              );
            })()}
          </div>
        </div>
      ) : (
        tickets.map((t) => (
          <TicketRow
            key={t.id}
            ticket={t}
            statusOptions={statusOptions}
            signature={signature}
            open={openId === t.id}
            onToggle={() => setOpenId(openId === t.id ? null : t.id)}
            onChanged={load}
          />
        ))
      )}

      <Lightbox />

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
      ⏱ {fmtDuration(ms)}
    </span>
  );
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
function plainToHtml(text) {
  return escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, "<br>");
}
// The model now returns formatted HTML; use it as-is. Fall back to plainToHtml
// only if it looks like plain text (no HTML tags).
function draftToHtml(draft) {
  const d = draft || "";
  return /<(p|ul|ol|li|strong|em|a|br|b|i)\b[^>]*>/i.test(d) ? d : plainToHtml(d);
}

// Minimal rich-text editor (contentEditable + execCommand). Uncontrolled: the
// content is set only when `docKey` changes (new/regenerated draft), so typing
// never resets the cursor. Parent reads the html via onChange.
function RichEditor({ docKey, initialHtml, disabled, onChange, onImagePaste }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = initialHtml || "";
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
    const safe = text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
      .replace(/\n/g, "<br>");
    document.execCommand("insertHTML", false, safe);
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
          🔗 Link
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
  ready: { bg: "#e7f4ec", border: "#3b7a57", text: "#205038", icon: "✓" },
  review: { bg: "#fdf4e3", border: "#c8912a", text: "#7a5712", icon: "⏿" },
  sensitive: { bg: "#fdecec", border: "#c0392b", text: "#7a221a", icon: "⚠" },
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

// Compact row for the peek (split) view — click to open the ticket on the right.
function CompactRow({ ticket, selected, onClick }) {
  return (
    <div className={`peek-row ${selected ? "sel" : ""}`} onClick={onClick}>
      <div className="peek-subj">{ticket.subject}</div>
      <div className="peek-meta">
        <span className="mono">#{ticket.number}</span>
        <span className="peek-cust">{ticket.customerName}</span>
        <span style={{ marginLeft: "auto", flexShrink: 0 }}>
          <WaitTimer since={ticket.customerResponseTime} status={ticket.status} />
        </span>
      </div>
    </div>
  );
}

function TicketRow({ ticket, open, onToggle, statusOptions = [], onChanged, signature = "", peek = false }) {
  const [conversation, setConversation] = useState(null);
  const [convoLoading, setConvoLoading] = useState(false);
  const [convoError, setConvoError] = useState(null);
  const [convoLoaded, setConvoLoaded] = useState(false);

  // conversation translation
  const [view, setView] = useState("orig");
  const [xcache, setXcache] = useState({});
  const [xlating, setXlating] = useState(false);
  const [xError, setXError] = useState(null);

  // AI draft + triage (rich-text)
  const [draftHtml, setDraftHtml] = useState("");
  const [docKey, setDocKey] = useState(0);
  const [triage, setTriage] = useState(null);
  // the ORIGINAL AI draft + triage, kept unmutated so we can measure how much
  // the agent edited it when they send (the feedback loop).
  const [aiMeta, setAiMeta] = useState(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState(null);

  // status
  const [status, setStatusState] = useState(ticket.status);
  const [statusSaving, setStatusSaving] = useState(false);

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
        setOutFiles((prev) => [...prev, up]);
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
  };

  const improveCurrentDraft = async () => {
    if (!draftHtml.replace(/<[^>]*>/g, "").trim()) return;
    setImproving(true);
    setSendError(null);
    try {
      const r = await api.improveDraft(ticket.id, draftHtml);
      setDraftHtml(draftToHtml(r.reply));
      setDocKey((k) => k + 1);
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
      const r = await api.translateDraft(draftHtml, target);
      setDraftHtml(draftToHtml(r.html));
      setDocKey((k) => k + 1);
    } catch (e) {
      setSendError(`Translate failed: ${e.message}`);
    } finally {
      setXDraft(false);
    }
  };

  // Reset the compose area for a fresh reply (used after a send + "write reply")
  const resetCompose = () => {
    setSent(false);
    setDraftHtml("");
    setDocKey((k) => k + 1);
    setAiMeta(null);
    setTriage(null);
    setOutFiles([]);
    setCc("");
    setSendError(null);
    setComposing(true);
  };

  // ticket attachments (#7)
  const [attachments, setAttachments] = useState([]);

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
  const noteFileRef = useRef(null);
  const onPickNoteFiles = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length) return;
    setNoteUploading(true);
    for (const f of files) {
      try { const up = await api.uploadAttachment(ticket.id, f); setNoteFiles((prev) => [...prev, up]); }
      catch (err) { alert(`Could not attach ${f.name}: ${err.message}`); }
    }
    setNoteUploading(false);
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
    try {
      const res = await api.conversation(ticket.id);
      setConversation(res.conversation || []);
      setConvoLoaded(true);
      // auto-look up any order numbers mentioned in the ticket (ShipStation)
      const text = `${ticket.subject || ""} ${(res.conversation || []).filter((m) => m.direction !== "out").map((m) => m.text || "").join(" ")}`;
      const nums = extractOrderNums(text);
      if (nums.length) {
        Promise.all(nums.slice(0, 2).map((n) => api.shipOrder(n).then((r) => r.orders || []).catch(() => [])))
          .then((arr) => { const flat = arr.flat(); if (flat.length) setShipResults(flat); });
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

  const generate = useCallback(async () => {
    setDrafting(true);
    setDraftError(null);
    try {
      const res = await api.draft(ticket.id, ticket);
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
    } catch (e) {
      setDraftError(e.message);
    } finally {
      setDrafting(false);
    }
  }, [ticket]);

  const translateTo = async (lang) => {
    if (lang === "orig" || xcache[lang]) {
      setView(lang);
      return;
    }
    setXlating(true);
    setXError(null);
    try {
      const target = lang === "es" ? "Spanish" : "English";
      const { translations } = await api.translate(
        (conversation || []).map((m) => m.text || ""),
        target
      );
      setXcache((c) => ({ ...c, [lang]: translations }));
      setView(lang);
    } catch (e) {
      setXError(e.message);
    } finally {
      setXlating(false);
    }
  };

  const changeStatus = async (next) => {
    const prev = status;
    setStatusState(next);
    setStatusSaving(true);
    try {
      await api.setStatus(ticket.id, next);
    } catch (e) {
      setStatusState(prev);
      setSendError(`Could not change status: ${e.message}`);
    } finally {
      setStatusSaving(false);
    }
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
        cc.trim()
      );
      setSent(true);
      setComposing(false);
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
            <span className="mono">#{ticket.number}</span>
            <span>{ticket.customerName}</span>
            {ticket.customerEmail && <span>{ticket.customerEmail}</span>}
            {ticket.channel && <span>{ticket.channel}</span>}
            {ticket.createdTime && (
              <span title={`Created ${fmtTime(ticket.createdTime)}`}>📅 {fmtDate(ticket.createdTime)}</span>
            )}
            {ticket.modifiedTime && (
              <span title={`Last activity ${fmtTime(ticket.modifiedTime)}`}>· updated {ago(ticket.modifiedTime)}</span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          {sent && <span className="badge sent">✓ Sent</span>}
          <WaitTimer since={ticket.customerResponseTime} status={status} />
          <StatusSelect status={status} options={statusOptions} onChange={changeStatus} saving={statusSaving} />
          {!/escalat/i.test(status) && (
            <button
              className="btn sm"
              title="Escalate this ticket"
              disabled={statusSaving}
              onClick={(e) => { e.stopPropagation(); changeStatus("Escalated"); }}
              style={{ color: "#c0392b", borderColor: "#e3b9b3" }}
            >
              ⤴ Escalate
            </button>
          )}
          <button
            className="btn sm"
            title="Mark as spam (hide from inbox)"
            disabled={acting}
            onClick={(e) => { e.stopPropagation(); actOn("spam"); }}
          >
            🚫
          </button>
          <button
            className="btn sm"
            title="Delete (move to Zoho trash)"
            disabled={acting}
            onClick={(e) => { e.stopPropagation(); actOn("trash"); }}
          >
            🗑
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
                to confirm — if it's empty there too, you can safely 🗑 delete or 🚫 spam it from here.
              </div>
            </div>
          )}

          {conversation && conversation.length > 0 && (
            <>
              <div className="convo-bar">
                <span style={{ fontSize: 12, color: xError ? "#c0392b" : "var(--ink-faint)" }}>
                  {xlating
                    ? "Translating…"
                    : xError
                    ? `Couldn't translate (${xError})`
                    : view === "orig"
                    ? "Conversation"
                    : `Translated to ${view === "es" ? "Spanish" : "English"}`}
                </span>
                <div className="seg">
                  <button className={view === "orig" ? "active" : ""} disabled={xlating} onClick={() => translateTo("orig")}>Original</button>
                  <button className={view === "en" ? "active" : ""} disabled={xlating} onClick={() => translateTo("en")}>EN</button>
                  <button className={view === "es" ? "active" : ""} disabled={xlating} onClick={() => translateTo("es")}>ES</button>
                </div>
              </div>
              <div className="convo">
                {conversation.length > 3 && !showAllMsgs && (
                  <button className="btn sm" onClick={() => setShowAllMsgs(true)} style={{ alignSelf: "center" }}>
                    ▾ Show {conversation.length - 3} earlier message{conversation.length - 3 === 1 ? "" : "s"}
                  </button>
                )}
                {conversation.map((m, i) => {
                  if (!showAllMsgs && conversation.length > 3 && i < conversation.length - 3) return null;
                  const txt = view !== "orig" && xcache[view] ? xcache[view][i] : m.text;
                  return (
                    <div key={m.id} className={`msg ${m.direction === "out" ? "out" : "in"}`}>
                      <div className="who">
                        <span>{m.direction === "out" ? "Agent" : "Customer"}{m.author ? ` · ${m.author}` : ""}</span>
                        {m.createdTime && <span className="when">{fmtTime(m.createdTime)}</span>}
                      </div>
                      <div className="text">
                        {view === "orig" && m.html ? (
                          <EmailHtml html={m.html} />
                        ) : txt ? (
                          linkifyNodes(txt)
                        ) : (
                          "(no text)"
                        )}
                      </div>
                      <MessageAttachments ticketId={ticket.id} threadId={m.id} attachments={m.attachments} />
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* ── Wix store: customer orders + product lookup ──── */}
          {orders && orders.length > 0 && (
            <div style={{ margin: "12px 0 4px" }}>
              <div
                style={{ fontSize: 12, color: "var(--ink-faint)", marginBottom: 6, cursor: orders.length > 2 ? "pointer" : "default", userSelect: "none" }}
                onClick={() => orders.length > 2 && setOrdersExpanded((v) => !v)}
              >
                🛒 Customer orders ({orders.length}){orders.length > 2 ? (ordersExpanded ? " ▲" : " ▾ show all") : ""}
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

          {/* ── ShipStation: shipments by order number (any channel) ── */}
          <ShipmentLookup
            q={shipQ} setQ={setShipQ} results={shipResults} loading={shipLoading} onSearch={() => searchShipment()}
          />

          <AttachmentStrip ticketId={ticket.id} attachments={attachments} />

          {/* ── private internal notes ───────────────────────── */}
          <div style={{ marginTop: 10 }}>
            <button className="btn sm" onClick={() => setNotesOpen((v) => !v)}>
              🗒 Private notes{notes.length ? ` (${notes.length})` : ""}{notesOpen ? " ▲" : ""}
            </button>
            {notesOpen && (
              <div className="card" style={{ marginTop: 8, padding: 12 }}>
                {notes.length === 0 && (
                  <div style={{ fontSize: 13, color: "var(--ink-faint)", marginBottom: 8 }}>
                    No internal notes yet. These are private — the customer never sees them.
                  </div>
                )}
                {notes.map((n) => {
                  const text = (n.content || "").replace(/<[^>]+>/g, " ").trim();
                  return (
                    <div key={n.id} style={{ borderLeft: "3px solid var(--amber)", paddingLeft: 10, margin: "8px 0", fontSize: 13 }}>
                      {text && <div style={{ whiteSpace: "pre-wrap" }}>{text}</div>}
                      {n.attachments?.length > 0 && (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                          {n.attachments.map((a) => {
                            const url = api.noteAttachmentUrl(ticket.id, n.id, a.id, a.name);
                            return IMAGE_RE.test(a.name || "")
                              ? <Thumb key={a.id} url={url} name={a.name} size={a.size} height={64} />
                              : <a key={a.id} href={url} target="_blank" rel="noreferrer" style={fileChipStyle}>📄 {a.name}</a>;
                          })}
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 2 }}>
                        {n.author || "Agent"} · {fmtTime(n.createdTime)}
                      </div>
                    </div>
                  );
                })}
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <textarea
                    rows={2}
                    value={noteText}
                    placeholder="Add a private note (internal only)…"
                    onChange={(e) => setNoteText(e.target.value)}
                    style={{ flex: 1, padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "#fffef9", fontSize: 13, fontFamily: "inherit", resize: "vertical" }}
                  />
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <input ref={noteFileRef} type="file" multiple accept="image/*,application/pdf" style={{ display: "none" }} onChange={onPickNoteFiles} />
                    <button className="btn sm" disabled={noteUploading} onClick={() => noteFileRef.current?.click()} title="Attach an image/screenshot">
                      {noteUploading ? "…" : "📎 Image"}
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
                        📎 {f.name}
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
              ⇄ Merge tickets{mergeOpen ? " ▲" : ""}
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
                ✦ Generate reply with AI
              </button>
              <button className="btn" onClick={() => setComposing(true)} disabled={convoLoading}>
                ✍️ Write reply
              </button>
              <button className="btn" onClick={forward} disabled={convoLoading} title="Forward this email to a colleague or supplier">
                ↪ Forward
              </button>
              <button className="btn" onClick={toggleTemplates} disabled={convoLoading}>
                📋 Templates
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
                    ↺
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
                    {improving ? <><span className="spin" /> Improving…</> : "✨ Improve with AI"}
                  </button>
                  <button className="btn sm" onClick={toggleTemplates}>📋 Templates</button>
                  {signature && (
                    <button
                      className="btn sm"
                      title="Insert your signature"
                      onClick={() => {
                        setDraftHtml((prev) => (prev && prev.replace(/<[^>]*>/g, "").trim() ? prev + "<br>" : "") + signature);
                        setDocKey((k) => k + 1);
                      }}
                    >
                      ✍️ Signature
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
                    {uploading ? <><span className="spin" /> Uploading…</> : "📎 Attach files"}
                  </button>
                )}
                {outFiles.map((f) => (
                  <span
                    key={f.id}
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", border: "1px solid var(--line)", borderRadius: 999, background: "#fffef9", fontSize: 12 }}
                  >
                    📎 {f.name} <span style={{ color: "var(--ink-faint)" }}>{fmtBytes(f.size)}</span>
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
                {sent && (
                  <>
                    <span style={{ color: "var(--green)", fontSize: 13 }}>✓ Reply sent to {toEmail}</span>
                    <button className="btn" onClick={resetCompose}>✍️ Write another reply</button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// In-app image viewer: click any email/attachment image → enlarges right here
// over a dark backdrop (click outside, ✕ or Esc to close). One instance lives
// at the Inbox root; openLightbox() is callable from anywhere in this module.
let _setLightboxUrl = null;
const openLightbox = (url) => _setLightboxUrl?.(url);

function Lightbox() {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    _setLightboxUrl = setUrl;
    return () => { _setLightboxUrl = null; };
  }, []);
  useEffect(() => {
    if (!url) return;
    const onKey = (e) => e.key === "Escape" && setUrl(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [url]);
  if (!url) return null;
  return (
    <div className="lightbox" onClick={() => setUrl(null)}>
      <img src={url} alt="" onClick={(e) => e.stopPropagation()} />
      <button className="lightbox-close" title="Close (Esc)" onClick={() => setUrl(null)}>✕</button>
    </div>
  );
}

// Render a message's real (server-sanitized) email HTML, with the quoted
// reply-chain collapsed behind a toggle so each bubble shows just the new part.
function EmailHtml({ html }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const hasQuoted = /<blockquote|gmail_quote|zmail_extra/i.test(html);
  // click any image in the email → enlarge it in-app
  const onClick = (e) => {
    const t = e.target;
    if (t?.tagName === "IMG" && t.src) {
      e.preventDefault();
      e.stopPropagation();
      openLightbox(t.src);
    }
  };
  return (
    <>
      <div
        className={`email-html ${hasQuoted && !showQuoted ? "hide-quotes" : ""}`}
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {hasQuoted && (
        <button type="button" className="quote-toggle" onClick={() => setShowQuoted((v) => !v)}>
          {showQuoted ? "▲ Hide quoted text" : "··· Show quoted text"}
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

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const VIDEO_RE = /\.(mp4|mov|webm|m4v|ogg)$/i;

// One attachment → image thumb / inline video player / file chip, each with a
// download button.
function Attachment({ url, name, size, thumbHeight = 74 }) {
  const dl = (
    <a href={url} download={name} title="Download" style={{ textDecoration: "none", color: "var(--ink-faint)", fontSize: 13, padding: "0 2px" }}>⬇</a>
  );
  if (VIDEO_RE.test(name || ""))
    return (
      <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
        <video controls src={url} style={{ maxWidth: 260, maxHeight: 180, borderRadius: 8, border: "1px solid var(--line)", background: "#000" }} />
        <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>🎬 {name} · {fmtBytes(size)} {dl}</span>
      </span>
    );
  if (IMAGE_RE.test(name || ""))
    return (
      <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
        <Thumb url={url} name={name} size={size} height={thumbHeight} />
        <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{dl} download</span>
      </span>
    );
  return (
    <span style={fileChipStyle}>
      <a href={url} target="_blank" rel="noreferrer" style={{ textDecoration: "none", color: "var(--ink)" }}>📄 {name}</a>
      <span style={{ color: "var(--ink-faint)", fontSize: 11 }}>{fmtBytes(size)}</span>
      {dl}
    </span>
  );
}

const fileChipStyle = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px",
  border: "1px solid var(--line)", borderRadius: 8, background: "#fffef9",
  fontSize: 12, textDecoration: "none", color: "var(--ink)",
};

// Image thumbnail: lazy-loaded over a soft placeholder, opens the lightbox on
// click, and degrades to a file chip if the image can't load.
function Thumb({ url, name, size, height = 74 }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (failed)
    return (
      <a href={url} target="_blank" rel="noreferrer" style={fileChipStyle}>
        🖼 {name} <span style={{ color: "var(--ink-faint)", fontSize: 11 }}>{fmtBytes(size)}</span>
      </a>
    );
  return (
    <a
      href={url}
      title={`${name} · ${fmtBytes(size)} — click to enlarge`}
      onClick={(e) => { e.preventDefault(); openLightbox(url); }}
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
  return (
    <div style={{ margin: "12px 0 4px" }}>
      <div style={{ fontSize: 12, color: "var(--ink-faint)", marginBottom: 6 }}>
        📎 Attachments ({attachments.length})
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {attachments.map((a) => (
          <Attachment key={a.id} url={api.attachmentUrl(ticketId, a.id, a.name)} name={a.name} size={a.size} thumbHeight={86} />
        ))}
      </div>
    </div>
  );
}

// Files attached to ONE message — rendered inside its bubble (like Zoho does).
function MessageAttachments({ ticketId, threadId, attachments }) {
  if (!attachments?.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
      {attachments.map((a) => (
        <Attachment key={a.id} url={api.threadAttachmentUrl(ticketId, threadId, a.id, a.name)} name={a.name} size={a.size} />
      ))}
    </div>
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
          📦 {t.carrier || "Tracking"}:{" "}
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

function ShipmentCard({ s }) {
  return (
    <div className="card" style={{ padding: "10px 12px", marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="mono" style={{ fontWeight: 700 }}>#{s.orderNumber}</span>
        <Pill text={s.status} color={SHIP_STATUS_COLOR[s.status]} />
        <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{s.channel}{s.account ? ` · ${s.account}` : ""}</span>
        <span style={{ fontSize: 11, color: "var(--ink-faint)", marginLeft: "auto" }}>{s.date || ""}</span>
      </div>
      {s.items?.length > 0 && (
        <div style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 5 }}>
          {s.items.map((i) => `${i.name}${i.qty > 1 ? ` ×${i.qty}` : ""}`).join(" · ")}
        </div>
      )}
      {s.tracking.map((t, i) => (
        <div key={i} style={{ fontSize: 12, marginTop: 4 }}>
          📦 {t.carrier || "Tracking"}:{" "}
          {t.url ? <a href={t.url} target="_blank" rel="noreferrer">{t.number}</a> : <span className="mono">{t.number}</span>}
          {t.shipDate && <span style={{ color: "var(--ink-faint)" }}> · shipped {t.shipDate}</span>}
        </div>
      ))}
    </div>
  );
}

function ShipmentLookup({ q, setQ, results, loading, onSearch }) {
  return (
    <div style={{ margin: "10px 0 4px" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>📦 ShipStation</span>
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
          placeholder="🔎 Look up a product (e.g. K-131G)…"
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

// render plain text with clickable links (for the read-only conversation)
function linkifyNodes(text) {
  return String(text || "")
    .split(/(https?:\/\/[^\s)]+)/g)
    .map((p, i) =>
      /^https?:\/\//.test(p) ? (
        <a key={i} href={p} target="_blank" rel="noreferrer">{p}</a>
      ) : (
        p
      )
    );
}
