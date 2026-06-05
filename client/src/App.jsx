import { useEffect, useState } from "react";
import { api, onAuthExpired } from "./api.js";
import Dashboard from "./components/Dashboard.jsx";
import Inbox from "./components/Inbox.jsx";
import KnowledgeBase from "./components/KnowledgeBase.jsx";
import Login from "./components/Login.jsx";

const TABS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "inbox", label: "Inbox" },
  { id: "kb", label: "Knowledge Base" },
];

export default function App() {
  const [tab, setTab] = useState("dashboard");
  const [health, setHealth] = useState({ zoho: false, dropbox: false, gemini: false });
  const [auth, setAuth] = useState({ checked: false, authed: false, enabled: true });

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
            <h1>Stylish</h1>
            <span className="sub">Customer Care</span>
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
          {auth.enabled && (
            <button className="btn sm" onClick={logout} title="Sign out" style={{ marginLeft: 4 }}>
              Sign out
            </button>
          )}
        </div>
      </div>

      {tab === "dashboard" && <Dashboard onOpenInbox={() => setTab("inbox")} />}
      {tab === "inbox" && <Inbox />}
      {tab === "kb" && <KnowledgeBase />}
    </div>
  );
}
