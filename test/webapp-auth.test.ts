// Вход в веб-версию из Telegram.
//
// initData приходит ОТ КЛИЕНТА -- от браузера внутри Telegram. Без проверки
// подписи любой прислал бы user={"id":123} и вошёл кем угодно. Поэтому здесь
// проверяется не «работает ли вход», а «нельзя ли войти без подписи».
import { env as testEnv } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { apiRoutes } from '../src/routes';
import { verifyInitData } from '../src/auth';
import { envWith } from './fixture';
import type { Env } from '../src/types';

const TOKEN = 'tg-bot-token';

/** Собирает подписанный initData ровно так, как это делает Telegram. */
async function signInitData(botToken: string, fields: Record<string, string>): Promise<string> {
  const enc = new TextEncoder();
  const hmacRaw = async (keyData: ArrayBuffer | Uint8Array, data: string) => {
    const k = await crypto.subtle.importKey('raw', keyData as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
  };
  const secret = await hmacRaw(enc.encode('WebAppData'), botToken);
  const dcs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const sig = await hmacRaw(secret, dcs);
  const hash = Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
  const p = new URLSearchParams(fields);
  p.set('hash', hash);
  return p.toString();
}

const nowSec = () => Math.floor(Date.now() / 1000);
const world = () =>
  envWith({
    users: [{ id: 'boss', phone: '+1', name: 'Директор', role: 'creator' }],
    memberships: [{ project_id: 'p1', user_id: 'boss' }],
    projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'boss' }],
    tasks: [],
  });
const withToken = (env: Env) => ({ ...env, TELEGRAM_BOT_TOKEN: TOKEN });

describe('подпись initData', () => {
  it('правильная подпись принимается', async () => {
    const data = await signInitData(TOKEN, { auth_date: String(nowSec()), user: JSON.stringify({ id: 42, username: 'a' }) });
    expect(await verifyInitData(TOKEN, data)).toMatchObject({ id: '42', username: 'a' });
  });

  it('подделанные данные при чужой подписи отвергаются', async () => {
    const data = await signInitData(TOKEN, { auth_date: String(nowSec()), user: JSON.stringify({ id: 42 }) });
    // Подменяем пользователя, подпись оставляем прежнюю -- ровно то, что сделал
    // бы злоумышленник, желая войти под чужим аккаунтом.
    const tampered = data.replace(encodeURIComponent('{"id":42}'), encodeURIComponent('{"id":999}'));
    expect(await verifyInitData(TOKEN, tampered)).toBeNull();
  });

  it('подпись чужим токеном не проходит', async () => {
    const data = await signInitData('другой-токен', { auth_date: String(nowSec()), user: JSON.stringify({ id: 42 }) });
    expect(await verifyInitData(TOKEN, data)).toBeNull();
  });

  it('просроченная строка не работает вечно', async () => {
    // initData попадает в URL мини-приложения и живёт в истории браузера:
    // перехваченная строка без срока годности была бы вечным ключом.
    const old = await signInitData(TOKEN, { auth_date: String(nowSec() - 48 * 3600), user: JSON.stringify({ id: 42 }) });
    expect(await verifyInitData(TOKEN, old)).toBeNull();
  });

  it('незаданный токен бота -- ЗАКРЫТАЯ дверь, а не открытая', async () => {
    // Тонкий случай: пустой ключ -- всё ещё ключ. Если TELEGRAM_BOT_TOKEN не
    // задан, злоумышленник подпишет данные ПУСТЫМ ключом, подпись сойдётся, и
    // он войдёт кем угодно. Проверять надо именно это, а не «чужая подпись не
    // подходит» -- та не подходит и без всякой защиты.
    const forged = await signInitData('', { auth_date: String(nowSec()), user: JSON.stringify({ id: 42 }) });
    expect(await verifyInitData('', forged)).toBeNull();
  });
});

describe('POST /auth/telegram', () => {
  const post = (env: Env, initData: string) =>
    apiRoutes.request('/auth/telegram', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData }),
    }, env);

  it('подключённый к боту входит без телефона и OTP', async () => {
    const env = withToken(await world());
    await testEnv.DB.prepare("UPDATE users SET telegram_user_id = '42' WHERE id = 'boss'").run();
    const data = await signInitData(TOKEN, { auth_date: String(nowSec()), user: JSON.stringify({ id: 42 }) });

    const res = await post(env, data);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { id: 'boss', role: 'creator' } });
    // Сессия выдана кукой -- дальше приложение работает как обычно.
    expect(res.headers.get('set-cookie')).toContain('session=');
  });

  it('без подписи -- 401', async () => {
    const env = withToken(await world());
    expect((await post(env, 'user=%7B%22id%22%3A42%7D&auth_date=1')).status).toBe(401);
  });

  it('не подключённый к боту не входит: людей заводит регистрация, а не веб', async () => {
    const env = withToken(await world());
    const data = await signInitData(TOKEN, { auth_date: String(nowSec()), user: JSON.stringify({ id: 777 }) });
    const res = await post(env, data);
    // Иначе появился бы второй путь создания людей, о котором не знает
    // подтверждение владельцем.
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'CONNECT_BOT_FIRST' });
  });

  it('подключён, но без организации -- 403, а не пустая доска', async () => {
    const env = withToken(await world());
    await testEnv.DB.prepare("UPDATE users SET telegram_user_id = '42' WHERE id = 'boss'").run();
    await testEnv.DB.prepare("UPDATE org_memberships SET left_at = '2026-01-01' WHERE user_id = 'boss'").run();
    const data = await signInitData(TOKEN, { auth_date: String(nowSec()), user: JSON.stringify({ id: 42 }) });
    const res = await post(env, data);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'NO_ORG' });
  });
});
