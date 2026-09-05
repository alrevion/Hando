// Приёмка шага 3: адресаты, виды поручений, отказ и авторство.
//
// Четыре инварианта из плана -- SQL-проверки бэкфилла и формы записи. Один
// недостаточен: он доказывает «строка есть», но не «строка указывает на того
// человека».
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { apiRoutes } from '../src/routes';
import { scheduled } from '../src/scheduled';
import { rollup } from '../src/assignees';
import { cookie, envWith, ORG_A, stubTelegram } from './fixture';

let restore: { mockRestore(): void } | null = null;
afterEach(() => { restore?.mockRestore(); restore = null; });
const tg = () => (restore = stubTelegram()) as ReturnType<typeof stubTelegram>;
const sends = (spy: ReturnType<typeof stubTelegram>) =>
  (spy.mock.calls as unknown as [string, { body?: string }][]).filter(([u]) => u.includes('/sendMessage'));

// Директор + четырнадцать сотрудников: ровно тот размер, на котором ломались
// по-задачные таймеры.
const boss = { id: 'boss', phone: '+1', name: 'Директор', role: 'creator' };
const staff = Array.from({ length: 14 }, (_, i) => ({ id: `u${i}`, phone: `+1${i}`, name: `Сотрудник ${i}`, role: 'admin' }));
const world = (tasks: Record<string, unknown>[] = []) =>
  envWith({
    users: [boss, ...staff],
    memberships: [{ project_id: 'p1', user_id: 'boss' }, ...staff.map((u) => ({ project_id: 'p1', user_id: u.id }))],
    projects: [{ id: 'p1', telegram_chat_id: '-100111', created_by: 'boss' }],
    tasks,
  });

const json = (c: string, body: unknown) => ({
  method: 'POST', headers: { Cookie: c, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('шаг 3: свёртка состояний в статус задачи', () => {
  it('пустой кворум даёт archived, а не done', () => {
    // Дефект, найденный при разборе ADR-3: «все неотказавшиеся закрыты» истинно
    // ВАКУУМНО, когда отказались все, -- и задача, которую никто не сделал,
    // закрылась бы как выполненная.
    expect(rollup('each', ['declined', 'declined', 'declined'])).toBe('archived');
    expect(rollup('each', [])).toBe('archived');
  });

  it('each закрывается по всем неотказавшимся, any -- по первому', () => {
    expect(rollup('each', ['done', 'accepted'])).toBe('in_progress');
    expect(rollup('each', ['done', 'done'])).toBe('done');
    // Один отказ из трёх не блокирует закрытие: считаются оставшиеся.
    expect(rollup('each', ['done', 'done', 'declined'])).toBe('done');
    expect(rollup('any', ['done', 'pending'])).toBe('done');
    expect(rollup('single', ['pending'])).toBe('todo');
  });
});

describe('шаг 3: рассылка на четырнадцать человек', () => {
  it('создание кладёт 14 независимых строк, и каждая двигается сама', async () => {
    const env = await world();
    tg();
    const res = await apiRoutes.request('/projects/p1/tasks',
      json(await cookie('boss', 'creator', ORG_A), {
        title: 'Сдать отчёт', assignee_ids: staff.map((u) => u.id), kind: 'each',
        deadline: '2030-01-01T00:00:00.000Z',
      }), env);
    expect(res.status).toBe(201);
    const { id } = await res.json<{ id: string }>();

    const { results } = await testEnv.DB.prepare('SELECT user_id, state FROM task_assignees WHERE task_id = ?').bind(id).all<{ user_id: string; state: string }>();
    expect(results).toHaveLength(14);
    expect(results.every((r) => r.state === 'pending')).toBe(true);

    // Один принял -- задача в работе, но остальные тринадцать всё ещё pending.
    expect((await apiRoutes.request(`/tasks/${id}/move`, json(await cookie('u0', 'admin', ORG_A), { to: 'in_progress' }), env)).status).toBe(200);
    const after = await testEnv.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(id).first<{ status: string }>();
    expect(after!.status).toBe('in_progress');
    const { results: states } = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM task_assignees WHERE task_id = ? AND state = 'pending'").bind(id).all<{ n: number }>();
    expect(states[0].n).toBe(13);
  });

  it('у каждого адресата СВОЙ таймер: cron предупреждает всех, а не одного', async () => {
    const env = await world();
    tg();
    const res = await apiRoutes.request('/projects/p1/tasks',
      json(await cookie('boss', 'creator', ORG_A), {
        title: 'Просроченное', assignee_ids: staff.map((u) => u.id), kind: 'each',
        deadline: '2020-01-01T00:00:00.000Z',
      }), env);
    const { id } = await res.json<{ id: string }>();
    restore!.mockRestore();

    const spy = tg();
    await scheduled({} as ScheduledController, env, {} as ExecutionContext);
    // Это и есть причина переезда таймеров: с по-задачным флагом первая же
    // отправка гасила его, и тринадцать человек не узнавали ничего никогда.
    const overdue = sends(spy).filter(([, init]) => String(init.body).includes('ПРОСРОЧИЛИ'));
    expect(overdue).toHaveLength(14);

    const { n } = (await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM task_assignees WHERE task_id = ? AND last_escalated_at IS NOT NULL').bind(id).first<{ n: number }>())!;
    expect(n).toBe(14);

    // Второй прогон молчит: гейт last_escalated_at держит «ровно один раз».
    const spy2 = tg();
    await scheduled({} as ScheduledController, env, {} as ExecutionContext);
    expect(sends(spy2).filter(([, i]) => String(i.body).includes('ПРОСРОЧИЛИ'))).toHaveLength(0);
  });

  it('один отказ из четырнадцати не блокирует закрытие, четырнадцать дают archived', async () => {
    const env = await world();
    tg();
    const mk = async () => {
      const r = await apiRoutes.request('/projects/p1/tasks',
        json(await cookie('boss', 'creator', ORG_A), { title: 'Рассылка', assignee_ids: staff.map((u) => u.id), kind: 'each' }), env);
      return (await r.json<{ id: string }>()).id;
    };
    const id = await mk();

    // Один отказался, тринадцать сделали.
    expect((await apiRoutes.request(`/tasks/${id}/decline`, json(await cookie('u0', 'admin', ORG_A), { reason: 'болею' }), env)).status).toBe(200);
    for (const u of staff.slice(1)) {
      await apiRoutes.request(`/tasks/${id}/move`, json(await cookie(u.id, 'admin', ORG_A), { to: 'in_progress' }), env);
      await apiRoutes.request(`/tasks/${id}/move`, json(await cookie(u.id, 'admin', ORG_A), { to: 'done' }), env);
    }
    expect((await testEnv.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(id).first<{ status: string }>())!.status).toBe('done');

    // А если откажутся ВСЕ -- задача уходит в архив, а не закрывается как готовая.
    const id2 = await mk();
    for (const u of staff) {
      await apiRoutes.request(`/tasks/${id2}/decline`, json(await cookie(u.id, 'admin', ORG_A), { reason: 'нет' }), env);
    }
    expect((await testEnv.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(id2).first<{ status: string }>())!.status).toBe('archived');
  });

  it('«взялся и не смог» разрешён: accepted -> declined', async () => {
    const env = await world([{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'u0', author_id: 'boss' }]);
    tg();
    await apiRoutes.request('/tasks/t1/move', json(await cookie('u0', 'admin', ORG_A), { to: 'in_progress' }), env);
    // Запрет оставлял бы человеку только rejected, который требует сначала
    // done -- то есть вынуждал бы соврать про выполнение, чтобы отказаться.
    const res = await apiRoutes.request('/tasks/t1/decline', json(await cookie('u0', 'admin', ORG_A), { reason: 'не вышло' }), env);
    expect(res.status).toBe(200);
    const a = await testEnv.DB.prepare("SELECT state, declined_reason FROM task_assignees WHERE task_id='t1'").first<{ state: string; declined_reason: string }>();
    expect(a).toMatchObject({ state: 'declined', declined_reason: 'не вышло' });
  });
});

describe('шаг 3: гейт приёмки -- авторство, а не роль', () => {
  it('сотрудник подтверждает работу директора по СВОЕЙ просьбе', async () => {
    // R1-1: поручения идут в любую сторону. Сотрудник попросил директора --
    // значит принимать работу ему, а не «начальнику».
    const env = await world([{ id: 't1', project_id: 'p1', status: 'done', responsible_user_id: 'boss', author_id: 'u0', done_at: '2026-01-01T00:00:00.000Z' }]);
    tg();
    const res = await apiRoutes.request('/tasks/t1/confirm', json(await cookie('u0', 'admin', ORG_A), {}), env);
    expect(res.status).toBe(200);
  });

  it('посторонний admin не подтверждает чужую задачу', async () => {
    const env = await world([{ id: 't1', project_id: 'p1', status: 'done', responsible_user_id: 'u1', author_id: 'u0', done_at: '2026-01-01T00:00:00.000Z' }]);
    tg();
    const res = await apiRoutes.request('/tasks/t1/confirm', json(await cookie('u2', 'admin', ORG_A), {}), env);
    expect(res.status).toBe(403);
  });

  it('creator остаётся запасным ключом: иначе задачи уволившегося автора не закрыть', async () => {
    const env = await world([{ id: 't1', project_id: 'p1', status: 'done', responsible_user_id: 'u1', author_id: 'u0', done_at: '2026-01-01T00:00:00.000Z' }]);
    tg();
    const res = await apiRoutes.request('/tasks/t1/confirm', json(await cookie('boss', 'creator', ORG_A), {}), env);
    expect(res.status).toBe(200);
  });
});

describe('шаг 3: инварианты после contract-релиза', () => {
  it('остаётся только №4 -- у каждой задачи есть автор', async () => {
    const env = await world([{ id: 'old', project_id: 'p1', status: 'todo', responsible_user_id: 'u0', author_id: 'boss' }]);
    tg();
    await apiRoutes.request('/projects/p1/tasks',
      json(await cookie('boss', 'creator', ORG_A), { title: 'Новая', assignee_ids: ['u0', 'u1'], kind: 'each' }), env);

    // Инварианты 1-3 СНЯТЫ: все три ссылались на tasks.responsible_user_id,
    // которого больше нет. Это не потеря покрытия -- они проверяли, что бэкфилл
    // не разошёлся с колонкой, а колонка удалена. Их предмет («у задачи есть
    // адресат из той же организации») теперь держит внешний ключ и валидация
    // на создании, проверенная отдельными тестами выше.
    const zero = async (label: string, sql: string) => {
      const { n } = (await testEnv.DB.prepare(sql).first<{ n: number }>())!;
      expect(n, label).toBe(0);
    };
    // №4 не снимается НИКОГДА: author_id -- предикат авторизации, и его NULL
    // означает задачу, которую никто не может подтвердить.
    await zero('задача без автора', 'SELECT COUNT(*) AS n FROM tasks WHERE author_id IS NULL');

    // Заодно: адресат всё ещё обязан быть членом организации задачи. Проверка
    // пережила снятие колонки, потому что опиралась на task_assignees.
    await zero('адресат не из организации задачи', `
      SELECT COUNT(*) AS n FROM task_assignees a
        JOIN tasks t ON t.id = a.task_id
        LEFT JOIN org_memberships m ON m.user_id = a.user_id AND m.org_id = t.org_id
          AND (m.left_at IS NULL OR m.left_at > t.created_at)
        WHERE m.user_id IS NULL`);
  });
});


describe('ревью: адресация уведомлений на рассылке', () => {
  // Дефект жил при зелёном наборе, потому что все проверки уведомлений писались
  // на single. На each он давал 14x14 = 196 сообщений за цикл, и в КАЖДОМ стояло
  // имя получателя вместо имени того, кто действовал.

  it('«принял» одного не рассылается остальным тринадцати', async () => {
    const env = await world();
    tg();
    const res = await apiRoutes.request('/projects/p1/tasks',
      json(await cookie('boss', 'creator', ORG_A), { title: 'Рассылка', assignee_ids: staff.map((u) => u.id), kind: 'each' }), env);
    const { id } = await res.json<{ id: string }>();
    await testEnv.DB.prepare('DELETE FROM notifications').run(); // письма о создании не считаем

    await apiRoutes.request(`/tasks/${id}/move`, json(await cookie('u0', 'admin', ORG_A), { to: 'in_progress' }), env);

    const { results } = await testEnv.DB.prepare('SELECT assignee_id FROM notifications WHERE task_id = ?').bind(id).all<{ assignee_id: string }>();
    // Двое: сам u0 (его письмо -- якорь ветки, его заменит эскалация) и автор,
    // которому видеть ход поручённой работы. Остальные тринадцать делают своё --
    // «коллега взял свою часть» их не касается.
    expect(results.map((r) => r.assignee_id).sort()).toEqual(['boss', 'u0']);
  });

  it('в тексте стоит имя ТОГО, КТО ДЕЙСТВОВАЛ, а не получателя', async () => {
    const env = await world();
    tg();
    const res = await apiRoutes.request('/projects/p1/tasks',
      json(await cookie('boss', 'creator', ORG_A), { title: 'Рассылка', assignee_ids: ['u0', 'u1'], kind: 'each' }), env);
    const { id } = await res.json<{ id: string }>();
    await testEnv.DB.prepare('DELETE FROM notifications').run();

    await apiRoutes.request(`/tasks/${id}/move`, json(await cookie('u0', 'admin', ORG_A), { to: 'in_progress' }), env);

    const forAuthor = await testEnv.DB.prepare("SELECT payload FROM notifications WHERE assignee_id = 'boss'").first<{ payload: string }>();
    const text = JSON.parse(forAuthor!.payload).text as string;
    // Директор читает «Сотрудник 0 взял задачу», а не «Директор взял задачу».
    expect(text).toContain('Сотрудник 0');
    expect(text).not.toContain('Директор');
  });

  it('закрытие задачи касается всех: его получают и остальные адресаты', async () => {
    const env = await world();
    tg();
    const res = await apiRoutes.request('/projects/p1/tasks',
      json(await cookie('boss', 'creator', ORG_A), { title: 'Кто первый', assignee_ids: ['u0', 'u1', 'u2'], kind: 'any' }), env);
    const { id } = await res.json<{ id: string }>();
    await apiRoutes.request(`/tasks/${id}/move`, json(await cookie('u0', 'admin', ORG_A), { to: 'in_progress' }), env);
    await testEnv.DB.prepare('DELETE FROM notifications').run();

    await apiRoutes.request(`/tasks/${id}/move`, json(await cookie('u0', 'admin', ORG_A), { to: 'done' }), env);

    const { results } = await testEnv.DB.prepare('SELECT assignee_id FROM notifications WHERE task_id = ?').bind(id).all<{ assignee_id: string }>();
    // Задача закрыта -- это меняет работу остальных: делать её больше не надо.
    expect(results.map((r) => r.assignee_id).sort()).toEqual(['boss', 'u0', 'u1', 'u2']);
  });

  it('отказ доходит до АВТОРА, а не до посторонних исполнителей', async () => {
    const env = await world([{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'u0', author_id: 'boss' }]);
    tg();
    await apiRoutes.request('/tasks/t1/decline', json(await cookie('u0', 'admin', ORG_A), { reason: 'болею' }), env);

    const { results } = await testEnv.DB.prepare("SELECT assignee_id, payload FROM notifications WHERE kind = 'declined'").all<{ assignee_id: string; payload: string }>();
    // Раньше здесь было ПУСТО: рассылка шла «живым адресатам», отказавшийся из
    // списка уже выпал, а автора в списке не было никогда. Задача уезжала в
    // архив молча, и поднять её автор-сотрудник сам не может.
    expect(results.map((r) => r.assignee_id)).toEqual(['boss']);
    expect(JSON.parse(results[0].payload).text).toContain('болею');
    expect((await testEnv.DB.prepare("SELECT status FROM tasks WHERE id='t1'").first<{ status: string }>())!.status).toBe('archived');
  });
});
