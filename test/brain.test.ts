// Модель с действиями (brain.ts + act.ts): ответ модели подставной, проверяется
// всё остальное -- что уходит в запрос, как ответ превращается в дела, и что
// при негодном ответе фраза идёт старым путём.
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { botApp } from '../src/bot';
import { resolve, type BrainCtx } from '../src/brain';
import { envWith, ORG_A } from './fixture';
import type { Env } from '../src/types';

let spy: { mockRestore(): void } | null = null;
afterEach(() => { spy?.mockRestore(); spy = null; });

const W0 = { kind: 'none', amount: null, unit: 'none', weekday: null, day: null, month: null, time: null, part: 'none' };
const R0 = { every: 'none', n: null, weekday: null, day: null, time: null, part: 'none' };
const create = (o: object) => ({ type: 'create', title: '', description: null, assignees: [], announcement: false, priority: 'none', checklist: [], when: W0, repeat: R0, ...o });
const onTask = (o: object) => ({ type: 'task', task: 't1', op: 'done', when: W0, priority: 'none', title: null, after: 'none', reason: null, ...o });

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
    // Сделано -- вопрос закрыт: третья фраза уходит модели без него.
    await say(env, 'спасибо');
    expect(m.calls[2].messages.map((x) => x.role)).toEqual(['system', 'user']);
  });

  it('несколько действий: причина и важность -- свои у каждого, а не вся фраза', async () => {
    const env = await world();
    await testEnv.DB.prepare("UPDATE task_assignees SET state = 'accepted' WHERE task_id = 'own'").run();
    const m = mock((b) => ({
      actions: [
        onTask({ task: ref(b, 'Посмотреть оформление'), op: 'late', reason: 'жду макеты' }),
        create({ title: 'Купить лекарства', priority: 'none' }),
      ],
      clarify: null,
    }));
    await say(env, 'срочно купить лекарства, а с оформлением не успеваю, жду макеты');
    expect(m.calls).toHaveLength(1);
    const ev = await testEnv.DB.prepare("SELECT comment FROM events WHERE action = 'late'")
      .first<{ comment: string }>();
    expect(ev?.comment).toBe('жду макеты');
    const d = await testEnv.DB.prepare('SELECT priority, priority_explicit FROM drafts').first<{ priority: string; priority_explicit: number }>();
    expect(d).toEqual({ priority: 'medium', priority_explicit: 0 });
  });

  it('тёзки -- переспрос старым путём, модель не выбирает сама', async () => {
    const env = await world();
    await testEnv.DB.prepare("INSERT INTO users (id, name, telegram_user_id, current_org_id, onboarded_at) VALUES ('aziz2', 'Азиз Рахимов', 'tg-aziz2', ?, datetime('now'))").bind(ORG_A).run();
    await testEnv.DB.prepare("INSERT INTO org_memberships (id, org_id, user_id, role, confirmed_at) VALUES ('m-aziz2', ?, 'aziz2', 'member', datetime('now'))").bind(ORG_A).run();
    const m = mock(() => ({ actions: [], clarify: 'не должно дойти' }));
    await say(env, 'Азизу купить бумагу');
    expect(m.calls).toHaveLength(0);
    expect(m.sent.some((s) => s.text.startsWith('Кого именно'))).toBe(true);
  });

  it('роль сверяется до исполнения: «сдал» по чужому поручению -- ошибка для повтора', () => {
    const ctx = {
      now: new Date(), sched: { timezone: 'Asia/Tashkent', always_on: 0, work_days: '1,2,3,4,5', work_end: '18:00', lunch_start: null, quiet_from: '22:00', quiet_to: '08:00' },
      me: { id: 'me', name: 'Я' }, people: [], drafts: [], history: [],
      tasks: [{ id: 'report', title: 'Отчёт', author: true, mine: null, status: 'not started', due: null, who: 'Азиз', last: false }],
    } as BrainCtx;
    expect(resolve({ actions: [onTask({ op: 'done' })], clarify: null }, ctx)).toContain('not an assignee');
    expect(typeof resolve({ actions: [onTask({ op: 'remind' })], clarify: null }, ctx)).toBe('object');
    ctx.tasks[0] = { ...ctx.tasks[0], author: false, mine: 'accepted' };
    expect(resolve({ actions: [onTask({ op: 'reschedule', when: { ...W0, kind: 'tomorrow' } })], clarify: null }, ctx)).toContain('not the author');
  });
});
