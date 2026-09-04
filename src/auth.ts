// Auth: phone pre-check -> auth-api OTP -> self-minted HMAC session token.
import type { Env, Role, SessionPayload, User } from './types';

export const SESSION_COOKIE = 'session';
// Exported so the cookie's own maxAge (routes.ts, set alongside mintSession) can't
// drift out of sync with the token's exp claim -- it did once, silently halving this.
export const SESSION_TTL_SECONDS = 12 * 60 * 60; // stateless token has no revoke path, so still bounded -- but 30min was logging out active users mid-task

const enc = new TextEncoder();
const dec = new TextDecoder();

// Step 1 of the auth flow: reject unregistered phones WITHOUT touching auth-api.
export function precheckPhone(db: Env['DB'], phone: string) {
  return db.prepare('SELECT * FROM users WHERE phone = ?').bind(phone.trim()).first<User>();
}

// Step 2: ask auth-api to send the OTP (only reached for a registered phone).
export async function sendOtp(env: Env, phone: string): Promise<boolean> {
  const res = await fetch(`${env.AUTH_API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': env.AUTH_API_KEY },
    body: JSON.stringify({ phone }),
  });
  return res.ok;
}

// Step 3: confirm the code with auth-api.
export async function verifyOtp(env: Env, phone: string, code: string): Promise<boolean> {
  const res = await fetch(`${env.AUTH_API_URL}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': env.AUTH_API_KEY },
    body: JSON.stringify({ phone, code }),
  });
  if (!res.ok) return false;
  const body = (await res.json().catch(() => ({}))) as { success?: boolean };
  return body.success === true;
}

// --- session token: base64url(payload).base64url(HMAC-SHA256(payload)) ---

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s: string): Uint8Array {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 ? 4 - (norm.length % 4) : 0;
  const bin = atob(norm + '='.repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

export async function mintSession(secret: string, claims: { sub: string; role: Role }): Promise<string> {
  const payload: SessionPayload = { ...claims, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = b64url(await hmac(secret, body));
  return `${body}.${sig}`;
}

// Verifies HMAC + expiry. When `fresh` is passed (role-elevated routes), also
// re-fetches the user row from D1 to confirm the account still exists and the
// current role is still allowed — closes the de-provisioning / role-downgrade gap.
export async function verifySession(
  secret: string,
  token: string | undefined,
  fresh?: { db: Env['DB']; allowed: Role[] },
): Promise<SessionPayload | null> {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;

  try {
    const expected = await hmac(secret, body);
    if (!safeEqual(unb64url(sig), expected)) return null;
  } catch {
    return null; // malformed base64 in an attacker-controlled cookie -> fail closed (401), not 500
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(dec.decode(unb64url(body)));
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
  if (!fresh) return payload;

  const user = await fresh.db.prepare('SELECT id, role FROM users WHERE id = ?').bind(payload.sub).first<{ id: string; role: Role }>();
  if (!user || !fresh.allowed.includes(user.role)) return null;
  return { ...payload, role: user.role };
}
