// Помощник -- шаг 6 (раздел 23) -- и тезисы /start -- шаг 7. Кнопки «Вопрос»
// нет: бот сам решает по смыслу фразы, вопрос это, просьба или поручение.
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { botApp } from '../src/bot';
import { apiRoutes } from '../src/routes';
import { askAssistant, classifyIntent, plain } from '../src/assistant';
import { cookie, envWith, ORG_A, stubTelegram } from './fixture';
import { setState } from '../src/menu';
import type { Env } from '../src/types';

let restore: { mockRestore(): void } | null = null;
afterEach(() => { restore?.mockRestore(); restore = null; });
const tg = () => (restore = stubTelegram()) as ReturnType<typeof stubTelegram>;
const sent = (spy: { mock: { calls: unknown[] } }) =>
  (spy.mock.calls as unknown as [string, { body?: string }][])
    .filter(([u]) => u.includes('/sendMessage')).map(([, i]) => JSON.parse(String(i.body)) as { chat_id: string; text: string; reply_markup?: { inline_keyboard?: { text: string; web_app?: { url: string } }[][] } });

const world = () => envWith({
  users: [{ id: 'boss', name: 'Директор', role: 'creator' }, { id: 'w1', name: 'Азиз', role: 'member' }],
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

  it('«напомни мне завтра в 10, что…» -- черновик себе со сроком, а не «ок, напомню»', async () => {
    // Живая фраза из продакшена. Раньше её забирал TO_BOT по первому слову,
    // помощник отвечал «Ок, напомню завтра в 10:00» -- и не заводил ничего.
    const env = await world();
    const spy = tg();
    await say(env, 'tg-boss', 'Напомни мне завтра в 10, что нужно замерить окна для того, чтобы съездить на джами и купить москитные сетки или сделать их и купить материалы.');
    const row = await testEnv.DB.prepare('SELECT assignee_ids, deadline, title FROM drafts').first<{ assignee_ids: string; deadline: string; title: string }>();
    // Без ключа модели тема не сокращается, но и «Что» в начале не остаётся.
    expect(row!.title).toMatch(/^Замерить окна/);
    expect(JSON.parse(row!.assignee_ids)).toEqual(['boss']);
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });
    expect(new Date(row!.deadline).toLocaleString('en-CA', { timeZone: 'Asia/Tashkent', hour12: false })).toBe(`${tomorrow}, 10:00:00`);
    expect(sent(spy).some((m) => m.text.includes('напомню'))).toBe(false);
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

describe('просьба к боту не рассыпается на полпути', () => {
  const drafts = async () =>
    (await testEnv.DB.prepare("SELECT title FROM drafts WHERE author_id = 'boss'").all<{ title: string }>()).results.map((r) => r.title);
  const tasks = async () =>
    (await testEnv.DB.prepare("SELECT title FROM tasks WHERE author_id = 'boss'").all<{ title: string }>()).results.map((r) => r.title);

  it('«удали все черновики» выполняется сразу, без переспроса', async () => {
    const env = await world();
    const spy = tg();
    // Два черновика: наговорены, но не подтверждены.
    await say(env, 'tg-boss', 'Азизу купить свёклу завтра');
    await say(env, 'tg-boss', 'Азизу полить цветы в пятницу');
    expect(await drafts()).toHaveLength(2);

    await say(env, 'tg-boss', 'удали все черновики');

    expect(await drafts()).toHaveLength(0);
    expect(sent(spy).at(-1)!.text).toContain('Удалил все черновики');
    // И ГЛАВНОЕ: просьба не превратилась в задачу «Удали все черновики».
    expect(await tasks()).not.toContain('Удали все черновики');
  });

  // Состояние ставим напрямую: какой именно вопрос задаст помощник, решает
  // модель, а правило проверяется одно -- «предыдущая реплика кончилась
  // вопросительным знаком».
  const botAsked = (env: Env, question: string) => setState(env, 'boss', {
    askAt: new Date().toISOString(),
    ask: [{ role: 'user' as const, text: 'удали черновик' }, { role: 'assistant' as const, text: question }],
  });

  it('ответ «все» на вопрос бота остаётся разговором, а не становится задачей', async () => {
    const env = await world();
    tg();
    await botAsked(env, 'Какой именно черновик удалить?');

    // Ровно то, на что жаловался владелец: «все» становилось задачей с темой «Все».
    const before = await drafts();
    await say(env, 'tg-boss', 'все');
    expect(await drafts()).toEqual(before);
  });

  it('названный человек сильнее вопроса: после переспроса «Азизу …» -- всё равно поручение', async () => {
    const env = await world();
    tg();
    await botAsked(env, 'Какой именно черновик удалить?');

    await say(env, 'tg-boss', 'Азизу сдать табель в понедельник');
    expect(await drafts()).toContain('Сдать табель');
  });

  it('«удали черновик» без уточнений сносит ПОСЛЕДНИЙ и называет его', async () => {
    const env = await world();
    const spy = tg();
    await say(env, 'tg-boss', 'Азизу купить свёклу завтра');
    await say(env, 'tg-boss', 'Азизу полить цветы в пятницу');

    await say(env, 'tg-boss', 'удали черновик');

    // Последним создан «Полить цветы» -- он и уходит; первый остаётся.
    expect(await drafts()).toEqual(['Купить свёклу']);
    const reply = sent(spy).at(-1)!.text;
    expect(reply).toContain('Полить цветы');
    expect(reply).toContain('Осталось ещё 1');
  });

  it('черновиков нет -- так и говорит, а не молчит и не заводит задачу', async () => {
    const env = await world();
    const spy = tg();
    await say(env, 'tg-boss', 'удали все черновики');
    expect(sent(spy).at(-1)!.text).toContain('Черновиков нет');
    expect(await drafts()).toHaveLength(0);
  });
});

describe('переспрос «кого именно?» не съедает фразу', () => {
  // Два Азиза: имени мало, нужна фамилия. Ровно тот случай, ради которого
  // переспрос и написан.
  const twoAziz = () => envWith({
    users: [
      { id: 'boss', name: 'Директор', role: 'creator' },
      { id: 'a1', name: 'Азиз Каримов', role: 'member' },
      { id: 'a2', name: 'Азиз Юсупов', role: 'member' },
    ],
    memberships: [{ project_id: 'p1', user_id: 'boss' }, { project_id: 'p1', user_id: 'a1' }, { project_id: 'p1', user_id: 'a2' }],
    projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'boss' }],
    tasks: [],
  });

  it('ответ фамилией достраивает ЗАПОМНЕННУЮ фразу, а не заводит черновик с темой «Каримов»', async () => {
    const env = await twoAziz();
    const spy = tg();
    await say(env, 'tg-boss', 'Азизу подготовить отчёт по кассе до пятницы');
    expect(sent(spy).at(-1)!.text).toContain('Кого именно');

    await say(env, 'tg-boss', 'Каримов');

    const rows = (await testEnv.DB.prepare("SELECT title, assignee_ids FROM drafts WHERE author_id = 'boss'")
      .all<{ title: string; assignee_ids: string }>()).results;
    expect(rows).toHaveLength(1);
    // Тема -- из ПЕРВОЙ фразы, адресат -- из ответа.
    expect(rows[0].title).toContain('отчёт');
    expect(rows[0].title).not.toBe('Каримов');
    expect(JSON.parse(rows[0].assignee_ids)).toEqual(['a1']);
  });
});

// ТАБЛИЦА НАМЕРЕНИЙ. Нужна потому, что «мои задачи» бот однажды завёл как
// задачу, и владелец справедливо сказал: таких случаев много, предусмотрите их
// заранее.
//
// Здесь проверяется ДЕТЕРМИНИРОВАННЫЙ слой -- тот, что решает без модели. Env
// намеренно без ключа: тогда всякое «ask» в таблице доказывает, что сработало
// правило, а всякое «task» -- что ни одно правило не сработало зря. Спорное
// по-прежнему уходит модели, и это не проверить таблицей.
describe('намерение фразы: что бот считает просьбой, а что поручением', () => {
  const CASES: [string, 'ask' | 'task', boolean][] = [
    // --- просьба показать своё: существительное без действия
    ['мои задачи', 'ask', false],
    ['мои поручения', 'ask', false],
    ['мои черновики', 'ask', false],
    ['у меня задачи', 'ask', false],
    ['задачи на сегодня', 'ask', false],
    ['мои задачи на завтра', 'ask', false],
    ['черновики', 'ask', false],

    // --- ЖИВАЯ РЕЧЬ. Распознавание услышало «какие» как «такие», и правило,
    // привязанное к первому слову, промахнулось -- бот завёл черновик «Такие
    // мои задачи». Первое слово во фразе с голоса ненадёжно всегда.
    ['такие мои задачи', 'ask', false],
    ['какие мои задачи', 'ask', false],
    ['ну мои задачи', 'ask', false],
    ['а мои черновики?', 'ask', false],
    ['покажи мои задачи', 'ask', false],
    // Вопрос ОБ УСТРОЙСТВЕ с теми же словами. Намерение то же ('ask'), но
    // ответ должен быть другой -- это стережёт тест «отвечает разделом по теме».
    ['кто видит мои задачи?', 'ask', false],
    // Голое существительное коротко -- список; длинная фраза без «мои» -- нет.
    // Сторожит ограничение по длине: в одной из редакций счётчик слов был сломан
    // двойным экранированием и всегда возвращал единицу.
    ['задачи по кассе', 'ask', false],
    ['задачи по кассе за прошлый месяц по регионам', 'task', false],
    // А это вопрос ОБ УСТРОЙСТВЕ с теми же словами -- и он не список.
    // Для намерения разницы нет (оба 'ask'), но ответ должен быть разный,
    // и это стережёт тест «без модели отвечает разделом по теме».
    ['кто видит мои задачи?', 'ask', false],

    // --- вопрос
    ['что у меня горит на этой неделе?', 'ask', false],
    ['как отметить выполненную?', 'ask', false],
    ['сколько у меня просрочено', 'ask', false],

    // --- просьба к боту
    ['удали все черновики', 'ask', false],
    ['напомни Азизу про отчёт', 'ask', true],
    ['напомни о смете', 'ask', false],
    ['напомни про подготовить отчёт', 'ask', false],

    // --- напоминание СЕБЕ: это дело со сроком, а не просьба толкнуть чужое
    ['напомни мне завтра в 10 замерить окна', 'task', false],
    ['напомните мне про встречу в пятницу', 'task', false],
    ['напомни завтра позвонить в банк', 'task', false],
    ['напомни в пятницу о том, что нужно оплатить интернет', 'task', false],
    ['покажи что сдано', 'ask', false],

    // --- поручение: есть действие
    ['купить бумагу до пятницы', 'task', false],
    ['подготовить отчёт по кассе', 'task', false],
    ['Азизу подготовить отчёт', 'task', true],
    ['полить цветы в пятницу', 'task', false],
    // Существительное «задачи» внутри поручения его не отменяет: есть глагол.
    ['задачи по кассе подготовить до пятницы', 'task', false],
    // Инфинитив -- признак действия, и он сильнее слова «мои».
    ['мои цветы поливать через день', 'task', false],
    ['подготовить мне справку', 'task', false],
  ];

  it('таблица разбирается без модели и без сети', async () => {
    // Ключа нет НАМЕРЕННО: всё, что не решили правила, вернётся как 'task'.
    const env = { ...testEnv, GROQ_API_KEY: '' } as unknown as Env;
    const wrong: string[] = [];
    for (const [phrase, want, named] of CASES) {
      const got = await classifyIntent(env, phrase, named);
      if (got !== want) wrong.push(`«${phrase}» -> ${got}, а ждали ${want}`);
    }
    expect(wrong).toEqual([]);
  });
});

// Живой случай: «Какие у меня сейчас есть черновики?» -- «Сейчас у вас нет
// черновиков», а кнопка «📝 Черновики» следом показала три. Модель видела
// задачи, но не черновики.
describe('черновики словами', () => {
  const withDraft = async () => {
    const env = await world();
    await testEnv.DB.prepare(
      `INSERT INTO drafts (id, org_id, author_id, title, assignee_ids, deadline, priority, priority_explicit, kind, heard, media, source, created_at, updated_at)
       VALUES ('d1', ?, 'boss', 'Съездить на Джами и забрать сетки', '["boss"]', NULL, 'medium', 0, 'single', 'сетки', '[]', 'pattern', ?, ?)`,
    ).bind(ORG_A, new Date().toISOString(), new Date().toISOString()).run();
    return env;
  };

  it('бот на «какие у меня черновики?» присылает карточки, как кнопка', async () => {
    const env = await withDraft();
    const spy = tg();
    await say(env, 'tg-boss', 'Какие у меня сейчас есть черновики?');
    const texts = sent(spy).filter((m) => m.chat_id === 'tg-boss').map((m) => m.text);
    expect(texts.some((t) => t.includes('Черновик') && t.includes('Съездить на Джами и забрать сетки'))).toBe(true);
    expect(texts.some((t) => /нет черновиков/i.test(t))).toBe(false);
  });

  it('помощник (экран «Вопрос») отвечает списком по данным, модели не спрашивая', async () => {
    const env = { ...(await withDraft()), GROQ_API_KEY: 'k' };
    const spy = vi.spyOn(globalThis, 'fetch');
    const a = await askAssistant(env, { userId: 'boss', orgId: ORG_A, role: 'creator', name: 'Директор' }, 'какие у меня черновики?');
    expect(a).toContain('«Съездить на Джами и забрать сетки»');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('на любой другой вопрос модель видит черновики в сведениях', async () => {
    const env = { ...(await withDraft()), GROQ_API_KEY: 'k' };
    let system = '';
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      system = (JSON.parse(String(init?.body)) as { messages: { content: string }[] }).messages[0].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"reply":"ок","general":false}' } }] }));
    });
    await askAssistant(env, { userId: 'boss', orgId: ORG_A, role: 'creator', name: 'Директор' }, 'с чего начать завтра?');
    spy.mockRestore();
    expect(system).toContain('ЧЕРНОВИКИ ЧЕЛОВЕКА');
    expect(system).toContain('«Съездить на Джами и забрать сетки»');
  });

  it('«удали все черновики» -- по-прежнему удаление, а не показ', async () => {
    const env = await withDraft();
    tg();
    await say(env, 'tg-boss', 'удали все черновики');
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n).toBe(0);
  });
});

// Аудит: «как удалить черновик?» УДАЛЯЛ черновик -- «удалить» содержит «удали».
// А «удали черновик про сетки» при нескольких удалял последний, а не про сетки.
describe('удаление черновиков: вопрос -- не команда, и не тот -- не удаляется', () => {
  const two = async () => {
    const env = await world();
    for (const [id, title, ago] of [['d1', 'Съездить на Джами и забрать сетки', 2], ['d2', 'Купить хлеб', 1]] as const) {
      await testEnv.DB.prepare(
        `INSERT INTO drafts (id, org_id, author_id, title, assignee_ids, deadline, priority, priority_explicit, kind, heard, media, source, created_at, updated_at)
         VALUES (?, ?, 'boss', ?, '["boss"]', NULL, 'medium', 0, 'single', ?, '[]', 'pattern', datetime('now', ?), datetime('now', ?))`,
      ).bind(id, ORG_A, title, title, `-${ago} hours`, `-${ago} hours`).run();
    }
    return env;
  };
  const left = async () => (await testEnv.DB.prepare('SELECT title FROM drafts ORDER BY title').all<{ title: string }>()).results.map((r) => r.title);

  it('«как удалить черновик?» -- справка, черновики на месте', async () => {
    const env = await two();
    tg();
    await say(env, 'tg-boss', 'как удалить черновик?');
    expect(await left()).toEqual(['Купить хлеб', 'Съездить на Джами и забрать сетки']);
  });

  it('«удали черновик про сетки» удаляет про сетки, а не последний', async () => {
    const env = await two();
    const spy = tg();
    await say(env, 'tg-boss', 'удали черновик про сетки');
    expect(await left()).toEqual(['Купить хлеб']);
    expect(sent(spy).at(-1)!.text).toContain('«Съездить на Джами и забрать сетки»');
  });

  it('названного нет -- не удаляется ничего, а не последний «на всякий случай»', async () => {
    const env = await two();
    const spy = tg();
    await say(env, 'tg-boss', 'удали черновик про молоко');
    expect(await left()).toEqual(['Купить хлеб', 'Съездить на Джами и забрать сетки']);
    expect(sent(spy).at(-1)!.text).toContain('не нашёл');
  });

  it('«удали черновик» без уточнений -- по-прежнему последний', async () => {
    const env = await two();
    tg();
    await say(env, 'tg-boss', 'удали черновик');
    expect(await left()).toEqual(['Съездить на Джами и забрать сетки']);
  });
});
