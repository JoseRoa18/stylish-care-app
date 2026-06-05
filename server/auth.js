// server/auth.js
// Minimal shared-password gate for the whole team. No user database: a single
// APP_PASSWORD unlocks the app, and a successful login gets an HMAC-signed,
// httpOnly session cookie (stateless — works across serverless instances).
//
// Set APP_PASSWORD in .env / Vercel to enable it. If APP_PASSWORD is unset the
// gate is DISABLED (open) so local dev stays friction-free — but then anyone
// with the URL can read tickets and send mail, so it MUST be set in production.
//
// SESSION_SECRET is optional; if absent we derive a stable secret from the
// password, so the team only has to configure one variable.

import crypto from "crypto";

const { APP_PASSWORD, SESSION_SECRET } = process.env;
const SECRET = SESSION_SECRET || (APP_PASSWORD ? `stylish-care::${APP_PASSWORD}` : null);
const COOKIE = "scare_session";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function authEnabled() {
  return Boolean(APP_PASSWORD);
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sign(data) {
  return b64url(crypto.createHmac("sha256", SECRET).update(data).digest());
}

function makeToken() {
  const payload = b64url(JSON.stringify({ exp: Date.now() + MAX_AGE_MS }));
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || !SECRET) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
    const { exp } = JSON.parse(json);
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}

export function checkPassword(pw) {
  if (!APP_PASSWORD) return false;
  const a = Buffer.from(String(pw ?? ""));
  const b = Buffer.from(APP_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

export function isAuthed(req) {
  if (!authEnabled()) return true;
  return verifyToken(readCookie(req, COOKIE));
}

export function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "Not authenticated", authRequired: true });
}

export function setSessionCookie(req, res) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.cookie(COOKIE, makeToken(), {
    httpOnly: true,
    secure,
    sameSite: "lax",
    maxAge: MAX_AGE_MS,
    path: "/",
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { path: "/" });
}
