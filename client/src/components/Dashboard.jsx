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

// One window for the whole page. 90 days is the default because a shorter one
// leaves the resolution and satisfaction cards with too few tickets to mean
// anything.
const PERIOD_DAYS = { "7d": 7, "30d": 30, "90d": 90, "180d": 180, "365d": 365, all: 0 };
const PERIOD_LABELS = { "7d": "7 days", "30d": "30 days", "90d": "90 days", "180d": "6 months", "365d": "1 year", all: "All time" };

export default function Dashboard({ onOpenInbox }) {
  const [data, setData] = useState(null);
  const [fb, setFb] = useState(null);
  const [wf, setWf] = useState(null);
  const [models, setModels] = useState(null);
  const [csat, setCsat] = useState(null);
  const [period, setPeriod] = useState("90d");
  const [err, setErr] = useState(null);

  // Only what actually depends on the period reloads when it changes. The
  // Wayfair panel alone took 2s (it calls their API), and refetching it on
  // every click is what made switching feel slow.
  useEffect(() => {
    const load = () => {
      api.dashboard({ period }).then(setData).catch((e) => setErr(e.message));
      api.modelReports(PERIOD_DAYS[period] || 0).then(setModels).catch(() => setModels(null));
    };
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [period]);

  // these three answer their own fixed windows, so they load once
  useEffect(() => {
    api.feedbackMetrics(90).then(setFb).catch(() => {});
    api.wayfairCancellations(14).then(setWf).catch(() => {});
    api.surveyMetrics(90).then((r) => setCsat(r.metrics)).catch(() => setCsat(null));
  }, []);

  if (err) return <div className="banner error">Could not load dashboard: {err}</div>;
  if (!data) return <div className="empty"><span className="spin" /> Loading…</div>;

  const lastFetch = data.lastFetch ? new Date(data.lastFetch).toLocaleString() : "—";
  const connectors = [
    ["Gemini", data.gemini], ["Zoho", data.zoho],
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

      {/* ── one window for every panel below ─────────────── */}
      <div className="period-bar">
        <span style={{ fontSize: 12, color: "var(--ink-faint)", textTransform: "uppercase", letterSpacing: ".06em" }}>Period</span>
        {Object.entries(PERIOD_LABELS).map(([k, label]) => (
          <button
            key={k}
            className={`btn sm ${period === k ? "primary" : ""}`}
            onClick={() => setPeriod(k)}
            style={{ fontSize: 11, padding: "3px 10px" }}
          >
            {label}
          </button>
        ))}
        {/* automated mail is never what the team wants to see — the count is
            kept visible so the numbers are not silently smaller than reality */}
        {data.notifications > 0 && (
          <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--ink-faint)" }}>
            {data.notifications} automated notification{data.notifications > 1 ? "s" : ""} excluded
          </span>
        )}
      </div>

      {/* ── headline metrics ─────────────────────────────── */}
      <div className="grid cards-4" style={{ marginTop: 8 }}>
        <Metric
          label="Open tickets"
          value={data.openNow ?? data.active}
          sub={`incl. escalated · ${data.active} active total · ${data.closed} closed`}
        />
        <Metric
          label="Avg wait (open)"
          value={fmtDuration(data.avgWaitMs)}
          color={targetColor(data.avgWaitMs, data.targets?.waitHours) || waitColor(data.avgWaitMs)}
          sub={`open + escalated · oldest ${fmtDuration(data.oldestWaitMs)}${data.targets?.waitHours ? ` · target ${data.targets.waitHours}h` : ""}`}
        />
        <AvgResolutionCard
          defaultAvgMs={data.avgResolutionMs}
          defaultCount={data.resolvedSample || 0}
          targetHours={data.targets?.resolutionHours}
        />
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

      {/* ── what the tickets are about ───────────────────── */}
      <CategoryPanel
        byCategory={data.byCategory}
        awaiting={data.awaitingByCategory}
        labels={data.categoryLabels}
      />

      {/* ── volume over time ─────────────────────────────── */}
      <TrendCard initial={data.perDay || []} />

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
          <WeeklyResolution data={data.resolutionByWeek} targetHours={data.targets?.resolutionHours} />
        </div>
      )}

      {/* ── Wayfair: recent volume + cancellations ───────── */}
      {wf && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="chart-title">
            Wayfair · last {wf.days} days — {wf.poCount} POs · {wf.cancellations?.length || 0} with cancelled items
          </div>
          {(wf.cancellations || []).length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--ink-faint)", marginTop: 6 }}>No cancellations in this window.</div>
          ) : (
            <div style={{ marginTop: 6 }}>
              {wf.cancellations.map((c) => (
                <div key={c.poNumber} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--line-soft)", fontSize: 13 }}>
                  <span className="mono" style={{ fontWeight: 600 }}>#{c.poNumber}</span>
                  {c.region && <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{c.region}</span>}
                  <span style={{ color: "var(--ink-soft)" }}>{c.customer || ""}</span>
                  <span style={{ color: "var(--red)" }}>{c.items.join(", ")} cancelled</span>
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-faint)" }}>{c.date}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── satisfaction (post-close survey) ─────────────── */}
      <SatisfactionPanel m={csat} enabled={data.surveysEnabled} />

      {/* ── which models drive the support load ──────────── */}
      <ModelReports reports={models} />

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
function AvgResolutionCard({ defaultAvgMs, defaultCount, targetHours }) {
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
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
          {years.map((y) => <option key={y} value={`year:${y}`}>{y}</option>)}
        </select>
      </div>
      <div className="value" style={{ opacity: loading ? 0.4 : 1, color: targetColor(val.avgMs, targetHours) }}>
        {val.avgMs != null ? fmtDuration(val.avgMs) : "—"}
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 4 }}>
        {loading ? "calculating…" : `over ${val.count || 0} closed tickets`}
        {targetHours ? ` · target ${targetHours}h` : ""}
      </div>
    </div>
  );
}

// Green under the goal, red over it. No target set → leave the value neutral
// rather than implying a judgement we were never given.
function targetColor(ms, targetHours) {
  if (ms == null || !targetHours) return undefined;
  return ms <= targetHours * 3600000 ? "var(--green)" : "var(--red)";
}

// What customers said after their ticket was closed. "Satisfaction rate" is the
// share rating 4 or 5 — the standard CSAT definition, so it can be compared to
// a benchmark rather than only to itself.
function SatisfactionPanel({ m, enabled }) {
  if (!m) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <div className="chart-title">Satisfaction</div>
        <div style={{ fontSize: 13, color: "var(--ink-faint)", marginTop: 6 }}>
          Not set up yet — run <code>supabase/surveys.sql</code> in the Supabase SQL editor. After that every
          closed ticket emails the customer a three-question survey.
        </div>
      </div>
    );
  }
  if (!m.answered) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <div className="chart-title">Satisfaction</div>
        <div style={{ fontSize: 13, color: "var(--ink-faint)", marginTop: 6 }}>
          {m.sent
            ? `${m.sent} survey${m.sent > 1 ? "s" : ""} sent, no answers yet.`
            : enabled === false
            ? "Surveys are turned off. Switch them on in Settings and every closed ticket will ask the customer three quick questions."
            : "No surveys sent yet — they go out when a ticket is closed."}
        </div>
      </div>
    );
  }
  const rate = m.satisfactionRate;
  const bars = [5, 4, 3, 2, 1];
  const max = Math.max(1, ...bars.map((s) => m.stars?.[s] || 0));
  const resolvedTotal = (m.resolvedYes || 0) + (m.resolvedPartly || 0) + (m.resolvedNo || 0);
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="chart-title">
        Satisfaction · last 90 days
        <span style={{ fontWeight: 400, color: "var(--ink-faint)", fontSize: 11, marginLeft: 8 }}>
          {m.answered} of {m.sent} answered
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 24, marginTop: 10, alignItems: "center" }}>
        <div>
          <div style={{ fontFamily: "Fraunces, serif", fontSize: 44, lineHeight: 1.1, color: rate >= 80 ? "var(--green)" : rate >= 60 ? "var(--amber)" : "var(--red)" }}>
            {rate}%
          </div>
          <div style={{ fontSize: 11, color: "var(--ink-faint)", textTransform: "uppercase", letterSpacing: ".06em" }}>rated 4 or 5</div>
          <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 8 }}>
            {m.avgSatisfaction} avg · {m.avgSpeed} on speed
          </div>
        </div>
        <div>
          {bars.map((s) => (
            <div key={s} style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0" }}>
              <span style={{ width: 34, fontSize: 12, color: "var(--ink-faint)", textAlign: "right" }}>{s}★</span>
              <div style={{ flex: 1, background: "var(--line-soft)", borderRadius: 5, height: 14 }}>
                <div style={{ width: `${((m.stars?.[s] || 0) / max) * 100}%`, height: "100%", background: s >= 4 ? "var(--green)" : s === 3 ? "var(--amber)" : "var(--red)", borderRadius: 5, minWidth: (m.stars?.[s] || 0) ? 4 : 0 }} />
              </div>
              <span className="mono" style={{ width: 26, fontSize: 12, textAlign: "right" }}>{m.stars?.[s] || 0}</span>
            </div>
          ))}
          {resolvedTotal > 0 && (
            <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 10 }}>
              Issue resolved: <b>{m.resolvedYes}</b> yes · {m.resolvedPartly} partly · <b>{m.resolvedNo}</b> no
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Which models generate spare-part demand and which come back defective.
// The sample size is printed next to every list on purpose: a model only
// appears when someone typed its code, so these are a directional read on
// support load, not a failure rate — and at these counts a difference of one
// or two tickets is noise.
function ModelReports({ reports }) {
  if (!reports) return null;
  const list = (rows) => {
    if (!rows.length) return <div style={{ fontSize: 13, color: "var(--ink-faint)", marginTop: 6 }}>No tickets named a model in this window.</div>;
    const max = Math.max(...rows.map((r) => r.count));
    return (
      <div style={{ marginTop: 8 }}>
        {rows.map((r) => (
          <div key={r.model} style={{ display: "flex", alignItems: "center", gap: 10, margin: "6px 0" }}>
            <span className="mono" style={{ width: 86, fontSize: 12, textAlign: "right", flexShrink: 0 }}>{r.model}</span>
            <div style={{ flex: 1, background: "var(--line-soft)", borderRadius: 6, height: 16 }}>
              <div style={{ width: `${(r.count / max) * 100}%`, height: "100%", background: "var(--brass)", borderRadius: 6, minWidth: 4 }} />
            </div>
            <span className="mono" style={{ width: 26, fontSize: 12, textAlign: "right" }}>{r.count}</span>
          </div>
        ))}
      </div>
    );
  };
  const total = (rows) => rows.reduce((n, r) => n + r.count, 0);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
      <div className="card">
        <div className="chart-title">Spare parts & warranty · by model</div>
        {list(reports.parts)}
        <div style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 8 }}>
          {total(reports.parts)} tickets that named a model
        </div>
      </div>
      <div className="card">
        <div className="chart-title">Defects & wrong items · by model</div>
        {list(reports.defects)}
        <div style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 8 }}>
          {total(reports.defects)} tickets that named a model — too few to rank confidently
        </div>
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
// A dashed goal line sits at the target so a week that missed it reads at a
// glance; bars over the target turn red.
function WeeklyResolution({ data, targetHours }) {
  const days = (ms) => (ms == null ? null : ms / 86400000);
  const target = targetHours ? targetHours / 24 : null;
  const PLOT = 84; // px of plot area the tallest bar fills
  // keep the goal line on-chart even when every week beat it comfortably
  const max = Math.max(1, ...data.map((d) => days(d.avgMs) || 0), target || 0);
  return (
    <>
      <div style={{ position: "relative", display: "flex", gap: 8, alignItems: "flex-end", height: 110, marginTop: 8 }}>
        {target != null && (
          <div
            title={`Target ${targetHours}h`}
            style={{ position: "absolute", left: 0, right: 0, bottom: (target / max) * PLOT, borderTop: "1px dashed var(--green)", pointerEvents: "none" }}
          >
            <span style={{ position: "absolute", right: 0, top: -13, fontSize: 10, color: "var(--green)", background: "var(--card)", padding: "0 3px" }}>
              target {targetHours}h
            </span>
          </div>
        )}
        {data.map((d, i) => {
          const dv = days(d.avgMs);
          const over = target != null && dv != null && dv > target;
          return (
            <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center" }} title={d.count ? `${d.count} tickets closed` : "no tickets closed"}>
              {dv != null && <span style={{ fontSize: 11, color: "var(--ink-soft)", marginBottom: 3 }}>{dv < 1 ? `${Math.round(dv * 24)}h` : `${dv.toFixed(1)}d`}</span>}
              <div style={{ width: "60%", maxWidth: 44, background: dv == null ? "var(--line-soft)" : over ? "var(--red)" : "var(--green)", borderRadius: "4px 4px 0 0", height: `${dv == null ? 2 : Math.max((dv / max) * PLOT, 3)}px` }} />
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

// New-ticket volume at the granularity the user picks. Seven fixed days was
// fine for spotting a spike but useless for "are we trending up this quarter".
const TREND_PERIODS = [
  { id: "days", label: "Days", n: 14 },
  { id: "weeks", label: "Weeks", n: 12 },
  { id: "months", label: "Months", n: 12 },
  { id: "custom", label: "Custom" },
];

function TrendCard({ initial }) {
  const [period, setPeriod] = useState("days");
  const [points, setPoints] = useState(initial || []);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [range, setRange] = useState({ from: monthAgo, to: today });

  const load = async (p, r = range) => {
    setLoading(true);
    setErr(null);
    try {
      const spec = TREND_PERIODS.find((x) => x.id === p);
      const res = await api.trend(
        p === "custom" ? { period: p, from: r.from, to: r.to } : { period: p, n: spec?.n }
      );
      setPoints(res.points || []);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  const pick = (p) => {
    setPeriod(p);
    load(p);
  };

  const total = points.reduce((n, p) => n + p.count, 0);

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="chart-title" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span>New tickets</span>
        <span style={{ fontSize: 11, color: "var(--ink-faint)", fontWeight: 400 }}>
          {total} total{loading ? " · loading…" : ""}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          {TREND_PERIODS.map((p) => (
            <button
              key={p.id}
              className={`btn sm ${period === p.id ? "primary" : ""}`}
              onClick={() => pick(p.id)}
              style={{ fontSize: 11, padding: "3px 9px" }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {period === "custom" && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, fontSize: 12, color: "var(--ink-faint)" }}>
          <input
            type="date" value={range.from} max={range.to}
            onChange={(e) => { const r = { ...range, from: e.target.value }; setRange(r); load("custom", r); }}
            style={dateStyle}
          />
          <span>to</span>
          <input
            type="date" value={range.to} min={range.from} max={today}
            onChange={(e) => { const r = { ...range, to: e.target.value }; setRange(r); load("custom", r); }}
            style={dateStyle}
          />
        </div>
      )}
      {err ? (
        <div style={{ fontSize: 12, color: "var(--red)", marginTop: 8 }}>{err}</div>
      ) : points.length ? (
        <div style={{ opacity: loading ? 0.45 : 1 }}><ColumnChart data={points} /></div>
      ) : (
        <div style={{ fontSize: 13, color: "var(--ink-faint)", marginTop: 8 }}>No tickets in this range.</div>
      )}
    </div>
  );
}

const dateStyle = {
  padding: "4px 8px", border: "1px solid var(--line)", borderRadius: 6,
  background: "var(--card)", color: "var(--ink-soft)", fontSize: 12,
};

// What the tickets are actually ABOUT, not which channel they came in on.
// Automated mail is the largest single bucket and would flatten every real
// issue next to it, so it's counted below the chart instead of inside it.
function CategoryPanel({ byCategory, awaiting, labels }) {
  if (!byCategory) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <div className="chart-title">Tickets by issue</div>
        <div style={{ fontSize: 13, color: "var(--ink-faint)", marginTop: 6 }}>
          Not set up yet — run <code>supabase/categories.sql</code> in the Supabase SQL editor,
          then the tickets get labelled automatically.
        </div>
      </div>
    );
  }
  const name = (k) => labels?.[k] || k;
  const strip = (o) =>
    Object.fromEntries(
      Object.entries(o || {}).filter(([k]) => k !== "notification" && k !== "uncategorized")
    );
  const issues = strip(byCategory);
  const waiting = strip(awaiting);
  const auto = byCategory.notification || 0;
  const todo = byCategory.uncategorized || 0;
  const named = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [name(k), v]));

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
      <div className="card">
        <div className="chart-title">Tickets by issue</div>
        <BarChart data={named(issues)} />
        <div style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 8 }}>
          Excludes {auto} automated notifications
          {todo ? ` · ${todo} not labelled yet` : ""}
        </div>
      </div>
      <div className="card">
        <div className="chart-title">Awaiting Response · by issue</div>
        {Object.keys(waiting).length ? (
          <BarChart data={named(waiting)} />
        ) : (
          <div style={{ fontSize: 13, color: "var(--ink-faint)", marginTop: 6 }}>
            Nothing waiting on a customer right now.
          </div>
        )}
      </div>
    </div>
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
