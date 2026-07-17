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
  const [fb, setFb] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    const load = () => {
      api.dashboard().then(setData).catch((e) => setErr(e.message));
      api.feedbackMetrics(90).then(setFb).catch(() => {});
    };
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
        <Metric
          label="Open tickets"
          value={data.openNow ?? data.active}
          sub={`incl. escalated · ${data.active} active total · ${data.closed} closed`}
        />
        <Metric label="Avg wait (open)" value={fmtDuration(data.avgWaitMs)} color={waitColor(data.avgWaitMs)} sub={`open + escalated · oldest ${fmtDuration(data.oldestWaitMs)}`} />
        <AvgResolutionCard defaultAvgMs={data.avgResolutionMs} defaultCount={data.resolvedSample || 0} />
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

      {/* ── RingCentral: calls + combined volume ─────────── */}
      {data.callsPerDay?.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
          <div className="card">
            <div className="chart-title">Answered calls · last 7 days</div>
            <ColumnChart data={data.callsPerDay} color="#7a8b6f" />
          </div>
          <div className="card">
            <div className="chart-title">Total volume · answered calls + tickets · last 7 days</div>
            <ColumnChart data={data.combinedPerDay} color="#a98b6a" />
          </div>
        </div>
      )}

      {/* ── weekly resolution ────────────────────────────── */}
      {data.resolutionByWeek?.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="chart-title">Avg resolution · by week (last 8 weeks)</div>
          <WeeklyResolution data={data.resolutionByWeek} />
        </div>
      )}

      {/* ── AI reply quality (feedback loop) ─────────────── */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="chart-title">AI reply quality · last 90 days</div>
        <AiQuality fb={fb} />
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

// AI acceptance: how often agents send the AI draft as-is vs edit/rewrite it,
// plus which topics get rewritten most (where the KB/prompt needs work).
function AiQuality({ fb }) {
  if (!fb) return <div style={{ color: "var(--ink-faint)", fontSize: 13, marginTop: 6 }}>Loading…</div>;
  const total = fb.total || 0;
  if (!total)
    return (
      <div style={{ color: "var(--ink-faint)", fontSize: 13, marginTop: 6 }}>
        No AI replies sent yet. As the team approves & sends AI-assisted replies, this will show how
        often they go out unchanged vs edited — and which topics need work.
      </div>
    );
  const pct = (n) => Math.round((n / total) * 100);
  const segs = [
    { label: "Sent as-is", n: fb.asIs || 0, color: "#3b7a57" },
    { label: "Lightly edited", n: fb.light || 0, color: "#c8912a" },
    { label: "Rewritten", n: fb.heavy || 0, color: "#c0392b" },
  ];
  const intents = (fb.byIntent || [])
    .map((r) => ({ ...r, rewritten: r.total ? Math.round((r.heavy / r.total) * 100) : 0 }))
    .sort((a, b) => b.rewritten - a.rewritten)
    .slice(0, 8);
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 30, fontWeight: 700, color: "#3b7a57" }}>{pct(fb.asIs || 0)}%</span>
        <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>sent without changes · {total} replies measured</span>
      </div>
      <div style={{ display: "flex", height: 16, borderRadius: 6, overflow: "hidden", background: "var(--line-soft)" }}>
        {segs.map((s) => s.n > 0 && (
          <div key={s.label} title={`${s.label}: ${s.n}`} style={{ width: `${pct(s.n)}%`, background: s.color }} />
        ))}
      </div>
      <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 12, flexWrap: "wrap" }}>
        {segs.map((s) => (
          <span key={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--ink-soft)" }}>
            <i style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} /> {s.label}: <b>{s.n}</b> ({pct(s.n)}%)
          </span>
        ))}
      </div>
      {intents.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, color: "var(--ink-faint)", marginBottom: 6 }}>By topic — where the AI gets rewritten most</div>
          {intents.map((r) => (
            <div key={r.intent} style={{ display: "flex", alignItems: "center", gap: 10, margin: "5px 0" }}>
              <span style={{ width: 130, fontSize: 12, color: "var(--ink-soft)", textAlign: "right", flexShrink: 0 }}>
                {(r.intent || "").replace(/_/g, " ")}
              </span>
              <div style={{ flex: 1, background: "var(--line-soft)", borderRadius: 6, height: 14 }}>
                <div style={{ width: `${r.rewritten}%`, height: "100%", background: "#c0392b", borderRadius: 6, minWidth: r.rewritten > 0 ? 4 : 0 }} />
              </div>
              <span className="mono" style={{ width: 70, fontSize: 11, textAlign: "right" }}>{r.rewritten}% · {r.total}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Avg resolution with a selectable window (all time, 30/90 days, or a year).
function AvgResolutionCard({ defaultAvgMs, defaultCount }) {
  const [period, setPeriod] = useState("all");
  const [val, setVal] = useState({ avgMs: defaultAvgMs, count: defaultCount });
  const [loading, setLoading] = useState(false);

  const years = [];
  for (let y = new Date().getFullYear(); y >= 2023; y--) years.push(y);

  const change = async (p) => {
    setPeriod(p);
    if (p === "all") { setVal({ avgMs: defaultAvgMs, count: defaultCount }); return; }
    setLoading(true);
    try {
      const r = await api.resolutionMetric(p);
      setVal({ avgMs: r.avgMs, count: r.count });
    } catch { /* keep last */ }
    finally { setLoading(false); }
  };

  return (
    <div className="card metric">
      <div className="label" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
        <span>Avg resolution</span>
        <select
          value={period}
          onChange={(e) => change(e.target.value)}
          style={{ fontSize: 11, padding: "2px 4px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--card)", color: "var(--ink-soft)", cursor: "pointer", textTransform: "none", letterSpacing: 0 }}
        >
          <option value="all">All time</option>
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
          {years.map((y) => <option key={y} value={`year:${y}`}>{y}</option>)}
        </select>
      </div>
      <div className="value" style={{ opacity: loading ? 0.4 : 1 }}>
        {val.avgMs != null ? fmtDuration(val.avgMs) : "—"}
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 4 }}>
        {loading ? "calculating…" : `over ${val.count || 0} closed tickets`}
      </div>
    </div>
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

// Weekly average resolution time — bars scaled to days, labelled with the value.
function WeeklyResolution({ data }) {
  const days = (ms) => (ms == null ? null : ms / 86400000);
  const max = Math.max(1, ...data.map((d) => days(d.avgMs) || 0));
  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", height: 110, marginTop: 8 }}>
        {data.map((d, i) => {
          const dv = days(d.avgMs);
          return (
            <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center" }} title={d.count ? `${d.count} tickets closed` : "no tickets closed"}>
              {dv != null && <span style={{ fontSize: 11, color: "var(--ink-soft)", marginBottom: 3 }}>{dv < 1 ? `${Math.round(dv * 24)}h` : `${dv.toFixed(1)}d`}</span>}
              <div style={{ width: "60%", maxWidth: 44, background: dv == null ? "var(--line-soft)" : "var(--brass)", borderRadius: "4px 4px 0 0", height: `${dv == null ? 2 : Math.max((dv / max) * 84, 3)}px` }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        {data.map((d, i) => (
          <span key={i} style={{ flex: 1, textAlign: "center", fontSize: 10, color: "var(--ink-faint)" }}>
            {d.label}<br /><span style={{ opacity: 0.7 }}>{d.count || 0}</span>
          </span>
        ))}
      </div>
    </>
  );
}

function ColumnChart({ data, color = "var(--brass)" }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", height: 96, marginTop: 8 }}>
        {data.map((d, i) => (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center" }}>
            {d.count > 0 && <span style={{ fontSize: 11, color: "var(--ink-soft)", marginBottom: 3 }}>{d.count}</span>}
            <div style={{ width: "62%", maxWidth: 40, background: color, borderRadius: "4px 4px 0 0", height: `${Math.max((d.count / max) * 72, 2)}px` }} />
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
