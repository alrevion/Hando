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

/**
 * Организация, в контексте которой человек работает сейчас. Порядок: липкий
 * current_org_id, затем единственное действующее членство. Если членств
 * несколько, а current не выставлен -- выбирать за человека нельзя, возвращаем
 * null и вызывающий требует выбора.
 */
export async function resolveOrgId(db: Env['DB'], userId: string): Promise<string | null> {
  const u = await db.prepare('SELECT current_org_id FROM users WHERE id = ?').bind(userId).first<{ current_org_id: string | null }>();
  if (u?.current_org_id) {
    // current мог указывать на организацию, из которой человека уже отозвали.
    const still = await db
      .prepare(`SELECT 1 FROM org_memberships m JOIN orgs o ON o.id = m.org_id
                WHERE m.org_id = ? AND m.user_id = ? AND m.left_at IS NULL
                  AND m.confirmed_at IS NOT NULL AND o.archived_at IS NULL`)
      .bind(u.current_org_id, userId)
      .first();
    if (still) return u.current_org_id;
  }
  const { results } = await db
    .prepare(`SELECT m.org_id FROM org_memberships m JOIN orgs o ON o.id = m.org_id
              WHERE m.user_id = ? AND m.left_at IS NULL AND m.confirmed_at IS NOT NULL
                AND o.archived_at IS NULL`)
    .bind(userId)
    .all<{ org_id: string }>();
  return results.length === 1 ? results[0].org_id : null;
}

/**
 * Роль человека В ЗАДАННОЙ организации.
 * null -- членства нет, оно отозвано ИЛИ ещё не подтверждено.
 *
 * confirmed_at обязателен здесь, а не только на экране заявок: вступивший по
 * коду получал бы доступ мгновенно, и подтверждение владельцем стало бы
 * декорацией. Код раздают в общем чате -- сам по себе он не должен пускать.
 */
export async function membershipRole(db: Env['DB'], orgId: string, userId: string): Promise<Role | null> {
  // archived_at обязателен здесь наравне с left_at. Удаление организации гасит
  // саму организацию, но строки членства остаются -- и без этой проверки уже
  // выданная кука продолжала пускать в УДАЛЁННУЮ организацию: в приложении
  // висели её заявки и её задачи. Проверка стоит в одной функции, через которую
  // ходит каждый роут, а не в каждом роуте по отдельности.
  const row = await db
    .prepare(`SELECT m.role FROM org_memberships m JOIN orgs o ON o.id = m.org_id
              WHERE m.org_id = ? AND m.user_id = ? AND m.left_at IS NULL
                AND m.confirmed_at IS NOT NULL AND o.archived_at IS NULL`)
    .bind(orgId, userId)
    .first<{ role: Role }>();
  return row?.role ?? null;
}

/**
 * Claims для сессии MCP, ЗАПЕРТОЙ на пилотную организацию (решение шага 2a).
 *
 * Живёт здесь, а не в mcp.ts, по одной причине: mcp.ts тянет
 * @modelcontextprotocol/sdk -> ajv, а ajv грузит .json как модуль, чего workerd
 * не умеет -- значит всё, что импортирует mcp.ts, тестируется только на
 * ПОДДЕЛКЕ базы. Подделка соврала трижды за три шага. Замок арендатора --
 * последнее, что можно доверить подделке, поэтому он вынесен туда, где его
 * проверяет настоящая D1.
 */
export async function mcpSessionClaims(
  env: Env,
  userId: string,
): Promise<{ sub: string; role: Role; org_id: string } | null> {
  if (!userId) return null;
  const orgId = await resolveOrgId(env.DB, userId);
  if (!orgId) return null;
  // Пустой MCP_ORG_ID -- отказ, а не «пропускаем всё»: незаданная переменная не
  // должна означать открытую дверь.
  if (!env.MCP_ORG_ID || orgId !== env.MCP_ORG_ID) return null;
  const role = await membershipRole(env.DB, orgId, userId);
  if (!role) return null;
  return { sub: userId, role, org_id: orgId };
}

/**
 * Проверяет initData мини-приложения Telegram.
 *
 * Telegram подписывает данные ключом HMAC-SHA256, где сам ключ получен как
 * HMAC("WebAppData", bot_token). Проверяем строку data-check-string: все поля
 * кроме hash, отсортированы по имени, склеены через \n.
 *
 * Почему это вообще нужно: initData приходит от КЛИЕНТА, то есть от браузера
 * внутри Telegram. Без проверки подписи любой мог бы прислать
 * `user={"id":123}` и войти кем угодно.
 *
 * auth_date проверяется на свежесть: перехваченная строка иначе работала бы
 * вечно, а она попадает в URL мини-приложения и живёт в истории браузера.
 */
export async function verifyInitData(
  botToken: string,
  initData: string,
  maxAgeSeconds = 24 * 60 * 60,
  now: Date = new Date(),
): Promise<{ id: string; username?: string; first_name?: string; last_name?: string } | null> {
  if (!botToken || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  try {
    const secret = await hmac('WebAppData', botToken);
    const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(dataCheckString)));
    const expected = Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
    // Сравнение постоянного времени: hash приходит от клиента.
    if (!safeEqual(enc.encode(expected), enc.encode(hash))) return null;

    const authDate = Number(params.get('auth_date') ?? 0);
    if (!authDate || now.getTime() / 1000 - authDate > maxAgeSeconds) return null;

    const raw = params.get('user');
    if (!raw) return null;
    const user = JSON.parse(raw) as { id?: number; username?: string; first_name?: string; last_name?: string };
    if (user.id == null) return null;
    return { id: String(user.id), username: user.username, first_name: user.first_name, last_name: user.last_name };
  } catch {
    return null;
  }
}

export async function mintSession(secret: string, claims: { sub: string; role: Role; org_id: string | null }): Promise<string> {
  const payload: SessionPayload = { ...claims, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = b64url(await hmac(secret, body));
  return `${body}.${sig}`;
}

// Verifies HMAC + expiry. When `fresh` is passed (role-elevated routes), also
// re-fetches the membership from D1 to confirm the account still belongs to the
// organisation and the current role is still allowed — closes the
// de-provisioning / role-downgrade gap.
//
// orgId в `fresh` -- ОБЯЗАТЕЛЬНЫЙ аргумент, и это не педантизм. requireRole
// контекстом не пользуется: он сам заново разбирает токен и вызывает эту
// функцию. Без явной организации пришлось бы читать «какое-нибудь подходящее по
// роли членство» -- то есть creator семейной группы прошёл бы гейт школы.
export async function verifySession(
  secret: string,
  token: string | undefined,
  fresh?: { db: Env['DB']; allowed: Role[]; orgId: string | null },
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

  // Организация берётся из claim, а при его отсутствии (токен, выпущенный до
  // деплоя 2a) резолвится по БД. Не резолвится вовсе -- гейт закрыт: лучше
  // принудительный релогин, чем угадывание арендатора.
  const orgId = fresh.orgId ?? payload.org_id ?? (await resolveOrgId(fresh.db, payload.sub));
  if (!orgId) return null;

  const role = await membershipRole(fresh.db, orgId, payload.sub);
  if (!role || !fresh.allowed.includes(role)) return null;
  return { ...payload, role, org_id: orgId };
}
