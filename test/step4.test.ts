// Приёмка шагов 4a (границы бота, онбординг) и 4d (тихие часы).
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { botApp } from '../src/bot';
import { scheduled } from '../src/scheduled';
import { apiRoutes } from '../src/routes';
import { isQuiet } from '../src/quiet';
import { drainOutbox } from '../src/outbox';
import { cookie, envWith, ORG_A, stubTelegram } from './fixture';
import type { Env } from '../src/types';

let restore: { mockRestore(): void } | null = null;
afterEach(() => { restore?.mockRestore(); restore = null; });
const tg = () => (restore = stubTelegram()) as ReturnType<typeof stubTelegram>;
const calls = (spy: ReturnType<typeof stubTelegram>) => spy.mock.calls as unknown as [string, { body?: string }][];

const boss = { id: 'boss', phone: '+1', name: 'Директор', role: 'creator' };
const worker1 = { id: 'w1', phone: '+2', name: 'Работник', role: 'admin' };
const world = (tasks: Record<string, unknown>[] = []) =>
  envWith({
    users: [boss, worker1],
    memberships: [{ project_id: 'p1', user_id: 'boss' }, { project_id: 'p1', user_id: 'w1' }],
    projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'boss' }],
    tasks,
  });

// Импортируется botApp, а не весь воркер: src/index тянет mcp.ts -> ajv, а тот
// грузит .json как модуль, чего workerd не умеет. Факт монтирования вне /api
// (то есть вне requireAuth) проверяется структурно в single-writer.test.ts.
const hook = (env: Env, body: unknown, secret: string | null = 'tg-secret') =>
  botApp.request('/webhook', {
    method: 'POST',
    headers: secret === null
      ? { 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify(body),
  }, env);

describe('шаг 4a: границы третьей двери', () => {
  it('апдейт без корректного секрет-токена отвергается', async () => {
    const env = await world();
    tg();
    expect((await (hook(env, { message: { chat: { id: 1 }, from: { id: 1 }, text: '/moe' } }, 'не тот'))).status).toBe(403);
    // И без заголовка вовсе.
    expect((await hook(env, {}, null)).status).toBe(403);
  });

  it('вебхук НЕ накрыт requireAuth: правильный секрет даёт 200 без куки', async () => {
    // Если бы роут сидел внутри apiRoutes, здесь был бы 401 -- Telegram
    // отретраил бы и отключил вебхук молча.
    const env = await world();
    tg();
    const res = await (hook(env, { message: { chat: { id: 999 }, from: { id: 999 }, text: 'привет' } }));
    expect(res.status).toBe(200);
  });

  it('неизвестный отправитель не порождает ответа -- молчание, а не «вы не зарегистрированы»', async () => {
    const env = await world();
    const spy = tg();
    await (hook(env, { message: { chat: { id: 777 }, from: { id: 777 }, text: '/moe' } }));
    // Ответ «вы не зарегистрированы» -- оракул существования: по нему перебором
    // узнают, какие telegram_user_id заведены в системе.
    expect(calls(spy).filter(([u]) => u.includes('/sendMessage'))).toHaveLength(0);
  });

  it('подключение по одноразовой ссылке: токен гасится, накопленное доставляется', async () => {
    const env = await envWith({
      users: [boss, { ...worker1, telegram_user_id: null }],
      memberships: [{ project_id: 'p1', user_id: 'boss' }, { project_id: 'p1', user_id: 'w1' }],
      projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'boss' }],
      tasks: [],
    });
    await testEnv.DB.prepare("UPDATE users SET invite_token = 'inv_abc' WHERE id = 'w1'").run();
    const spy = tg();

    // Задача поставлена ДО подключения: сообщение ждёт в очереди, потому что
    // падать назад в групповой чат ADR-4 запрещает.
    await apiRoutes.request('/projects/p1/tasks', {
      method: 'POST', headers: { Cookie: await cookie('boss', 'creator', ORG_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Ждёт подключения', responsible_user_id: 'w1' }),
    }, env);
    expect(calls(spy).filter(([u]) => u.includes('/sendMessage'))).toHaveLength(0);
    const pending = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE sent_at IS NULL').first<{ n: number }>();
    expect(pending!.n).toBe(1);

    await (hook(env, { message: { chat: { id: 555 }, from: { id: 555, username: 'w' }, text: '/start inv_abc' } }));

    const u = await testEnv.DB.prepare("SELECT telegram_user_id, invite_token, connected_at FROM users WHERE id='w1'").first<{ telegram_user_id: string; invite_token: string | null; connected_at: string }>();
    expect(u!.telegram_user_id).toBe('555');
    // Ссылка одноразовая: переслать её -- значит отдать чужой доступ.
    expect(u!.invite_token).toBeNull();
    expect(u!.connected_at).not.toBeNull();

    // Накопленное уехало сразу после подключения.
    const after = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE sent_at IS NULL').first<{ n: number }>();
    expect(after!.n).toBe(0);
  });

  it('неверный токен приглашения -- тоже молчание', async () => {
    const env = await world();
    const spy = tg();
    await (hook(env, { message: { chat: { id: 1 }, from: { id: 1 }, text: '/start inv_выдумка' } }));
    expect(calls(spy).filter(([u]) => u.includes('/sendMessage'))).toHaveLength(0);
  });
});

describe('шаг 4a: кнопка и её погашение', () => {
  it('нажатие «Принял» двигает СВОЮ строку, гасит клавиатуру и отвечает на callback', async () => {
    const env = await world([{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'w1', author_id: 'boss' }]);
    const spy = tg();
    await (hook(env, {
      callback_query: { id: 'cb1', from: { id: 'tg-w1' as unknown as number }, data: 'accept:t1', message: { chat: { id: 5 }, message_id: 7 } },
    }));

    const a = await testEnv.DB.prepare("SELECT state FROM task_assignees WHERE task_id='t1'").first<{ state: string }>();
    expect(a!.state).toBe('accepted');
    // answerCallbackQuery -- на КАЖДОЕ нажатие: без него спиннер крутится до таймаута.
    expect(calls(spy).filter(([u]) => u.includes('answerCallbackQuery'))).toHaveLength(1);
    // Клавиатура гасится ровно один раз на переход.
    expect(calls(spy).filter(([u]) => u.includes('editMessageReplyMarkup'))).toHaveLength(1);
  });

  it('нажатие чужой кнопки отвергается, но callback всё равно отвечается', async () => {
    const env = await world([{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'w1', author_id: 'boss' }]);
    const spy = tg();
    // boss не адресат: пересланное сообщение не делает кнопку его.
    await (hook(env, {
      callback_query: { id: 'cb2', from: { id: 'tg-boss' as unknown as number }, data: 'accept:t1', message: { chat: { id: 5 }, message_id: 7 } },
    }));

    expect((await testEnv.DB.prepare("SELECT state FROM task_assignees WHERE task_id='t1'").first<{ state: string }>())!.state).toBe('pending');
    expect(calls(spy).filter(([u]) => u.includes('answerCallbackQuery'))).toHaveLength(1);
    expect(calls(spy).filter(([u]) => u.includes('editMessageReplyMarkup'))).toHaveLength(0);
  });

  it('закрытие из бота и из mini-app дают одинаковую строку tasks', async () => {
    const env = await world([
      { id: 'ui', project_id: 'p1', status: 'in_progress', responsible_user_id: 'w1', author_id: 'boss' },
      { id: 'bot', project_id: 'p1', status: 'in_progress', responsible_user_id: 'w1', author_id: 'boss' },
    ]);
    tg();
    await apiRoutes.request('/tasks/ui/move', {
      method: 'POST', headers: { Cookie: await cookie('w1', 'admin', ORG_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'done' }),
    }, env);
    await (hook(env, {
      callback_query: { id: 'cb3', from: { id: 'tg-w1' as unknown as number }, data: 'done:bot', message: { chat: { id: 5 }, message_id: 8 } },
    }));

    const row = (id: string) => testEnv.DB.prepare('SELECT status, telegram_message_id, confirmed_at FROM tasks WHERE id = ?').bind(id).first<Record<string, unknown>>();
    // Один автомат на оба канала -- значит и строка обязана совпасть, а не
    // «примерно совпасть».
    expect(await row('bot')).toEqual(await row('ui'));
  });
});

describe('шаг 4a: ADR-4 -- заголовок задачи не уходит в групповой чат', () => {
  it('ни один sendMessage в групповой чат не содержит заголовка задачи', async () => {
    const env = await world();
    const spy = tg();
    const secret = 'Секретное поручение про увольнение';
    await apiRoutes.request('/projects/p1/tasks', {
      method: 'POST', headers: { Cookie: await cookie('boss', 'creator', ORG_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: secret, responsible_user_id: 'w1' }),
    }, env);

    const sends = calls(spy).filter(([u]) => u.includes('/sendMessage')).map(([, i]) => JSON.parse(String(i.body)));
    expect(sends.length).toBeGreaterThan(0);
    // Проверяем ЗНАЧЕНИЕМ, а не грепом по исходникам: заголовок приходит в
    // переменной, и греп его не увидит. Утверждение сильнее «в группе нет
    // заголовка»: в групповой чат не уходит НИЧЕГО -- пустая проверка «нет
    // сообщений с заголовком» была бы истинна и при полном молчании.
    expect(sends.map((s) => String(s.chat_id))).not.toContain('-100999');
    // И он действительно ушёл -- в личку адресата, а не пропал.
    const dm = sends.find((s) => String(s.chat_id) === 'tg-w1');
    expect(dm).toBeDefined();
    expect(String(dm.text)).toContain(secret);
  });
});

describe('шаг 4d: тихие часы в поясе организации', () => {
  it('в Ташкенте тихо с 20:00 до 08:00 местного, а не серверного', () => {
    // 2026-09-04T16:00Z = 21:00 в Ташкенте (UTC+5) -- тихо, хотя по UTC день.
    expect(isQuiet(new Date('2026-09-04T16:00:00Z'), 'Asia/Tashkent')).toBe(true);
    // 2026-09-04T04:00Z = 09:00 местного -- рабочее время, хотя по UTC ночь.
    expect(isQuiet(new Date('2026-09-04T04:00:00Z'), 'Asia/Tashkent')).toBe(false);
    // Переход суток: 19:00Z = 00:00 следующего дня местного.
    expect(isQuiet(new Date('2026-09-04T19:00:00Z'), 'Asia/Tashkent')).toBe(true);
    expect(isQuiet(new Date('2026-09-04T03:30:00Z'), 'Asia/Tashkent')).toBe(false); // 08:30
    // Воскресенье целиком: 2026-09-06 -- воскресенье.
    expect(isQuiet(new Date('2026-09-06T09:00:00Z'), 'Asia/Tashkent')).toBe(true);
    // Тот же момент в UTC-поясе -- 09:00 буднего дня, если бы пояс игнорировали.
    expect(isQuiet(new Date('2026-09-04T16:00:00Z'), 'UTC')).toBe(false);
  });

  it('срок пробивает тишину: предупреждение после провала бесполезно', () => {
    expect(isQuiet(new Date('2026-09-04T16:00:00Z'), 'Asia/Tashkent', true)).toBe(false);
  });

  it('в тихие часы outbox копит, а не теряет', async () => {
    const env = await world([{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'w1', author_id: 'boss' }]);
    await testEnv.DB.prepare('UPDATE orgs SET quiet_hours = 1 WHERE id = ?').bind(ORG_A).run();
    const spy = tg();

    // Момент фиксируем через подмену времени: набор не смеет зависеть от того,
    // в какое время суток его запустили.
    vi.setSystemTime(new Date('2026-09-04T16:00:00Z')); // 21:00 в Ташкенте
    await apiRoutes.request('/tasks/t1/move', {
      method: 'POST', headers: { Cookie: await cookie('w1', 'admin', ORG_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'in_progress' }),
    }, env);
    expect(calls(spy).filter(([u]) => u.includes('/sendMessage'))).toHaveLength(0);
    // Строка ЖДЁТ, а не потеряна.
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE sent_at IS NULL').first<{ n: number }>())!.n).toBe(1);

    vi.setSystemTime(new Date('2026-09-04T05:00:00Z')); // 10:00 в Ташкенте
    expect(await drainOutbox(env)).toBe(1);
    vi.useRealTimers();
  });
});


describe('ревью: у cron нет своего пути отправки', () => {
  // Класс дефекта, доживший до прода: три прохода cron звали sendMessage
  // напрямую и слали в ГРУППОВОЙ чат текст с заголовком задачи. Оба
  // утверждения -- «в группу не уходит ничего» (ADR-4) и «тихие часы в
  // единственной точке отправки» (4d) -- проверялись только на пути СОЗДАНИЯ
  // задачи, поэтому дефект был невидим. Тесты ниже закрывают весь класс.

  it('ни одно сообщение за тик cron не уходит в групповой чат', async () => {
    const env = await world([
      { id: 'late', project_id: 'p1', status: 'todo', responsible_user_id: 'w1', author_id: 'boss', deadline: '2020-01-01T00:00:00.000Z' },
      // done_at СТАРШЕ двух дней (окно проверки), но МОЛОЖЕ семи: иначе задачу
      // сначала заберёт автоархив, и напоминание по ней законно не поставится.
      { id: 'stale', project_id: 'p1', status: 'done', responsible_user_id: 'w1', author_id: 'boss', done_at: new Date(Date.now() - 3 * 86400_000).toISOString() },
    ]);
    await testEnv.DB.prepare("UPDATE task_assignees SET due_at = '2020-01-01T00:00:00.000Z' WHERE task_id = 'late'").run();
    await testEnv.DB.prepare("UPDATE task_assignees SET state = 'done', done_at = (SELECT done_at FROM tasks WHERE id='stale') WHERE task_id = 'stale'").run();

    const spy = tg();
    await scheduled({} as ScheduledController, env, {} as ExecutionContext);

    const sends = calls(spy).filter(([u]) => u.includes('/sendMessage')).map(([, i]) => JSON.parse(String(i.body)));
    expect(sends.length).toBeGreaterThan(0); // иначе проверка вакуумна
    // Групповой чат проекта -- '-100999'. Не должно быть НИ ОДНОГО.
    expect(sends.map((x) => String(x.chat_id))).not.toContain('-100999');
    // И заголовки действительно ушли -- в личку, а не пропали.
    expect(sends.some((x) => String(x.text).includes('ПРОСРОЧИЛИ'))).toBe(true);
  });

  it('напоминания cron подчиняются тихим часам, а срочность их пробивает', async () => {
    const env = await world([
      { id: 'late', project_id: 'p1', status: 'todo', responsible_user_id: 'w1', author_id: 'boss', deadline: '2020-01-01T00:00:00.000Z' },
      { id: 'stale', project_id: 'p1', status: 'done', responsible_user_id: 'w1', author_id: 'boss', done_at: new Date(Date.now() - 3 * 86400_000).toISOString() },
    ]);
    await testEnv.DB.prepare('UPDATE orgs SET quiet_hours = 1 WHERE id = ?').bind(ORG_A).run();
    await testEnv.DB.prepare("UPDATE task_assignees SET due_at = '2020-01-01T00:00:00.000Z' WHERE task_id = 'late'").run();
    await testEnv.DB.prepare("UPDATE task_assignees SET state = 'done', done_at = (SELECT done_at FROM tasks WHERE id='stale') WHERE task_id = 'stale'").run();

    vi.setSystemTime(new Date('2026-09-04T16:00:00Z')); // 21:00 в Ташкенте
    const spy = tg();
    await scheduled({} as ScheduledController, env, {} as ExecutionContext);
    const sent = calls(spy).filter(([u]) => u.includes('/sendMessage')).map(([, i]) => JSON.parse(String(i.body)));

    // Просрочка пробивает тишину: предупреждение после провала бесполезно.
    expect(sent.some((x) => String(x.text).includes('ПРОСРОЧИЛИ'))).toBe(true);
    // А «пора проверить» подождёт до утра.
    expect(sent.some((x) => String(x.text).includes('Пора проверить'))).toBe(false);
    // И не потеряно: строка ждёт в очереди.
    const pending = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE sent_at IS NULL AND kind = 'stale_review'").first<{ n: number }>();
    expect(pending!.n).toBe(1);
    vi.useRealTimers();
  });
});
