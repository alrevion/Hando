// Шаг 0 плана: пять настоящих багов доступа, скопированных форком из Sayn.
//
// Приёмка шага сформулирована в двух половинах, и здесь они обе:
//   -- поведенческая: super_admin, не связанный с доской, не может её ни
//      прочитать, ни изменить, ни архивировать -- ни саму, ни её содержимое;
//   -- структурная: ни один роут с параметром проекта не обходится без
//      загрузчика доступа.
// Вторая половина важнее первой. Список тестов по одному на маршрут устаревает
// ровно в тот момент, когда кто-то добавляет новый маршрут, -- то есть тогда,
// когда проверка и нужна. Перебор apiRoutes.routes не устаревает.
import { describe, expect, it } from 'vitest';
import { apiRoutes } from '../src/routes';
import { cookie, envWith, stubTelegram } from './fixture';

// Чужая доска: её создал кто-то другой, s1 в ней не состоит. Роль super_admin
// сама по себе доступа не даёт -- в этом и была дыра.
const foreign = () =>
  envWith({
    users: [
      { id: 's1', phone: '+9', name: 'Чужой супер', role: 'super_admin' },
      { id: 'o1', phone: '+8', name: 'Владелец', role: 'super_admin' },
    ],
    memberships: [{ project_id: 'p1', user_id: 'o1' }],
    projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'o1' }],
    tasks: [{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'o1' }],
    attachments: [{ id: 'a1', task_id: 't1', uploaded_by: 'o1', telegram_message_id: '7', telegram_file_id: 'f7', filename: 'смета.pdf', mime_type: 'application/pdf', size_bytes: 10 }],
  });

describe('шаг 0: структурный инвариант', () => {
  it('ни один роут с параметром проекта, задачи или вложения не обходится без загрузчика доступа', () => {
    // Каждая мидлвара регистрируется отдельной строкой с тем же path, поэтому
    // достаточно собрать по пути все обработчики и поискать среди них помеченный.
    const handlers = new Map<string, string[]>();
    for (const r of apiRoutes.routes) {
      const key = `${r.method} ${r.path}`;
      const tag = (r.handler as { accessSource?: string }).accessSource;
      handlers.set(key, [...(handlers.get(key) ?? []), tag ?? '']);
    }

    // Что считается «ведёт на конкретную доску»: явный :projectId либо id
    // ресурса, из которого проект выводится через JOIN.
    const needsLoader = (path: string) =>
      path.includes(':projectId') || path.startsWith('/tasks/:id') || path.startsWith('/attachments/:id');

    const unguarded = [...handlers]
      .filter(([key]) => needsLoader(key.split(' ')[1]))
      .filter(([, tags]) => !tags.some(Boolean))
      .map(([key]) => key);

    expect(unguarded).toEqual([]);
    // Страховка от «инвариант выполнен, потому что подходящих роутов ноль»:
    // если фильтр однажды перестанет что-либо находить, тест обязан упасть.
    expect([...handlers].filter(([key]) => needsLoader(key.split(' ')[1])).length).toBeGreaterThan(10);
  });
});

describe('шаг 0: чужая доска закрыта на чтение и на запись', () => {
  const c = () => cookie('s1', 'super_admin');

  it('архивирование чужого проекта -- 403, а не 200', async () => {
    const env = await foreign();
    const res = await apiRoutes.request('/projects/p1', { method: 'DELETE', headers: { Cookie: await c() } }, env);
    expect(res.status).toBe(403);
  });

  it('восстановление чужого проекта -- 403', async () => {
    const env = await envWith({
      users: [{ id: 's1', phone: '+9', name: 'Чужой супер', role: 'super_admin' }, { id: 'o1', phone: '+8', name: 'Владелец', role: 'super_admin' }],
      memberships: [{ project_id: 'p1', user_id: 'o1' }],
      projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'o1', archived_at: '2026-01-01T00:00:00.000Z' }],
      tasks: [],
    });
    const res = await apiRoutes.request('/projects/p1/restore', { method: 'POST', headers: { Cookie: await c(), 'Content-Type': 'application/json' }, body: '{}' }, env);
    expect(res.status).toBe(403);
  });

  it('архив чужой доски вместе с событийным следом -- 403', async () => {
    const env = await foreign();
    const res = await apiRoutes.request('/projects/p1/archive', { headers: { Cookie: await c() } }, env);
    // Утечка была самой дорогой из трёх: роут отдавал не только задачи, но и
    // журнал действий чужой организации.
    expect(res.status).toBe(403);
  });

  it('список архивных проектов больше не показывает чужую доску', async () => {
    const env = await envWith({
      users: [{ id: 's1', phone: '+9', name: 'Чужой супер', role: 'super_admin' }, { id: 'o1', phone: '+8', name: 'Владелец', role: 'super_admin' }],
      memberships: [{ project_id: 'mine', user_id: 's1' }],
      projects: [
        { id: 'mine', telegram_chat_id: '-100111', created_by: 'o1', archived_at: '2026-01-01T00:00:00.000Z' },
        { id: 'theirs', telegram_chat_id: '-100999', created_by: 'o1', archived_at: '2026-01-02T00:00:00.000Z' },
      ],
      tasks: [],
    });
    const res = await apiRoutes.request('/projects/archived', { headers: { Cookie: await c() } }, env);
    expect(res.status).toBe(200);
    // 200 со списком -- не признак корректности: важно, ЧТО в списке.
    expect((await res.json<{ id: string }[]>()).map((p) => p.id)).toEqual(['mine']);
  });

  it('задача и вложение чужой доски: 403 на скачивание и на удаление', async () => {
    const env = await foreign();
    const stub = stubTelegram();
    try {
      expect((await apiRoutes.request('/tasks/t1', { headers: { Cookie: await c() } }, env)).status).toBe(403);
      expect((await apiRoutes.request('/attachments/a1/download', { headers: { Cookie: await c() } }, env)).status).toBe(403);
      expect((await apiRoutes.request('/attachments/a1', { method: 'DELETE', headers: { Cookie: await c() } }, env)).status).toBe(403);
    } finally {
      stub.mockRestore();
    }
    // Удаление обязано не состояться и в базе, а не только в ответе.
    const still = await env.DB.prepare('SELECT 1 FROM attachments WHERE id = ?').bind('a1').first();
    expect(still).not.toBeNull();
  });

  it('свой человек тем же кодом проходит: 403 выдаёт отсутствие связи, а не сломанный загрузчик', async () => {
    const env = await foreign();
    const own = await cookie('o1', 'super_admin');
    expect((await apiRoutes.request('/tasks/t1', { headers: { Cookie: own } }, env)).status).toBe(200);
    expect((await apiRoutes.request('/projects/p1/archive', { headers: { Cookie: own } }, env)).status).toBe(200);
  });
});

describe('шаг 0: добавление участника проверяет user_id', () => {
  it('несуществующий user_id -- 400 и отдельная формулировка, а не 409 «уже участник»', async () => {
    const env = await envWith({
      users: [{ id: 'o1', phone: '+8', name: 'Владелец', role: 'super_admin' }, { id: 'u1', phone: '+7', name: 'Новичок', role: 'admin' }],
      memberships: [{ project_id: 'p1', user_id: 'o1' }],
      projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'o1' }],
      tasks: [],
    });
    const c = await cookie('o1', 'super_admin');
    const call = (user_id: string) =>
      apiRoutes.request('/projects/p1/members', {
        method: 'POST',
        headers: { Cookie: c, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id }),
      }, env);

    const missing = await call('такого-нет');
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'user_id not found' });

    // Настоящий дубль по-прежнему 409 -- две разные ошибки снова различимы.
    expect((await call('u1')).status).toBe(201);
    expect((await call('u1')).status).toBe(409);
  });
});
