// server/ringcentral.js
// Read-only-ish RingCentral integration (server-to-server, JWT auth) so Care
// can see a customer's phone history — calls (with recordings), voicemails
// (with transcription) and SMS — by their phone number, and act on it
// (send SMS, click-to-call) right from the ticket.

const {
  RINGCENTRAL_SERVER,
  RINGCENTRAL_CLIENT_ID,
  RINGCENTRAL_CLIENT_SECRET,
  RINGCENTRAL_JWT,
  RINGCENTRAL_SMS_FROM, // an SMS-enabled number on the account (for sending)
} = process.env;

const SERVER = RINGCENTRAL_SERVER || "https://platform.ringcentral.com";

export function ringcentralConfigured() {
  return Boolean(RINGCENTRAL_CLIENT_ID && RINGCENTRAL_CLIENT_SECRET && RINGCENTRAL_JWT);
}

// ── auth (JWT bearer → access token, cached) ─────────────────
let _token = null;
async function getToken() {
  if (_token && _token.exp - 60_000 > Date.now()) return _token.value;
  const basic = "Basic " + Buffer.from(`${RINGCENTRAL_CLIENT_ID}:${RINGCENTRAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: RINGCENTRAL_JWT,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    throw new Error(`RingCentral auth failed (${res.status}): ${j.error_description || j.message || "unknown"}`);
  }
  _token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return _token.value;
}

async function rcFetch(path, options = {}) {
  const token = await getToken();
  const res = await fetch(`${SERVER}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  return res;
}
async function rcGet(path) {
  const res = await rcFetch(path);
  if (!res.ok) throw new Error(`RingCentral ${res.status}`);
  return res.json();
}

// digits only — the call-log/message phoneNumber filter wants no "+"
const digits = (p) => String(p || "").replace(/\D/g, "");
const ISO = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

// ── call history for a phone number ──────────────────────────
export async function getCallHistory(phone, { days = 180, limit = 25 } = {}) {
  const num = digits(phone);
  if (!ringcentralConfigured() || !num) return [];
  const data = await rcGet(
    `/restapi/v1.0/account/~/call-log?view=Detailed&perPage=${limit}&phoneNumber=${num}&dateFrom=${ISO(days)}`
  ).catch(() => ({ records: [] }));
  return (data.records || []).map((r) => ({
    id: r.id,
    time: r.startTime,
    direction: r.direction,         // Inbound / Outbound
    result: r.result,               // Accepted / Missed / Voicemail / …
    durationSec: r.duration || 0,
    fromNumber: r.from?.phoneNumber || null,
    fromName: r.from?.name || null,
    toNumber: r.to?.phoneNumber || null,
    recordingId: r.recording?.id || null,
  }));
}

// ── recent inbound calls to the line (the "who called" view) ──
export async function getRecentCalls({ days = 7, limit = 50 } = {}) {
  if (!ringcentralConfigured()) return [];
  const data = await rcGet(
    `/restapi/v1.0/account/~/call-log?view=Detailed&direction=Inbound&perPage=${limit}&dateFrom=${ISO(days)}`
  ).catch(() => ({ records: [] }));
  return (data.records || []).map((r) => ({
    id: r.id,
    time: r.startTime,
    fromNumber: r.from?.phoneNumber || null,
    fromName: r.from?.name || null,
    toNumber: r.to?.phoneNumber || null,
    result: r.result,
    durationSec: r.duration || 0,
    recordingId: r.recording?.id || null,
  }));
}

// Inbound calls grouped by day (UTC) for the dashboard → { "2026-06-19": 21 }.
export async function getCallsPerDay({ days = 7 } = {}) {
  if (!ringcentralConfigured()) return {};
  const dateFrom = ISO(days);
  const out = {};
  for (let page = 1; page <= 10; page++) {
    const data = await rcGet(
      `/restapi/v1.0/account/~/call-log?direction=Inbound&perPage=1000&page=${page}&dateFrom=${dateFrom}`
    ).catch(() => ({ records: [] }));
    for (const r of data.records || []) {
      const d = (r.startTime || "").slice(0, 10);
      if (d) out[d] = (out[d] || 0) + 1;
    }
    if (!data.navigation?.nextPageId && (data.records || []).length < 1000) break;
  }
  return out;
}

export async function getRecentVoicemails({ days = 21, limit = 40 } = {}) {
  if (!ringcentralConfigured()) return [];
  const data = await rcGet(
    `/restapi/v1.0/account/~/extension/~/message-store?messageType=VoiceMail&perPage=${limit}&dateFrom=${ISO(days)}`
  ).catch(() => ({ records: [] }));
  return (data.records || []).map((m) => {
    const audio = (m.attachments || []).find((a) => a.type === "AudioRecording");
    return {
      id: m.id,
      time: m.creationTime,
      fromNumber: m.from?.phoneNumber || null,
      fromName: m.from?.name || null,
      durationSec: audio?.vmDuration || null,
      audioId: audio?.id || null,
      unread: m.readStatus !== "Read",
    };
  });
}

// ── messages (voicemail + SMS) for a phone number ────────────
async function getMessages(phone, type, { days = 180, limit = 25 } = {}) {
  const num = digits(phone);
  if (!ringcentralConfigured() || !num) return [];
  const data = await rcGet(
    `/restapi/v1.0/account/~/extension/~/message-store?messageType=${type}&perPage=${limit}&dateFrom=${ISO(days)}&phoneNumber=${num}`
  ).catch(() => ({ records: [] }));
  return data.records || [];
}

export async function getVoicemails(phone, opts) {
  const recs = await getMessages(phone, "VoiceMail", opts);
  return recs.map((m) => {
    const audio = (m.attachments || []).find((a) => a.type === "AudioRecording");
    const transcript = (m.attachments || []).find((a) => /transcription/i.test(a.type));
    return {
      id: m.id,
      time: m.creationTime,
      fromNumber: m.from?.phoneNumber || null,
      fromName: m.from?.name || null,
      durationSec: audio?.vmDuration || null,
      audioId: audio?.id || null,
      transcriptId: transcript?.id || null,
      transcriptionStatus: m.vmTranscriptionStatus || null,
    };
  });
}

export async function getSms(phone, opts) {
  const recs = await getMessages(phone, "SMS", opts);
  return recs
    .map((m) => ({
      id: m.id,
      time: m.creationTime,
      direction: m.direction, // Inbound / Outbound
      text: m.subject || "",
      from: m.from?.phoneNumber || null,
      to: (m.to || []).map((t) => t.phoneNumber).join(", "),
    }))
    .sort((a, b) => (a.time > b.time ? 1 : -1));
}

// ── media (call recording / voicemail audio / transcript) ────
export async function getMedia(uriPath) {
  // uriPath is a RingCentral media path we built from known ids — validated
  const res = await rcFetch(uriPath);
  if (!res.ok) throw new Error(`RingCentral media ${res.status}`);
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") || "application/octet-stream",
  };
}
export const recordingPath = (id) => `/restapi/v1.0/account/~/recording/${encodeURIComponent(id)}/content`;
export const voicemailAudioPath = (msgId, attId) =>
  `/restapi/v1.0/account/~/extension/~/message-store/${encodeURIComponent(msgId)}/content/${encodeURIComponent(attId)}`;

// ── actions: send SMS, click-to-call ─────────────────────────
export async function sendSms(to, text) {
  if (!RINGCENTRAL_SMS_FROM) throw new Error("RINGCENTRAL_SMS_FROM (a sending number) is not set");
  const res = await rcFetch(`/restapi/v1.0/account/~/extension/~/sms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: { phoneNumber: RINGCENTRAL_SMS_FROM }, to: [{ phoneNumber: to }], text }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`RingCentral SMS failed (${res.status}): ${j.message || j.errorCode || "unknown"}`);
  return { ok: true, id: j.id };
}

// RingOut: rings the agent's phone first, then connects to the customer.
export async function ringOut(toNumber, fromNumber) {
  if (!fromNumber) throw new Error("Your phone number (to ring first) is required");
  const res = await rcFetch(`/restapi/v1.0/account/~/extension/~/ring-out`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: { phoneNumber: fromNumber }, to: { phoneNumber: toNumber }, playPrompt: false }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`RingCentral RingOut failed (${res.status}): ${j.message || j.errorCode || "unknown"}`);
  return { ok: true, status: j.status?.callStatus };
}

// transcription text (when available)
export async function getVoicemailTranscript(msgId, attId) {
  const res = await rcFetch(voicemailAudioPath(msgId, attId));
  if (!res.ok) return "";
  return (await res.text()).trim();
}
