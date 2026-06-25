import { useEffect, useState } from "react";
import { api } from "../api.js";

const RESULT_COLOR = { Accepted: "#3b7a57", Missed: "#c0392b", Voicemail: "#c8912a", Rejected: "#c0392b", Busy: "#c8912a" };

function fmtTime(t) {
  try { return new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
  catch { return ""; }
}
function fmtDur(s) {
  if (!s) return "—";
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}
function Pill({ text, color }) {
  return <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 8px", borderRadius: 999, color, border: `1px solid ${color}` }}>{text}</span>;
}

export default function Calls({ onOpenInbox }) {
  const [data, setData] = useState(null);
  const [days, setDays] = useState(7);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    api.rcRecent(days).then((d) => alive && setData(d)).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [days]);

  if (err) return <div className="banner error" style={{ marginTop: 16 }}>RingCentral: {err}</div>;

  const calls = data?.calls || [];
  const voicemails = data?.voicemails || [];

  return (
    <>
      <div className="section-title">
        <h2>Phone</h2>
        <label style={{ fontSize: 13, color: "var(--ink-faint)", display: "flex", alignItems: "center", gap: 6 }}>
          Last
          <select className="status-select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={1}>24 hours</option>
            <option value={3}>3 days</option>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
          </select>
        </label>
      </div>

      {!data ? (
        <div className="empty"><span className="spin" /> Loading calls…</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16, alignItems: "start" }}>
          {/* Inbound calls */}
          <div className="card">
            <div className="chart-title">Inbound calls ({calls.length})</div>
            {calls.length === 0 ? (
              <div style={{ color: "var(--ink-faint)", fontSize: 13, marginTop: 8 }}>No inbound calls in this window.</div>
            ) : (
              <div style={{ marginTop: 6 }}>
                {calls.map((c) => (
                  <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.fromName || c.fromNumber || "Unknown"}
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
                        <span className="mono">{c.fromNumber}</span> · {fmtTime(c.time)} · {fmtDur(c.durationSec)}
                      </div>
                    </div>
                    <Pill text={c.result} color={RESULT_COLOR[c.result] || "#888"} />
                    {c.recordingId && <audio controls src={api.rcRecordingUrl(c.recordingId)} style={{ height: 30, maxWidth: 180 }} />}
                    <button
                      className="btn sm"
                      title="Find this caller in tickets"
                      onClick={() => onOpenInbox?.(c.fromName ? c.fromName.split(" - ").pop().trim() : c.fromNumber)}
                    >
                      Find
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Voicemails */}
          <div className="card">
            <div className="chart-title">Voicemails ({voicemails.length})</div>
            {voicemails.length === 0 ? (
              <div style={{ color: "var(--ink-faint)", fontSize: 13, marginTop: 8 }}>No voicemails.</div>
            ) : (
              <div style={{ marginTop: 6 }}>
                {voicemails.map((v) => (
                  <div key={v.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.fromName || v.fromNumber}</div>
                        <div style={{ fontSize: 11, color: "var(--ink-faint)" }}><span className="mono">{v.fromNumber}</span> · {fmtTime(v.time)}{v.durationSec ? ` · ${v.durationSec}s` : ""}</div>
                      </div>
                    </div>
                    {v.audioId && <audio controls src={api.rcVoicemailUrl(v.id, v.audioId)} style={{ height: 32, width: "100%", marginTop: 4 }} />}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
