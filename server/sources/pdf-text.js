// server/sources/pdf-text.js
// Robust PDF text extraction. Many Stylish spec sheets are image/drawing PDFs
// with no real text layer, so pdf-parse returns fragments. For those we fall
// back to Gemini multimodal OCR (it reads the document as images and returns
// the text + specifications). Text-layer PDFs (most install manuals) skip the
// expensive OCR path entirely.

const { GEMINI_API_KEY } = process.env;
const OCR_MODEL = process.env.GEMINI_OCR_MODEL || "gemini-2.5-flash";
// below this many non-whitespace chars we treat a PDF as image-based
const MIN_TEXT_CHARS = Number(process.env.PDF_MIN_TEXT_CHARS || 200);
// inline_data request cap (base64 inflates ~33%); larger PDFs need the File API
const INLINE_LIMIT = 15 * 1024 * 1024;

const OCR_PROMPT = `Extract ALL readable text from this product document as plain UTF-8 text.
Include model numbers, dimensions, finishes/colors, materials, part lists, warranty notes and any table contents as readable lines.
Do not describe images or add commentary — output only the extracted text.`;

function thinkingFor(model) {
  return /^gemini-3/.test(model) ? { thinkingLevel: "low" } : { thinkingBudget: 0 };
}

function dense(text) {
  return (text || "").replace(/\s+/g, "").length;
}

async function textLayer(buffer) {
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    const r = await parser.getText();
    return (r.text || "").trim();
  } catch {
    return "";
  }
}

async function geminiOcr(buffer) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${OCR_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                inline_data: {
                  mime_type: "application/pdf",
                  data: buffer.toString("base64"),
                },
              },
              { text: OCR_PROMPT },
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens: 4096,
          temperature: 0,
          thinkingConfig: thinkingFor(OCR_MODEL),
        },
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `OCR HTTP ${res.status}`);
  return (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();
}

// Returns { text, method }. method ∈ text-layer | gemini-ocr |
// text-layer-sparse | too-large-for-ocr.
export async function extractPdfText(buffer) {
  const layer = await textLayer(buffer);
  if (dense(layer) >= MIN_TEXT_CHARS) return { text: layer, method: "text-layer" };

  if (!GEMINI_API_KEY) return { text: layer, method: "text-layer-sparse" };
  if (buffer.length > INLINE_LIMIT)
    return { text: layer, method: "too-large-for-ocr" };

  try {
    const ocr = await geminiOcr(buffer);
    // accept OCR only if it actually recovered more than the text layer
    if (dense(ocr) > dense(layer)) return { text: ocr, method: "gemini-ocr" };
  } catch {
    // fall through to whatever the text layer gave
  }
  return { text: layer, method: "text-layer-sparse" };
}
