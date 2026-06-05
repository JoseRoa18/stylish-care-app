// server/dropbox.js
// Dropbox integration: list installation manuals AND ingest their text
// content into the Knowledge Base. Uses a Dropbox access token (no MCP).
// If no token is set, every function degrades gracefully to "not configured".
//
// Text extraction for PDF/DOCX uses optional deps (pdf-parse, mammoth) loaded
// dynamically — the server still boots if they aren't installed yet; ingestion
// just reports which files it couldn't read and why.

import { chunkText } from "./sources/chunk.js";

const {
  DROPBOX_ACCESS_TOKEN,
  DROPBOX_REFRESH_TOKEN,
  DROPBOX_APP_KEY,
  DROPBOX_APP_SECRET,
  DROPBOX_MANUALS_PATH,
} = process.env;

// Durable auth: with a refresh token + app key/secret we mint short-lived
// access tokens on demand (and cache them), so the connection never expires.
// Falls back to a static DROPBOX_ACCESS_TOKEN (the ~4h kind) if that's all
// that's configured.
const hasRefresh = Boolean(
  DROPBOX_REFRESH_TOKEN && DROPBOX_APP_KEY && DROPBOX_APP_SECRET
);

export function dropboxConfigured() {
  return hasRefresh || Boolean(DROPBOX_ACCESS_TOKEN);
}

let _token = null; // { value, expiresAt }

async function getAccessToken() {
  if (!hasRefresh) {
    if (DROPBOX_ACCESS_TOKEN) return DROPBOX_ACCESS_TOKEN;
    throw new Error("Dropbox not configured");
  }
  if (_token && _token.expiresAt - 60_000 > Date.now()) return _token.value;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: DROPBOX_REFRESH_TOKEN,
    client_id: DROPBOX_APP_KEY,
    client_secret: DROPBOX_APP_SECRET,
  });
  const res = await fetch("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Dropbox token refresh failed (${res.status}): ${
        data.error_description || data.error || "unknown"
      }`
    );
  }
  _token = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 14400) * 1000,
  };
  return _token.value;
}

// ── list files in the manuals folder (handles pagination) ────
export async function listManuals() {
  if (!dropboxConfigured()) return { configured: false, files: [] };

  const token = await getAccessToken();
  async function call(endpoint, body) {
    const res = await fetch(`https://api.dropboxapi.com/2/files/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        `Dropbox error (${res.status}): ${data?.error_summary || "unknown"}`
      );
    }
    return data;
  }

  const files = [];
  let data = await call("list_folder", {
    path: DROPBOX_MANUALS_PATH || "",
    recursive: true,
    limit: 2000,
  });
  // Dropbox returns results in pages — follow the cursor until exhausted.
  for (;;) {
    for (const e of data.entries || []) {
      if (e[".tag"] === "file")
        files.push({ name: e.name, path: e.path_lower, id: e.id, size: e.size });
    }
    if (!data.has_more) break;
    data = await call("list_folder/continue", { cursor: data.cursor });
  }

  return { configured: true, files };
}

// ── download one file as a Buffer ────────────────────────────
// Download by file id, not path: files inside a Dropbox *team folder* live in
// a different namespace, so path-based download 409s ("path/not_found") even
// when listing works. The id is namespace-independent.
async function downloadFile(idOrPath, attempt = 0) {
  const token = await getAccessToken();
  try {
    const res = await fetch("https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": JSON.stringify({ path: idOrPath }),
      },
    });
    if (res.status === 429 || res.status >= 500) {
      throw new Error(`transient ${res.status}`); // retry below
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`download failed (${res.status}): ${txt.slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    // retry transient network errors ("fetch failed") and 429/5xx, up to 3x
    const transient = /fetch failed|transient|ECONN|ETIMEDOUT|network/i.test(err.message);
    if (transient && attempt < 3) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      return downloadFile(idOrPath, attempt + 1);
    }
    throw err;
  }
}

// Extract plain text from a file buffer based on its extension.
// PDF/DOCX use optional deps; if missing, we throw a clear "install X" error.
async function extractText(name, buffer) {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "txt" || ext === "md") return buffer.toString("utf-8");

  if (ext === "pdf") {
    // text-layer when available, Gemini OCR fallback for image-based PDFs
    const { extractPdfText } = await import("./sources/pdf-text.js");
    const { text } = await extractPdfText(buffer);
    return text;
  }

  if (ext === "docx") {
    let mammoth;
    try {
      mammoth = await import("mammoth");
    } catch {
      throw new Error("docx support needs `npm install mammoth`");
    }
    const { value } = await mammoth.extractRawText({ buffer });
    return value || "";
  }

  throw new Error(`unsupported file type: .${ext}`);
}

// ── ingest manuals into KB articles ──────────────────────────
// Returns { articles, errors } — caller persists via kb.replaceSource.
// onProgress(done, total, name) is called after each file (optional).
export async function ingestDropbox({ onProgress } = {}) {
  if (!dropboxConfigured()) {
    return { articles: [], errors: [{ error: "Dropbox not configured" }] };
  }

  const { files } = await listManuals();
  const articles = [];
  const errors = [];
  const stamp = new Date().toISOString();

  // Only these text formats are extractable — skip images/video/CAD without
  // even downloading them (they are the bulk of a product folder).
  const SUPPORTED = new Set(["pdf", "docx", "txt", "md"]);
  // Filename filter (default: installation manuals + spec sheets).
  const include = new RegExp(process.env.DROPBOX_INCLUDE || "manual|spec", "i");
  // Most product docs are triplicated EN / FR / EN+FR. By default keep the
  // English + bilingual ones and drop French-only duplicates. Set
  // DROPBOX_INCLUDE_FRENCH=true to keep them.
  const dropFrenchOnly = process.env.DROPBOX_INCLUDE_FRENCH !== "true";
  // Skip very large files — almost always image-only PDFs (drawings) that
  // yield no usable text but cost a big download.
  const maxBytes = Number(process.env.DROPBOX_MAX_FILE_MB || 30) * 1048576;

  const candidates = files.filter((f) => {
    const name = f.name.toLowerCase();
    const ext = name.split(".").pop();
    if (!SUPPORTED.has(ext)) return false;
    if (!include.test(name)) return false;
    if (dropFrenchOnly && /french|francais|français|_fr\b/.test(name) && !/english|_en\b/.test(name))
      return false;
    if (f.size && f.size > maxBytes) return false;
    return true;
  });

  let done = 0;
  for (const f of candidates) {
    try {
      const buffer = await downloadFile(f.id || f.path);
      const text = await extractText(f.name, buffer);
      const chunks = chunkText(text, 1400);
      if (!chunks.length) {
        errors.push({ file: f.name, error: "no extractable text (scanned image?)" });
        continue;
      }
      const base = f.name.replace(/\.[^.]+$/, "").trim();
      const slug = base.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40);
      // file-id tail keeps article ids unique across same-named files
      const uid = String(f.id || "").replace(/[^a-z0-9]/gi, "").slice(-6);
      chunks.forEach((body, i) => {
        articles.push({
          id: `DBX-${uid}${chunks.length > 1 ? `-${i + 1}` : ""}`,
          title:
            chunks.length > 1 ? `${base} (${i + 1}/${chunks.length})` : base,
          body,
          finish: null,
          tags: ["manual-doc", "dropbox", slug],
          sourceUrl: f.path,
          updatedAt: stamp,
        });
      });
    } catch (err) {
      errors.push({ file: f.name, error: err.message });
    }
    done++;
    if (onProgress) onProgress(done, candidates.length, f.name);
  }

  return { articles, errors, scanned: files.length, ingestedFiles: candidates.length };
}
