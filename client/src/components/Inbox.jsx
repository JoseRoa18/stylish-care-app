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

export default function Inbox() {
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
      ) : (
        tickets.map((t) => (
          <TicketRow
            key={t.id}
            ticket={t}
            statusOptions={statusOptions}
            open={openId === t.id}
            onToggle={() => setOpenId(openId === t.id ? null : t.id)}
            onChanged={load}
          />
        ))
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
      ⏱ {fmtDuration(ms)}
    </span>
  );
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
function RichEditor({ docKey, initialHtml, disabled, onChange }) {
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

  return (
    <div className="rich">
      <div className="rich-toolbar">
        {btn(<b>B</b>, "bold", "Bold")}
        {btn(<i>I</i>, "italic", "Italic")}
        {btn(<u>U</u>, "underline", "Underline")}
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

function TicketRow({ ticket, open, onToggle, statusOptions = [], onChanged }) {
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
  const fileInputRef = useRef(null);
  const onPickFiles = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = ""; // allow re-picking the same file
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

  // ticket attachments (#7)
  const [attachments, setAttachments] = useState([]);

  const loadConversation = useCallback(async () => {
    setConvoLoading(true);
    setConvoError(null);
    // fetch the file list in parallel — non-blocking, best-effort
    api.attachments(ticket.id).then((r) => setAttachments(r.attachments || [])).catch(() => {});
    try {
      const res = await api.conversation(ticket.id);
      setConversation(res.conversation || []);
      setConvoLoaded(true);
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
        ticket.id, toEmail.trim(), draftHtml, "html",
        aiMeta
          ? {
              aiDraft: aiMeta.draft, intent: aiMeta.intent,
              confidence: aiMeta.confidence, sensitive: aiMeta.sensitive,
              lane: aiMeta.lane, kbCovered: aiMeta.kbCovered,
              kbUsed: aiMeta.usedKb, ticketNumber: ticket.number,
            }
          : undefined,
        outFiles.map((f) => f.id)
      );
      setSent(true);
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
                {conversation.map((m, i) => {
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
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <AttachmentStrip ticketId={ticket.id} attachments={attachments} />

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

          {!hasContent && !drafting && (
            <div className="draft-actions" style={{ marginTop: 14 }}>
              <button className="btn primary" onClick={generate} disabled={convoLoading}>
                ✦ Generate reply with AI
              </button>
              <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>Uses the approved Knowledge Base.</span>
            </div>
          )}

          {drafting && !hasContent && (
            <div style={{ padding: "16px 0", color: "var(--ink-faint)" }}>
              <span className="spin" /> Drafting reply from Knowledge Base…
            </div>
          )}

          {hasContent && (
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
              <RichEditor
                docKey={docKey}
                initialHtml={draftHtml}
                disabled={sent}
                onChange={setDraftHtml}
              />
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
                <button className="btn" onClick={generate} disabled={drafting || sending || sent}>
                  {drafting ? "Regenerating…" : "↻ Regenerate"}
                </button>
                {sent && <span style={{ color: "var(--green)", fontSize: 13 }}>Reply sent to {toEmail}</span>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Render a message's real (server-sanitized) email HTML, with the quoted
// reply-chain collapsed behind a toggle so each bubble shows just the new part.
function EmailHtml({ html }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const hasQuoted = /<blockquote|gmail_quote|zmail_extra/i.test(html);
  return (
    <>
      <div
        className={`email-html ${hasQuoted && !showQuoted ? "hide-quotes" : ""}`}
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

// Strip of every file on the ticket: image thumbnails + download links (#7).
function AttachmentStrip({ ticketId, attachments }) {
  if (!attachments?.length) return null;
  return (
    <div style={{ margin: "12px 0 4px" }}>
      <div style={{ fontSize: 12, color: "var(--ink-faint)", marginBottom: 6 }}>
        📎 Attachments ({attachments.length})
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {attachments.map((a) => {
          const url = api.attachmentUrl(ticketId, a.id, a.name);
          return IMAGE_RE.test(a.name || "") ? (
            <a key={a.id} href={url} target="_blank" rel="noreferrer" title={`${a.name} · ${fmtBytes(a.size)}`}>
              <img
                src={url}
                alt={a.name}
                style={{ height: 86, maxWidth: 150, objectFit: "cover", borderRadius: 8, border: "1px solid var(--line)", display: "block" }}
              />
            </a>
          ) : (
            <a
              key={a.id}
              href={url}
              target="_blank"
              rel="noreferrer"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 11px", border: "1px solid var(--line)", borderRadius: 8, background: "#fffef9", fontSize: 13, textDecoration: "none", color: "var(--ink)" }}
            >
              📄 {a.name} <span style={{ color: "var(--ink-faint)", fontSize: 11 }}>{fmtBytes(a.size)}</span>
            </a>
          );
        })}
      </div>
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
