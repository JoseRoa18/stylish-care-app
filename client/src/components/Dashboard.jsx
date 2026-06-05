import { useEffect, useState } from "react";
import { api } from "../api.js";

const STATUS_COLORS = {
  Open: "#3b7a57",
  "On Hold": "#c8912a",
  Escalated: "#c0392b",
  Closed: "#8a8378",
};

function fmtDuration(ms) {
  if (ms == null) return "—";
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
function waitColor(ms) {
  if (ms == null) return "var(--ink)";
  const h = ms / 3600000;
  return h < 4 ? "#3b7a57" : h < 24 ? "#c8912a" : "#c0392b";
}

export default function Dashboard({ onOpenInbox }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    const load = () => api.dashboard().then(setData).catch((e) => setErr(e.message));
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  if (err) return <div className="banner error">Could not load dashboard: {err}</div>;
  if (!data) return <div className="empty"><span className="spin" /> Loading…</div>;

  const lastFetch = data.lastFetch ? new Date(data.lastFetch).toLocaleString() : "—";
  const connectors = [
    ["Gemini", data.gemini], ["Zoho", data.zoho], ["Dropbox", data.dropbox],
  ];

  return (
    <>
      {!data.zoho && (
        <div className="banner warn">
          Zoho Desk is not configured yet. Add your Zoho credentials to <b>.env</b> to
          start pulling live tickets. (The Knowledge Base works without it.)
        </div>
      )}
      {data.error && <div className="banner error">Zoho: {data.error}</div>}

      {/* ── headline metrics ─────────────────────────────── */}
      <div className="grid cards-4" style={{ marginTop: 8 }}>
        <Metric label="Active tickets" value={data.active} sub={`${data.total} loaded · ${data.closed} closed`} />
        <Metric label="Avg wait (active)" value={fmtDuration(data.avgWaitMs)} color={waitColor(data.avgWaitMs)} sub={`oldest ${fmtDuration(data.oldestWaitMs)}`} />
        <Metric label="Avg resolution" value={fmtDuration(data.avgResolutionMs)} sub={`${data.resolvedSample || 0} closed sampled`} />
        <Metric label="KB articles" value={data.kbArticles} />
      </div>

      {/* ── breakdown charts ─────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <div className="card">
          <div className="chart-title">Tickets by status</div>
          <BarChart data={data.byStatus} colors={STATUS_COLORS} onPick={onOpenInbox} />
        </div>
        <div className="card">
          <div className="chart-title">Tickets by channel</div>
          <BarChart data={data.byChannel} />
        </div>
      </div>

      {/* ── volume over time ─────────────────────────────── */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="chart-title">New tickets · last 7 days</div>
        <ColumnChart data={data.perDay || []} />
      </div>

      {/* ── footer ───────────────────────────────────────── */}
      <div className="card" style={{ marginTop: 16, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
          {connectors.map(([name, ok]) => (
            <span key={name} style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--ink-soft)" }}>
              <i style={{ width: 8, height: 8, borderRadius: 999, background: ok ? "var(--green)" : "var(--ink-faint)" }} />
              {name}
            </span>
          ))}
        </div>
        <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>Last synced: {lastFetch}</span>
        <button className="btn sm" onClick={onOpenInbox}>Go to Inbox →</button>
      </div>
    </>
  );
}

function Metric({ label, value, sub, color }) {
  return (
    <div className="card metric">
      <div className="label">{label}</div>
      <div className="value" style={color ? { color } : undefined}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function BarChart({ data, colors, onPick }) {
  const entries = Object.entries(data || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return <div style={{ color: "var(--ink-faint)", fontSize: 13 }}>No data.</div>;
  const max = Math.max(1, ...entries.map((e) => e[1]));
  return (
    <div style={{ marginTop: 8 }}>
      {entries.map(([k, v]) => (
        <div
          key={k}
          onClick={onPick}
          style={{ display: "flex", alignItems: "center", gap: 10, margin: "7px 0", cursor: onPick ? "pointer" : "default" }}
        >
          <span style={{ width: 84, fontSize: 12, color: "var(--ink-soft)", textAlign: "right", flexShrink: 0 }}>{k}</span>
          <div style={{ flex: 1, background: "var(--line-soft)", borderRadius: 6, height: 18 }}>
            <div style={{ width: `${(v / max) * 100}%`, height: "100%", background: colors?.[k] || "var(--brass)", borderRadius: 6, minWidth: 4 }} />
          </div>
          <span className="mono" style={{ width: 28, fontSize: 12, textAlign: "right" }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function ColumnChart({ data }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", height: 96, marginTop: 8 }}>
        {data.map((d, i) => (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center" }}>
            {d.count > 0 && <span style={{ fontSize: 11, color: "var(--ink-soft)", marginBottom: 3 }}>{d.count}</span>}
            <div style={{ width: "62%", maxWidth: 40, background: "var(--brass)", borderRadius: "4px 4px 0 0", height: `${Math.max((d.count / max) * 72, 2)}px` }} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        {data.map((d, i) => (
          <span key={i} style={{ flex: 1, textAlign: "center", fontSize: 10, color: "var(--ink-faint)" }}>{d.label}</span>
        ))}
      </div>
    </>
  );
}
