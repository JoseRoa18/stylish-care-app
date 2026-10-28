// server/attachment-http.js
// Every file the app proxies from Zoho (ticket, message and note attachments,
// inline email images) goes out through here, for three reasons:
//  1) Zoho's Content-Type is unreliable (text/html for .mov, .mp4, .eml and
//     .htm; vnd.ms-excel for .xlsx), so the type comes from the file extension.
//  2) A customer's file must never run as a page on the app's origin: it would
//     carry the agent's session cookie. nosniff on everything, plus a CSP
//     sandbox on everything except PDF, video and audio (Chrome refuses to show
//     a sandboxed PDF and never plays sandboxed media; those types + nosniff
//     can't execute as HTML anyway, and media gets default-src 'none'), keep
//     every type inert even when it is opened in a new tab.
//     Security must not depend on ?name= (it is the customer's filename): every
//     branch below is non-executable whatever the name says. Keep it that way.
//  3) Vercel caps a buffered function response at 4.5 MB, so the Zoho body is
//     streamed straight through — and the upstream fetch is aborted when the
//     browser goes away, so a closed viewer stops pulling a 20 MB video.
import { Readable, pipeline } from "node:stream";

const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  // QuickTime is ISO-BMFF; Firefox refuses video/quicktime but plays it as mp4
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  ini: "text/plain; charset=utf-8",
  yaml: "text/plain; charset=utf-8",
  yml: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  json: "application/json",
  xml: "text/xml",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  eml: "message/rfc822",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  zip: "application/zip",
};

export function mimeFor(name) {
  const ext = /\.([a-z0-9]+)$/i.exec(String(name || ""))?.[1]?.toLowerCase();
  return (ext && MIME[ext]) || "application/octet-stream";
}

// Inline email images carry no filename, so Zoho's type is the only hint —
// accept it only for plain raster images (never svg, html or anything else).
export function rasterImageType(contentType) {
  const t = String(contentType || "").split(";")[0].trim().toLowerCase();
  return /^image\/(png|jpe?g|gif|webp|bmp)$/.test(t) ? t : null;
}

// Raster images can't run anything themselves; the bare sandbox keeps them
// viewable when opened in a tab. Video and audio can't run anything either,
// but the browser's media page never starts playing inside a sandbox, so they
// may only load media from here instead. Everything else (html, svg, text,
// eml, unknown) also gets default-src 'none' so an opened page can't load
// scripts, frames or forms either.
const IMAGE_RE = /^image\/(png|jpeg|gif|webp|bmp|heic|heif)$/;
const AV_RE = /^(video|audio)\//;
const SANDBOX = "sandbox allow-popups allow-popups-to-escape-sandbox";
const AV_ONLY = "default-src 'none'; media-src 'self'";
const LOCKED =
  `${SANDBOX}; default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; ` +
  "font-src data: https:; form-action 'none'; base-uri 'none'";

function contentDisposition(name, download) {
  const clean = String(name || "attachment").replace(/[\r\n]/g, " ").slice(0, 180);
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(clean).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export function setAttachmentHeaders(res, { name, type, download = false, maxAge = 3600 }) {
  res.setHeader("Content-Type", type);
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (type !== "application/pdf")
    res.setHeader("Content-Security-Policy", IMAGE_RE.test(type) ? SANDBOX : AV_RE.test(type) ? AV_ONLY : LOCKED);
  res.setHeader("Content-Disposition", contentDisposition(name, download || type === "application/octet-stream"));
  res.setHeader("Cache-Control", `private, max-age=${maxAge}`);
}

// ?name= and ?dl=1 as the client sends them (api.js attachment URLs).
export function fileOptions(req) {
  return { name: String(req.query.name || "attachment"), download: req.query.dl === "1" };
}

// Stream one Zoho file to the browser. `open(signal)` performs the authorized
// GET (zoho.js open* helpers) and must throw when Zoho answers non-2xx, so the
// route can still reply with JSON. `type` overrides the extension map, either
// as a string or as a function of Zoho's response (null → 415).
export async function sendZohoFile(req, res, open, { name = "attachment", download = false, type, maxAge } = {}) {
  const ac = new AbortController();
  // 'close' on the response fires both when it finished and when the browser
  // went away; only the second one should cancel the upstream download.
  res.on("close", () => {
    if (!res.writableFinished) ac.abort();
  });
  const zres = await open(ac.signal);
  const finalType = typeof type === "function" ? type(zres) : type || mimeFor(name);
  if (!finalType) {
    zres.body?.cancel().catch(() => {});
    throw Object.assign(new Error("Unsupported file type"), { status: 415 });
  }
  setAttachmentHeaders(res, { name, type: finalType, download, maxAge });
  // fetch has already un-gzipped the body, so a length is only right when Zoho
  // did not compress it (it rarely sends one at all)
  const len = zres.headers.get("content-length");
  if (len && !zres.headers.get("content-encoding")) res.setHeader("Content-Length", len);
  if (!zres.body) return res.end();
  await new Promise((resolve) => {
    pipeline(Readable.fromWeb(zres.body), res, (err) => {
      if (err) {
        ac.abort();
        res.destroy();
      }
      resolve();
    });
  });
}

// Error reply for the file routes: JSON while nothing has been sent yet, else
// just drop the connection (a half-sent file can't turn into an error page).
export function sendFileError(res, err) {
  if (res.headersSent) return res.destroy();
  if (res.writableEnded || res.destroyed || res.socket?.destroyed) return; // browser already gone
  res.status(err.status || 502).json({ error: err.message });
}
