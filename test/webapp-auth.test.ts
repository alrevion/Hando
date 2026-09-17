// Вход в веб-версию из Telegram.
//
// initData приходит ОТ КЛИЕНТА -- от браузера внутри Telegram. Без проверки
// подписи любой прислал бы user={"id":123} и вошёл кем угодно. Поэтому здесь
// проверяется не «работает ли вход», а «нельзя ли войти без подписи».
import { env as testEnv } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { apiRoutes } from '../src/routes';
import { botApp } from '../src/bot';
import { verifyInitData } from '../src/auth';
import { envWith, stubTelegram } from './fixture';
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

  it('подключён, но без организации -- сессия без организации, а не отказ', async () => {
    const env = withToken(await world());
    await testEnv.DB.prepare("UPDATE users SET telegram_user_id = '42' WHERE id = 'boss'").run();
    await testEnv.DB.prepare("UPDATE org_memberships SET left_at = '2026-01-01' WHERE user_id = 'boss'").run();
    const data = await signInitData(TOKEN, { auth_date: String(nowSec()), user: JSON.stringify({ id: 42 }) });
    const res = await post(env, data);
    // Первая организация создаётся в приложении (раздел 18): сессия без
    // организации законна, и приложение показывает «создайте или вступите».
    expect(res.status).toBe(200);
    expect((await res.json<{ user: { org_id: string | null } }>()).user.org_id).toBeNull();
  });
});

// Вход в браузере. По телефону войти было нельзя: бот номер не спрашивает, и
// ни у кого в базе его нет. Теперь сайт открывает бота с ключом, а человек
// подтверждает вход кнопкой.
describe('вход в браузере через бота', () => {
  const hook = (env: Env, update: unknown) =>
    botApp.request('/webhook', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'Content-Type': 'application/json' }, body: JSON.stringify(update) }, env);
  const start = (env: Env, token: string) =>
    hook(env, { message: { chat: { id: 'tg-boss', type: 'private' }, from: { id: 'tg-boss', first_name: 'Д' }, text: `/start login_${token}` } });
  const press = (env: Env, data: string) =>
    hook(env, { callback_query: { id: 'c1', from: { id: 'tg-boss' }, data, message: { chat: { id: 'tg-boss', type: 'private' }, message_id: 7 } } });
  const claim = (env: Env, cookie?: string) =>
    apiRoutes.request('/auth/link/claim', { method: 'POST', headers: cookie ? { Cookie: cookie } : {} }, env);
  /** Ключ и кука браузера, начавшего вход. */
  async function begin(env: Env) {
    const res = await apiRoutes.request('/auth/link', { method: 'POST' }, env);
    const { url } = await res.json<{ url: string }>();
    const token = url.match(/start=login_([0-9a-f]{32})$/)![1];
    const cookie = res.headers.get('Set-Cookie')!.split(';')[0];
    return { url, token, cookie };
  }
  const sentTexts = (spy: ReturnType<typeof stubTelegram>) =>
    (spy.mock.calls as unknown as [string, { body?: string }][])
      .filter(([u]) => u.includes('/sendMessage') || u.includes('/editMessageText'))
      .map(([, i]) => JSON.parse(String(i.body)) as { text: string; reply_markup?: { inline_keyboard: { callback_data: string }[][] } });

  it('ссылка -> бот -> «Войти» -> браузер получает сессию, один раз', async () => {
    const env = await world();
    const spy = stubTelegram();
    try {
      const { url, token, cookie } = await begin(env);
      expect(url).toBe(`https://t.me/hando_ai_bot?start=login_${token}`);
      expect((await claim(env, cookie)).status).toBe(202);

      await start(env, token);
      // Переход по ссылке сам ничего не подтверждает.
      expect((await claim(env, cookie)).status).toBe(202);
      const ask = sentTexts(spy).at(-1)!;
      expect(ask.text).toContain('Вход в Hando в браузере');
      expect(ask.reply_markup!.inline_keyboard[0].map((b) => b.callback_data)).toEqual([`lg:${token}`, `lgx:${token}`]);

      await press(env, `lg:${token}`);
      expect(sentTexts(spy).at(-1)!.text).toContain('Вход подтверждён');
      const ok = await claim(env, cookie);
      expect(ok.status).toBe(200);
      expect((await ok.json<{ user: { id: string } }>()).user.id).toBe('boss');
      expect(ok.headers.get('Set-Cookie')).toContain('session=');
      // Второй раз той же кукой -- уже нет.
      expect((await claim(env, cookie)).status).toBe(410);
    } finally { spy.mockRestore(); }
  });

  it('подтверждённый ключ без куки браузера бесполезен: ссылку мало подсмотреть', async () => {
    const env = await world();
    const spy = stubTelegram();
    try {
      const { token } = await begin(env);
      await start(env, token);
      await press(env, `lg:${token}`);
      expect((await claim(env)).status).toBe(410);
      expect((await claim(env, `login_link=${token.replace(/.$/, '0')}`)).status).toBe(410);
    } finally { spy.mockRestore(); }
  });

  it('«Это не я» гасит ключ', async () => {
    const env = await world();
    const spy = stubTelegram();
    try {
      const { token, cookie } = await begin(env);
      await start(env, token);
      await press(env, `lgx:${token}`);
      expect(sentTexts(spy).at(-1)!.text).toContain('Вход отменён');
      expect((await claim(env, cookie)).status).toBe(410);
      // И подтвердить его после этого нельзя.
      await press(env, `lg:${token}`);
      expect((await claim(env, cookie)).status).toBe(410);
    } finally { spy.mockRestore(); }
  });

  it('истёкший ключ не подтверждается', async () => {
    const env = await world();
    const spy = stubTelegram();
    try {
      const { token, cookie } = await begin(env);
      await testEnv.DB.prepare('UPDATE login_links SET created_at = ? WHERE token = ?')
        .bind(new Date(Date.now() - 11 * 60 * 1000).toISOString(), token).run();
      await start(env, token);
      expect(sentTexts(spy).at(-1)!.text).toContain('устарела');
      await press(env, `lg:${token}`);
      expect((await testEnv.DB.prepare('SELECT confirmed_at FROM login_links WHERE token = ?').bind(token).first<{ confirmed_at: string | null }>())!.confirmed_at).toBeNull();
      expect((await claim(env, cookie)).status).toBe(410);
    } finally { spy.mockRestore(); }
  });
});
