// client/src/api.js

async function req(path, options) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  health: () => req("/health"),
  dashboard: () => req("/dashboard"),
  inbox: ({ view = "active", q = "", page = 1, pageSize = 50, sort = "updated" } = {}) =>
    req(`/inbox?view=${encodeURIComponent(view)}&q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}&sort=${sort}`),
  tickets: () => req("/tickets"),
  conversation: (id) => req(`/tickets/${id}/conversation`),
  draft: (id, ticket) =>
    req(`/tickets/${id}/draft`, {
      method: "POST",
      body: JSON.stringify({ ticket }),
    }),
  send: (id, to, content, contentType = "html") =>
    req(`/tickets/${id}/send`, {
      method: "POST",
      body: JSON.stringify({ to, content, contentType }),
    }),
  setStatus: (id, status) =>
    req(`/tickets/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),
  kb: () => req("/kb"),
  kbSources: () => req("/kb/sources"),
  kbCreate: (article) =>
    req("/kb", { method: "POST", body: JSON.stringify(article) }),
  kbUpdate: (id, patch) =>
    req(`/kb/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  kbDelete: (id) => req(`/kb/${id}`, { method: "DELETE" }),
  kbIngest: (key) =>
    req(key ? `/kb/ingest/${key}` : "/kb/ingest", { method: "POST" }),
  kbIngestStatus: () => req("/kb/ingest/status"),
  manuals: () => req("/dropbox/manuals"),
  translate: (texts, target) =>
    req("/translate", { method: "POST", body: JSON.stringify({ texts, target }) }),
};

// KB source → badge color/label
export const KB_SOURCES = {
  manual: { label: "Manual", color: "#8a8378" },
  web: { label: "Web", color: "#3b7a57" },
  dropbox: { label: "Dropbox", color: "#0061ff" },
  "zoho-template": { label: "Template", color: "#c8a24a" },
  youtube: { label: "Video", color: "#ff0033" },
};

// Stylish product finishes → tag colors
export const FINISHES = {
  "Stainless Steel": "#9aa3a8",
  "Graphite Black": "#3a3d42",
  "Brushed Nickel": "#b8b2a7",
  "Polished Chrome": "#c7ced4",
  Gold: "#c8a24a",
  "Gun Metal": "#5b5d63",
  "Matte Black": "#1c1c1e",
  "Pearl White": "#ece8e1",
  "Granite Composite": "#6b6258",
};
