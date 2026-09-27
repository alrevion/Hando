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

const boss = { id: 'boss', name: 'Директор', role: 'creator' };
const worker1 = { id: 'w1', name: 'Работник', role: 'admin' };
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
    expect((await (hook(env, { message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/moe' } }, 'не тот'))).status).toBe(403);
    // И без заголовка вовсе.
    expect((await hook(env, {}, null)).status).toBe(403);
  });

  it('вебхук НЕ накрыт requireAuth: правильный секрет даёт 200 без куки', async () => {
    // Если бы роут сидел внутри apiRoutes, здесь был бы 401 -- Telegram
    // отретраил бы и отключил вебхук молча.
    const env = await world();
    tg();
    const res = await (hook(env, { message: { chat: { id: 999, type: 'private' }, from: { id: 999 }, text: 'привет' } }));
    expect(res.status).toBe(200);
  });

  it('незнакомцу предлагают зарегистрироваться, и это НЕ оракул существования', async () => {
    // Правило «неизвестному -- молчание» СНЯТО 2026-09-06 вместе с введением
    // авторегистрации: без ответа незнакомцу зарегистрироваться невозможно.
    //
    // Оракула при этом не возникает, и вот его определение: ответ не должен
    // зависеть от того, заведён ли отправитель в системе. Ниже это и
    // проверяется -- два РАЗНЫХ незнакомца получают одно и то же.
    const env = await world();
    const spy = tg();
    await hook(env, { message: { chat: { id: 777, type: 'private' }, from: { id: 777 }, text: '/start' } });
    await hook(env, { message: { chat: { id: 888, type: 'private' }, from: { id: 888 }, text: '/start' } });

    const bodies = calls(spy).filter(([u]) => u.includes('/sendMessage')).map(([, i]) => JSON.parse(String(i.body)));
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      // Первым делом бот знакомится: имя из Telegram для обращения не годится.
      expect(b.text).toContain('Как к Вам обращаться');
      // Ответ не содержит ничьих имён и не подтверждает наличия кого-либо.
      expect(b.text).not.toContain('Директор');
      expect(b.text).not.toContain('не зарегистрированы');
    }
  });

  it('незнакомец без организации не получает НИЧЕГО из чужих данных', async () => {
    const env = await world([{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'w1', author_id: 'boss', title: 'Секретное поручение' }]);
    const spy = tg();
    // Подключился, но организации нет: команда «мои задачи» не должна ничего
    // показать -- resolveOrgId вернёт null, потому что членства нет.
    await hook(env, { message: { chat: { id: 777, type: 'private' }, from: { id: 777 }, text: '/start' } });
    await hook(env, { message: { chat: { id: 777, type: 'private' }, from: { id: 777 }, text: '/moe' } });
    const texts = calls(spy).filter(([u]) => u.includes('/sendMessage')).map(([, i]) => JSON.parse(String(i.body)).text as string);
    expect(texts.join(' ')).not.toContain('Секретное');
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

    await (hook(env, { message: { chat: { id: 555, type: 'private' }, from: { id: 555, username: 'w' }, text: '/start inv_abc' } }));

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
    await (hook(env, { message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/start inv_выдумка' } }));
    expect(calls(spy).filter(([u]) => u.includes('/sendMessage'))).toHaveLength(0);
  });
});

describe('шаг 4a: кнопка и её погашение', () => {
  it('нажатие «Принял» двигает СВОЮ строку, гасит клавиатуру и отвечает на callback', async () => {
    const env = await world([{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'w1', author_id: 'boss' }]);
    const spy = tg();
    await (hook(env, {
      callback_query: { id: 'cb1', from: { id: 'tg-w1' as unknown as number }, data: 'accept:t1', message: { chat: { id: 5, type: 'private' }, message_id: 7 } },
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
      callback_query: { id: 'cb2', from: { id: 'tg-boss' as unknown as number }, data: 'accept:t1', message: { chat: { id: 5, type: 'private' }, message_id: 7 } },
    }));

    expect((await testEnv.DB.prepare("SELECT state FROM task_assignees WHERE task_id='t1'").first<{ state: string }>())!.state).toBe('pending');
    expect(calls(spy).filter(([u]) => u.includes('answerCallbackQuery'))).toHaveLength(1);
    expect(calls(spy).filter(([u]) => u.includes('editMessageReplyMarkup'))).toHaveLength(0);
  });

  it('«Готово» из бота больше нет: done:… строку не двигает, сдают в приложении', async () => {
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
      callback_query: { id: 'cb3', from: { id: 'tg-w1' as unknown as number }, data: 'done:bot', message: { chat: { id: 5, type: 'private' }, message_id: 8 } },
    }));

    const row = (id: string) => testEnv.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(id).first<{ status: string }>();
    // Решение владельца: техничка тоже открывает приложение и нажимает «Готово» там.
    expect((await row('ui'))!.status).toBe('done');
    expect((await row('bot'))!.status).toBe('in_progress');
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
  // По умолчанию 22:00-08:00, у каждого пространства своё окно.
  const Q = { timezone: 'Asia/Tashkent', quiet_from: '22:00', quiet_to: '08:00', always_on: 0 };

  it('тихо с 22:00 до 08:00 местного, а не серверного', () => {
    // 17:30Z = 22:30 в Ташкенте (UTC+5) -- тихо, хотя по UTC день.
    expect(isQuiet(new Date('2026-09-04T17:30:00Z'), Q)).toBe(true);
    // 16:00Z = 21:00 -- ещё не тихо.
    expect(isQuiet(new Date('2026-09-04T16:00:00Z'), Q)).toBe(false);
    // 04:00Z = 09:00 местного -- день, хотя по UTC ночь.
    expect(isQuiet(new Date('2026-09-04T04:00:00Z'), Q)).toBe(false);
    // Переход суток: 19:00Z = 00:00 следующего дня местного.
    expect(isQuiet(new Date('2026-09-04T19:00:00Z'), Q)).toBe(true);
    expect(isQuiet(new Date('2026-09-04T03:30:00Z'), Q)).toBe(false); // 08:30
    // Тот же момент в UTC-поясе -- 17:30 буднего дня, если бы пояс игнорировали.
    expect(isQuiet(new Date('2026-09-04T17:30:00Z'), { ...Q, timezone: 'UTC' })).toBe(false);
  });

  it('у 24/7 ночь тоже тихая, а воскресенье -- нет; у графика воскресенье тихое целиком', () => {
    // Раньше у 24/7 тишины не было вовсе: «Просрочено» шло круглые сутки.
    expect(isQuiet(new Date('2026-09-04T19:00:00Z'), { ...Q, always_on: 1 })).toBe(true);
    // 2026-09-06 -- воскресенье, 14:00 местного.
    expect(isQuiet(new Date('2026-09-06T09:00:00Z'), Q)).toBe(true);
    expect(isQuiet(new Date('2026-09-06T09:00:00Z'), { ...Q, always_on: 1 })).toBe(false);
  });

  it('окно из настроек: своё, внутри суток, и «00:00-00:00» -- без тишины', () => {
    expect(isQuiet(new Date('2026-09-04T09:00:00Z'), { ...Q, quiet_from: '13:00', quiet_to: '15:00' })).toBe(true); // 14:00
    expect(isQuiet(new Date('2026-09-04T11:00:00Z'), { ...Q, quiet_from: '13:00', quiet_to: '15:00' })).toBe(false); // 16:00
    expect(isQuiet(new Date('2026-09-04T19:00:00Z'), { ...Q, quiet_from: '00:00', quiet_to: '00:00', always_on: 1 })).toBe(false);
    // «Тишины нет» -- и в воскресенье: приложение так и обещает, «в любое время».
    // Раньше воскресенье у графика молчало и при выключенной тишине, и весь
    // набор тестов (тишина в нём выключена) падал по воскресеньям.
    expect(isQuiet(new Date('2026-09-06T09:00:00Z'), { ...Q, quiet_from: '00:00', quiet_to: '00:00' })).toBe(false);
    // Весть о просрочке («только ночь») воскресенье не держит, ночь -- держит.
    expect(isQuiet(new Date('2026-09-06T09:00:00Z'), Q, false, true)).toBe(false);
    expect(isQuiet(new Date('2026-09-06T17:30:00Z'), Q, false, true)).toBe(true);
  });

  it('срок, назначенный на тихое время, пробивает тишину', () => {
    expect(isQuiet(new Date('2026-09-04T17:30:00Z'), Q, true)).toBe(false);
  });

  it('в тихие часы outbox копит, а не теряет', async () => {
    const env = await world([{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'w1', author_id: 'boss' }]);
    await testEnv.DB.prepare("UPDATE orgs SET quiet_from = '20:00', quiet_to = '08:00' WHERE id = ?").bind(ORG_A).run();
    const spy = tg();

    // Момент фиксируем через подмену времени: набор не смеет зависеть от того,
    // в какое время суток его запустили.
    vi.setSystemTime(new Date('2026-09-04T16:00:00Z')); // 21:00 в Ташкенте
    await apiRoutes.request('/tasks/t1/move', {
      method: 'POST', headers: { Cookie: await cookie('w1', 'admin', ORG_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'in_progress' }),
    }, env);
    expect(calls(spy).filter(([u]) => u.includes('/sendMessage'))).toHaveLength(0);
    // Строка ЖДЁТ, а не потеряна. Она одна -- автору (ему видеть ход
    // поручённой работы); самому адресату о его же действии не пишем.
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
    expect(sends.some((x) => String(x.text).includes('Просрочено'))).toBe(true);
  });

  it('напоминания cron подчиняются тихим часам; «Просрочено» ночью ждёт утра', async () => {
    // Время подменяется ДО постройки мира, а не после. Прежняя редакция считала
    // done_at от НАСТОЯЩЕГО «сейчас», а проверяла при подменённом -- и разошлась
    // сама собой, когда календарная дата сменилась: 3 дня назад от реального дня
    // оказались 1,6 дня назад от подменённого, и окно проверки не наступало.
    // Тест, зависящий от того, какой сегодня день, ловит календарь, а не код.
    const NIGHT = new Date('2026-09-04T16:00:00Z'); // 21:00 в Ташкенте
    vi.setSystemTime(NIGHT);

    const env = await world([
      { id: 'late', project_id: 'p1', status: 'todo', responsible_user_id: 'w1', author_id: 'boss', deadline: '2020-01-01T00:00:00.000Z' },
      { id: 'stale', project_id: 'p1', status: 'done', responsible_user_id: 'w1', author_id: 'boss', done_at: new Date(NIGHT.getTime() - 3 * 86400_000).toISOString() },
    ]);
    await testEnv.DB.prepare("UPDATE orgs SET quiet_from = '20:00', quiet_to = '08:00' WHERE id = ?").bind(ORG_A).run();
    await testEnv.DB.prepare("UPDATE task_assignees SET due_at = '2020-01-01T00:00:00.000Z' WHERE task_id = 'late'").run();
    await testEnv.DB.prepare("UPDATE task_assignees SET state = 'done', done_at = (SELECT done_at FROM tasks WHERE id='stale') WHERE task_id = 'stale'").run();

    const spy = tg();
    await scheduled({} as ScheduledController, env, {} as ExecutionContext);
    const sent = calls(spy).filter(([u]) => u.includes('/sendMessage')).map(([, i]) => JSON.parse(String(i.body)));

    // Просрочка ТИШИНУ НЕ пробивает: срок уже прошёл, до утра хуже не станет,
    // а ночной звонок -- станет. Раньше пробивала, и у семьи шло всю ночь.
    expect(sent.some((x) => String(x.text).includes('Просрочено'))).toBe(false);
    expect(sent.some((x) => String(x.text).includes('Пора проверить'))).toBe(false);
    // И не потеряно: обе строки ждут в очереди и уходят утром.
    const pending = await testEnv.DB.prepare("SELECT kind FROM notifications WHERE sent_at IS NULL AND kind IN ('overdue','stale_review') ORDER BY kind").all<{ kind: string }>();
    expect(pending.results.map((r) => r.kind)).toEqual(['overdue', 'stale_review']);
    vi.setSystemTime(new Date('2026-09-05T05:00:00Z')); // 10:00 субботы: у графика тихо только воскресенье
    await drainOutbox(env);
    const later = calls(spy).filter(([u]) => u.includes('/sendMessage')).map(([, i]) => JSON.parse(String(i.body)));
    expect(later.some((x) => String(x.text).includes('Просрочено'))).toBe(true);
    vi.useRealTimers();
  });
});


describe('ревью: находки security-ревью', () => {
  it('в групповом чате бот МОЛЧИТ: «/moe» печатал туда задачи всех организаций', async () => {
    const env = await world([{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'w1', author_id: 'boss' }]);
    const spy = tg();
    // Бот состоит в группах проектов, и Telegram доставляет ему команды со
    // слэша даже при privacy mode. Ответ шёл по адресу входящего сообщения.
    await hook(env, { message: { chat: { id: -100999, type: 'supergroup' }, from: { id: 'tg-w1' }, text: '/moe' } });
    expect(calls(spy).filter(([u]) => u.includes('/sendMessage'))).toHaveLength(0);

    // А в личке -- отвечает.
    await hook(env, { message: { chat: { id: 'tg-w1', type: 'private' }, from: { id: 'tg-w1' }, text: '/moe' } });
    expect(calls(spy).filter(([u]) => u.includes('/sendMessage'))).toHaveLength(1);
  });

  it('отозванный сотрудник не получает накопленных уведомлений', async () => {
    const env = await world([{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'w1', author_id: 'boss' }]);
    tg();
    // Ставим уведомление в очередь...
    await apiRoutes.request('/tasks/t1/move', {
      method: 'POST', headers: { Cookie: await cookie('w1', 'admin', ORG_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'in_progress' }),
    }, env);
    restore!.mockRestore();

    // ...человека увольняют, и только ПОТОМ идёт проход отправки.
    await testEnv.DB.prepare("UPDATE org_memberships SET left_at = '2026-01-01' WHERE user_id='w1' AND org_id=?").bind(ORG_A).run();
    await testEnv.DB.prepare("INSERT INTO notifications (id, task_id, assignee_id, org_id, kind, payload) VALUES ('n9','t1','w1',?,'test',?)")
      .bind(ORG_A, JSON.stringify({ recipient_user_id: 'w1', text: 'Секретное поручение', delete_message_id: null, track: false }))
      .run();

    const spy = tg();
    await drainOutbox(env);
    // requireAuth перечитывает членство на каждом запросе -- но очередь живёт
    // без запроса, и без предиката в точке отправки уволенный получал бы
    // заголовки задач бывшего работодателя бессрочно.
    expect(calls(spy).filter(([u]) => u.includes('/sendMessage'))).toHaveLength(0);
  });

  it('«напомнить» с кнопки повода доступно только автору', async () => {
    const env = await world([{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'w1', author_id: 'boss' }]);
    await testEnv.DB.prepare("INSERT INTO reminders (assignee_row_id, kind, sent_at) VALUES ('as-t1', 'not_accepted', '2026-01-01')").run();
    tg();
    const logged = async () => (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reminders WHERE assignee_row_id='as-t1'").first<{ n: number }>())!.n;
    // Не автор: без гейта он стирал бы журнал по любой задаче, и исполнитель
    // получал бы повторные напоминания сквозь график.
    await hook(env, { callback_query: { id: 'c1', from: { id: 'tg-w1' }, data: 'nudge_remind:t1', message: { chat: { id: 1, type: 'private' }, message_id: 2 } } });
    expect(await logged()).toBe(1);

    await hook(env, { callback_query: { id: 'c2', from: { id: 'tg-boss' }, data: 'nudge_remind:t1', message: { chat: { id: 1, type: 'private' }, message_id: 2 } } });
    expect(await logged()).toBe(0);
  });

  it('«принять» с кнопки повода не подтверждает недоделанную задачу', async () => {
    const env = await world([{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'w1', author_id: 'boss' }]);
    tg();
    await hook(env, { callback_query: { id: 'c3', from: { id: 'tg-boss' }, data: 'nudge_confirm:t1', message: { chat: { id: 1, type: 'private' }, message_id: 2 } } });
    // Кнопка обходила гейты status==='done' и confirmed_at IS NULL, которые
    // есть у POST /tasks/:id/confirm.
    expect((await testEnv.DB.prepare("SELECT confirmed_at FROM tasks WHERE id='t1'").first<{ confirmed_at: string | null }>())!.confirmed_at).toBeNull();
  });
});
