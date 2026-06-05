// server/sources/chunk.js
// Shared helper: split a blob of plain text into readable, similarly-sized
// chunks on paragraph/line boundaries (so we never cut mid-sentence harder
// than necessary). Used by the file and template ingesters.

export function chunkText(text, max = 1400, minLine = 1) {
  const lines = String(text || "")
    .split(/\r?\n+/)
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l.length >= minLine);

  const chunks = [];
  let buf = "";
  for (const line of lines) {
    if (buf && buf.length + line.length + 1 > max) {
      chunks.push(buf.trim());
      buf = "";
    }
    buf += (buf ? "\n" : "") + line;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}
