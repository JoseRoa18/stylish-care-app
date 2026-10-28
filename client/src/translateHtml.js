// client/src/translateHtml.js
// Translate an email WITHOUT letting the model touch its markup. The HTML is
// cut into runs of inline text (one per paragraph / list item / cell…); each
// run goes to the model as plain text where inline formatting is a numbered
// placeholder (<g3>bold words</g3>, <i4/> for an image, <br/>). The answer is
// written back into a clone of the message's own DOM: model text only ever
// becomes text nodes, and every element is a copy of one that was already
// there — so paragraphs, lists, tables, links and images survive, and nothing
// the model returns is ever parsed as HTML.
import { api } from "./api.js";
import { sanitizeEmailHtml, QUOTED_CLASS } from "./sanitize.js";

const BLOCK = (
  "address article aside blockquote center dd details dialog div dl dt fieldset figcaption figure " +
  "footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary table caption " +
  "colgroup thead tbody tfoot tr td th ul"
).split(" ");
const BLOCK_TAGS = new Set(BLOCK.map((t) => t.toUpperCase()));
const BLOCK_SEL = BLOCK.join(",");
const ATOMIC = new Set("IMG SVG VIDEO AUDIO PICTURE CANVAS MATH HR WBR INPUT".split(" "));
const SKIP = new Set("SCRIPT STYLE CODE TEXTAREA NOSCRIPT TEMPLATE".split(" "));
// Same parts styles.css hides behind "Show quoted text" (sanitize.js tags them
// all, and leaves a forward with no words of its own untagged) — those stay
// in the original language (and are labelled as such).
const QUOTED_SEL = `.${QUOTED_CLASS}`;
// the only four placeholder forms (lenient on case and on "<i3 />" / "<br>",
// which a model may write)
const TOKEN = /<g\d+>|<\/g\d+>|<i\d+\s*\/>|<br\s*\/?>/gi;
const TOKEN_SPLIT = /(<g\d+>|<\/g\d+>|<i\d+\s*\/>|<br\s*\/?>)/i;
// HTML whitespace only — \s would also eat &nbsp; spacing
const WS = /[ \t\n\r\f]+/g;
const EDGE_WS = /^[ \t\n\r\f]+|[ \t\n\r\f]+$/g;
const PRE_STYLE = /white-space\s*:\s*pre/i;
// Invisible padding (a preheader's hundreds of &zwnj;&nbsp;): the model loops
// on it until it runs out of tokens, so it goes as one <iN/> and stays as is.
const FILLER = /((?:[\u200B-\u200D\u2060\u034F\u00AD\uFEFF][\u00A0 ]*){3,})/;
// Literal "<" in the text is sent as &lt; (and an "&lt;"/"&amp;" already there
// as &amp;…), so text like "<br>" or "<g0>" can't pass for a placeholder.
const escText = (s) => s.replace(/&(?=(?:lt|amp);)/g, "&amp;").replace(/</g, "&lt;");
const unescText = (s) => s.replace(/&(lt|amp);/g, (_, e) => (e === "lt" ? "<" : "&"));

// Hidden parts (a preheader is hidden preview text plus that padding) are
// never seen by the agent, so never sent: left as they are, like <style>.
// Only rules a child can't undo — not font-size:0 or visibility:hidden.
const ZERO = /^0[a-z%]*$/;
function isHidden(el) {
  const s = el.style || {};
  return (
    el.hasAttribute("hidden") ||
    s.display === "none" ||
    s.opacity === "0" ||
    ((ZERO.test(s.maxHeight) || ZERO.test(s.height)) && s.overflowY === "hidden")
  );
}

const CHUNK_CHARS = 4000; // per request — keeps each Gemini call to a couple of seconds
const CHUNK_ITEMS = 150;
const MAX_CHARS = 30000; // per message; anything past it stays in the original

// Parse (inert: nothing runs, no image loads) and cut into translatable runs.
export function segmentHtml(html, { skipQuoted = true } = {}) {
  const clean = sanitizeEmailHtml(html, { display: false, quotes: skipQuoted });
  // Parse as a whole document and walk <body>: wrapping the email in our own
  // <div> would let a stray </div> in it close the wrapper and drop the rest.
  const doc = new DOMParser().parseFromString(clean, "text/html");
  const runs = [];
  const isBlank = (n) => (n.nodeType === 3 && !n.nodeValue.replace(WS, "")) || n.nodeType === 8;
  const trimEnds = (arr) => {
    let a = 0, b = arr.length;
    while (a < b && isBlank(arr[a])) a++;
    while (b > a && isBlank(arr[b - 1])) b--;
    return arr.slice(a, b);
  };
  const tag = (el) => el.tagName.toUpperCase(); // SVG/MathML names come lowercase
  const isPre = (el) => tag(el) === "PRE" || PRE_STYLE.test(el.getAttribute("style") || "");

  function flush(run, inPre) {
    let nodes = trimEnds(run);
    let host = null;
    // a paragraph-wide <span>/<font>/<a> wrapper stays out of the request
    while (
      nodes.length === 1 && nodes[0].nodeType === 1 &&
      !ATOMIC.has(tag(nodes[0])) && !SKIP.has(tag(nodes[0])) && tag(nodes[0]) !== "BR" && !isHidden(nodes[0])
    ) {
      host = nodes[0];
      inPre = inPre || isPre(host);
      nodes = trimEnds([...host.childNodes]);
    }
    if (!nodes.length) return;
    const slots = [];
    const atomic = (node) => {
      slots.push({ kind: "atomic", node });
      return `<i${slots.length - 1}/>`;
    };
    const ser = (n, pre) => {
      if (n.nodeType === 3)
        return n.nodeValue
          .split(FILLER)
          .map((s, i) => (i % 2 ? atomic(doc.createTextNode(s)) : pre ? escText(s).replace(/\r?\n/g, "<br/>") : escText(s.replace(WS, " "))))
          .join("");
      if (n.nodeType !== 1) return "";
      if (tag(n) === "BR") return "<br/>";
      if (ATOMIC.has(tag(n)) || SKIP.has(tag(n)) || isHidden(n)) return atomic(n);
      const k = slots.length;
      slots.push({ kind: "wrap", node: n });
      const p = pre || isPre(n);
      return `<g${k}>` + [...n.childNodes].map((c) => ser(c, p)).join("") + `</g${k}>`;
    };
    const raw = nodes.map((n) => ser(n, inPre)).join("");
    const text = raw.replace(EDGE_WS, "");
    // nothing to translate (numbers, an order id, a lone image…)
    if (!/\p{L}{2}/u.test(text.replace(TOKEN, "").replace(/&(?:lt|amp);/g, ""))) return;
    // edge spaces stay out of the request and are put back as they were
    // (one space, or verbatim inside <pre>)
    const edge = (s) => (s && !inPre ? " " : s);
    runs.push({
      text, slots, nodes, host,
      lead: edge(raw.match(/^[ \t\n\r\f]*/)[0]),
      trail: edge(raw.match(/[ \t\n\r\f]*$/)[0]),
    });
  }

  function walk(el, inPre) {
    let run = [];
    for (const c of [...el.childNodes]) {
      if (c.nodeType === 1) {
        if ((skipQuoted && c.matches(QUOTED_SEL)) || SKIP.has(tag(c)) || isHidden(c)) {
          flush(run, inPre);
          run = [];
          continue;
        }
        // blocks (and inline elements holding blocks or a quote) are containers:
        // their own text is translated run by run, the element itself stays
        if (BLOCK_TAGS.has(tag(c)) || c.querySelector(BLOCK_SEL) || (skipQuoted && c.querySelector(QUOTED_SEL))) {
          flush(run, inPre);
          run = [];
          walk(c, inPre || isPre(c));
          continue;
        }
      }
      run.push(c);
    }
    flush(run, inPre);
  }

  walk(doc.body, false);
  return { doc, runs };
}

// Rebuild a run from the model's text. Placeholders only ever produce clones
// of the run's own elements (unknown or repeated numbers are ignored); all
// other text becomes text nodes, so a stray "<b>" just shows as "<b>".
function buildFragment(doc, translated, slots) {
  const frag = doc.createDocumentFragment();
  const stack = [{ k: -1, el: frag }];
  const used = new Set();
  const top = () => stack[stack.length - 1].el;
  for (const part of translated.split(TOKEN_SPLIT)) {
    if (!part) continue;
    let m;
    if ((m = /^<g(\d+)>$/i.exec(part))) {
      const k = +m[1];
      if (slots[k]?.kind === "wrap" && !used.has(k)) {
        used.add(k);
        const el = slots[k].node.cloneNode(false);
        top().appendChild(el);
        stack.push({ k, el });
      }
    } else if ((m = /^<\/g(\d+)>$/i.exec(part))) {
      const i = stack.findIndex((f) => f.k === +m[1]);
      if (i > 0) stack.length = i;
    } else if ((m = /^<i(\d+)\s*\/>$/i.exec(part))) {
      const k = +m[1];
      if (slots[k]?.kind === "atomic" && !used.has(k)) {
        used.add(k);
        top().appendChild(slots[k].node.cloneNode(true));
      }
    } else if (/^<br\s*\/?>$/i.test(part)) {
      top().appendChild(doc.createElement("br"));
    } else {
      top().appendChild(doc.createTextNode(unescText(part)));
    }
  }
  // never lose an image the model dropped
  slots.forEach((s, k) => {
    if (s.kind === "atomic" && !used.has(k)) frag.appendChild(s.node.cloneNode(true));
  });
  return frag;
}

// Swap a run's nodes for its translation. Runs never overlap (a container is
// walked into, never part of a run), so they can be applied in any order.
function applyRun(doc, run, translated) {
  if (!translated.replace(TOKEN, "").trim()) return false;
  const frag = buildFragment(doc, translated.replace(EDGE_WS, ""), run.slots);
  if (run.lead) frag.prepend(doc.createTextNode(run.lead));
  if (run.trail) frag.append(doc.createTextNode(run.trail));
  if (run.host) {
    run.host.replaceChildren(frag);
  } else {
    run.nodes[0].parentNode.insertBefore(frag, run.nodes[0]);
    run.nodes.forEach((n) => n.remove());
  }
  return true;
}

// One request; a 429 (Gemini rate limit) gets one retry after a short pause.
async function requestChunk(items, target) {
  try {
    return (await api.translateSegments(items, target)).translations || {};
  } catch (e) {
    if (e.status !== 429) throw e;
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
    return (await api.translateSegments(items, target)).translations || {};
  }
}

// A chunk the model ran away on (MAX_TOKENS) is halved until the segment that
// causes it is alone: only that one stays in the original language, not the
// whole chunk. The server caps the output by the input, so a runaway fails fast.
async function requestSplit(items, target) {
  try {
    return await requestChunk(items, target);
  } catch (e) {
    if (e.code !== "MAX_TOKENS" || items.length < 2) throw e;
    const mid = Math.ceil(items.length / 2);
    const got = {};
    let ok = false, err = e;
    for (const half of [items.slice(0, mid), items.slice(mid)]) {
      try {
        Object.assign(got, await requestSplit(half, target));
        ok = true;
      } catch (e2) {
        err = e2;
      }
    }
    if (!ok) throw err;
    return got;
  }
}

// → { html, partial }. partial = some text is still in the original language
// (a missing id, a failed chunk, or past the size cap) — the UI says so and
// offers Retry instead of passing it off as translated. Throws only when
// nothing at all could be translated.
export async function translateHtmlSegments(html, target, { skipQuoted = true } = {}) {
  const { doc, runs } = segmentHtml(html, { skipQuoted });
  const chunks = [];
  let cur = [], size = 0, total = 0, capped = false;
  runs.forEach((r, id) => {
    if (capped || total + r.text.length > MAX_CHARS) {
      capped = true;
      return;
    }
    total += r.text.length;
    if (cur.length && (size + r.text.length > CHUNK_CHARS || cur.length >= CHUNK_ITEMS)) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push({ id, t: r.text });
    size += r.text.length;
  });
  if (cur.length) chunks.push(cur);

  let missing = 0, failed = 0, lastErr = null;
  for (const items of chunks) {
    let got;
    try {
      got = await requestSplit(items, target);
    } catch (e) {
      failed++;
      lastErr = e;
      missing += items.length;
      continue;
    }
    for (const { id } of items) {
      const t = got[id];
      if (!(typeof t === "string" && applyRun(doc, runs[id], t))) missing++;
    }
  }
  if (chunks.length && failed === chunks.length) throw lastErr;
  return { html: doc.body.innerHTML, partial: missing > 0 || capped };
}

// Conversation messages: one shared promise per message + language, so
// collapsing/reopening a ticket, the Peek view remounting it and StrictMode's
// double effects never translate the same message twice. Failures and partial
// results are dropped from the cache so Retry really retries.
const cache = new Map();
export function translateMessage(key, html, target) {
  const k = `${key}|${target}|${html.length}`;
  let p = cache.get(k);
  if (!p) {
    p = translateHtmlSegments(html, target);
    cache.set(k, p);
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    p.then(
      (r) => r.partial && cache.delete(k),
      () => cache.delete(k)
    );
  }
  return p;
}
