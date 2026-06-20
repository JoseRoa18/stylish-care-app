// server/settings.js
// Small app-wide settings stored in the shared app_state table (so they persist
// and are the same for everyone). Currently: the outgoing reply signature.

import { supabase } from "./supabase.js";

export const DEFAULT_SIGNATURE = `<p>Regards,<br><strong>Stylish Customer Care</strong><br>Stylish International Inc.<br><a href="https://www.stylishkb.com">www.stylishkb.com</a> | 1-855-789-5352</p>`;

export async function getSettings() {
  let signature = DEFAULT_SIGNATURE;
  try {
    if (supabase) {
      const { data } = await supabase
        .from("app_state").select("value").eq("key", "settings").maybeSingle();
      if (data?.value?.signature != null) signature = data.value.signature;
    }
  } catch {
    /* fall back to default */
  }
  return { signature };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  if (supabase) {
    await supabase.from("app_state").upsert({
      key: "settings",
      value: next,
      updated_at: new Date().toISOString(),
    });
  }
  return next;
}

// Append the signature to a reply body, unless it's already there.
const normText = (s) =>
  String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

export function appendSignature(html, signature) {
  const sig = (signature || "").trim();
  if (!sig) return html;
  const body = String(html || "").trim();
  const marker = normText(sig).slice(0, 40); // distinctive enough to avoid a stray "regards,"
  if (marker && normText(body).includes(marker)) return body;
  return `${body}\n${sig}`;
}
