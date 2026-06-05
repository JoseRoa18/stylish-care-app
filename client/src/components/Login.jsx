import { useState } from "react";
import { api } from "../api.js";

export default function Login({ onSuccess }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setErr(null);
    try {
      await api.login(password);
      onSuccess();
    } catch (e) {
      setErr(e.message || "Incorrect password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <form onSubmit={submit} className="card" style={{ width: "100%", maxWidth: 360, padding: 28 }}>
        <div className="brand" style={{ marginBottom: 4 }}>
          <h1 style={{ margin: 0 }}>Stylish</h1>
          <span className="sub">Customer Care</span>
        </div>
        <p style={{ fontSize: 13, color: "var(--ink-faint)", margin: "8px 0 18px" }}>
          Enter the team password to continue.
        </p>
        <input
          type="password"
          className="field"
          autoFocus
          autoComplete="current-password"
          placeholder="Team password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: "100%", padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 8, background: "#fffef9", boxSizing: "border-box" }}
        />
        {err && <div className="banner error" style={{ marginTop: 12 }}>{err}</div>}
        <button className="btn primary" type="submit" disabled={busy || !password} style={{ width: "100%", marginTop: 16, justifyContent: "center" }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
