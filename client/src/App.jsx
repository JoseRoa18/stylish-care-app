import { useEffect, useState } from "react";
import { api, onAuthExpired } from "./api.js";
import Dashboard from "./components/Dashboard.jsx";
import Inbox from "./components/Inbox.jsx";
import KnowledgeBase from "./components/KnowledgeBase.jsx";
import Calls from "./components/Calls.jsx";
import Login from "./components/Login.jsx";

const TABS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "inbox", label: "Inbox" },
  { id: "calls", label: "Calls" },
  { id: "kb", label: "Knowledge Base" },
];

export default function App() {
  const [tab, setTab] = useState("dashboard");
  const [health, setHealth] = useState({ zoho: false, dropbox: false, gemini: false });
  const [auth, setAuth] = useState({ checked: false, authed: false, enabled: true });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [signature, setSignature] = useState("");
  const [targets, setTargets] = useState(null);
  const [surveysEnabled, setSurveysEnabled] = useState(false);
  const [inboxSearch, setInboxSearch] = useState("");

  useEffect(() => {
    if (!auth.authed) return;
    api.getSettings()
      .then((s) => { setSignature(s.signature || ""); setTargets(s.targets || null); setSurveysEnabled(!!s.surveysEnabled); })
      .catch(() => {});
  }, [auth.authed]);

  const saveSettings = async (patch) => {
    try {
      const s = await api.saveSettings(patch);
      setSignature(s.signature || "");
      setTargets(s.targets || null);
      setSurveysEnabled(!!s.surveysEnabled);
      setSettingsOpen(false);
    } catch (e) {
      alert(`Could not save: ${e.message}`);
    }
  };

  // check the session once on load, and drop to login if it expires mid-use
  useEffect(() => {
    onAuthExpired(() => setAuth((a) => ({ ...a, authed: false })));
    api
      .me()
      .then((m) => setAuth({ checked: true, authed: m.authed, enabled: m.authEnabled }))
      .catch(() => setAuth({ checked: true, authed: false, enabled: true }));
  }, []);

  const logout = async () => {
    try { await api.logout(); } catch { /* ignore */ }
    setAuth((a) => ({ ...a, authed: false }));
  };

  useEffect(() => {
    if (!auth.authed) return;
    let alive = true;
    // poll health so the connector dots self-heal after a transient blip
    // (e.g. a server reload) instead of staying grey until a page refresh
    const load = () =>
      api
        .health()
        .then((h) => alive && setHealth(h))
        .catch(() => {}); // keep last known state on a transient error
    load();
    const id = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [auth.authed]);

  const dot = (ok) => ({
    background: ok ? "var(--green)" : "var(--ink-faint)",
  });

  // Gate: wait for the session check, then show the login screen if needed.
  if (!auth.checked)
    return <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-faint)" }}>Loading…</div>;
  if (auth.enabled && !auth.authed)
    return <Login onSuccess={() => setAuth((a) => ({ ...a, authed: true }))} />;

  return (
    <div className="shell">
      <div className="topbar">
        <div>
          <div className="brand">
            {/* the mark only — the lockup's tagline is Spanish and the UI is English */}
            <img src="/icon.svg" alt="" className="brand-mark" width="30" height="30" />
            <h1>WeCare</h1>
            <span className="sub">Stylish Customer Care</span>
          </div>
          <div className="tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`tab ${tab === t.id ? "active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="status-row">
          <span>
            <i className="status-dot" style={dot(health.gemini)} /> Gemini AI
          </span>
          <span>
            <i className="status-dot" style={dot(health.zoho)} /> Zoho Desk
          </span>
          <span>
            <i className="status-dot" style={dot(health.dropbox)} /> Dropbox
          </span>
          <span>
            <i className="status-dot" style={dot(health.wix)} /> Wix
          </span>
          <span>
            <i className="status-dot" style={dot(health.shipstation)} /> ShipStation
          </span>
          <span>
            <i className="status-dot" style={dot(health.ringcentral)} /> RingCentral
          </span>
          <span>
            <i className="status-dot" style={dot(health.wayfair)} /> Wayfair
          </span>
          <span>
            <i className="status-dot" style={dot(health.bestbuy)} /> Best Buy
          </span>
          <span>
            <i className="status-dot" style={dot(health.walmart)} /> Walmart
          </span>
          <button className="btn sm" onClick={() => setSettingsOpen(true)} title="Settings (signature)" style={{ marginLeft: 4 }}>
            Settings
          </button>
          {auth.enabled && (
            <button className="btn sm" onClick={logout} title="Sign out">
              Sign out
            </button>
          )}
        </div>
      </div>

      {tab === "dashboard" && <Dashboard onOpenInbox={() => setTab("inbox")} />}
      {tab === "inbox" && <Inbox signature={signature} initialSearch={inboxSearch} />}
      {tab === "calls" && <Calls onOpenInbox={(term) => { setInboxSearch(term || ""); setTab("inbox"); }} />}
      {tab === "kb" && <KnowledgeBase />}

      {settingsOpen && (
        <SettingsModal
          initial={signature}
          initialTargets={targets}
          initialSurveys={surveysEnabled}
          onClose={() => setSettingsOpen(false)}
          onSave={saveSettings}
        />
      )}
    </div>
  );
}

// App settings: the outgoing reply signature, and the service targets the
// dashboard measures against (kept here so the team can move a goal without
// waiting on a deploy).
function SettingsModal({ initial, initialTargets, initialSurveys, onClose, onSave }) {
  const [val, setVal] = useState(initial || "");
  const [res, setRes] = useState(initialTargets?.resolutionHours ?? 48);
  const [wait, setWait] = useState(initialTargets?.waitHours ?? 24);
  const [surveys, setSurveys] = useState(!!initialSurveys);
  const numField = {
    width: 80, padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8,
    background: "#fffef9", fontSize: 13,
  };
  return (
    <div className="lightbox" onClick={onClose} style={{ alignItems: "flex-start", paddingTop: "8vh" }}>
      <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 620, padding: 22, cursor: "default", maxHeight: "80vh", overflowY: "auto" }}>
        <h3 style={{ margin: "0 0 4px" }}>Targets</h3>
        <p style={{ fontSize: 13, color: "var(--ink-faint)", margin: "0 0 12px" }}>
          The goals the dashboard colours against and draws as a line on the weekly chart.
        </p>
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap", marginBottom: 22 }}>
          <label style={{ fontSize: 13 }}>
            <div style={{ marginBottom: 5, color: "var(--ink-soft)" }}>Resolution time</div>
            <input type="number" min="1" max="2000" value={res} onChange={(e) => setRes(e.target.value)} style={numField} />
            <span style={{ marginLeft: 6, color: "var(--ink-faint)" }}>hours</span>
          </label>
          <label style={{ fontSize: 13 }}>
            <div style={{ marginBottom: 5, color: "var(--ink-soft)" }}>Max wait on an open ticket</div>
            <input type="number" min="1" max="2000" value={wait} onChange={(e) => setWait(e.target.value)} style={numField} />
            <span style={{ marginLeft: 6, color: "var(--ink-faint)" }}>hours</span>
          </label>
        </div>

        <h3 style={{ margin: "0 0 4px" }}>Satisfaction survey</h3>
        <p style={{ fontSize: 13, color: "var(--ink-faint)", margin: "0 0 10px" }}>
          When on, closing a ticket emails the customer three quick questions. Automated notifications,
          no-reply addresses and our own mailboxes are always skipped.
        </p>
        <label style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 14, marginBottom: 22, cursor: "pointer" }}>
          <input type="checkbox" checked={surveys} onChange={(e) => setSurveys(e.target.checked)} style={{ width: 16, height: 16 }} />
          <span>
            Send the survey when a ticket is closed
            <span style={{ marginLeft: 8, fontSize: 12, color: surveys ? "var(--green)" : "var(--ink-faint)" }}>
              {surveys ? "— on" : "— off, nothing is sent"}
            </span>
          </span>
        </label>

        <h3 style={{ margin: "0 0 4px" }}>Reply signature</h3>
        <p style={{ fontSize: 13, color: "var(--ink-faint)", margin: "0 0 12px" }}>
          HTML appended to the end of every reply (AI drafts include it automatically). Use the team's
          Zoho block here — name, company, phone, links.
        </p>
        <textarea
          value={val}
          onChange={(e) => setVal(e.target.value)}
          rows={7}
          style={{ width: "100%", padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 8, background: "#fffef9", fontSize: 13, fontFamily: "monospace", boxSizing: "border-box", resize: "vertical" }}
        />
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--ink-faint)" }}>Preview:</div>
        <div className="email-html" style={{ border: "1px solid var(--line-soft)", borderRadius: 8, padding: 10, marginTop: 4 }} dangerouslySetInnerHTML={{ __html: val }} />
        <div style={{ display: "flex", gap: 10, marginTop: 16, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            onClick={() =>
              onSave({
                signature: val,
                targets: { resolutionHours: Number(res), waitHours: Number(wait) },
                surveysEnabled: surveys,
              })
            }
          >
            Save settings
          </button>
        </div>
      </div>
    </div>
  );
}
