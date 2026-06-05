import { useEffect, useState } from "react";
import { api } from "./api.js";
import Dashboard from "./components/Dashboard.jsx";
import Inbox from "./components/Inbox.jsx";
import KnowledgeBase from "./components/KnowledgeBase.jsx";

const TABS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "inbox", label: "Inbox" },
  { id: "kb", label: "Knowledge Base" },
];

export default function App() {
  const [tab, setTab] = useState("dashboard");
  const [health, setHealth] = useState({ zoho: false, dropbox: false, gemini: false });

  useEffect(() => {
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
  }, []);

  const dot = (ok) => ({
    background: ok ? "var(--green)" : "var(--ink-faint)",
  });

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
        </div>
      </div>

      {tab === "dashboard" && <Dashboard onOpenInbox={() => setTab("inbox")} />}
      {tab === "inbox" && <Inbox />}
      {tab === "kb" && <KnowledgeBase />}
    </div>
  );
}
