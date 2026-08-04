import { useEffect, useState } from "react";
import { api } from "../api.js";

function fmt(t) {
  try { return new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
  catch { return ""; }
}

export default function Marketplace() {
  const [threads, setThreads] = useState(null);
  const [err, setErr] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [draft, setDraft] = useState("");
  const [order, setOrder] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [onlyPending, setOnlyPending] = useState(true);

  const load = () => api.bbThreads().then((r) => setThreads(r.threads || [])).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const open = async (t) => {
    setOpenId(t.id); setDetail(null); setDraft(""); setOrder(null); setSent(false); setBusy(true);
    try {
      const d = await api.bbThread(t.id);
      setDetail(d);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const generate = async () => {
    if (!openId) return;
    setBusy(true);
    try {
      const r = await api.bbDraft(openId);
      setDraft(r.draft || "");
      setOrder(r.order || null);
      if (r.thread) setDetail(r.thread);
    } catch (e) { setErr(`Draft failed: ${e.message}`); }
    finally { setBusy(false); }
  };

  const send = async () => {
    if (!draft.trim()) return;
    if (!confirm("Send this reply to the customer on Best Buy Marketplace?")) return;
    setSending(true);
    try {
      await api.bbReply(openId, draft);
      setSent(true);
      const d = await api.bbThread(openId).catch(() => null);
      if (d) setDetail(d);
      load();
    } catch (e) { setErr(`Send failed: ${e.message}`); }
    finally { setSending(false); }
  };

  if (err && !threads) return <div className="banner error" style={{ marginTop: 16 }}>Best Buy: {err}</div>;

  const list = (threads || []).filter((t) => !onlyPending || t.needsReply);
  const pending = (threads || []).filter((t) => t.needsReply).length;

  return (
    <>
      <div className="section-title">
        <h2>Best Buy Marketplace</h2>
        <label style={{ fontSize: 13, color: "var(--ink-faint)", display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
          Awaiting our reply only ({pending})
        </label>
      </div>

      {err && <div className="banner error" style={{ marginBottom: 12 }}>{err}</div>}

      {!threads ? (
        <div className="empty"><span className="spin" /> Loading customer messages…</div>
      ) : (
        <div className="peek">
          <div className="peek-list">
            {list.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--ink-faint)", padding: 8 }}>Nothing awaiting a reply.</div>
            ) : list.map((t) => (
              <div key={t.id} className={`peek-row ${openId === t.id ? "sel" : ""}`} onClick={() => open(t)}>
                <div className="peek-subj">
                  {t.needsReply && <span style={{ color: "var(--red)", marginRight: 6 }}>●</span>}
                  {t.topic}
                </div>
                <div className="peek-meta">
                  <span>{t.customer}</span>
                  {t.orderId && <span className="mono">{t.orderId}</span>}
                  <span style={{ marginLeft: "auto" }}>{fmt(t.lastAt)}</span>
                </div>
                {t.lastPreview && (
                  <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.lastFrom && /CUSTOMER/i.test(t.lastFrom) ? "" : "You: "}{t.lastPreview}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="peek-detail">
            {!openId ? (
              <div className="empty" style={{ marginTop: 40 }}>← Select a message</div>
            ) : (
              <div className="card">
                {busy && !detail ? (
                  <div style={{ color: "var(--ink-faint)" }}><span className="spin" /> Loading…</div>
                ) : detail ? (
                  <>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{detail.topic}</div>
                    <div style={{ fontSize: 12, color: "var(--ink-faint)", marginBottom: 10 }}>
                      {detail.customer}{detail.orderId ? ` · order ${detail.orderId}` : ""}
                    </div>
                    {order && (
                      <div style={{ fontSize: 12, color: "var(--ink-soft)", background: "var(--paper)", borderRadius: 8, padding: "8px 10px", marginBottom: 10 }}>
                        {order.state} · {order.date} · {order.items.map((i) => `${i.sku} ×${i.qty}`).join(", ")}
                      </div>
                    )}
                    <div className="convo" style={{ marginTop: 0 }}>
                      {detail.messages.map((m) => (
                        <div key={m.id} className={`msg ${m.from === "customer" ? "in" : "out"}`}>
                          <div className="who">
                            <span>{m.from === "customer" ? detail.customer : "Sinks Direct"}</span>
                            <span className="when">{fmt(m.date)}</span>
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
                            {sending ? <><span className="spin" /> Sending…</> : "Send to customer"}
                          </button>
                        </div>
                      </>
                    )}
                  </>
                ) : null}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
