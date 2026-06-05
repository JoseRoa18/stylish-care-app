import { useEffect, useState } from "react";
import { api, FINISHES, KB_SOURCES } from "../api.js";

const FINISH_NAMES = Object.keys(FINISHES);

export default function KnowledgeBase() {
  const [articles, setArticles] = useState([]);
  const [sources, setSources] = useState(null);
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [editing, setEditing] = useState(null); // article or {new:true}
  const [err, setErr] = useState(null);
  const [ingesting, setIngesting] = useState(null); // key being ingested
  const [ingestMsg, setIngestMsg] = useState(null);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 24;

  const load = () =>
    Promise.all([api.kb(), api.kbSources()])
      .then(([d, s]) => {
        setArticles(d.articles);
        setSources(s);
      })
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);

  const filtered = articles.filter((a) => {
    if (sourceFilter !== "all" && a.source !== sourceFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return a.title.toLowerCase().includes(q) || a.body.toLowerCase().includes(q);
  });

  // reset to page 1 whenever the filter/search changes
  useEffect(() => {
    setPage(1);
  }, [search, sourceFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const save = async (form) => {
    try {
      if (form.new) await api.kbCreate(form);
      else await api.kbUpdate(form.id, form);
      setEditing(null);
      load();
    } catch (e) {
      setErr(e.message);
    }
  };

  const remove = async (id) => {
    if (!confirm("Delete this article?")) return;
    await api.kbDelete(id);
    load();
  };

  // poll the background job until it finishes, updating the progress message
  const pollUntilDone = async (label) => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 2500));
      let s;
      try {
        s = await api.kbIngestStatus();
      } catch {
        continue; // transient (e.g. server reload) — keep polling
      }
      if (s.running) {
        const pct = s.total ? ` ${s.done}/${s.total}` : "";
        setIngestMsg(`${label}: working…${pct}${s.file ? " · " + s.file : ""}`);
        continue;
      }
      return s; // finished
    }
  };

  const ingest = async (key, label) => {
    setIngesting(key);
    setIngestMsg(`${label}: starting…`);
    setErr(null);
    try {
      await api.kbIngest(key); // returns { started: true } — runs in background
      const s = await pollUntilDone(label);
      const r = (s.results || []).find((x) => x.key === key) || {};
      if (r.error) {
        setErr(`${label} ingest failed: ${r.error}`);
      } else {
        const added = r.added ?? r.ingested ?? 0;
        const errs = (r.errors || []).length;
        const idx = s.reindex && !s.reindex.error ? " · search index rebuilt" : "";
        setIngestMsg(
          `${label}: imported ${added} article${added === 1 ? "" : "s"}` +
            (errs ? ` · ${errs} skipped` : "") +
            idx
        );
      }
      load();
    } catch (e) {
      if (/already running/i.test(e.message)) {
        // another ingestion is in progress — just track it to completion
        setIngestMsg(`${label}: an ingestion is already running — tracking it…`);
        await pollUntilDone(label);
        setIngestMsg("Ingestion finished.");
        load();
      } else {
        setErr(`${label} ingest failed: ${e.message}`);
      }
    } finally {
      setIngesting(null);
    }
  };

  const connectors = sources?.connectors || {};

  return (
    <>
      <div className="section-title">
        <h2>Knowledge Base</h2>
        <button className="btn primary" onClick={() => setEditing({ new: true, finish: "" })}>
          + Add article
        </button>
      </div>

      {/* ── source counts + ingestion controls ─────────────── */}
      {sources && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <SourceChip
              label={`All ${sources.total}`}
              active={sourceFilter === "all"}
              onClick={() => setSourceFilter("all")}
            />
            {Object.entries(KB_SOURCES).map(([key, meta]) => (
              <SourceChip
                key={key}
                label={`${meta.label} ${sources.bySource?.[key] || 0}`}
                color={meta.color}
                active={sourceFilter === key}
                onClick={() => setSourceFilter(key)}
              />
            ))}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
            <button className="btn sm" disabled={!!ingesting} onClick={() => ingest("web", "Website")}>
              {ingesting === "web" ? "Importing…" : "↻ Import from Website"}
            </button>
            <button
              className="btn sm"
              disabled={!!ingesting || !connectors.youtube}
              title={connectors.youtube ? "" : "Set YOUTUBE_API_KEY + channel in .env"}
              onClick={() => ingest("youtube", "YouTube")}
            >
              {ingesting === "youtube" ? "Importing…" : "↻ Import YouTube videos"}
              {!connectors.youtube && " (not connected)"}
            </button>
            <button
              className="btn sm"
              disabled={!!ingesting || !connectors.dropbox}
              title={connectors.dropbox ? "" : "Set DROPBOX_ACCESS_TOKEN in .env"}
              onClick={() => ingest("dropbox", "Dropbox")}
            >
              {ingesting === "dropbox" ? "Importing…" : "↻ Import from Dropbox"}
              {!connectors.dropbox && " (not connected)"}
            </button>
            <button
              className="btn sm"
              disabled={!!ingesting || !connectors.templates}
              title={connectors.templates ? "" : "Place the Zoho export at server/data/zoho-templates.txt"}
              onClick={() => ingest("zoho-templates", "Zoho templates")}
            >
              {ingesting === "zoho-templates" ? "Importing…" : "↻ Import Zoho templates"}
              {!connectors.templates && " (no file)"}
            </button>
          </div>
          {ingestMsg && (
            <div style={{ marginTop: 10, fontSize: 12, color: "var(--green)" }}>{ingestMsg}</div>
          )}
        </div>
      )}

      {err && <div className="banner error">{err}</div>}

      <input
        className="field"
        style={{ width: "100%", maxWidth: 340, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 8, marginBottom: 18, background: "#fffef9" }}
        placeholder="Search articles…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, fontSize: 12, color: "var(--ink-faint)" }}>
        <span>
          {filtered.length} article{filtered.length === 1 ? "" : "s"}
          {filtered.length > PAGE_SIZE &&
            ` · showing ${(safePage - 1) * PAGE_SIZE + 1}–${Math.min(safePage * PAGE_SIZE, filtered.length)}`}
        </span>
      </div>

      <div className="kb-grid">
        {pageItems.map((a) => {
          const sm = KB_SOURCES[a.source] || KB_SOURCES.manual;
          return (
            <div key={a.id} className="kb-card">
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--brass)" }}>{a.id}</span>
                <span className="badge" style={{ background: sm.color, color: "#fff" }}>{sm.label}</span>
                {a.finish && (
                  <span className="badge" style={{ background: "var(--line-soft)", color: "var(--ink-soft)" }}>
                    <i className="swatch" style={{ background: FINISHES[a.finish] || "#ccc" }} />
                    {a.finish}
                  </span>
                )}
              </div>
              <h3>{a.title}</h3>
              <div className="kb-body">{a.body}</div>
              <div className="kb-foot">
                {a.sourceUrl && (
                  <a className="btn sm ghost" href={a.sourceUrl.startsWith("http") ? a.sourceUrl : undefined} target="_blank" rel="noreferrer" style={{ pointerEvents: a.sourceUrl.startsWith("http") ? "auto" : "none" }}>
                    Source
                  </a>
                )}
                <button className="btn sm" onClick={() => setEditing({ ...a })}>Edit</button>
                <button className="btn sm ghost" style={{ color: "var(--red)" }} onClick={() => remove(a.id)}>Delete</button>
              </div>
            </div>
          );
        })}
      </div>

      {pageCount > 1 && (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 12, marginTop: 20 }}>
          <button className="btn sm" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
            ← Prev
          </button>
          <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>
            Page {safePage} of {pageCount}
          </span>
          <button className="btn sm" disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)}>
            Next →
          </button>
        </div>
      )}

      {editing && (
        <Editor article={editing} onCancel={() => setEditing(null)} onSave={save} />
      )}
    </>
  );
}

function SourceChip({ label, color, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 999,
        border: active ? "1px solid var(--ink-soft)" : "1px solid var(--line)",
        background: active ? "var(--line-soft)" : "transparent",
        fontSize: 12,
        cursor: "pointer",
      }}
    >
      {color && <i style={{ width: 8, height: 8, borderRadius: 999, background: color }} />}
      {label}
    </button>
  );
}

function Editor({ article, onCancel, onSave }) {
  const [form, setForm] = useState({
    new: article.new || false,
    id: article.id,
    title: article.title || "",
    body: article.body || "",
    finish: article.finish || "",
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="modal-bg" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ fontSize: 18, marginBottom: 18 }}>
          {form.new ? "New article" : `Edit ${form.id}`}
        </h2>
        <div className="field">
          <label>Title</label>
          <input value={form.title} onChange={(e) => set("title", e.target.value)} />
        </div>
        <div className="field">
          <label>Content (approved policy text)</label>
          <textarea value={form.body} onChange={(e) => set("body", e.target.value)} />
        </div>
        <div className="field">
          <label>Finish tag (optional)</label>
          <select value={form.finish} onChange={(e) => set("finish", e.target.value)}>
            <option value="">— none —</option>
            {FINISH_NAMES.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button
            className="btn primary"
            onClick={() => onSave(form)}
            disabled={!form.title.trim() || !form.body.trim()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
