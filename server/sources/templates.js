// server/sources/templates.js
// Imports the team's approved Zoho Desk ticket templates (exported as a
// tab-separated file with an HTML "Messaje" column) into the Knowledge Base
// as the "zoho-template" source. These are the real, approved replies for
// every common scenario — gold for grounding the AI in the team's wording
// and exact policies ($20 shipping, 20% restocking, FREESPAREPARTS, etc.).
//
// No Zoho API scope needed — it reads a local export file. Re-export from
// Zoho and drop it at server/data/zoho-templates.txt (or set TEMPLATES_FILE)
// to refresh.

import * as cheerio from "cheerio";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chunkText } from "./chunk.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE =
  process.env.TEMPLATES_FILE ||
  path.join(__dirname, "..", "data", "zoho-templates.txt");

export function templatesConfigured() {
  return existsSync(FILE);
}

// Minimal TSV parser that supports a quoted field (the HTML message) which
// itself spans many lines and contains "" escaped quotes — CSV rules, tab
// delimited.
function parseDelimited(text) {
  const rows = [];
  let row = [],
    field = "",
    inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === "\t") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// HTML email body → clean plain text.
function htmlToText(html) {
  const $ = cheerio.load(html || "");
  $("style, script, img, svg").remove();
  $("br").replaceWith("\n");
  $("p, div, li, tr, h1, h2, h3, h4").append("\n");
  return $("body")
    .text()
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Drop the greeting and the sign-off/signature block (no KB value, pure noise).
function stripChrome(text) {
  let t = text;
  const sig = t.search(/\n?\s*Regards,/i);
  if (sig !== -1) t = t.slice(0, sig);
  t = t.replace(/^\s*Hi[,!.]?\s*\n?/i, "");
  return t.trim();
}

function slug(s) {
  return String(s)
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase()
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

// Map "smart" punctuation — real Unicode (U+2019 etc.) OR raw CP1252 C1 bytes
// read via latin1 (U+0092 etc.) — to clean ASCII. Kills the � / stray symbols.
function normalizePunct(s) {
  let out = "";
  for (const ch of String(s)) {
    const c = ch.charCodeAt(0);
    if (c === 0x2018 || c === 0x2019 || c === 0x91 || c === 0x92) out += "'";
    else if (c === 0x201c || c === 0x201d || c === 0x93 || c === 0x94) out += '"';
    else if (c === 0x2013 || c === 0x2014 || c === 0x96 || c === 0x97) out += "-";
    else if (c === 0x2026 || c === 0x85) out += "...";
    else if (c === 0x2022 || c === 0x95) out += "*";
    else if (c === 0xa0) out += " ";
    else out += ch;
  }
  return out;
}

// Returns { articles, errors } — caller persists via kb.replaceSource.
export async function ingestTemplates() {
  if (!templatesConfigured()) {
    return {
      articles: [],
      errors: [
        { error: `templates file not found (expected ${FILE} or TEMPLATES_FILE)` },
      ],
    };
  }

  // The Zoho export is often Windows-1252 (smart quotes/dashes). Reading it as
  // UTF-8 turns those bytes into U+FFFD. Try UTF-8; if it's not valid UTF-8,
  // fall back to a lossless latin1 read. Either way, normalizePunct() maps the
  // smart punctuation (whether U+2019 or the raw CP1252 C1 byte U+0092) to
  // clean ASCII so no � or stray control chars reach the KB.
  const buf = await readFile(FILE);
  let raw = buf.toString("utf-8");
  if (raw.includes("�")) raw = buf.toString("latin1");
  raw = normalizePunct(raw);
  const rows = parseDelimited(raw);
  if (!rows.length) return { articles: [], errors: [{ error: "empty file" }] };

  // map header → column index (Name, Folder, Subject, Messaje)
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iName = col("name");
  const iFolder = col("folder");
  const iSubject = col("subject");
  const iMsg = col("messaje") !== -1 ? col("messaje") : col("message");
  if (iName === -1 || iMsg === -1) {
    return {
      articles: [],
      errors: [{ error: "missing Name/Messaje columns in export header" }],
    };
  }

  const stamp = new Date().toISOString();
  const articles = [];
  const errors = [];
  const seen = new Set();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = (row[iName] || "").trim();
    const html = row[iMsg] || "";
    if (!name || !html) continue;
    const body = stripChrome(htmlToText(html));
    if (!body) {
      errors.push({ template: name, error: "empty after cleaning" });
      continue;
    }
    let id = `TPL-${slug(name)}`;
    while (seen.has(id)) id += "x";
    seen.add(id);

    const subject = (row[iSubject] || "").trim();
    const folder = (row[iFolder] || "").trim();
    const chunks = chunkText(body, 1400);
    chunks.forEach((chunkBody, i) => {
      articles.push({
        id: chunks.length > 1 ? `${id}-${i + 1}` : id,
        title:
          chunks.length > 1 ? `${name} (${i + 1}/${chunks.length})` : name,
        body: subject && i === 0 ? `Scenario: ${subject}\n${chunkBody}` : chunkBody,
        finish: null,
        tags: ["template", "zoho", slug(folder || "customer-service")],
        sourceUrl: null,
        updatedAt: stamp,
      });
    });
  }

  return { articles, errors };
}
