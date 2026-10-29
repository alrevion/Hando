// Hando закрыт (HANDO_CLOSED = '1'): только люди с users.allowed = 1.
import { env as testEnv } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { allowed } from '../src/access';
import { botApp } from '../src/bot';
import { apiRoutes } from '../src/routes';
import type { Env } from '../src/types';
import { cookie, envWith } from './fixture';

const closedWorld = async (): Promise<Env> => ({
  ...(await envWith({ users: [{ id: 'on', name: 'On', role: 'creator' }, { id: 'off', name: 'Off', role: 'creator', allowed: 0 }], memberships: [], tasks: [] })),
  GROQ_API_KEY: 'k', BRAIN: '1', HANDO_CLOSED: '1',
} as Env);

const fetches = async (run: () => unknown) => {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true,"result":{"message_id":1}}'));
  await run();
  const urls = spy.mock.calls.map(([u]) => String(u instanceof Request ? u.url : u));
  const bodies = spy.mock.calls.map(([, i]) => String((i as RequestInit | undefined)?.body ?? ''));
  spy.mockRestore();
  return { groq: urls.filter((u) => u.includes('api.groq.com')).length, bodies };
};

const say = (env: Env, tg: string, text: string) => botApp.request('/webhook', {
  method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: { chat: { id: tg, type: 'private' }, from: { id: tg, first_name: 'X' }, text } }),
}, env);

describe('Hando closed', () => {
  it('only allowed users pass; open mode lets everyone through', async () => {
    const env = await closedWorld();
    expect(await allowed(env, 'id', 'on')).toBe(true);
    expect(await allowed(env, 'telegram_user_id', 'tg-on')).toBe(true);
    expect(await allowed(env, 'id', 'off')).toBe(false);
    expect(await allowed(env, 'telegram_user_id', 'stranger')).toBe(false);
    expect(await allowed(env, 'id', null)).toBe(false);
    expect(await allowed({ ...env, HANDO_CLOSED: undefined }, 'id', 'off')).toBe(true);
  });

  it('a stranger in the bot gets one line, no account, no AI', async () => {
    const env = await closedWorld();
    const { groq, bodies } = await fetches(() => say(env, 'tg-stranger', 'Напомни завтра в десять позвонить в банк'));
    expect(groq).toBe(0);
    expect(bodies.some((b) => b.includes('закрыт'))).toBe(true);
    const row = await testEnv.DB.prepare("SELECT id FROM users WHERE telegram_user_id = 'tg-stranger'").first();
    expect(row).toBeNull();
  });

  it('a user without access is not served by the bot; an allowed one is', async () => {
    const env = await closedWorld();
    const text = 'Напомни завтра в десять позвонить в банк насчёт кредита';
    expect((await fetches(() => say(env, 'tg-off', text))).groq).toBe(0);
    expect((await fetches(() => say(env, 'tg-on', text))).groq).toBeGreaterThan(0);
  });

  it('the web API answers 403 to a user without access', async () => {
    const env = await closedWorld();
    const off = await apiRoutes.request('/me', { headers: { Cookie: await cookie('off', 'creator') } }, env);
    const on = await apiRoutes.request('/me', { headers: { Cookie: await cookie('on', 'creator') } }, env);
    expect(off.status).toBe(403);
    expect(on.status).toBe(200);
  });

  it('new rows start without access', async () => {
    await envWith({ users: [], memberships: [], tasks: [] });
    await testEnv.DB.prepare("INSERT INTO users (id, name) VALUES ('fresh', 'Fresh')").run();
    expect((await testEnv.DB.prepare("SELECT allowed FROM users WHERE id = 'fresh'").first<{ allowed: number }>())?.allowed).toBe(0);
  });
});
