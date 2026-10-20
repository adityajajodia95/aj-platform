// Sessions and abuse protection (Platform M4): Turnstile → signed `aj_s` cookie bound to a hashed IP.
// ipHash = SHA-256(IP + daily salt), so raw IPs are never stored; the salt is derived from SESSION_KEY.
import { utcDay } from "./types";

export const SESSION_COOKIE = "aj_s";
export const SESSION_TTL_S = 2 * 3600;
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const enc = new TextEncoder();
const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function hashIp(ip: string, sessionKey: string, now = Date.now()): Promise<string> {
  const salt = hex(
    await crypto.subtle.sign("HMAC", await hmacKey(sessionKey), enc.encode(`ip-salt:${utcDay(now)}`)),
  );
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(`${ip}|${salt}`)));
}

export async function verifyTurnstile(
  secret: string,
  token: string,
  ip: string | null,
  doFetch: typeof fetch = fetch,
): Promise<boolean> {
  if (!token) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  const res = await doFetch(SITEVERIFY, { method: "POST", body: form });
  if (!res.ok) return false;
  return Boolean(((await res.json()) as { success?: boolean }).success);
}

/** Token = base64url(`sessionId.exp.ipHash`) + "." + base64url(HMAC-SHA256(SESSION_KEY, payload)). */
export async function issueSession(
  sessionKey: string,
  ipHash: string,
  now = Date.now(),
): Promise<{ token: string; sessionId: string; exp: number }> {
  const sessionId = crypto.randomUUID();
  const exp = Math.floor(now / 1000) + SESSION_TTL_S;
  const payload = `${sessionId}.${exp}.${ipHash}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(sessionKey), enc.encode(payload));
  return { token: `${b64url(enc.encode(payload))}.${b64url(sig)}`, sessionId, exp };
}

export async function checkSessionToken(
  sessionKey: string,
  token: string,
  ipHash: string,
  now = Date.now(),
): Promise<{ ok: boolean; sessionId?: string; reason?: string }> {
  const [p, s] = token.split(".");
  if (!p || !s) return { ok: false, reason: "malformed" };
  let payload: string;
  let sig: Uint8Array;
  try {
    payload = new TextDecoder().decode(fromB64url(p));
    sig = fromB64url(s);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(sessionKey), sig, enc.encode(payload));
  if (!valid) return { ok: false, reason: "bad_signature" };
  const [sessionId, exp, boundIp] = payload.split(".");
  if (!sessionId || Number(exp) * 1000 <= now) return { ok: false, reason: "expired" };
  if (boundIp !== ipHash) return { ok: false, reason: "ip_mismatch" };
  return { ok: true, sessionId };
}

export const sessionCookie = (token: string) =>
  `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_TTL_S}; Path=/; HttpOnly; Secure; SameSite=Lax`;

export function readCookie(header: string | null, name = SESSION_COOKIE): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
