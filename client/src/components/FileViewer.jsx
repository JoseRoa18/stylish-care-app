// client/src/components/FileViewer.jsx
// In-app viewer for every file on a ticket: what customers send (message and
// note attachments) and what the agent is about to send (local File objects).
// One instance is mounted at the Inbox root; openViewer(item, list) opens it
// from anywhere, and ‹ › walk the other files of the same list.
//
// An item is { name, size, url?, file?, kind?, noDownload? }: `url` for files
// behind the attachment proxy, `file` for a local File/Blob (outgoing files,
// files inside an .eml or .zip). The kind comes from the extension, and from
// the first bytes when the extension is missing or unknown.
//
// Customer content must never run on the app's origin (it would carry the
// agent's session cookie), so:
//  - html, eml and docx render only in an <iframe sandbox srcdoc> WITHOUT
//    allow-scripts / allow-same-origin, after DOMPurify, keeping only absolute
//    http/https/mailto links (relative ones would resolve against the app);
//  - blob: URLs are only made by objectUrl(), which refuses every type except
//    raster images, pdf, video, audio and octet-stream — never text/html or
//    image/svg+xml, whatever the file claims to be;
//  - svg is only ever shown as an <img> (a data: URL when it comes from bytes);
//  - sniffing only picks between those same inert renderers.
import { useEffect, useRef, useState } from "react";
import { api, authExpired } from "../api.js";

// Videos and audio are loaded whole so seeking works (Zoho supports no Range
// requests); anything bigger is offered as a download instead.
const MEDIA_CAP = 100 * 1048576;
const PARSE_CAP = 50 * 1048576; // files parsed in the browser (eml, zip, xlsx…)
const TEXT_CAP = 1048576; // text / csv: show the first 1 MB
const ROW_CAP = 1000;
const COL_CAP = 50;

const EXT_KINDS = {
  image: "jpg jpeg jfif png gif webp bmp svg avif ico",
  heic: "heic heif",
  pdf: "pdf",
  html: "htm html",
  eml: "eml",
  text: "txt log md json xml yaml yml ini cfg conf",
  csv: "csv tsv",
  sheet: "xlsx xlsm xls ods",
  docx: "docx",
  zip: "zip",
  video: "mp4 mov m4v webm",
  audio: "mp3 wav m4a aac ogg oga opus flac",
  // known formats a browser can't show — no point downloading them to sniff
  file: "dxf dwg rtf doc msg pptx ppt odt odp pages numbers key exe dmg iso rar 7z tif tiff psd ai eps",
};
const KIND_OF = {};
for (const [kind, exts] of Object.entries(EXT_KINDS)) for (const e of exts.split(" ")) KIND_OF[e] = kind;

export const KIND_ICON = {
  image: "🖼", heic: "🖼", pdf: "📄", html: "🌐", eml: "✉", text: "📝", csv: "📊",
  sheet: "📊", docx: "📃", zip: "📦", video: "🎬", audio: "🎵", file: "📎", unknown: "📎",
};
const KIND_LABEL = {
  image: "Image", heic: "iPhone photo (HEIC)", pdf: "PDF", html: "Web page (HTML)", eml: "Email message",
  text: "Text", csv: "Table", sheet: "Spreadsheet", docx: "Word document", zip: "ZIP archive",
  video: "Video", audio: "Audio", file: "File", unknown: "File",
};

const extOf = (name) => /\.([a-z0-9]+)$/i.exec(String(name || ""))?.[1]?.toLowerCase() || "";

// Kind from the name alone; "unknown" means the bytes have to decide.
export function fileKind(name) {
  return KIND_OF[extOf(name)] || "unknown";
}

const EXT_TYPE = {
  jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", avif: "image/avif", ico: "image/x-icon", svg: "image/svg+xml",
  webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac",
  ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac",
};
const DEFAULT_TYPE = { image: "image/png", video: "video/mp4", audio: "audio/mpeg", pdf: "application/pdf" };
const typeFor = (name, kind) => EXT_TYPE[extOf(name)] || DEFAULT_TYPE[kind];

export function fmtBytes(n) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// ── safety helpers ─────────────────────────────────────────────

// The ONLY place blob: URLs are made. A blob: URL lives on the app's origin,
// so html or svg behind one would run with the agent's session.
const SAFE_BLOB_TYPE =
  /^(image\/(png|jpeg|gif|webp|bmp|avif|x-icon)|application\/pdf|video\/(mp4|webm)|audio\/(mpeg|mp4|aac|wav|ogg|flac)|application\/octet-stream)$/;
function objectUrl(blob, type) {
  if (!SAFE_BLOB_TYPE.test(type || "")) throw new Error(`No preview URL for type ${type}`);
  return URL.createObjectURL(new Blob([blob], { type }));
}

function useObjectUrl(blob, type) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!blob) return;
    let u = null;
    try { u = objectUrl(blob, type); } catch { return; }
    setUrl(u);
    return () => URL.revokeObjectURL(u); // on close, next/previous and unmount
  }, [blob, type]);
  return url;
}

function saveBlob(blob, name) {
  const url = objectUrl(blob, "application/octet-stream"); // always a download, never a page
  const a = document.createElement("a");
  a.href = url;
  a.download = name || "file";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function dataUrl(blob, type) {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = () => fail(r.error);
    r.readAsDataURL(new Blob([blob], { type }));
  });
}

// Bytes → text. Zoho re-encodes .htm parts to UTF-8 but leaves the original
// <meta charset=us-ascii>, so the meta tag can't come first: BOM, then strict
// UTF-8, then the declared charset, then windows-1252 (old Outlook / Excel).
export function decodeText(bytes, { html = false } = {}) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { /* not UTF-8 */ }
  if (html) {
    const head = new TextDecoder("windows-1252").decode(bytes.subarray(0, 4096));
    const cs = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1];
    if (cs) {
      try { return new TextDecoder(cs).decode(bytes); } catch { /* unknown label */ }
    }
  }
  return new TextDecoder("windows-1252").decode(bytes);
}

// Customer HTML → a srcdoc for a sandboxed frame. DOMPurify drops scripts,
// handlers, forms and javascript: URLs; then only absolute links survive and
// images may come from https/data (cid: parts of an .eml are inlined by `cid`).
const FRAME_CSP = "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src data: https:";
const FRAME_STYLE =
  "body{margin:16px;font:14px/1.5 system-ui,sans-serif;color:#1f1d1a;background:#fff;word-break:break-word}" +
  "img{max-width:100%;height:auto}table{max-width:100%}";
async function safeDoc(html, { cid } = {}) {
  const { default: DOMPurify } = await import("dompurify");
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ["form", "input", "button", "textarea", "select", "base", "meta", "link", "iframe", "frame", "object", "embed"],
  });
  const doc = new DOMParser().parseFromString(clean, "text/html"); // inert: nothing runs or loads
  for (const a of doc.querySelectorAll("[href]")) {
    const href = a.getAttribute("href").trim();
    if (a.tagName === "A" && /^(https?:|mailto:)/i.test(href)) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    } else a.removeAttribute("href");
  }
  for (const el of doc.querySelectorAll("[src]")) {
    const src = el.getAttribute("src").trim();
    const inlined = cid && /^cid:/i.test(src) ? cid(src.slice(4)) : null;
    if (inlined) el.setAttribute("src", inlined);
    else if (!/^(https:|data:image\/)/i.test(src)) el.removeAttribute("src");
  }
  for (const el of doc.querySelectorAll("*")) {
    el.removeAttribute("srcset");
    const x = el.getAttribute("xlink:href"); // svg links / images
    if (x != null && !/^(#|https:|data:image\/)/i.test(x.trim())) el.removeAttribute("xlink:href");
  }
  return (
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">` +
    `<meta name="referrer" content="no-referrer"><base target="_blank"><style>${FRAME_STYLE}</style>` +
    `${doc.head.innerHTML}</head>${doc.body.outerHTML}</html>`
  );
}

function SafeFrame({ html, title }) {
  return (
    <iframe
      className="viewer-frame"
      title={title || "Preview"}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={html}
    />
  );
}

// ── kind sniffing ──────────────────────────────────────────────

function looksText(b) {
  const n = Math.min(b.length, 4096);
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i];
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32 && c !== 27)) ctrl++;
  }
  return ctrl <= n * 0.02;
}

// What the first bytes say the file is: { kind, type? }.
export function sniff(b) {
  const at = (o, s) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  const hex = (o, ...xs) => xs.every((x, i) => b[o + i] === x);
  if (at(0, "%PDF")) return { kind: "pdf", type: "application/pdf" };
  if (hex(0, 0x89, 0x50, 0x4e, 0x47)) return { kind: "image", type: "image/png" };
  if (hex(0, 0xff, 0xd8, 0xff)) return { kind: "image", type: "image/jpeg" };
  if (at(0, "GIF8")) return { kind: "image", type: "image/gif" };
  if (at(0, "RIFF") && at(8, "WEBP")) return { kind: "image", type: "image/webp" };
  if (at(0, "RIFF") && at(8, "WAVE")) return { kind: "audio", type: "audio/wav" };
  if (at(0, "BM") && b.length > 26 && hex(6, 0, 0, 0, 0)) return { kind: "image", type: "image/bmp" };
  if (at(4, "ftyp")) {
    const brand = String.fromCharCode(...b.subarray(8, 12));
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return { kind: "heic" };
    if (/^avi[fs]$/.test(brand)) return { kind: "image", type: "image/avif" };
    if (/^M4[AB] $/.test(brand)) return { kind: "audio", type: "audio/mp4" };
    return { kind: "video", type: "video/mp4" }; // isom, mp41/42, qt (iPhone .MOV), 3gp…
  }
  if (hex(0, 0x1a, 0x45, 0xdf, 0xa3)) return { kind: "video", type: "video/webm" };
  if (at(0, "ID3") || hex(0, 0xff, 0xfb) || hex(0, 0xff, 0xf3) || hex(0, 0xff, 0xf2)) return { kind: "audio", type: "audio/mpeg" };
  if (hex(0, 0xff, 0xf1) || hex(0, 0xff, 0xf9)) return { kind: "audio", type: "audio/aac" };
  if (at(0, "OggS")) return { kind: "audio", type: "audio/ogg" };
  if (at(0, "fLaC")) return { kind: "audio", type: "audio/flac" };
  if (at(0, "PK\x03\x04")) return { kind: "zip" }; // docx / xlsx / ods are zips too — see zipKind
  if (hex(0, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return { kind: "sheet" }; // OLE: old .xls (a .doc/.msg falls back to the card)
  const bom = hex(0, 0xef, 0xbb, 0xbf) || hex(0, 0xff, 0xfe) || hex(0, 0xfe, 0xff);
  if (!bom && !looksText(b)) return { kind: "file" };
  const h = decodeText(b).replace(/^\uFEFF/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(h)) return { kind: "image", type: "image/svg+xml" };
  if (/^<(!doctype html|html|head|body|meta|div|table|style)[\s>]/i.test(h)) return { kind: "html" };
  if (/^[A-Za-z][\w-]*:[ \t]/.test(h) && (/^mime-version:/im.test(h) || (/^received:/im.test(h) && /^(from|subject):/im.test(h))))
    return { kind: "eml" };
  return { kind: "text" };
}

// docx, xlsx and ods are zips: the entry names tell them apart.
async function zipKind(blob) {
  const { unzipSync } = await import("fflate");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const names = [];
  try {
    unzipSync(bytes, { filter: (f) => { names.push(f.name); return false; } });
  } catch {
    return "file";
  }
  if (names.includes("word/document.xml")) return "docx";
  if (names.some((n) => /^xl\/workbook\.(xml|bin)$/.test(n))) return "sheet";
  if (names.some((n) => n.startsWith("ppt/"))) return "file";
  if (names.includes("mimetype")) {
    const m = unzipSync(bytes, { filter: (f) => f.name === "mimetype" }).mimetype;
    return m && /spreadsheet/.test(new TextDecoder().decode(m)) ? "sheet" : "file";
  }
  return "zip";
}

// Name first; the bytes decide when the name says nothing (no or an unknown
// extension), and when an iPhone photo's name doesn't match its format.
async function detectKind(blob, named, name) {
  const s = sniff(new Uint8Array(await blob.slice(0, 16384).arrayBuffer()));
  if (named === "unknown") return s.kind === "zip" ? { kind: await zipKind(blob) } : s;
  if (named === "heic" && s.kind === "image") return s;
  if (named === "image" && s.kind === "heic") return s;
  return { kind: named, type: s.kind === named && s.type ? s.type : typeFor(name, named) };
}

// ── loading ────────────────────────────────────────────────────

// Streams the proxy response so the progress bar moves; Zoho sends no
// Content-Length, so the total is the size from the attachment list.
async function readUrl(url, { signal, onProgress, stopAt, max }) {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    if (res.status === 401 && j?.authRequired) authExpired(); // back to the login screen
    throw new Error(j?.error || `Couldn't load the file (${res.status})`);
  }
  if (!res.body) return { blob: new Blob([await res.arrayBuffer()]), truncated: false };
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
    if (stopAt && got >= stopAt) {
      reader.cancel().catch(() => {});
      return { blob: new Blob(chunks).slice(0, stopAt), truncated: true };
    }
    if (got > max) {
      reader.cancel().catch(() => {});
      throw new Error("Too large to preview here — download it to open it.");
    }
  }
  return { blob: new Blob(chunks), truncated: false };
}

// The item's bytes, fetched once and shared by whichever renderer needs them.
function useDownload(item, { enabled, stopAt = 0, max }) {
  const [st, setSt] = useState(() => {
    const f = item.file;
    if (f && stopAt && f.size > stopAt) return { blob: f.slice(0, stopAt), truncated: true, got: 0 };
    return { blob: f || null, truncated: false, got: 0, total: item.size || 0 };
  });
  useEffect(() => {
    if (!enabled || item.file) return;
    const ac = new AbortController();
    let last = 0;
    const onProgress = (got, total) => {
      const now = Date.now();
      if (now - last < 120) return;
      last = now;
      setSt((s) => ({ ...s, got, total: total || s.total }));
    };
    readUrl(item.url, { signal: ac.signal, onProgress, stopAt, max }).then(
      (r) => setSt((s) => ({ ...s, ...r })),
      (error) => { if (!ac.signal.aborted) setSt((s) => ({ ...s, error })); }
    );
    return () => ac.abort(); // closed or moved on: stop the download (the server stops Zoho's too)
  }, [item, enabled, stopAt, max]);
  return st;
}

function useAsync(fn, deps) {
  const [st, setSt] = useState({ loading: true });
  useEffect(() => {
    let live = true;
    setSt({ loading: true });
    Promise.resolve()
      .then(fn)
      .then((value) => live && setSt({ value }), (error) => live && setSt({ error }));
    return () => { live = false; };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return st;
}

// ── the viewer shell ───────────────────────────────────────────

let _open = null;
export const openViewer = (item, list) => _open?.(item, list);

let _seq = 0; // part of the item key: every open remounts the renderer
function frame(item, list) {
  const l = list?.length ? list : [item];
  const i = l.indexOf(item);
  return { list: l, index: i < 0 ? 0 : i, back: [], seq: ++_seq };
}

export default function FileViewer() {
  // { list, index, back: [{ list, index }] } — back is the way out of an .eml/.zip
  const [st, setSt] = useState(null);
  const [info, setInfo] = useState(null); // { item, kind, blob } once the open item has loaded
  const closeRef = useRef(null);
  useEffect(() => {
    _open = (item, list) => setSt(frame(item, list));
    return () => { _open = null; };
  }, []);

  const close = () => setSt(null);
  const go = (d) => setSt((s) => s && { ...s, index: (s.index + d + s.list.length) % s.list.length });
  const openChild = (child, siblings) =>
    setSt((s) => ({ ...frame(child, siblings), back: [...s.back, { list: s.list, index: s.index }] }));
  const goBack = () => setSt((s) => ({ ...s, ...s.back[s.back.length - 1], back: s.back.slice(0, -1) }));

  useEffect(() => {
    if (!st) return;
    const onKey = (e) => {
      if (e.key === "Escape") return close();
      if (st.list.length < 2 || /^(INPUT|TEXTAREA|SELECT|VIDEO|AUDIO)$/.test(e.target?.tagName || "")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [st]);

  // modal: no page scroll underneath, focus on ✕ so Esc / Enter work at once
  const isOpen = Boolean(st);
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => { document.body.style.overflow = prev; };
  }, [isOpen]);

  const item = st?.list[st.index];
  if (!item) return null;
  const mine = info?.item === item ? info : null;
  const kind = mine?.kind || item.kind || fileKind(item.name);
  const multi = st.list.length > 1;
  const stop = (e) => e.stopPropagation();
  // A click inside a PDF / HTML frame moves focus into it, and its keys never
  // reach this window: once the pointer leaves the frame, focus comes back so
  // Esc and ← → work again.
  const refocus = () => {
    if (document.activeElement?.tagName === "IFRAME") closeRef.current?.focus();
  };
  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={item.name || KIND_LABEL[kind]} onClick={close}>
      <div className="viewer-bar" onClick={stop}>
        {st.back.length > 0 && (
          <button type="button" className="viewer-btn" onClick={goBack}>← Back</button>
        )}
        <span style={{ fontSize: 20 }}>{KIND_ICON[kind]}</span>
        <div className="viewer-title">
          <b title={item.name}>{item.name || KIND_LABEL[kind]}</b>
          <span>{[KIND_LABEL[kind], fmtBytes(item.size), multi && `${st.index + 1} / ${st.list.length}`].filter(Boolean).join(" · ")}</span>
        </div>
        <DownloadButton item={item} blob={mine?.blob} />
        {api.isAttachmentUrl(item.url) && (
          <a className="viewer-btn" href={item.url} target="_blank" rel="noopener noreferrer">Open in new tab ↗</a>
        )}
        <button ref={closeRef} type="button" className="viewer-btn viewer-close" title="Close (Esc)" onClick={close}>✕</button>
      </div>
      <div className="viewer-body">
        {multi && (
          <button type="button" className="viewer-nav" title="Previous (←)" onClick={(e) => { stop(e); go(-1); }}>‹</button>
        )}
        <div className="viewer-stage" onClick={stop} onMouseLeave={refocus}>
          <ItemView
            key={`${st.seq}:${st.back.length}:${st.index}`}
            item={item}
            onInfo={(i) => setInfo({ item, ...i })}
            onOpenChild={openChild}
          />
        </div>
        {multi && (
          <button type="button" className="viewer-nav" title="Next (→)" onClick={(e) => { stop(e); go(1); }}>›</button>
        )}
      </div>
    </div>
  );
}

// Download: the proxy's ?dl=1 for attachment URLs, the bytes already in hand
// for local / extracted files (and loaded videos — no second Zoho download).
function DownloadButton({ item, blob, className = "viewer-btn", label = "⬇ Download" }) {
  if (item.noDownload) return null;
  const bytes = blob || item.file;
  if (bytes)
    return <button type="button" className={className} onClick={() => saveBlob(bytes, item.name)}>{label}</button>;
  if (api.isAttachmentUrl(item.url))
    return <a className={className} href={api.dl(item.url)} download={item.name || true}>{label}</a>;
  return null;
}

// Picks the renderer: images and PDFs behind the proxy load straight from
// their URL; everything else is fetched once (with progress) and sniffed.
function ItemView({ item, onInfo, onOpenChild }) {
  const named = item.kind || fileKind(item.name);
  const [viaBytes, setViaBytes] = useState(false); // a direct image that failed: try its bytes (HEIC named .jpg)
  const direct = Boolean(item.url && !item.file && !viaBytes && (named === "image" || named === "pdf"));
  const media = named === "video" || named === "audio";
  const cap = media || named === "unknown" ? MEDIA_CAP : PARSE_CAP;
  const tooBig = item.size > cap;
  const dl = useDownload(item, {
    enabled: !direct && !tooBig && named !== "file",
    stopAt: named === "text" || named === "csv" ? TEXT_CAP : 0,
    max: cap,
  });
  const [found, setFound] = useState(null); // { kind, type } once the bytes are in
  useEffect(() => {
    if (!dl.blob) return;
    let live = true;
    detectKind(dl.blob, named, item.name).then(
      (f) => {
        if (!live) return;
        setFound(f);
        onInfo?.({ kind: f.kind, blob: dl.truncated ? null : dl.blob });
      },
      () => live && setFound({ kind: "file" })
    );
    return () => { live = false; };
  }, [dl.blob]); // eslint-disable-line react-hooks/exhaustive-deps

  if (named === "file") return <FileCard item={item} kind="file" />;
  if (tooBig)
    return <FileCard item={item} kind={named} text={`Too large to preview here (${fmtBytes(item.size)}) — download it to open it.`} />;
  if (direct)
    return named === "pdf"
      ? <PdfView item={item} />
      : <ImageView item={item} onFail={item.noDownload ? null : () => setViaBytes(true)} />;
  if (dl.error) return <FileCard item={item} kind={named} title="Couldn't load this file" text={dl.error.message} />;
  if (!dl.blob || !found) return <Loading got={dl.got} total={dl.total} />;

  const p = { item, blob: dl.blob, type: found.type, truncated: dl.truncated, onOpenChild };
  switch (found.kind) {
    case "image": return <ImageView {...p} />;
    case "heic": return <HeicView {...p} />;
    case "pdf": return <PdfView {...p} />;
    case "html": return <HtmlView {...p} />;
    case "eml": return <EmlView {...p} />;
    case "text": return <TextView {...p} />;
    case "csv": return <CsvView {...p} />;
    case "sheet": return <SheetView {...p} />;
    case "docx": return <DocxView {...p} />;
    case "zip": return <ZipView {...p} />;
    case "video":
    case "audio": return <MediaView {...p} kind={found.kind} />;
    default: return <FileCard item={item} kind={found.kind} blob={dl.blob} />;
  }
}

function Loading({ got = 0, total = 0, label = "Loading…" }) {
  const pct = total ? Math.min(100, Math.round((got / total) * 100)) : null;
  return (
    <div className="viewer-card">
      <div><span className="spin" style={{ verticalAlign: "-2px", marginRight: 8 }} />{label}</div>
      {got > 0 && (
        <>
          <div className="viewer-progress"><div style={{ width: `${pct ?? 50}%` }} /></div>
          <div style={{ fontSize: 12, color: "var(--ink-faint)" }}>{fmtBytes(got)}{total ? ` of ${fmtBytes(total)}` : ""}</div>
        </>
      )}
    </div>
  );
}

// Anything without a preview: what it is, and a way to get it.
function FileCard({ item, kind, blob, title, text }) {
  const ext = extOf(item.name);
  return (
    <div className="viewer-card">
      <div style={{ fontSize: 40, lineHeight: 1.2 }}>{KIND_ICON[kind] || "📎"}</div>
      <div style={{ fontWeight: 600, marginTop: 6, wordBreak: "break-word" }}>{item.name || "File"}</div>
      <div style={{ fontSize: 12, color: "var(--ink-faint)" }}>
        {[fmtBytes(item.size), ext && `.${ext}`].filter(Boolean).join(" · ")}
      </div>
      {title && <div style={{ fontWeight: 600, marginTop: 12 }}>{title}</div>}
      <div style={{ margin: "8px 0 16px", color: "var(--ink-soft)", fontSize: 13 }}>{text || "No preview for this file type."}</div>
      <DownloadButton item={item} blob={blob} className="btn primary" />
    </div>
  );
}

function Problem({ item, blob, kind, error }) {
  return <FileCard item={item} kind={kind} blob={blob} title="Couldn't open this file" text={`${error?.message || error} — download it to open it.`} />;
}

// ── renderers ──────────────────────────────────────────────────

function ImageView({ item, blob, type, onFail }) {
  const svg = type === "image/svg+xml";
  const url = useObjectUrl(blob && !svg ? blob : null, type);
  const svgSrc = useAsync(() => (blob && svg ? dataUrl(blob, type) : null), [blob, svg]);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (failed) return <FileCard item={item} kind="image" blob={blob} text="This image can't be displayed here." />;
  const src = !blob ? item.url : svg ? svgSrc.value : url;
  if (!src) return <Loading />;
  // a big photo straight from the proxy takes seconds: spinner until it's in
  return (
    <>
      {!loaded && <Loading />}
      <img
        className="viewer-media"
        src={src}
        alt={item.name || ""}
        style={loaded ? undefined : { display: "none" }}
        onLoad={() => setLoaded(true)}
        onError={() => (onFail ? onFail() : setFailed(true))}
      />
    </>
  );
}

function HeicView({ item, blob }) {
  const st = useAsync(async () => {
    const { heicTo } = await import("heic-to");
    return heicTo({ blob, type: "image/jpeg", quality: 0.9 });
  }, [blob]);
  if (st.loading) return <Loading label="Converting the iPhone photo (HEIC)…" />;
  if (st.error) return <Problem item={item} blob={blob} kind="heic" error={st.error} />;
  return <ImageView item={item} blob={st.value} type="image/jpeg" />;
}

// No sandbox attribute: Chrome refuses to run its PDF viewer in a sandboxed
// frame. Safe because the proxy always sends application/pdf + nosniff, and a
// sniffed PDF becomes an application/pdf blob.
// When the proxy fails it answers JSON instead (same origin, so the frame's
// document can be read): show the error card, not Chrome's JSON viewer.
function PdfView({ item, blob }) {
  const url = useObjectUrl(blob || null, "application/pdf");
  const [error, setError] = useState(null);
  const src = blob ? url : item.url;
  const onLoad = (e) => {
    let doc = null;
    try { doc = e.currentTarget.contentDocument; } catch { /* not readable: a real PDF */ }
    if (doc?.contentType !== "application/json") return;
    let j = null;
    try { j = JSON.parse(doc.querySelector("pre")?.textContent || doc.body?.textContent || ""); } catch { /* not JSON after all */ }
    if (j?.authRequired) authExpired();
    setError(j?.error || "The file couldn't be loaded.");
  };
  if (error) return <FileCard item={item} kind="pdf" title="Couldn't load this file" text={error} />;
  if (!src) return <Loading />;
  return <iframe className="viewer-frame" src={src} title={item.name || "PDF"} onLoad={onLoad} />;
}

function MediaView({ item, blob, type, kind }) {
  const url = useObjectUrl(blob, type || DEFAULT_TYPE[kind]);
  const [failed, setFailed] = useState(false);
  if (kind === "video") return url ? <VideoView item={item} blob={blob} url={url} /> : <Loading />;
  if (failed)
    return (
      <FileCard
        item={item}
        kind={kind}
        blob={blob}
        title="Can't play this audio here"
        text="This browser can't play this audio file. Download it and open it with a media player."
      />
    );
  if (!url) return <Loading />;
  return (
    <div className="viewer-card" style={{ maxWidth: 520, width: "92vw" }}>
      <div style={{ fontSize: 36 }}>🎵</div>
      <audio src={url} controls autoPlay style={{ width: "100%", marginTop: 10 }} onError={() => setFailed(true)} />
    </div>
  );
}

// Edge's "Enhance videos" setting paints a picture turned 90° / 270° solid
// black on some GPUs, and almost every phone video is turned that way. Sound,
// decoding and canvas readback stay fine, so nothing on the page can see it:
// in Edge those videos are drawn on a canvas from a hidden <video> instead
// ("compatible view"), and the agent can switch either way.
const EDGE = /\bEdg\//.test(navigator.userAgent);

// 90 / 270 when the file asks for its picture to be turned: the frame says so
// (WebCodecs), else the decoded size is the shown size swapped.
function rotationOf(v, meta) {
  try {
    const f = new VideoFrame(v);
    const r = f.rotation || 0;
    f.close();
    if (r) return r;
  } catch { /* no WebCodecs, or no frame yet */ }
  return meta && meta.width === v.videoHeight && meta.height === v.videoWidth && meta.width !== meta.height ? 90 : 0;
}

const clock = (s) => {
  if (!Number.isFinite(s)) return "–:––";
  const n = Math.max(0, Math.floor(s));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};

function VideoView({ item, blob, url }) {
  const vRef = useRef(null);
  const cRef = useRef(null);
  const wrapRef = useRef(null);
  const [error, setError] = useState(null); // "damaged" | "codec"
  const [noPicture, setNoPicture] = useState(false);
  const [rot, setRot] = useState(null); // null until the first frame
  const [pick, setPick] = useState(null); // "canvas" | "native" once the agent chose
  const [pl, setPl] = useState({ paused: true, t: 0, dur: NaN, muted: false });
  // !error: the error card replaces the player, so the drawing loop must stop
  const compat = EDGE && !error && !noPicture && (pick ? pick === "canvas" : rot % 180 === 90);

  const sync = () => {
    const v = vRef.current;
    if (v) setPl({ paused: v.paused, t: v.currentTime, dur: v.duration, muted: v.muted });
  };
  const detect = (meta) => {
    const r = rotationOf(vRef.current, meta);
    setRot((x) => x || r);
  };

  // the rotation shows on the first frame (loadeddata covers a missing rVFC)
  useEffect(() => {
    const v = vRef.current;
    if (!EDGE || !v.requestVideoFrameCallback) return;
    const id = v.requestVideoFrameCallback((now, meta) => detect(meta));
    return () => v.cancelVideoFrameCallback(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Compatible view: the same <video> keeps playing (sound, position), hidden;
  // every frame it shows is copied onto the canvas, which applies the rotation.
  useEffect(() => {
    if (!compat) return;
    const v = vRef.current;
    const c = cRef.current;
    const g = c.getContext("2d");
    let rv = 0, raf = 0, last = 0;
    const draw = () => {
      if (!v.videoWidth) return;
      if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
        c.width = v.videoWidth;
        c.height = v.videoHeight;
      }
      g.drawImage(v, 0, 0, c.width, c.height);
    };
    const onFrame = () => {
      last = performance.now();
      draw();
      rv = v.requestVideoFrameCallback(onFrame);
    };
    // rAF only steps in if frame callbacks stop (or don't exist), and runs
    // only while playing: paused or ended, nothing new needs drawing
    const tick = (now) => {
      if (now - last > 250) draw();
      raf = v.paused ? 0 : requestAnimationFrame(tick);
    };
    const onPlay = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    if (v.requestVideoFrameCallback) rv = v.requestVideoFrameCallback(onFrame);
    if (!v.paused) onPlay();
    draw();
    v.addEventListener("play", onPlay);
    v.addEventListener("seeked", draw);
    v.addEventListener("loadeddata", draw);
    return () => {
      v.cancelVideoFrameCallback?.(rv);
      cancelAnimationFrame(raf);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("seeked", draw);
      v.removeEventListener("loadeddata", draw);
    };
  }, [compat]);

  // Space plays / pauses the player the agent is looking at: the compatible
  // view's frame once it opens (focus was on ✕, where Space closes the viewer),
  // the browser's own player once the agent picks it (focus was left on the
  // note's button, where Space switched the player back)
  useEffect(() => {
    if (compat) wrapRef.current?.focus({ preventScroll: true });
    else if (pick === "native") vRef.current?.focus({ preventScroll: true });
  }, [compat]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error)
    return (
      <FileCard
        item={item}
        kind="video"
        blob={blob}
        title="Can't play this video"
        text={
          error === "damaged"
            ? "The file looks incomplete or damaged. Download it to try another player."
            : "This browser can't play this video file. Download it and open it with a video player such as VLC."
        }
      />
    );

  const toggle = () => {
    const v = vRef.current;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };
  const seek = (t) => {
    vRef.current.currentTime = t;
    setPl((p) => ({ ...p, t }));
  };
  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else wrapRef.current?.requestFullscreen?.().catch(() => {});
  };
  // Space plays / pauses anywhere on the player (also on its buttons, as on
  // the native one); ← → step 5 s on the seek bar and walk the files elsewhere.
  const onKey = (e) => {
    if (e.key !== " ") return;
    e.preventDefault();
    toggle();
  };
  const onSeekKey = (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const v = vRef.current;
    seek(Math.min(v.duration || 0, Math.max(0, v.currentTime + (e.key === "ArrowLeft" ? -5 : 5))));
  };
  const note = EDGE && !noPicture && (pick || rot !== null);
  return (
    <>
      {noPicture && (
        <div className="viewer-note" style={{ borderRadius: 8, marginBottom: 8 }}>
          Only the sound can play here: this browser can't decode the picture. Download the video to watch it.
        </div>
      )}
      <div
        ref={wrapRef}
        className={`viewer-player${compat ? " compat" : ""}${note ? " noted" : ""}`}
        tabIndex={compat ? 0 : undefined}
        onKeyDown={compat ? onKey : undefined}
      >
        <video
          ref={vRef}
          className={compat ? "viewer-vsrc" : "viewer-media"}
          src={url}
          controls={!compat}
          autoPlay
          playsInline
          // the container can't be read at all (cut-off upload, no moov box);
          // NO_SUPPORTED_STREAMS is an intact file in a codec the browser lacks
          onError={(e) => setError(/DEMUXER_ERROR_COULD_NOT_(OPEN|PARSE)/.test(e.currentTarget.error?.message || "") ? "damaged" : "codec")}
          onLoadedMetadata={(e) => { setNoPicture(e.currentTarget.videoWidth === 0); sync(); }}
          onLoadedData={EDGE ? () => detect(null) : undefined}
          onPlay={sync}
          onPause={sync}
          onTimeUpdate={sync}
          onDurationChange={sync}
          onVolumeChange={sync}
        />
        {compat && <canvas ref={cRef} className="viewer-media" onClick={toggle} />}
        {compat && (
          <div className="viewer-vctl">
            <button type="button" title={pl.paused ? "Play (Space)" : "Pause (Space)"} onClick={toggle}>
              {pl.paused ? "▶" : "❚❚"}
            </button>
            <input
              type="range"
              aria-label="Position"
              min={0}
              max={Number.isFinite(pl.dur) ? pl.dur : 0}
              step="any"
              value={pl.t}
              onChange={(e) => seek(Number(e.target.value))}
              onKeyDown={onSeekKey}
            />
            <span className="viewer-vtime">{clock(pl.t)} / {clock(pl.dur)}</span>
            <button type="button" title={pl.muted ? "Unmute" : "Mute"} onClick={() => { vRef.current.muted = !vRef.current.muted; }}>
              {pl.muted ? "🔇" : "🔊"}
            </button>
            <button type="button" title="Full screen" onClick={fullscreen}>⛶</button>
          </div>
        )}
      </div>
      {note && (
        <div className="viewer-vnote">
          {compat ? (
            <>Compatible view for Edge · <button type="button" onClick={() => setPick("native")}>Use the browser's player</button></>
          ) : (
            <>Black picture? <button type="button" onClick={() => setPick("canvas")}>Show it another way</button> · or turn off 'Enhance videos' in Edge settings</>
          )}
        </div>
      )}
    </>
  );
}

// Apple Mail Drop: iPhone/Mac Mail sends a big file (usually a video) as an
// iCloud link card instead of attaching it, and Outlook turns that card into an
// ATT0000N.htm part. data-url points at a raw content host and data-size is
// "0", so the link is the card's own <a> to www.icloud.com and no size is shown;
// data-expiration is milliseconds as a float ("1795618229000.000000").
function readMailDrop(doc) {
  const el = doc.querySelector(".x-apple-maildrop, [data-filename][data-expiration]");
  if (!el) return null;
  const size = parseFloat(el.getAttribute("data-size"));
  let exp = parseFloat(el.getAttribute("data-expiration"));
  if (exp > 0 && exp < 1e11) exp *= 1000; // seconds, just in case
  let link = null;
  for (const a of [...el.querySelectorAll("a[href]"), ...doc.querySelectorAll("a[href]")]) {
    try {
      const u = new URL(a.getAttribute("href"));
      if (u.protocol === "https:" && u.hostname === "www.icloud.com") { link = u.href; break; }
    } catch { /* not an absolute URL */ }
  }
  return {
    filename: el.getAttribute("data-filename") || "",
    size: size > 0 ? size : 0,
    expires: exp > 0 ? new Date(exp) : null,
    link,
  };
}

function MailDropCard({ md }) {
  const video = /\.(mov|mp4|m4v|webm|avi|3gp)$/i.test(md.filename);
  const expired = md.expires && md.expires < new Date();
  const when = md.expires?.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return (
    <div className="viewer-maildrop">
      <span style={{ fontSize: 22 }}>{video ? "🎬" : "☁"}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: "var(--ink)", wordBreak: "break-word" }}>
          {md.filename || "File"}{md.size ? ` · ${fmtBytes(md.size)}` : ""}
        </div>
        <div>
          {video ? "Video" : "File"} stored on iCloud by the customer (Apple Mail Drop) — it is not attached to the ticket
          {when ? (expired ? ` · link expired on ${when}` : ` · link valid until ${when}`) : ""}
        </div>
      </div>
      {md.link && !expired && (
        <a className="btn sm" href={md.link} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none", whiteSpace: "nowrap" }}>
          Open on iCloud ↗
        </a>
      )}
    </div>
  );
}

const parseHtml = (html) => new DOMParser().parseFromString(html, "text/html"); // inert: nothing runs or loads

function HtmlView({ item, blob }) {
  const [showPart, setShowPart] = useState(false);
  const st = useAsync(async () => {
    const html = decodeText(new Uint8Array(await blob.arrayBuffer()), { html: true });
    const raw = parseHtml(html);
    return {
      mailDrop: readMailDrop(raw),
      textLen: (raw.body?.textContent || "").replace(/\s+/g, " ").trim().length,
      doc: await safeDoc(html),
    };
  }, [blob]);
  if (st.loading) return <Loading label="Opening…" />;
  if (st.error) return <Problem item={item} blob={blob} kind="html" error={st.error} />;
  const { mailDrop, textLen, doc } = st.value;
  const frameShown = !mailDrop || showPart;
  return (
    <div className="viewer-doc" style={frameShown ? null : { height: "auto" }}>
      {mailDrop && (
        <div style={{ padding: 14 }}>
          <MailDropCard md={mailDrop} />
          {!showPart && (
            <button type="button" className="btn sm" style={{ marginTop: 10 }} onClick={() => setShowPart(true)}>
              Show the part as Apple Mail wrote it
            </button>
          )}
        </div>
      )}
      {!mailDrop && textLen < 40 && /^ATT\d+/i.test(item.name || "") && (
        <div className="viewer-note">
          Just the end of the customer's email (e.g. "Sent from my iPhone") — iPhone mail that passes through Outlook
          arrives split into ATT0000N.htm parts like this one. The message itself is in the conversation.
        </div>
      )}
      {frameShown && <SafeFrame html={doc} title={item.name} />}
    </div>
  );
}

// Small Mail Drop card inside the message bubble, so the agent sees at once
// that the customer's video is on iCloud. Only for tiny ATT0000N.htm parts.
const _mailDrops = new Map(); // url → Promise<card | null>
export function MailDropPeek({ url }) {
  const [md, setMd] = useState(null);
  useEffect(() => {
    let live = true;
    if (!_mailDrops.has(url))
      _mailDrops.set(
        url,
        fetch(url)
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .then((buf) => (buf ? readMailDrop(parseHtml(decodeText(new Uint8Array(buf), { html: true }))) : null))
          .catch(() => null)
      );
    _mailDrops.get(url).then((v) => live && setMd(v));
    return () => { live = false; };
  }, [url]);
  return md ? <div style={{ flexBasis: "100%" }}><MailDropCard md={md} /></div> : null;
}

const fmtAddr = (a) =>
  !a ? "" : a.group ? `${a.name}: ${a.group.map(fmtAddr).join(", ")}` : a.name ? `${a.name} <${a.address}>` : a.address || "";
const fmtAddrs = (list) => (list || []).map(fmtAddr).filter(Boolean).join(", ");

function toBytes(content) {
  return typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
}
function base64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
// Some small .eml files on tickets start with a blank line and indent every
// header by one space, so a parser sees no headers at all. Undo both (byte for
// byte — the charset is still unknown at this point).
function cleanEml(raw) {
  let i = 0;
  while (i < raw.length && (raw[i] === 13 || raw[i] === 10)) i++;
  raw = raw.subarray(i);
  if (raw[0] !== 32 || raw.length > 1048576) return raw;
  let s = "";
  for (let j = 0; j < raw.length; j += 0x8000) s += String.fromCharCode.apply(null, raw.subarray(j, j + 0x8000));
  return Uint8Array.from(s.replace(/^ (?=[\w-]+:)/gm, ""), (c) => c.charCodeAt(0));
}

const MIME_EXT = {
  "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
  "text/plain": ".txt", "text/html": ".htm", "message/rfc822": ".eml", "text/csv": ".csv",
};

function EmlView({ item, blob, onOpenChild }) {
  const st = useAsync(async () => {
    const { default: PostalMime } = await import("postal-mime");
    const email = await PostalMime.parse(cleanEml(new Uint8Array(await blob.arrayBuffer())));
    const atts = email.attachments || [];
    // pictures embedded in the body (cid:) become data: URIs — raster only
    const byCid = new Map();
    for (const a of atts)
      if (a.contentId && /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(a.mimeType || ""))
        byCid.set(a.contentId.replace(/^<|>$/g, "").toLowerCase(), a);
    const used = new Set();
    const cid = (id) => {
      const a = byCid.get(decodeURIComponent(id).toLowerCase());
      if (!a) return null;
      used.add(a);
      return `data:${a.mimeType.toLowerCase()};base64,${base64(toBytes(a.content))}`;
    };
    const doc = email.html ? await safeDoc(email.html, { cid }) : null;
    const files = atts
      .filter((a) => !used.has(a))
      .map((a, i) => {
        const bytes = toBytes(a.content);
        const name = a.filename || `attachment-${i + 1}${MIME_EXT[(a.mimeType || "").toLowerCase()] || ""}`;
        return { name, size: bytes.length, file: new Blob([bytes]) };
      });
    return { email, doc, files };
  }, [blob]);
  if (st.loading) return <Loading label="Reading the email…" />;
  if (st.error) return <Problem item={item} blob={blob} kind="eml" error={st.error} />;
  const { email, doc, files } = st.value;
  const date = email.date ? new Date(email.date) : null;
  return (
    <div className="viewer-doc">
      <div className="viewer-head">
        <div style={{ fontWeight: 600, fontSize: 14, color: "var(--ink)", marginBottom: 4 }}>{email.subject || "(no subject)"}</div>
        {[
          ["From", fmtAddr(email.from)],
          ["To", fmtAddrs(email.to)],
          ["Cc", fmtAddrs(email.cc)],
          ["Date", date && !isNaN(date) ? date.toLocaleString() : ""],
        ].map(([k, v]) => v && (
          <div key={k} style={{ display: "flex", gap: 8 }}>
            <span style={{ flex: "0 0 38px", fontWeight: 600 }}>{k}</span>
            <span style={{ wordBreak: "break-word" }}>{v}</span>
          </div>
        ))}
        {files.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {files.map((f, i) => (
              <button key={i} type="button" className="viewer-chip" title="Open in the viewer" onClick={() => onOpenChild(f, files)}>
                {KIND_ICON[fileKind(f.name)]} {f.name} <span>{fmtBytes(f.size)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {doc ? (
        <SafeFrame html={doc} title={email.subject || item.name} />
      ) : (
        <pre className="viewer-text viewer-text-fill">{email.text || "(empty message)"}</pre>
      )}
    </div>
  );
}

// A cut at TEXT_CAP can split a UTF-8 character; cutting at the last newline
// keeps strict UTF-8 decoding (and the charset rule) working.
async function readText(blob, truncated) {
  let bytes = new Uint8Array(await blob.arrayBuffer());
  if (truncated) {
    const nl = bytes.lastIndexOf(10);
    if (nl > 0) bytes = bytes.subarray(0, nl + 1);
  }
  return decodeText(bytes);
}

const capNote = (truncated) => (truncated ? `Showing the first ${fmtBytes(TEXT_CAP)} — download the file for the rest.` : null);

function TextView({ item, blob, truncated }) {
  const st = useAsync(async () => {
    const text = await readText(blob, truncated);
    if (!truncated && (/\.json$/i.test(item.name || "") || /^\s*[[{]/.test(text))) {
      try { return JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON after all */ }
    }
    return text;
  }, [blob]);
  if (st.loading) return <Loading label="Opening…" />;
  if (st.error) return <Problem item={item} blob={blob} kind="text" error={st.error} />;
  return (
    <div className="viewer-doc">
      {truncated && <div className="viewer-note">{capNote(truncated)}</div>}
      <pre className="viewer-text viewer-text-fill">{st.value}</pre>
    </div>
  );
}

function parseCsv(text, sep, maxRows) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (rows.length >= maxRows) return { rows, more: i < text.length - 1 };
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return { rows, more: false };
}

function CsvView({ item, blob, truncated }) {
  const st = useAsync(async () => {
    const text = (await readText(blob, truncated)).replace(/^\uFEFF/, "");
    const first = text.slice(0, text.indexOf("\n") + 1 || 2000);
    const count = (ch) => first.split(ch).length - 1;
    const sep = /\.tsv$/i.test(item.name || "") ? "\t" : [",", ";", "\t"].sort((a, b) => count(b) - count(a))[0];
    return parseCsv(text, sep, ROW_CAP);
  }, [blob]);
  if (st.loading) return <Loading label="Opening…" />;
  if (st.error) return <Problem item={item} blob={blob} kind="csv" error={st.error} />;
  const { rows, more } = st.value;
  const note = capNote(truncated) || (more ? `Showing the first ${ROW_CAP.toLocaleString()} rows — download the file for the rest.` : null);
  return <TableDoc rows={rows} note={note} />;
}

const colName = (i) => {
  let s = "";
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};

// Spreadsheet-style grid (column letters, row numbers) — no guessing whether
// the first row is a header.
function TableDoc({ rows, note, r0 = 0, c0 = 0, footer }) {
  const shown = rows.slice(0, ROW_CAP);
  const width = shown.reduce((m, r) => Math.max(m, r.length), 0);
  const cols = Math.min(COL_CAP, Math.max(1, width));
  const notes = [note, width > COL_CAP && `Showing the first ${COL_CAP} columns.`].filter(Boolean).join(" ");
  return (
    <div className="viewer-doc">
      {notes && <div className="viewer-note">{notes}</div>}
      <div className="viewer-table-wrap">
        {shown.length ? (
          <table className="viewer-table">
            <thead>
              <tr>
                <th className="rn" />
                {Array.from({ length: cols }, (_, c) => <th key={c}>{colName(c0 + c)}</th>)}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i}>
                  <td className="rn">{r0 + i + 1}</td>
                  {Array.from({ length: cols }, (_, c) => {
                    const v = r[c] == null ? "" : String(r[c]);
                    return <td key={c} title={v.length > 40 ? v : undefined}>{v}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ padding: 20, color: "var(--ink-faint)" }}>(empty)</div>
        )}
      </div>
      {footer}
    </div>
  );
}

function SheetView({ item, blob }) {
  const [tab, setTab] = useState(0);
  const st = useAsync(async () => {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(new Uint8Array(await blob.arrayBuffer()), { type: "array", sheetRows: ROW_CAP, cellDates: true });
    return wb.SheetNames.map((name) => {
      const ws = wb.Sheets[name];
      const ref = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : null;
      const full = ws["!fullref"] ? XLSX.utils.decode_range(ws["!fullref"]) : ref;
      const rows = ref ? XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "", blankrows: true }) : [];
      return { name, rows, r0: ref?.s.r || 0, c0: ref?.s.c || 0, total: full ? full.e.r + 1 : rows.length };
    });
  }, [blob]);
  if (st.loading) return <Loading label="Reading the spreadsheet…" />;
  if (st.error) return <Problem item={item} blob={blob} kind="sheet" error={st.error} />;
  const sheets = st.value;
  const s = sheets[Math.min(tab, sheets.length - 1)];
  if (!s) return <FileCard item={item} kind="sheet" blob={blob} text="This spreadsheet has no sheets." />;
  const note = s.total > ROW_CAP ? `Showing the first ${ROW_CAP.toLocaleString()} of ${s.total.toLocaleString()} rows — download the file for the rest.` : null;
  return (
    <TableDoc
      key={tab}
      rows={s.rows}
      r0={s.r0}
      c0={s.c0}
      note={note}
      footer={sheets.length > 1 && (
        <div className="viewer-tabs">
          {sheets.map((x, i) => (
            <button key={i} type="button" className={i === tab ? "active" : ""} onClick={() => setTab(i)}>{x.name}</button>
          ))}
        </div>
      )}
    />
  );
}

function DocxView({ item, blob }) {
  const st = useAsync(async () => {
    const mod = await import("mammoth/mammoth.browser.js");
    const mammoth = mod.default || mod;
    const { value } = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
    return safeDoc(value);
  }, [blob]);
  if (st.loading) return <Loading label="Opening the document…" />;
  if (st.error) return <Problem item={item} blob={blob} kind="docx" error={st.error} />;
  return <SafeFrame html={st.value} title={item.name} />;
}

function ZipView({ item, blob, onOpenChild }) {
  const [err, setErr] = useState(null);
  const st = useAsync(async () => {
    const { unzipSync } = await import("fflate");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const entries = [];
    unzipSync(bytes, {
      filter: (f) => {
        if (!f.name.endsWith("/") && !/(^|\/)(__MACOSX\/|\.DS_Store$)/.test(f.name)) entries.push(f);
        return false; // list only — nothing is decompressed until opened
      },
    });
    return { bytes, entries, unzipSync };
  }, [blob]);
  if (st.loading) return <Loading label="Reading the archive…" />;
  if (st.error) return <Problem item={item} blob={blob} kind="zip" error={st.error} />;
  const { bytes, entries, unzipSync } = st.value;
  const extract = (e) => {
    setErr(null);
    try {
      const data = unzipSync(bytes, { filter: (f) => f.name === e.name })[e.name];
      return { name: e.name.split("/").pop(), size: data.length, file: new Blob([data]) };
    } catch (x) {
      setErr(`Couldn't extract ${e.name}: ${x.message}`);
      return null;
    }
  };
  return (
    <div className="viewer-doc">
      <div className="viewer-note">
        {entries.length} file{entries.length === 1 ? "" : "s"} in this archive{err ? ` — ${err}` : ""}
      </div>
      <div className="viewer-table-wrap">
        <table className="viewer-table" style={{ width: "100%" }}>
          <tbody>
            {entries.map((e) => {
              const k = fileKind(e.name);
              const canOpen = k !== "file" && e.originalSize <= PARSE_CAP;
              const path = e.name.split("/");
              const base = path.pop();
              return (
                <tr key={e.name}>
                  <td style={{ width: 24 }}>{KIND_ICON[k]}</td>
                  <td style={{ whiteSpace: "normal", maxWidth: "none" }}>
                    {path.length > 0 && <span style={{ color: "var(--ink-faint)" }}>{path.join("/")}/</span>}
                    {base}
                  </td>
                  <td style={{ color: "var(--ink-faint)", textAlign: "right" }}>{fmtBytes(e.originalSize)}</td>
                  <td style={{ textAlign: "right" }}>
                    {canOpen && (
                      <button type="button" className="btn sm" onClick={() => { const f = extract(e); if (f) onOpenChild(f); }}>Preview</button>
                    )}{" "}
                    <button type="button" className="btn sm" title="Download" onClick={() => { const f = extract(e); if (f) saveBlob(f.file, f.name); }}>⬇</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
