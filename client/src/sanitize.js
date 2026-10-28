// client/src/sanitize.js
// One DOMPurify pass for every customer-email HTML the app renders (Original
// and translated views) and for HTML that goes into the reply editor. The
// server's regex sanitizer is a first pass only: it can be bypassed (e.g.
// <img src=x/onerror=…>, unquoted href=javascript:…), so nothing reaches
// innerHTML without going through here.
import DOMPurify from "dompurify";

// Own instance, so these hooks never leak into other DOMPurify users.
const purifier = DOMPurify(window);

const CONFIG = {
  // Styles (attribute), classes and ids stay: emails need them for layout, and
  // the quote collapse keys off Gmail/Zoho/Outlook classes and ids.
  FORBID_TAGS: [
    "script", "style", "iframe", "frame", "frameset", "object", "embed", "form",
    "base", "meta", "link", "noscript", "template", "title",
  ],
  RETURN_DOM: true, // a <body> from DOMParser — post-processed below, then serialized
};

// true while sanitizing an email to show it (not editor HTML, which is sent
// to customers)
let display = false;

// A shown email must not make the agent's browser call the app itself: a
// relative (or own-origin) src/href/background is a GET to /api/… that carries
// the session cookie. Only the inline-image proxy URLs the server wrote stay.
const URL_ATTRS = new Set(["src", "srcset", "poster", "background", "href", "xlink:href", "action", "formaction", "cite", "longdesc"]);
function hitsApp(u) {
  if (u.startsWith("#")) return false; // an anchor inside the email
  try {
    const url = new URL(u, location.href);
    return url.origin === location.origin && url.pathname !== "/api/tickets/inline-image";
  } catch {
    return true; // unparseable: drop it
  }
}

// DOMPurify already drops on* handlers and javascript:/vbscript: URLs; it would
// still let data: URLs through on media tags. Only plain images may be inline.
const ATTR_WS = /[\x00-\x20\s]/g; // what a browser ignores in a URL scheme, and more
const SAFE_DATA_IMG = /^data:image\/(png|jpe?g|gif|webp|bmp)[;,]/i;
purifier.addHook("uponSanitizeAttribute", (node, data) => {
  const raw = String(data.attrValue || "");
  const v = raw.replace(ATTR_WS, "");
  if (/^data:/i.test(v)) {
    const imgSrc = node.nodeName === "IMG" && (data.attrName === "src" || data.attrName === "srcset");
    if (!(imgSrc && SAFE_DATA_IMG.test(v))) data.keepAttr = false;
    return;
  }
  if (!display || !URL_ATTRS.has(data.attrName)) return;
  const urls = data.attrName === "srcset" ? raw.split(",").map((c) => c.trim().split(/\s+/)[0]) : [raw.trim()];
  if (urls.some(hitsApp)) data.keepAttr = false;
});

// …and the same through CSS (background:url(…) in a style attribute). Read
// back from the parsed style, so CSS escapes in the source can't hide a URL.
function dropAppUrlsInStyle(node) {
  const st = node.style;
  for (let i = (st?.length || 0) - 1; i >= 0; i--) {
    const prop = st[i];
    const val = st.getPropertyValue(prop);
    if (!/url\(|image-set\(/i.test(val)) continue;
    const urls = [
      ...[...val.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1")),
      ...[...val.matchAll(/url\(\s*([^"'\s)]+)\s*\)/gi)].map((m) => m[1]),
    ];
    if (!urls.length || urls.some(hitsApp)) st.removeProperty(prop);
  }
}

// Links in a rendered email open in a new tab — clicking one must never
// navigate the app away.
purifier.addHook("afterSanitizeAttributes", (node) => {
  if (!display) return;
  if (node.hasAttribute?.("style")) dropAppUrlsInStyle(node);
  if (node.nodeName !== "A") return;
  const href = node.getAttribute("href") || "";
  if (!href || href.startsWith("#") || /^(mailto|tel):/i.test(href)) return;
  node.setAttribute("target", "_blank");
  node.setAttribute("rel", "noopener noreferrer");
});

// Zoho prefixes the email's own classes/ids (x_123gmail_quote,
// x_456divRplyFwdMsg), so match by substring and tag every quoted part with
// one class that styles.css hides and the translator skips.
export const QUOTED_CLASS = "sc-quoted";
const QUOTE_SEL = 'blockquote, [class*="gmail_quote"], [class*="zmail_extra"], [class*="yahoo_quoted"]';
// Outlook has no wrapper: the quoted chain is everything AFTER its reply header.
const OUTLOOK_SEL = '[id*="appendonsend"], [id*="divRplyFwdMsg"], [id*="mail-editor-reference-message-container"]';

function markQuoted(body) {
  for (const el of body.querySelectorAll(QUOTE_SEL)) el.classList.add(QUOTED_CLASS);
  const start = body.querySelector(OUTLOOK_SEL);
  if (start) markOutlookChain(body, start);
  // A forward with no words of its own (the whole email sits after Outlook's
  // header or in a gmail_quote): collapsed, the bubble would be empty, so the
  // quote is shown — and translated — as the message itself.
  const own = body.cloneNode(true);
  for (const el of own.querySelectorAll(`.${QUOTED_CLASS}`)) el.remove();
  if (/\p{L}{2}/u.test(own.textContent)) return;
  for (const el of body.querySelectorAll(`.${QUOTED_CLASS}`)) {
    el.classList.remove(QUOTED_CLASS);
    if (!el.classList.length) el.removeAttribute("class");
  }
}

function markOutlookChain(body, start) {
  const doc = body.ownerDocument;
  const hide = (n) => {
    if (n.nodeType === 1) n.classList.add(QUOTED_CLASS);
    else if (n.nodeType === 3 && n.nodeValue.trim()) {
      const span = doc.createElement("span");
      span.className = QUOTED_CLASS;
      n.replaceWith(span);
      span.appendChild(n);
    }
  };
  // the <hr> Outlook draws right above the header belongs to the quote too
  const prev = start.previousElementSibling;
  if (prev?.tagName === "HR") hide(prev);
  // the header, everything after it, and everything after each ancestor
  for (let n = start; n && n !== body; n = n.parentNode) {
    for (let s = n === start ? n : n.nextSibling; s; ) {
      const next = s.nextSibling; // hide() may wrap a text node
      hide(s);
      s = next;
    }
  }
}

// display: links open in a new tab and nothing points back at the app
// (rendered views only).
// quotes: tag quoted parts so they collapse (and aren't translated).
export function sanitizeEmailHtml(html, { display: shown = true, quotes = shown } = {}) {
  if (!html) return "";
  display = shown;
  let body;
  try {
    body = purifier.sanitize(String(html), CONFIG);
  } finally {
    display = false;
  }
  if (!body) return "";
  if (quotes) markQuoted(body);
  return body.innerHTML;
}
