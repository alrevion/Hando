// Шаг -1 плана: слепок СЕГОДНЯШНЕГО поведения перед пятью ломающими миграциями.
//
// Смысл набора -- не проверить права (это делает access.test.ts), а закрепить
// ДАННЫЕ: какие поля строки меняет каждая операция и что она пишет в events.
// Ровно это и ломается при мультитенантности, множественных адресатах и
// пересборке `users`/`events`: маршрут продолжает отвечать 200, а строка
// получается другой. Отсюда правило набора: утверждать про содержимое таблиц,
// а не про статус ответа.
//
// Сценарий 4 (блокировка по зависимости) уже закреплён в access.test.ts:198 --
// здесь закрепляется вторая половина, которой там нет: что снятие блокировки
// не портит саму строку.
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { apiRoutes } from '../src/routes';
import { scheduled } from '../src/scheduled';
import { cookie, envWith, stubTelegram } from './fixture';

let restore: { mockRestore(): void } | null = null;
afterEach(() => {
  restore?.mockRestore();
  restore = null;
});

const tg = () => {
  restore = stubTelegram();
  return restore as ReturnType<typeof stubTelegram>;
};

const json = (c: string, body: unknown) => ({
  method: 'POST',
  headers: { Cookie: c, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const row = (id: string) =>
  testEnv.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<Record<string, unknown>>();

const events = (targetId: string) =>
  testEnv.DB.prepare('SELECT action, actor_id, comment, overdue_by FROM events WHERE target_id = ? ORDER BY rowid')
    .bind(targetId)
    .all<{ action: string; actor_id: string | null; comment: string | null; overdue_by: number | null }>();

// Владелец доски + исполнитель. super_admin состоит в проекте явно: своя доска
// со своими людьми, роль сама по себе доступа не даёт.
const boss = { id: 's1', phone: '+1', name: 'Босс', role: 'super_admin' };
const worker = { id: 'w1', phone: '+2', name: 'Работник', role: 'admin' };
const team = { users: [boss, worker], memberships: [{ project_id: 'p1', user_id: 's1' }, { project_id: 'p1', user_id: 'w1' }] };

describe('регрессия шага -1: создание и редактирование', () => {
  it('1. создание кладёт строку в todo с приоритетом medium и пишет событие created', async () => {
    const env = await envWith({ ...team, tasks: [] });
    tg();
    const res = await apiRoutes.request(
      '/projects/p1/tasks',
      json(await cookie('s1', 'super_admin'), { title: 'Договор', description: 'текст', responsible_user_id: 'w1', deadline: '2030-01-01T00:00:00.000Z' }),
      env,
    );
    expect(res.status).toBe(201);
    const { id } = await res.json<{ id: string }>();

    const t = await row(id);
    expect(t).toMatchObject({
      project_id: 'p1',
      title: 'Договор',
      description: 'текст',
      status: 'todo',
      priority: 'medium',
      deadline: '2030-01-01T00:00:00.000Z',
    });
    // Ничего из «жизненного цикла» не проставлено заранее -- это и есть чистый todo.
    expect(t!.done_at).toBeNull();
    expect(t!.confirmed_at).toBeNull();
    // Адресат -- отдельная строка с шага 3; таймеры теперь на ней.
    const assignee = await testEnv.DB.prepare('SELECT user_id, state, last_escalated_at FROM task_assignees WHERE task_id = ?').bind(id).first<{ user_id: string; state: string; last_escalated_at: string | null }>();
    expect(assignee).toMatchObject({ user_id: 'w1', state: 'pending' });
    expect(assignee!.last_escalated_at).toBeNull();

    const { results } = await events(id);
    expect(results).toEqual([{ action: 'created', actor_id: 's1', comment: null, overdue_by: null }]);

    // Глубокая ссылка обязана вести в Hando. Форк принёс сюда домен Sayn, и
    // уведомление уводило человека на чужую доску -- ошибка, невидимая в коде
    // ответа: маршрут всё это время отвечал 201.
    const calls = (restore as unknown as { mock: { calls: [string, { body?: string }][] } }).mock.calls;
    // Ссылка живёт в кнопке «Открыть» (web_app), а не в тексте.
    const body = JSON.parse(calls.at(-1)![1].body!) as { reply_markup: { inline_keyboard: { web_app?: { url: string } }[][] } };
    const urls = body.reply_markup.inline_keyboard.flat().map((b) => b.web_app?.url ?? '');
    expect(urls).toContain(`https://hando.alrevion.com/?task=${id}`);
    expect(JSON.stringify(body)).not.toContain('sayn.alrevion.com');
  });

  it('2. edit-lock: в todo правка проходит и меняет поля, в done -- 409 и строка не тронута', async () => {
    const env = await envWith({
      ...team,
      tasks: [
        { id: 'open', project_id: 'p1', title: 'До', status: 'todo', responsible_user_id: 'w1' },
        { id: 'shut', project_id: 'p1', title: 'До', status: 'done', responsible_user_id: 'w1', done_at: '2026-01-01T00:00:00.000Z' },
      ],
    });
    const c = await cookie('s1', 'super_admin');
    const patch = (id: string) => apiRoutes.request(id === 'open' ? '/tasks/open' : '/tasks/shut', {
      method: 'PATCH',
      headers: { Cookie: c, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'После', priority: 'urgent' }),
    }, env);

    expect((await patch('open')).status).toBe(200);
    expect(await row('open')).toMatchObject({ title: 'После', priority: 'urgent', status: 'todo' });

    // Неизвестный приоритет на PATCH молча СОХРАНЯЕТ прежний (COALESCE с null),
    // а не сбрасывает в medium, как это делает создание. Разное поведение двух
    // маршрутов -- существующая асимметрия, её и фиксируем.
    await apiRoutes.request('/tasks/open', {
      method: 'PATCH', headers: { Cookie: c, 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 'ЧРЕЗВЫЧАЙНО' }),
    }, env);
    expect((await row('open'))!.priority).toBe('urgent');

    expect((await patch('shut')).status).toBe(409);
    // 409 без отката -- главное: строка обязана остаться прежней, а не «почти прежней».
    expect(await row('shut')).toMatchObject({ title: 'До', priority: 'medium', status: 'done' });
  });
});

describe('регрессия шага -1: движение по доске', () => {
  it('3. todo -> in_progress -> done: done_at выставляется, telegram_message_id ставится и снимается', async () => {
    const env = await envWith({ ...team, tasks: [{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'w1' }] });
    const c = await cookie('w1', 'admin');
    tg();

    expect((await apiRoutes.request('/tasks/t1/move', json(c, { to: 'in_progress' }), env)).status).toBe(200);
    const inProgress = await row('t1');
    expect(inProgress!.status).toBe('in_progress');
    // Сообщение «🚀 В работе» -- то самое, которое эскалация потом заменяет собой.
    expect(inProgress!.telegram_message_id).toBe('1');
    expect(inProgress!.done_at).toBeNull();

    expect((await apiRoutes.request('/tasks/t1/move', json(c, { to: 'done' }), env)).status).toBe(200);
    const done = await row('t1');
    expect(done!.status).toBe('done');
    expect(done!.done_at).not.toBeNull();
    // Живое сообщение снято: иначе cron позже попытается удалить чужой message_id.
    expect(done!.telegram_message_id).toBeNull();

    // done -> in_progress руками недоступно: это работа confirm/reject, не move.
    expect((await apiRoutes.request('/tasks/t1/move', json(c, { to: 'in_progress' }), env)).status).toBe(409);

    const { results } = await events('t1');
    // Третьим -- 'confirmed': задача поручена самому себе, и проверять её не у
    // кого. Спрашивать «примите работу» у того же человека было бы обрядом.
    expect(results.map((e) => e.action)).toEqual(['moved_in_progress', 'moved_done', 'confirmed']);
  });

  it('4. снятие блокировки по зависимости не портит строку: предшественник в архиве тоже открывает путь', async () => {
    const env = await envWith({
      ...team,
      tasks: [
        { id: 'dep', project_id: 'p1', status: 'archived', responsible_user_id: 'w1' },
        { id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'w1', depends_on_task_id: 'dep' },
      ],
    });
    tg();
    const res = await apiRoutes.request('/tasks/t1/move', json(await cookie('w1', 'admin'), { to: 'in_progress' }), env);
    expect(res.status).toBe(200);
    const t = await row('t1');
    expect(t!.status).toBe('in_progress');
    // Связь переживает переход: её теряли бы, если бы UPDATE перечислял поля без depends_on.
    expect(t!.depends_on_task_id).toBe('dep');
  });
});

describe('регрессия шага -1: приёмка', () => {
  // Один env на три случая: изоляция хранилища откатывает записи МЕЖДУ тестами,
  // а не внутри одного -- второй вызов envWith() падал бы на UNIQUE users.phone.
  const withDone = () =>
    envWith({
      ...team,
      tasks: [
        { id: 'late', project_id: 'p1', status: 'done', responsible_user_id: 'w1', deadline: '2026-01-01T00:00:00.000Z', done_at: '2026-01-01T02:00:00.000Z' },
        { id: 'early', project_id: 'p1', status: 'done', responsible_user_id: 'w1', deadline: '2026-01-01T02:00:00.000Z', done_at: '2026-01-01T00:00:00.000Z' },
        { id: 'nodl', project_id: 'p1', status: 'done', responsible_user_id: 'w1', deadline: null, done_at: '2026-01-01T00:00:00.000Z' },
      ],
    });

  it('5. confirm считает overdue_by в секундах: просрочка, ноль вовремя, null без дедлайна', async () => {
    const env = await withDone();
    const c = await cookie('s1', 'super_admin');
    const confirm = (id: string) => apiRoutes.request(`/tasks/${id}/confirm`, json(c, {}), env);
    tg();

    expect(await (await confirm('late')).json()).toEqual({ success: true, overdue_by: 7200 });
    // Событие несёт ту же цифру: по нему потом считается статистика, не по ответу.
    expect((await events('late')).results[0]).toMatchObject({ action: 'confirmed', overdue_by: 7200 });
    expect((await row('late'))!.confirmed_at).not.toBeNull();

    // Досрочно -- это 0, а не отрицательное число: «успел» не бывает разной степени.
    expect(await (await confirm('early')).json()).toEqual({ success: true, overdue_by: 0 });

    // Без дедлайна судить не о чем -- null, и это не то же самое, что 0.
    expect(await (await confirm('nodl')).json()).toEqual({ success: true, overdue_by: null });
  });

  it('5b. повторный confirm отбивается 409 и не переписывает confirmed_at', async () => {
    const env = await withDone();
    const c = await cookie('s1', 'super_admin');
    tg();
    expect((await apiRoutes.request('/tasks/late/confirm', json(c, {}), env)).status).toBe(200);
    const first = (await row('late'))!.confirmed_at;
    expect((await apiRoutes.request('/tasks/late/confirm', json(c, {}), env)).status).toBe(409);
    expect((await row('late'))!.confirmed_at).toBe(first);
  });

  it('6. reject возвращает в работу, сбрасывает done_at/confirmed_at и ВСЕ три таймера напоминаний', async () => {
    const env = await envWith({
      ...team,
      tasks: [{ id: 't1', project_id: 'p1', status: 'done', responsible_user_id: 'w1', deadline: '2026-01-01T00:00:00.000Z', done_at: '2026-01-02T00:00:00.000Z', confirmed_at: null }],
    });
    // Таймеры не заводятся через фикстуру -- их ставит cron. Здесь важно, что
    // reject их гасит: иначе новый дедлайн проживёт без единого напоминания.
    await testEnv.DB.prepare(
      "UPDATE task_assignees SET state = 'done', last_escalated_at = '2026-01-01T01:00:00.000Z', reminder_sent_at = '2025-12-31T00:00:00.000Z', review_reminded_at = '2026-01-04T00:00:00.000Z' WHERE task_id = 't1'",
    ).run();
    tg();

    const before = Date.now();
    const res = await apiRoutes.request('/tasks/t1/reject', json(await cookie('s1', 'super_admin'), { comment: 'переделать', extra_days: 3 }), env);
    expect(res.status).toBe(200);

    const t = await row('t1');
    expect(t!.status).toBe('in_progress');
    expect(t!.done_at).toBeNull();
    expect(t!.confirmed_at).toBeNull();
    // Таймеры гасятся на СТРОКЕ адресата: в tasks их больше нет, потому что при
    // рассылке на 14 человек по-задачный флаг гасился первой же отправкой.
    const a = await testEnv.DB.prepare("SELECT state, last_escalated_at, reminder_sent_at, review_reminded_at FROM task_assignees WHERE task_id = 't1'").first<Record<string, unknown>>();
    expect(a!.state).toBe('rejected');
    expect(a!.last_escalated_at).toBeNull();
    expect(a!.reminder_sent_at).toBeNull();
    expect(a!.review_reminded_at).toBeNull();

    const shifted = Date.parse(t!.deadline as string) - before;
    expect(shifted).toBeGreaterThan(3 * 24 * 3600 * 1000 - 5000);
    expect(shifted).toBeLessThan(3 * 24 * 3600 * 1000 + 5000);

    // Слои журнала разделены: строка адресата пишет 'rejected' (target_type =
    // 'assignee'), задача -- свой переход. Раньше это было одно событие, потому
    // что адресат был один; при рассылке первое случается по числу сдавших.
    const assigneeEvents = await testEnv.DB.prepare(
      "SELECT action, comment FROM events WHERE target_type = 'assignee' ORDER BY rowid",
    ).all<{ action: string; comment: string | null }>();
    expect(assigneeEvents.results.at(-1)).toMatchObject({ action: 'rejected', comment: 'переделать' });
    expect((await events('t1')).results.map((e) => e.action)).toContain('rejected');
  });
});

describe('регрессия шага -1: архив и вложения', () => {
  it('7. архив -> восстановление: без комментария 400, с комментарием возврат в todo и комментарий в events', async () => {
    const env = await envWith({ ...team, tasks: [{ id: 't1', project_id: 'p1', status: 'done', responsible_user_id: 'w1', done_at: '2026-01-01T00:00:00.000Z' }] });
    const c = await cookie('s1', 'super_admin');
    tg();

    expect((await apiRoutes.request('/tasks/t1', { method: 'DELETE', headers: { Cookie: c } }, env)).status).toBe(200);
    expect((await row('t1'))!.status).toBe('archived');

    // Пустая строка -- это отсутствие причины, а не причина.
    expect((await apiRoutes.request('/tasks/t1/restore', json(c, { comment: '   ' }), env)).status).toBe(400);
    expect((await row('t1'))!.status).toBe('archived');

    expect((await apiRoutes.request('/tasks/t1/restore', json(c, { comment: 'вернули' }), env)).status).toBe(200);
    const t = await row('t1');
    expect(t!.status).toBe('todo');
    // done_at гасится: иначе восстановленная задача мгновенно уедет в автоархив.
    expect(t!.done_at).toBeNull();

    const { results } = await events('t1');
    expect(results.map((e) => e.action)).toEqual(['deleted', 'restored']);
    expect(results[1].comment).toBe('вернули');
  });

  it('8. загрузка вложения кладёт file_id и message_id из Telegram, список отдаёт имя загрузившего', async () => {
    const env = await envWith({ ...team, tasks: [{ id: 't1', project_id: 'p1', status: 'done', responsible_user_id: 'w1' }] });
    const c = await cookie('w1', 'admin');
    tg();

    const form = new FormData();
    form.append('file', new File(['содержимое'], 'акт.pdf', { type: 'application/pdf' }), 'акт.pdf');
    const res = await apiRoutes.request('/tasks/t1/attachments', { method: 'POST', headers: { Cookie: c }, body: form }, env);
    expect(res.status).toBe(201);
    const { id } = await res.json<{ id: string }>();

    const att = await testEnv.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(id).first<Record<string, unknown>>();
    // Это единственное хранилище медиа (ADR-4), поэтому оба идентификатора Telegram
    // обязаны лечь в строку: без message_id нечего удалять, без file_id нечего скачать.
    expect(att).toMatchObject({ task_id: 't1', telegram_file_id: 'file-1', telegram_message_id: '42', filename: 'акт.pdf', mime_type: 'application/pdf', uploaded_by: 'w1' });

    // Статус задачи не мешает вложениям: это справочный материал, а не правка объёма.
    const list = await apiRoutes.request('/tasks/t1/attachments', { headers: { Cookie: c } }, env);
    expect(await list.json()).toMatchObject([{ id, filename: 'акт.pdf', uploaded_by_name: 'Работник' }]);

    expect((await events('t1')).results[0]).toMatchObject({ action: 'attachment_added', comment: 'акт.pdf' });
  });
});

describe('регрессия шага -1: cron', () => {
  it('9. автоархив забирает done старше 7 дней и не трогает шестидневную, событие пишется без актора', async () => {
    const day = 24 * 3600 * 1000;
    const env = await envWith({
      ...team,
      tasks: [
        { id: 'old', project_id: 'p1', status: 'done', responsible_user_id: 'w1', done_at: new Date(Date.now() - 8 * day).toISOString() },
        { id: 'fresh', project_id: 'p1', status: 'done', responsible_user_id: 'w1', done_at: new Date(Date.now() - 6 * day).toISOString() },
      ],
    });
    tg();

    await scheduled({} as ScheduledController, env, {} as ExecutionContext);

    expect((await row('old'))!.status).toBe('archived');
    expect((await row('fresh'))!.status).toBe('done');
    // Актор null -- это отметка «сделала система», по ней архив отличают от ручного.
    expect((await events('old')).results).toEqual([{ action: 'archived', actor_id: null, comment: null, overdue_by: null }]);
    expect((await events('fresh')).results).toEqual([]);
  });
});
