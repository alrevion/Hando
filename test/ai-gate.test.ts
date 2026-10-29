// Нейросети -- только тем, у кого users.ai_enabled = 1 (миграция 0037).
import { env as testEnv } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { apiRoutes } from '../src/routes';
import { botApp } from '../src/bot';
import type { Env } from '../src/types';
import { aiEnv } from '../src/ai';
import { cookie, envWith } from './fixture';

describe('ai gate', () => {
  it('keeps the Groq key only for users with ai_enabled', async () => {
    const env = { ...(await envWith({ users: [{ id: 'on', name: 'On', role: 'admin' }, { id: 'off', name: 'Off', role: 'admin', ai_enabled: 0 }], memberships: [], tasks: [] })), GROQ_API_KEY: 'k' };

    expect((await aiEnv(env, 'id', 'on')).GROQ_API_KEY).toBe('k');
    expect((await aiEnv(env, 'telegram_user_id', 'tg-on')).GROQ_API_KEY).toBe('k');
    expect((await aiEnv(env, 'id', 'off')).GROQ_API_KEY).toBe('');
    expect((await aiEnv(env, 'telegram_user_id', 'tg-off')).GROQ_API_KEY).toBe('');
    expect((await aiEnv(env, 'telegram_user_id', 'stranger')).GROQ_API_KEY).toBe('');
    expect((await aiEnv(env, 'id', null)).GROQ_API_KEY).toBe('');
  });

  it('new users start without AI', async () => {
    await envWith({ users: [], memberships: [], tasks: [] });
    await testEnv.DB.prepare("INSERT INTO users (id, name) VALUES ('fresh', 'Fresh')").run();
    const row = await testEnv.DB.prepare("SELECT ai_enabled FROM users WHERE id = 'fresh'").first<{ ai_enabled: number }>();
    expect(row?.ai_enabled).toBe(0);
  });

  it('the web API never calls Groq for a user without AI', async () => {
    const env = { ...(await envWith({ users: [{ id: 'on', name: 'On', role: 'admin' }, { id: 'off', name: 'Off', role: 'admin', ai_enabled: 0 }], memberships: [], tasks: [] })), GROQ_API_KEY: 'k' };
    const groqCalls = async (user: string) => {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
      await apiRoutes.request('/ask', {
        method: 'POST', headers: { Cookie: await cookie(user, 'admin'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Сколько задач у команды и что горит сильнее всего?' }),
      }, env);
      const n = spy.mock.calls.filter(([u]) => String(u instanceof Request ? u.url : u).includes('api.groq.com')).length;
      spy.mockRestore();
      return n;
    };
    expect(await groqCalls('off')).toBe(0);
    expect(await groqCalls('on')).toBeGreaterThan(0);
  });

  it('the bot never calls Groq for a sender without AI', async () => {
    const env = { ...(await envWith({ users: [{ id: 'on', name: 'On', role: 'creator' }, { id: 'off', name: 'Off', role: 'creator', ai_enabled: 0 }], memberships: [], tasks: [] })), GROQ_API_KEY: 'k', BRAIN: '1' } as Env;
    const groqCalls = async (user: string) => {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
      await botApp.request('/webhook', {
        method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { chat: { id: `tg-${user}`, type: 'private' }, from: { id: `tg-${user}`, first_name: 'X' }, text: 'Напомни завтра в десять позвонить в банк насчёт кредита' } }),
      }, env);
      const n = spy.mock.calls.filter(([u]) => String(u instanceof Request ? u.url : u).includes('api.groq.com')).length;
      spy.mockRestore();
      return n;
    };
    expect(await groqCalls('off')).toBe(0);
    expect(await groqCalls('on')).toBeGreaterThan(0);
  });
});
