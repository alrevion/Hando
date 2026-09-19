// Модель с действиями (brain.ts + act.ts): ответ модели подставной, проверяется
// всё остальное -- что уходит в запрос, как ответ превращается в дела, и что
// при негодном ответе фраза идёт старым путём.
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { botApp } from '../src/bot';
import { envWith, ORG_A } from './fixture';
import type { Env } from '../src/types';

let spy: { mockRestore(): void } | null = null;
afterEach(() => { spy?.mockRestore(); spy = null; });

const W0 = { kind: 'none', amount: null, unit: 'none', weekday: null, day: null, month: null, time: null, part: 'none' };
const R0 = { every: 'none', n: null, weekday: null, day: null, time: null, part: 'none' };
const create = (o: object) => ({ type: 'create', title: '', description: null, assignees: [], announcement: false, checklist: [], when: W0, repeat: R0, ...o });
const onTask = (o: object) => ({ type: 'task', task: 't1', op: 'done', when: W0, priority: 'none', title: null, after: 'none', ...o });

type Body = { messages: { role: string; content: string }[]; response_format?: { type: string; json_schema?: { strict: boolean; schema: unknown } } };
/** Ссылка задачи по её теме -- порядок задач в подсказке зависит от времени правки. */
const ref = (b: Body, title: string) => new RegExp(`(t\\d+) = «${title}»`).exec(b.messages[0].content)?.[1];

/** fetch: модель действий отвечает `brain`, прочие вызовы модели -- 500, Telegram -- ок. */
function mock(brain: (b: Body) => unknown) {
  const calls: Body[] = [];
  const sent: { text: string; reply_markup?: { inline_keyboard?: { callback_data?: string }[][] } }[] = [];
  spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes('groq')) {
      const b = JSON.parse(String(init?.body)) as Body;
      if (b.response_format?.type !== 'json_schema') return new Response('no', { status: 500 });
      calls.push(b);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(brain(b)) } }] }));
    }
    if (url.includes('/sendMessage')) sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
  return { calls, sent };
}

const world = async (): Promise<Env> => {
  const env = await envWith({
    users: [{ id: 'me', name: 'Яков', role: 'creator' }, { id: 'aziz', name: 'Азиз Каримов', role: 'member' }],
    memberships: [{ project_id: 'p1', user_id: 'me' }, { project_id: 'p1', user_id: 'aziz' }],
    projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'me' }],
    tasks: [
      { id: 'own', project_id: 'p1', title: 'Посмотреть оформление', status: 'in_progress', responsible_user_id: 'me', author_id: 'me' },
      { id: 'report', project_id: 'p1', title: 'Подготовить отчёт', status: 'todo', responsible_user_id: 'aziz', author_id: 'me' },
    ],
  });
  return { ...env, GROQ_API_KEY: 'k', BRAIN: '1' } as Env;
};
const say = (env: Env, text: string) => botApp.request('/webhook', {
  method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: { chat: { id: 'tg-me', type: 'private' }, from: { id: 'tg-me', first_name: 'Я' }, text } }),
}, env);

describe('модель с действиями', () => {
  it('создание: строгая схема, люди перечислением, сроки считает код', async () => {
    const env = await world();
    const m = mock((b) => {
      expect(b.response_format?.json_schema?.strict).toBe(true);
      expect(JSON.stringify(b.response_format?.json_schema?.schema)).toContain('"enum":["me","p1"]');
      expect(b.messages[0].content).toContain('p1 = Азиз Каримов');
      return {
        actions: [
          create({ title: 'проверить оформление', when: { ...W0, kind: 'in', amount: 2, unit: 'minutes' } }),
          create({ title: 'Пить таблетку', assignees: ['p1'], repeat: { ...R0, every: 'day', time: '09:00' } }),
        ],
        clarify: null,
      };
    });
    const before = Date.now();
    await say(env, 'напомни через 2 минуты проверить оформление, а Азизу каждый день в 9 пить таблетку');
    expect(m.calls).toHaveLength(1);
    const { results } = await testEnv.DB.prepare('SELECT title, deadline, repeat_min, assignee_ids, source FROM drafts ORDER BY created_at, rowid')
      .all<{ title: string; deadline: string; repeat_min: number | null; assignee_ids: string; source: string }>();
    expect(results.map((r) => r.title)).toEqual(['Проверить оформление', 'Пить таблетку']);
    expect(Math.abs(Date.parse(results[0].deadline) - (before + 2 * 60_000))).toBeLessThan(10_000);
    expect(JSON.parse(results[0].assignee_ids)).toEqual(['me']);
    // Повтор без срока не напоминал бы ни разу: первый срок ставится сам.
    expect(results[1].repeat_min).toBe(1440);
    expect(results[1].deadline).not.toBeNull();
    expect(JSON.parse(results[1].assignee_ids)).toEqual(['aziz']);
    expect(results[0].source).toBe('llm');
  });

  it('своя задача закрывается словами, которых правила не знают', async () => {
    const env = await world();
    const m = mock((b) => ({ actions: [onTask({ task: ref(b, 'Посмотреть оформление'), op: 'done' })], clarify: null }));
    await say(env, 'с оформлением покончено');
    const t = await testEnv.DB.prepare("SELECT status, confirmed_at FROM tasks WHERE id = 'own'").first<{ status: string; confirmed_at: string | null }>();
    expect(t?.status).toBe('done');
    expect(t?.confirmed_at).not.toBeNull();
    expect(m.sent.map((s) => s.text)).toContain('✅ «Посмотреть оформление» выполнена.');
  });

  it('отмену задачи модель только предлагает: нужна кнопка', async () => {
    const env = await world();
    const m = mock((b) => ({ actions: [onTask({ task: ref(b, 'Подготовить отчёт'), op: 'delete' })], clarify: null }));
    await say(env, 'убери отчёт Азиза');
    const t = await testEnv.DB.prepare("SELECT status FROM tasks WHERE id = 'report'").first<{ status: string }>();
    expect(t?.status).not.toBe('archived');
    const card = m.sent.find((s) => s.text.startsWith('Отменить «Подготовить отчёт»'));
    expect(card?.reply_markup?.inline_keyboard?.[0].map((b) => b.callback_data)).toEqual(['cancel:report', 'keep:report']);
  });

  it('негодный ответ -- один повтор с ошибкой, потом старый путь правил', async () => {
    const env = await world();
    const m = mock(() => ({ actions: [onTask({ task: 't9', op: 'done' })], clarify: null }));
    await say(env, 'купить хлеб завтра');
    expect(m.calls).toHaveLength(2);
    expect(m.calls[1].messages.at(-1)?.content).toContain('unknown task ref');
    // Ничего не сделано моделью, а черновик завели правила.
    const d = await testEnv.DB.prepare('SELECT title, source FROM drafts').first<{ title: string; source: string }>();
    expect(d?.title).toContain('Купить хлеб');
    expect(d?.source).not.toBe('llm');
  });

  it('уточнение уходит человеку, а его ответ модель видит вместе с вопросом', async () => {
    const env = await world();
    const m = mock((b) => (b.messages.length === 2
      ? { actions: [], clarify: 'Какую задачу перенести?' }
      : { actions: [onTask({ task: ref(b, 'Подготовить отчёт'), op: 'reschedule', when: { ...W0, kind: 'tomorrow' } })], clarify: null }));
    await say(env, 'перенеси на завтра');
    expect(m.sent.map((s) => s.text)).toContain('Какую задачу перенести?');
    await say(env, 'отчёт');
    expect(m.calls[1].messages.map((x) => x.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(m.calls[1].messages[2].content).toBe('Какую задачу перенести?');
    const t = await testEnv.DB.prepare("SELECT deadline FROM tasks WHERE id = 'report' AND org_id = ?").bind(ORG_A).first<{ deadline: string | null }>();
    expect(t?.deadline).not.toBeNull();
  });
});
