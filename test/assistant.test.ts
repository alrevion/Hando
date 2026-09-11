// Помощник «Вопрос» -- шаг 6 (раздел 23) -- и тезисы /start -- шаг 7.
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { botApp } from '../src/bot';
import { apiRoutes } from '../src/routes';
import { BTN } from '../src/menu';
import { askAssistant, plain } from '../src/assistant';
import { cookie, envWith, ORG_A, stubTelegram } from './fixture';
import type { Env } from '../src/types';

let restore: { mockRestore(): void } | null = null;
afterEach(() => { restore?.mockRestore(); restore = null; });
const tg = () => (restore = stubTelegram()) as ReturnType<typeof stubTelegram>;
const sent = (spy: { mock: { calls: unknown[] } }) =>
  (spy.mock.calls as unknown as [string, { body?: string }][])
    .filter(([u]) => u.includes('/sendMessage')).map(([, i]) => JSON.parse(String(i.body)) as { chat_id: string; text: string; reply_markup?: { inline_keyboard?: { text: string; web_app?: { url: string } }[][] } });

const world = () => envWith({
  users: [{ id: 'boss', phone: '+1', name: 'Директор', role: 'creator' }, { id: 'w1', phone: '+2', name: 'Азиз', role: 'member' }],
  memberships: [{ project_id: 'p1', user_id: 'boss' }, { project_id: 'p1', user_id: 'w1' }],
  projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'boss' }],
  tasks: [
    { id: 't1', project_id: 'p1', title: 'Сдать отчёт', status: 'todo', responsible_user_id: 'w1', author_id: 'boss', deadline: '2026-09-12T10:00:00.000Z', priority: 'urgent' },
    { id: 't2', project_id: 'p1', title: 'Купить бумагу', status: 'todo', responsible_user_id: 'w1', author_id: 'boss' },
  ],
});
const hook = (env: Env, update: unknown) =>
  botApp.request('/webhook', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'Content-Type': 'application/json' }, body: JSON.stringify(update) }, env);
const say = (env: Env, tgId: string, text: string) =>
  hook(env, { message: { chat: { id: tgId, type: 'private' }, from: { id: tgId, first_name: 'Ч' }, text } });

describe('помощник', () => {
  it('markdown из ответа модели снимается: Telegram показал бы звёздочки как есть', () => {
    expect(plain('В приложении:\n- **Поручения** — что ты поручил.\n- **Задачи** — что поручили тебе.\n## Напоминания\nКод `dc`.'))
      .toBe('В приложении:\n• Поручения — что ты поручил.\n• Задачи — что поручили тебе.\nНапоминания\nКод dc.');
    expect(plain('2 * 3 = 6')).toBe('2 * 3 = 6');
  });

  it('без модели: «за что взяться» -- порядок по сроку и важности, с уточнением', async () => {
    const env = await world();
    const a = await askAssistant(env, { userId: 'w1', orgId: ORG_A, role: 'member', name: 'Азиз' }, 'за что взяться сначала?');
    expect(a).toContain('1. «Сдать отчёт»');
    expect(a).toContain('высокая');
    expect(a).toContain('2. «Купить бумагу»');
    expect(a).toContain('Сколько времени займёт');
    const how = await askAssistant(env, { userId: 'w1', orgId: ORG_A, role: 'member', name: 'Азиз' }, 'как отметить выполненную?');
    expect(how).toContain('«Готово»');
  });

  it('с моделью: задачи человека и история уходят в запрос, ответ возвращается', async () => {
    const env = { ...(await world()), GROQ_API_KEY: 'k' };
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('groq')) {
        const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
        expect(body.messages[0].content).toContain('«Сдать отчёт»');
        expect(body.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Начните с отчёта: срок в субботу.' } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });
    restore = spy;
    const a = await askAssistant(env, { userId: 'w1', orgId: ORG_A, role: 'member', name: 'Азиз' }, 'а что первое?', [{ role: 'user', text: 'что у меня?' }, { role: 'assistant', text: 'Две задачи.' }]);
    expect(a).toBe('Начните с отчёта: срок в субботу.');
  });

  it('бот: «Вопрос» открывает диалог, фраза -- вопрос, а не поручение; «Назад» выходит', async () => {
    const env = await world();
    const spy = tg();
    await say(env, 'tg-w1', BTN.ask);
    await say(env, 'tg-w1', 'за что взяться?');
    expect(sent(spy).at(-1)!.text).toContain('1. «Сдать отчёт»');
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n).toBe(0);
    const st = await testEnv.DB.prepare("SELECT bot_state FROM users WHERE id='w1'").first<{ bot_state: string }>();
    expect(JSON.parse(st!.bot_state).ask).toHaveLength(2);
    await say(env, 'tg-w1', BTN.back);
    await say(env, 'tg-w1', 'Азизу купить скрепки');
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n).toBe(1);
  });

  it('API: POST /ask отвечает по своим задачам', async () => {
    const env = await world();
    const res = await apiRoutes.request('/ask', { method: 'POST', headers: { Cookie: await cookie('w1', 'member', ORG_A), 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'за что взяться?', history: [] }) }, env);
    expect(res.status).toBe(200);
    expect((await res.json<{ answer: string }>()).answer).toContain('«Сдать отчёт»');
  });
});

describe('обучение: /start', () => {
  it('тезисы с кнопкой «Открыть приложение», и /help -- то же', async () => {
    const env = await world();
    const spy = tg();
    await say(env, 'tg-boss', '/start');
    const tips = sent(spy).find((m) => m.text.startsWith('Что умеет Hando'))!;
    expect(tips.text).toContain('черновик');
    expect(tips.reply_markup!.inline_keyboard![0][0].web_app!.url).toBe('https://hando.alrevion.com/');
    await say(env, 'tg-boss', '/help');
    expect(sent(spy).filter((m) => m.text.startsWith('Что умеет Hando'))).toHaveLength(2);
  });
});
