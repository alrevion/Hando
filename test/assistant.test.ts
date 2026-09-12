// Помощник -- шаг 6 (раздел 23) -- и тезисы /start -- шаг 7. Кнопки «Вопрос»
// нет: бот сам решает по смыслу фразы, вопрос это, просьба или поручение.
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { botApp } from '../src/bot';
import { apiRoutes } from '../src/routes';
import { askAssistant, classifyIntent, plain } from '../src/assistant';
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
    // Не «нажмите Готово»: такой кнопки в приложении больше нет -- есть круглая
    // стрелка и та же команда словами.
    expect(how).toContain('уйдёт на проверку');
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

  it('«удали …» -- удаляет своё поручение сам, чужое -- нет', async () => {
    const env = await world();
    tg();
    // w1 -- адресат, не автор: удалить не вправе.
    const no = await askAssistant(env, { userId: 'w1', orgId: ORG_A, role: 'member', name: 'Азиз' }, 'удали купить бумагу');
    expect(no).toContain('Что именно удалить');
    expect((await testEnv.DB.prepare("SELECT status FROM tasks WHERE id='t2'").first<{ status: string }>())!.status).toBe('todo');
    // boss -- автор: удаляет.
    const yes = await askAssistant(env, { userId: 'boss', orgId: ORG_A, role: 'creator', name: 'Директор' }, 'удали задачу купить бумагу');
    expect(yes).toContain('Удалено: «Купить бумагу»');
    expect((await testEnv.DB.prepare("SELECT status FROM tasks WHERE id='t2'").first<{ status: string }>())!.status).toBe('archived');
  });

  it('с моделью: JSON с delete -- удаляется только разрешённое, reply без markdown', async () => {
    const env = { ...(await world()), GROQ_API_KEY: 'k' };
    restore = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('groq')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: 'Готово, **убрал** дубль.', delete: ['t2', 'nope'] }) } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });
    const a = await askAssistant(env, { userId: 'boss', orgId: ORG_A, role: 'creator', name: 'Директор' }, 'удали дубль', []);
    expect(a).toBe('Готово, убрал дубль.\n\nУдалено: «Купить бумагу».');
    expect((await testEnv.DB.prepare("SELECT status FROM tasks WHERE id='t2'").first<{ status: string }>())!.status).toBe('archived');
  });

  it('бот сам отличает вопрос от поручения -- без всяких кнопок', async () => {
    const env = await world();
    const spy = tg();
    // Вопрос: отвечаем и НЕ заводим черновик.
    await say(env, 'tg-w1', 'за что взяться?');
    const answer = sent(spy).at(-1)!;
    expect(answer.text).toContain('1. «Сдать отчёт»');
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n).toBe(0);
    // Под ответом -- выход на случай промаха разбора.
    expect(answer.reply_markup!.inline_keyboard![0][0].text).toBe('📌 Это поручение');
    const st = await testEnv.DB.prepare("SELECT bot_state FROM users WHERE id='w1'").first<{ bot_state: string }>();
    expect(JSON.parse(st!.bot_state).ask).toHaveLength(2);

    // Поручение сразу после вопроса: режима выходить не надо, черновик заводится.
    await say(env, 'tg-w1', 'Азизу купить скрепки');
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n).toBe(1);
  });

  it('без модели отвечает разделом по теме, а не всем руководством', async () => {
    const env = await world();
    const me = { userId: 'w1', orgId: ORG_A, role: 'member' as const, name: 'Азиз' };
    const files = await askAssistant(env, me, 'как прикрепить фото к задаче?');
    expect(files).toContain('Прикрепить файл');
    expect(files).not.toContain('Календарь.');   // чужие разделы в ответ не лезут

    expect(await askAssistant(env, me, 'как отметить выполненную?')).toContain('уйдёт на проверку');
    expect(await askAssistant(env, me, 'кто видит мои задачи?')).toContain('Владелец видит всё');
    expect(await askAssistant(env, me, 'как пригласить сотрудника?')).toContain('ссылка-приглашение');
    expect(await askAssistant(env, me, 'куда делась выполненная задача?')).toContain('Архив');
    expect(await askAssistant(env, me, 'что если сотрудник ушёл в отпуск?')).toContain('заморажива');

    // Непонятный вопрос -- список тем, а не молчание и не стена текста.
    const unknown = await askAssistant(env, me, 'а что вообще умеет эта штука?');
    expect(unknown).toContain('Могу рассказать про это');
  });

  it('намерение: вопрос, просьба к боту и поручение -- врозь', async () => {
    const env = await world();
    // Просьба к боту: кириллическая граница слова, на которой ломался \\b.
    expect(await classifyIntent(env, 'напомни про отчёт', false)).toBe('ask');
    expect(await classifyIntent(env, 'Удали задачу про бумагу', false)).toBe('ask');
    expect(await classifyIntent(env, 'как отметить выполненную', false)).toBe('ask');
    expect(await classifyIntent(env, 'что у меня на сегодня', false)).toBe('ask');
    expect(await classifyIntent(env, 'успею до пятницы?', false)).toBe('ask');
    // Поручения: имя названо -- вопросительный знак не в счёт.
    expect(await classifyIntent(env, 'Азизу подготовить отчёт?', true)).toBe('task');
    expect(await classifyIntent(env, 'купить бумагу до пятницы', false)).toBe('task');
    // «Напоминание» -- не «напомни»: слово длиннее, и это поручение.
    expect(await classifyIntent(env, 'Напоминание сделать отчёт', false)).toBe('task');
  });

  it('состояние старого режима «Вопрос» не превращает фразу в код вступления', async () => {
    const env = await world();
    const spy = tg();
    await testEnv.DB.prepare("UPDATE users SET bot_state = ? WHERE id='w1'").bind(JSON.stringify({ screen: 'main', await: 'ask', ask: [] })).run();
    await say(env, 'tg-w1', 'Азизу купить скрепки');
    expect(sent(spy).at(-1)!.text).toContain('Черновик');
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n).toBe(1);
  });

  it('спорную фразу разбирает модель -- и её ответ уважается', async () => {
    const env = { ...(await world()), GROQ_API_KEY: 'k' };
    const seen: string[] = [];
    restore = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const body = String((init as { body?: string })?.body ?? '');
      if (String(input).includes('groq')) {
        seen.push(body);
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"intent":"ask"}' } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });
    // Ни вопросительного слова, ни «?», ни имени -- решает модель.
    expect(await classifyIntent(env as Env, 'там с бумагой непонятно вышло', false)).toBe('ask');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('там с бумагой непонятно вышло');
    // Имя названо -- модель не спрашиваем вовсе: лишний запрос на каждое поручение.
    expect(await classifyIntent(env as Env, 'Азизу купить бумагу', true)).toBe('task');
    expect(seen).toHaveLength(1);
  });

  it('память ответов: тот же по смыслу вопрос отдаётся без модели, личное не запоминается', async () => {
    // Эмбеддер подделан: два «похожих» вопроса дают близкие векторы, третий -- далёкий.
    const vecs: Record<string, number[]> = {
      'как отметить выполненную?': [1, 0, 0],
      'где нажать что задача готова': [0.97, 0.24, 0],
      'за что взяться сначала?': [0, 1, 0],
    };
    const env = { ...(await world()), GROQ_API_KEY: 'k', EMBED_URL: 'http://embed.local', EMBED_TOKEN: 't' };
    let llm = 0;
    restore = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String((init as { body?: string })?.body ?? '{}')) as { texts?: string[] };
      if (url.includes('embed.local')) {
        const v = vecs[body.texts![0]] ?? [0, 0, 1];
        return new Response(JSON.stringify({ model: 'mini', dim: 3, vectors: [v] }), { status: 200 });
      }
      if (url.includes('groq')) {
        llm += 1;
        const personal = llm > 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(personal
          ? { reply: 'Начните со «Сдать отчёт».', general: false }
          : { reply: 'Откройте Задачи и нажмите «Готово».', general: true }) } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });
    const me = { userId: 'w1', orgId: ORG_A, role: 'member' as const, name: 'Азиз' };

    // Первый раз -- модель, ответ общий, значит запоминается.
    expect(await askAssistant(env, me, 'как отметить выполненную?')).toContain('«Готово»');
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM answer_cache').first<{ n: number }>())!.n).toBe(1);

    // Другими словами про то же -- из памяти, модель не тревожим.
    expect(await askAssistant(env, me, 'где нажать что задача готова')).toContain('«Готово»');
    expect(llm).toBe(1);
    expect((await testEnv.DB.prepare('SELECT hits FROM answer_cache').first<{ hits: number }>())!.hits).toBe(1);

    // Далёкий вопрос -- снова модель; ответ личный, в общую память не идёт.
    expect(await askAssistant(env, me, 'за что взяться сначала?')).toContain('Сдать отчёт');
    expect(llm).toBe(2);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM answer_cache').first<{ n: number }>())!.n).toBe(1);
  });

  it('вчерашний разговор не считается контекстом: через двадцать минут вопрос новый', async () => {
    const env = await world();
    const spy = tg();
    // Реплики есть, но они старые -- значит история не подхватывается.
    await testEnv.DB.prepare("UPDATE users SET bot_state = ? WHERE id='w1'").bind(JSON.stringify({
      screen: 'main',
      ask: [{ role: 'user', text: 'вчерашний вопрос' }, { role: 'assistant', text: 'вчерашний ответ' }],
      askAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    })).run();
    await say(env, 'tg-w1', 'за что взяться?');
    const st = JSON.parse((await testEnv.DB.prepare("SELECT bot_state FROM users WHERE id='w1'").first<{ bot_state: string }>())!.bot_state) as { ask: unknown[] };
    // Вчерашняя пара выброшена, осталась только сегодняшняя.
    expect(st.ask).toHaveLength(2);
    expect(sent(spy).at(-1)!.text).toContain('Сдать отчёт');
  });

  it('эмбеддер недоступен -- помощник отвечает как обычно', async () => {
    const env = { ...(await world()), GROQ_API_KEY: 'k', EMBED_URL: 'http://embed.local' };
    restore = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('embed.local')) throw new Error('сервер лежит');
      if (url.includes('groq')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: 'Ответ модели.', general: true }) } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });
    expect(await askAssistant(env, { userId: 'w1', orgId: ORG_A, role: 'member', name: 'Азиз' }, 'как удалить организацию?')).toBe('Ответ модели.');
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM answer_cache').first<{ n: number }>())!.n).toBe(0);
  });

  it('память намерения: та же фраза второй раз до модели не доходит', async () => {
    const env = { ...(await world()), GROQ_API_KEY: 'k' };
    let calls = 0;
    restore = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('groq')) {
        calls += 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"intent":"ask"}' } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });
    expect(await classifyIntent(env as Env, 'там с бумагой непонятно вышло', false)).toBe('ask');
    // Второй раз -- из памяти: регистр, пунктуация и «ё» на отпечаток не влияют.
    expect(await classifyIntent(env as Env, 'Там с бумагой непонятно вышло!', false)).toBe('ask');
    expect(calls).toBe(1);
    const row = await testEnv.DB.prepare('SELECT intent, hits FROM intent_cache').first<{ intent: string; hits: number }>();
    expect(row).toMatchObject({ intent: 'ask', hits: 1 });
    // В памяти лежит отпечаток, а не фраза: таблица общая на всех арендаторов.
    const { results } = await testEnv.DB.prepare('SELECT phrase FROM intent_cache').all<{ phrase: string }>();
    expect(results[0].phrase).toMatch(/^[0-9a-f]{32}$/);
  });

  it('«Это поручение» превращает ответ в черновик той же фразой', async () => {
    const env = await world();
    tg();
    await say(env, 'tg-w1', 'что сделать с отчётом для налоговой?');
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n).toBe(0);
    await hook(env, { callback_query: { id: 'c1', from: { id: 'tg-w1' }, data: 'as_task', message: { chat: { id: 'tg-w1', type: 'private' }, message_id: 7 } } });
    const row = await testEnv.DB.prepare('SELECT title, heard FROM drafts').first<{ title: string; heard: string }>();
    expect(row!.heard).toBe('что сделать с отчётом для налоговой?');
  });

  it('просьба к боту выполняется: «напомни …» толкает исполнителя', async () => {
    const env = await world();
    const spy = tg();
    await testEnv.DB.prepare("INSERT INTO reminders (assignee_row_id, kind, sent_at) SELECT id, 'not_accepted', '2026-09-11T06:00:00.000Z' FROM task_assignees WHERE task_id='t1'").run();
    await say(env, 'tg-boss', 'напомни про Сдать отчёт');
    expect(sent(spy).at(-1)!.text).toContain('Напомню исполнителям: «Сдать отчёт»');
    // Журнал очищен -- ближайший проход cron напомнит заново.
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reminders WHERE kind='not_accepted'").first<{ n: number }>())!.n).toBe(0);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n).toBe(0);
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
