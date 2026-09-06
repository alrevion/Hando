// Приёмка шага 2a: мультитенантность.
//
// Центральная часть -- РЕЕСТР РОУТОВ. Перечислять проверки вручную бессмысленно:
// список устаревает ровно тогда, когда кто-то добавляет роут, то есть в
// единственный момент, когда проверка нужна. Поэтому тест перебирает
// apiRoutes.routes и требует, чтобы КАЖДЫЙ роут был в карте фикстур; отсутствие
// роута в карте -- падение, а не пропуск.
//
// Фикстура двойного членства обязательна и не декоративна. Пока users носили
// org_id, хватало «токен А против идентификаторов Б». Теперь человек глобальный,
// и появился класс, которого та фикстура не покрывает: человек, состоящий И в А,
// И в Б, с сессией в А, трогает идентификаторы Б. Код вида
// EXISTS(SELECT 1 FROM org_memberships WHERE user_id = ?) без AND org_id = ?
// прошёл бы старую фикстуру зелёным -- и мутационная проверка тоже.
// О МУТАЦИОННОЙ ПРОВЕРКЕ ИЗОЛЯЦИИ -- и о том, чего она НЕ доказывает.
//
// Разово прогонялся оператор «удалить `AND org_id = ?`» по всем вхождениям
// предиката (на момент прогона 2026-09-04 их было 32; с тех пор код вырос, и
// цифра в комментарии протухла бы в тот же день). Половина мутаций роняла набор,
// половина -- нет, и неубиваемые были вторыми рубежами на путях, чей первый
// рубеж уже перекрыт `requireProjectAccess`.
//
// РЕЗУЛЬТАТ ТОГО ПРОГОНА ЗДЕСЬ НЕ ЗАПИСАН НОМЕРАМИ НАМЕРЕННО. Прежняя редакция
// перечисляла «middleware #1/#3, routes #11-#14…» -- нумерацию по порядку
// вхождения в файл, которая ничего не значит уже после первой правки и не
// проверяется даже автором через месяц. Утверждение, которое нельзя
// переаудировать, хуже отсутствующего: оно выглядит как гарантия.
//
// Чего этот оператор НЕ ловит по построению, и это важнее его результата:
//   -- НЕВЕРНОЕ значение предиката (`bind(row.org_id)` вместо организации
//      сессии) -- полный обход изоляции, переживающий все мутации до одной;
//   -- ОТСУТСТВУЮЩИЙ предикат: удалить можно лишь то, что есть. Этот класс
//      держит реестр роутов ниже, а не мутации;
//   -- дефекты на ЗАПИСИ: оператор смотрит SELECT;
//   -- изоляцию НЕ через org_id: `left_at`, `current_org_id`, скоуп ролей.
//
// То есть мутации доказывают «эти тесты не тавтологичны», а не «покрытие
// достаточно». Смешивать эти два утверждения нельзя -- именно на таком
// смешении и дожили до прода дефекты, найденные консенсус-ревью.
//
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { apiRoutes } from '../src/routes';
import { mcpSessionClaims, mintSession, resolveOrgId } from '../src/auth';
import { cookie, envWith, ORG_A, ORG_B, SECRET, stubTelegram } from './fixture';
import type { Env } from '../src/types';

let restore: { mockRestore(): void } | null = null;
afterEach(() => {
  restore?.mockRestore();
  restore = null;
});
const tg = () => (restore = stubTelegram()) as ReturnType<typeof stubTelegram>;

// Два арендатора. `both` состоит в обеих организациях -- это и есть фикстура,
// без которой тест изоляции обесценен.
const both = { id: 'both', phone: '+1', name: 'Двойной', role: 'creator', orgs: [ORG_A, ORG_B] };
const aOnly = { id: 'a1', phone: '+2', name: 'Только А', role: 'admin', orgs: [ORG_A] };
const bOnly = { id: 'b1', phone: '+3', name: 'Только Б', role: 'creator', orgs: [ORG_B] };
// Рядовой сотрудник в ОБЕИХ организациях. Нужен отдельно от `both`: тот creator,
// а у creator'а в списках досок своя ветка -- ветка «участник» без него слепа.
const worker = { id: 'w', phone: '+4', name: 'Сотрудник', role: 'admin', orgs: [ORG_A, ORG_B] };

// Мир: у каждой организации своя доска, задача и вложение.
const world = () =>
  envWith({
    users: [both, aOnly, bOnly, worker],
    memberships: [
      { project_id: 'pa', user_id: 'both', org_id: ORG_A },
      { project_id: 'pa', user_id: 'a1', org_id: ORG_A },
      { project_id: 'pb', user_id: 'both', org_id: ORG_B },
      { project_id: 'pb', user_id: 'b1', org_id: ORG_B },
      { project_id: 'pb-arch', user_id: 'b1', org_id: ORG_B },
      { project_id: 'pa', user_id: 'w', org_id: ORG_A },
      { project_id: 'pb', user_id: 'w', org_id: ORG_B },
      { project_id: 'pb-arch', user_id: 'w', org_id: ORG_B },
    ],
    projects: [
      { id: 'pa', telegram_chat_id: '-100111', created_by: 'both', org_id: ORG_A },
      // У организации Б есть И живая доска, И архивная. Пока была только
      // архивная, половина проверок была слепой: живой список её не показывал бы
      // и без всякой изоляции.
      { id: 'pb', telegram_chat_id: '-100222', created_by: 'both', org_id: ORG_B },
      { id: 'pb-arch', telegram_chat_id: '-100333', created_by: 'both', org_id: ORG_B, archived_at: '2026-01-01T00:00:00.000Z' },
    ],
    tasks: [
      { id: 'ta', project_id: 'pa', status: 'todo', responsible_user_id: 'a1', org_id: ORG_A },
      { id: 'tb', project_id: 'pb', status: 'done', responsible_user_id: 'b1', org_id: ORG_B, done_at: '2026-01-02T00:00:00.000Z' },
      // Закрытая задача ДВОЙНОГО человека в организации Б: без неё «мой архив»
      // нечем было отличить от чужого -- он и так пуст.
      { id: 'tb-mine', project_id: 'pb', status: 'archived', responsible_user_id: 'both', org_id: ORG_B },
      { id: 'ta-mine', project_id: 'pa', status: 'archived', responsible_user_id: 'both', org_id: ORG_A },
    ],
    attachments: [
      { id: 'ab', task_id: 'tb', uploaded_by: 'b1', telegram_message_id: '9', telegram_file_id: 'fb', filename: 'секрет.pdf', mime_type: 'application/pdf', size_bytes: 5, org_id: ORG_B },
      { id: 'aa', task_id: 'ta', uploaded_by: 'a1', telegram_message_id: '8', telegram_file_id: 'fa', filename: 'смета-А.pdf', mime_type: 'application/pdf', size_bytes: 5, org_id: ORG_A },
    ],
  });

// Карта фикстур: для каждого роута -- запрос, целящийся в ИДЕНТИФИКАТОРЫ
// ОРГАНИЗАЦИИ Б. `skip` -- роуты, у которых предмета изоляции нет (публичный
// вход, «моё»), с явной причиной: молчаливый пропуск неотличим от забытого роута.
type Probe = { path: string; method?: string; body?: unknown; skip?: string };
const FIXTURES: Record<string, Probe> = {
  'POST /auth/login': { path: '/auth/login', method: 'POST', body: { phone: '+3' }, skip: 'публичный: до сессии организации ещё нет' },
  'POST /auth/verify': { path: '/auth/verify', method: 'POST', body: { phone: '+3', code: '1' }, skip: 'публичный: до сессии организации ещё нет' },
  'POST /auth/logout': { path: '/auth/logout', method: 'POST', skip: 'гасит свою же куку, чужих идентификаторов не принимает' },
  'GET /me': { path: '/me', skip: 'отдаёт только себя в СВОЕЙ организации; проверяется отдельным тестом ниже' },
  'GET /archive/mine': { path: '/archive/mine', skip: 'отдаёт только свои задачи; проверяется отдельным тестом ниже' },
  'GET /users': { path: '/users', skip: 'списочный: проверяется отдельным тестом на содержимое' },
  'GET /projects': { path: '/projects', skip: 'списочный: проверяется отдельным тестом на содержимое' },
  'GET /projects/archived': { path: '/projects/archived', skip: 'списочный: проверяется отдельным тестом на содержимое' },
  'POST /projects': { path: '/projects', method: 'POST', body: { name: 'x', telegram_group_id: '111' }, skip: 'создаёт в своей организации; чужих идентификаторов не принимает' },
  'POST /users': { path: '/users', method: 'POST', body: { phone: '+3', name: 'x', role: 'admin' }, skip: 'штатно добавляет членство существующему телефону -- см. отдельный тест' },

  'PATCH /users/:id': { path: '/users/b1', method: 'PATCH', body: { name: 'взломан' } },
  // pb-arch добавлен в мир -- значит и в карту, иначе она перестала бы быть полной.
  'DELETE /projects/:projectId': { path: '/projects/pb', method: 'DELETE' },
  'POST /projects/:projectId/restore': { path: '/projects/pb-arch/restore', method: 'POST', body: {} },
  'GET /projects/:projectId/archive': { path: '/projects/pb/archive' },
  'GET /projects/:projectId/members': { path: '/projects/pb/members' },
  'POST /projects/:projectId/members': { path: '/projects/pb/members', method: 'POST', body: { user_id: 'b1' } },
  'DELETE /projects/:projectId/members/:userId': { path: '/projects/pb/members/b1', method: 'DELETE' },
  'DELETE /orgs/:orgId/members/:userId': { path: `/orgs/${ORG_B}/members/b1`, method: 'DELETE' },
  'GET /projects/:projectId/tasks': { path: '/projects/pb/tasks' },
  'POST /projects/:projectId/tasks': { path: '/projects/pb/tasks', method: 'POST', body: { title: 'x', responsible_user_id: 'b1' } },
  'GET /tasks/:id': { path: '/tasks/tb' },
  'PATCH /tasks/:id': { path: '/tasks/tb', method: 'PATCH', body: { title: 'взломан' } },
  'POST /tasks/:id/move': { path: '/tasks/tb/move', method: 'POST', body: { to: 'done' } },
  'DELETE /tasks/:id': { path: '/tasks/tb', method: 'DELETE' },
  'POST /tasks/:id/restore': { path: '/tasks/tb/restore', method: 'POST', body: { comment: 'x' } },
  'POST /tasks/:id/confirm': { path: '/tasks/tb/confirm', method: 'POST', body: {} },
  'POST /tasks/:id/reject': { path: '/tasks/tb/reject', method: 'POST', body: { comment: 'x', extra_days: 1 } },
  'POST /tasks/:id/decline': { path: '/tasks/tb/decline', method: 'POST', body: { reason: 'не буду' } },
  'GET /tasks/:id/assignees': { path: '/tasks/tb/assignees' },
  'POST /tasks/:id/attachments': { path: '/tasks/tb/attachments', method: 'POST' },
  'GET /tasks/:id/attachments': { path: '/tasks/tb/attachments' },
  'GET /attachments/:id/download': { path: '/attachments/ab/download' },
  'DELETE /attachments/:id': { path: '/attachments/ab', method: 'DELETE' },
};

const registered = () => {
  const keys = new Set<string>();
  for (const r of apiRoutes.routes) {
    if (r.path === '/*') continue; // requireAuth, смонтирован на всё
    keys.add(`${r.method} ${r.path}`);
  }
  return [...keys];
};

describe('шаг 2a: реестр роутов покрыт целиком', () => {
  it('каждый зарегистрированный роут есть в карте фикстур', () => {
    const missing = registered().filter((k) => !(k in FIXTURES));
    expect(missing).toEqual([]);
    // И наоборот: карта не должна нести роутов, которых уже нет -- иначе она
    // выглядит полной, покрывая несуществующее.
    const stale = Object.keys(FIXTURES).filter((k) => !registered().includes(k));
    expect(stale).toEqual([]);
    expect(registered().length).toBeGreaterThan(25);
  });
});

describe('шаг 2a: токен организации А против идентификаторов организации Б', () => {
  // Сессия выдана в А, но человек состоит И в Б. Это и есть тот класс, который
  // старая фикстура пропускала.
  const probes = Object.entries(FIXTURES).filter(([, p]) => !p.skip);

  it.each(probes)('%s -- отказ, без данных организации Б', async (key, probe) => {
    const env = await world();
    tg();
    const init: RequestInit = { method: probe.method ?? 'GET', headers: { Cookie: await cookie('both', 'creator', ORG_A) } };
    if (probe.body !== undefined) {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(probe.body);
    }
    const res = await apiRoutes.request(probe.path, init, env);

    // 400/403/404 -- отказ. 200 недопустим ни в каком виде.
    expect([400, 403, 404], `${key} ответил ${res.status}`).toContain(res.status);

    // Тело не должно содержать ни идентификаторов, ни данных организации Б.
    const text = await res.text();
    for (const leak of ['секрет.pdf', 'Только Б', '-100222']) {
      expect(text, `${key} протёк: ${leak}`).not.toContain(leak);
    }
  });

  it('ни одна запись организации Б не изменилась после всех проб', async () => {
    const env = await world();
    tg();
    for (const [, probe] of probes) {
      const init: RequestInit = { method: probe.method ?? 'GET', headers: { Cookie: await cookie('both', 'creator', ORG_A) } };
      if (probe.body !== undefined) {
        (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
        init.body = JSON.stringify(probe.body);
      }
      await apiRoutes.request(probe.path, init, env);
    }
    // Отказ в ответе и отсутствие записи -- разные утверждения. Проверяем второе.
    const task = await testEnv.DB.prepare("SELECT title, status FROM tasks WHERE id='tb'").first<{ title: string; status: string }>();
    expect(task).toMatchObject({ title: 'T', status: 'done' });
    const user = await testEnv.DB.prepare("SELECT name FROM users WHERE id='b1'").first<{ name: string }>();
    expect(user!.name).toBe('Только Б');
    // Проба DELETE целилась в живую pb -- она обязана остаться живой.
    const live = await testEnv.DB.prepare("SELECT archived_at FROM projects WHERE id='pb'").first<{ archived_at: string | null }>();
    expect(live!.archived_at).toBeNull();
    // Проба restore целилась в архивную -- она обязана остаться архивной.
    const arch = await testEnv.DB.prepare("SELECT archived_at FROM projects WHERE id='pb-arch'").first<{ archived_at: string | null }>();
    expect(arch!.archived_at).not.toBeNull();
    const att = await testEnv.DB.prepare("SELECT 1 FROM attachments WHERE id='ab'").first();
    expect(att).not.toBeNull();
  });
});

describe('шаг 2a: списочные роуты не отдают чужого', () => {
  const asA = () => cookie('both', 'creator', ORG_A);

  it('GET /users отдаёт только людей своей организации', async () => {
    const env = await world();
    const res = await apiRoutes.request('/users', { headers: { Cookie: await asA() } }, env);
    const ids = (await res.json<{ id: string }[]>()).map((u) => u.id).sort();
    expect(ids).toEqual(['a1', 'both', 'w']);
  });

  it('GET /projects и /projects/archived отдают только доски своей организации', async () => {
    const env = await world();
    const live = await apiRoutes.request('/projects', { headers: { Cookie: await asA() } }, env);
    expect((await live.json<{ id: string }[]>()).map((p) => p.id)).toEqual(['pa']);
    const arch = await apiRoutes.request('/projects/archived', { headers: { Cookie: await asA() } }, env);
    // pb архивный, но чужой -- список обязан быть пуст.
    expect(await arch.json()).toEqual([]);
  });

  it('GET /me и /archive/mine показывают человека в ТЕКУЩЕЙ организации', async () => {
    const env = await world();
    const me = await apiRoutes.request('/me', { headers: { Cookie: await asA() } }, env);
    expect(await me.json()).toMatchObject({ user: { id: 'both', org_id: ORG_A } });

    // Тот же человек с сессией в Б видит себя в Б -- один аккаунт, разные
    // контексты. Ради этого R1-2 и вводился.
    const meB = await apiRoutes.request('/me', { headers: { Cookie: await cookie('both', 'creator', ORG_B) } }, env);
    expect(await meB.json()).toMatchObject({ user: { id: 'both', org_id: ORG_B } });
  });
});

describe('шаг 2a: байпасы creator ограничены организацией', () => {
  it('creator организации Б не видит проектов А ни списком, ни поштучно, ни через вложения', async () => {
    const env = await world();
    const c = await cookie('b1', 'creator', ORG_B);
    // 1) GET /projects (routes.ts, ветка creator). Свою доску он видит --
    // важно, что ЧУЖОЙ в списке нет.
    const list = await apiRoutes.request('/projects', { headers: { Cookie: c } }, env);
    expect((await list.json<{ id: string }[]>()).map((p) => p.id)).toEqual(['pb']);
    // 2) requireProjectAccess (middleware.ts, безусловный байпас до 2a)
    expect((await apiRoutes.request('/projects/pa/tasks', { headers: { Cookie: c } }, env)).status).toBe(403);
    expect((await apiRoutes.request('/tasks/ta', { headers: { Cookie: c } }, env)).status).toBe(403);
    // 3) вложения (бывший attachmentForAccess). Целимся во вложение организации
    // А: 'ab' принадлежит самому b1, и отказ по нему ничего не доказал бы.
    expect((await apiRoutes.request('/attachments/aa/download', { headers: { Cookie: c } }, env)).status).toBe(403);
  });
});

describe('шаг 2a: адресатом не станет чужой человек', () => {
  it('responsible_user_id чужой организации отбивается на создании и на правке', async () => {
    const env = await world();
    const c = await cookie('both', 'creator', ORG_A);
    tg();
    const create = await apiRoutes.request('/projects/pa/tasks', {
      method: 'POST', headers: { Cookie: c, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x', responsible_user_id: 'b1' }),
    }, env);
    expect(create.status).toBe(400);

    const patch = await apiRoutes.request('/tasks/ta', {
      method: 'PATCH', headers: { Cookie: c, 'Content-Type': 'application/json' },
      body: JSON.stringify({ responsible_user_id: 'b1' }),
    }, env);
    expect(patch.status).toBe(400);
    // Уведомление с заголовком задачи чужому человеку не ушло бы -- но важнее,
    // что и ответственный не сменился.
    // Адресат живёт в task_assignees с contract-релиза.
    expect((await testEnv.DB.prepare("SELECT user_id FROM task_assignees WHERE task_id='ta'").first<{ user_id: string }>())!.user_id).toBe('a1');
  });

  it('POST /projects/:id/members не принимает человека чужой организации', async () => {
    const env = await world();
    const res = await apiRoutes.request('/projects/pa/members', {
      method: 'POST', headers: { Cookie: await cookie('both', 'creator', ORG_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'b1' }),
    }, env);
    expect(res.status).toBe(400);
  });
});

describe('шаг 2a: живая сессия, выпущенная до деплоя', () => {
  it('токен без claim org_id не даёт ни 500, ни пустой доски', async () => {
    const env = await world();
    // Ровно тот вид токена, что лежит в браузерах на момент деплоя: без org_id.
    const legacy = `session=${await mintSession(SECRET, { sub: 'a1', role: 'admin' } as never)}`;
    const res = await apiRoutes.request('/projects', { headers: { Cookie: legacy } }, env);
    expect(res.status).toBe(200);
    // Не пустая: догруз через users.current_org_id отработал.
    expect((await res.json<{ id: string }[]>()).map((p) => p.id)).toEqual(['pa']);

    // И на роль-гейте тоже: requireRole сам разбирает токен заново.
    const gated = await apiRoutes.request('/projects/archived', { headers: { Cookie: legacy } }, env);
    expect(gated.status).toBe(403); // admin, не super_admin -- отказ по РОЛИ, а не 500
  });
});

describe('шаг 2a: MCP заперт на пилотную организацию', () => {
  const mcpEnv = (over: Partial<Env>) => ({ DB: testEnv.DB, MCP_ORG_ID: ORG_A, ...over }) as Env;

  it('пользователь пилотной организации получает claims, чужой -- нет', async () => {
    await world();
    expect(await mcpSessionClaims(mcpEnv({}), 'a1')).toMatchObject({ sub: 'a1', org_id: ORG_A, role: 'admin' });
    // b1 состоит только в Б -- дверь заперта.
    expect(await mcpSessionClaims(mcpEnv({}), 'b1')).toBeNull();
  });

  it('пустой MCP_ORG_ID -- отказ, а не «пропускаем всё»', async () => {
    await world();
    expect(await mcpSessionClaims(mcpEnv({ MCP_ORG_ID: '' }), 'a1')).toBeNull();
  });

  it('отозванное членство закрывает дверь', async () => {
    await world();
    await testEnv.DB.prepare("UPDATE org_memberships SET left_at = '2026-01-01' WHERE org_id = ? AND user_id = 'a1'").bind(ORG_A).run();
    expect(await mcpSessionClaims(mcpEnv({}), 'a1')).toBeNull();
  });
});

describe('шаг 2a: отзыв членства', () => {
  it('мягкий отзыв гасит доступ и переставляет липкий контекст', async () => {
    const env = await world();
    const res = await apiRoutes.request(`/orgs/${ORG_A}/members/a1`, {
      method: 'DELETE', headers: { Cookie: await cookie('both', 'creator', ORG_A) },
    }, env);
    expect(res.status).toBe(200);

    // Строка не удалена -- задачи и события по-прежнему ссылаются на живого человека.
    const m = await testEnv.DB.prepare("SELECT left_at FROM org_memberships WHERE org_id = ? AND user_id='a1'").bind(ORG_A).first<{ left_at: string | null }>();
    expect(m!.left_at).not.toBeNull();
    // Других членств нет -> current обнулён, а не оставлен на организации, из
    // которой человека уволили.
    expect(await resolveOrgId(testEnv.DB, 'a1')).toBeNull();
    // И войти он больше не может.
    // 401, а не 403: членства больше нет, то есть это не «нет прав», а «сессия
    // недействительна» -- человеку надо войти заново.
    expect((await apiRoutes.request('/projects', { headers: { Cookie: await cookie('a1', 'admin', ORG_A) } }, env)).status).toBe(401);
  });

  it('у человека с двумя членствами отзыв одного переставляет контекст на второе', async () => {
    const env = await world();
    await apiRoutes.request(`/orgs/${ORG_B}/members/both`, {
      method: 'DELETE', headers: { Cookie: await cookie('b1', 'creator', ORG_B) },
    }, env);
    expect(await resolveOrgId(testEnv.DB, 'both')).toBe(ORG_A);
  });
});

describe('шаг 2a: формы записи, а не только бэкфилл', () => {
  it('после сквозного сценария ни одна тенантная строка не осталась без организации', async () => {
    const env = await world();
    tg();
    const c = await cookie('both', 'creator', ORG_A);
    const json = (body: unknown) => ({ headers: { Cookie: c, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    // Человек -> проект -> членство -> задача -> вложение -> событие -> ПЕРЕХОД.
    // Переход обязателен: без него не родится строка в notifications.
    const u = await apiRoutes.request('/users', { method: 'POST', ...json({ phone: '+77', name: 'Новый', role: 'admin' }) }, env);
    expect(u.status).toBe(201);
    const { id: newUser } = await u.json<{ id: string }>();

    const pr = await apiRoutes.request('/projects', { method: 'POST', ...json({ name: 'Новая доска', telegram_group_id: '999' }) }, env);
    expect(pr.status).toBe(201);
    const { id: newProject } = await pr.json<{ id: string }>();

    expect((await apiRoutes.request(`/projects/${newProject}/members`, { method: 'POST', ...json({ user_id: newUser }) }, env)).status).toBe(201);

    const tk = await apiRoutes.request(`/projects/${newProject}/tasks`, { method: 'POST', ...json({ title: 'Задача', responsible_user_id: newUser }) }, env);
    expect(tk.status).toBe(201);
    const { id: newTask } = await tk.json<{ id: string }>();

    const form = new FormData();
    form.append('file', new File(['x'], 'файл.pdf', { type: 'application/pdf' }), 'файл.pdf');
    expect((await apiRoutes.request(`/tasks/${newTask}/attachments`, { method: 'POST', headers: { Cookie: c }, body: form }, env)).status).toBe(201);

    // Переход: задачу двигает ответственный, поэтому сессия -- его.
    const own = await cookie(newUser, 'admin', ORG_A);
    expect((await apiRoutes.request(`/tasks/${newTask}/move`, {
      method: 'POST', headers: { Cookie: own, 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'in_progress' }),
    }, env)).status).toBe(200);

    for (const table of ['projects', 'project_memberships', 'tasks', 'events', 'attachments', 'notifications']) {
      const { n } = (await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id IS NULL`).first<{ n: number }>())!;
      expect(n, `${table} содержит строки без организации`).toBe(0);
    }

    // И ни одного человека без хотя бы одного членства: users org_id не носит,
    // поэтому «принадлежит» для неё означает именно это.
    const { n: orphans } = (await testEnv.DB.prepare(
      'SELECT COUNT(*) AS n FROM users u WHERE NOT EXISTS (SELECT 1 FROM org_memberships m WHERE m.user_id = u.id)',
    ).first<{ n: number }>())!;
    expect(orphans).toBe(0);
  });
});


describe('шаг 2a: предикаты, до которых загрузчик доступа не доходит', () => {
  // Роуты ниже проходят гейт штатно: доска своя, человек свой. Изоляцию здесь
  // держит собственный предикат обработчика, и проверить его можно только так --
  // отказом гейта эти строки не прикрыты.
  const asA = () => cookie('both', 'creator', ORG_A);

  it('«мой архив» не смешивает задачи двух организаций одного человека', async () => {
    const env = await world();
    const res = await apiRoutes.request('/archive/mine', { headers: { Cookie: await asA() } }, env);
    const ids = (await res.json<{ task: { id: string } }[]>()).map((r) => r.task.id);
    // tb-mine -- его же задача, но в организации Б. Фильтр по
    // responsible_user_id её НЕ отсекает: человек глобальный.
    expect(ids).toEqual(['ta-mine']);
  });

  it('живой список досок не показывает живую доску другой организации', async () => {
    const env = await world();
    const res = await apiRoutes.request('/projects', { headers: { Cookie: await asA() } }, env);
    expect((await res.json<{ id: string }[]>()).map((p) => p.id)).toEqual(['pa']);
  });

  it('архивный список не показывает архивную доску другой организации', async () => {
    const env = await world();
    // b1 -- creator в Б и состоит в pb-arch: ветка «участник», а не «creator».
    const res = await apiRoutes.request('/projects/archived', { headers: { Cookie: await cookie('b1', 'creator', ORG_B) } }, env);
    expect((await res.json<{ id: string }[]>()).map((p) => p.id)).toEqual(['pb-arch']);
  });

  it('GET /me берёт членство ИМЕННО текущей организации', async () => {
    const env = await world();
    const meB = await apiRoutes.request('/me', { headers: { Cookie: await cookie('both', 'creator', ORG_B) } }, env);
    const body = await meB.json<{ user: { org_id: string; org_name: string } }>();
    expect(body.user.org_id).toBe(ORG_B);
    expect(body.user.org_name).toBe(ORG_B);
  });

  it('чужого человека по телефону НЕ присоединить: это была цепочка захвата аккаунта', async () => {
    const env = await world();
    // b1 существует и состоит только в Б. Раньше здесь молча создавалось
    // членство в А -- и этого хватало, чтобы пройти гейт PATCH /users/:id,
    // переписать ГЛОБАЛЬНЫЙ телефон жертвы на свой, войти под ней и оказаться
    // в ЕЁ организациях. Согласия жертвы не спрашивали, уведомления не было.
    const res = await apiRoutes.request('/users', {
      method: 'POST', headers: { Cookie: await asA(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+3', name: 'Только Б', role: 'admin' }),
    }, env);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'INVITE_REQUIRED' });

    // Членства не появилось.
    const { results } = await testEnv.DB.prepare("SELECT org_id FROM org_memberships WHERE user_id='b1'").all<{ org_id: string }>();
    expect(results.map((r) => r.org_id)).toEqual([ORG_B]);
  });

  it('идентичность человека из нескольких организаций не правит один арендатор', async () => {
    const env = await world();
    // `w` -- рядовой сотрудник, состоящий и в А, и в Б. Цель именно такая:
    // у `both` роль creator, а её менять запрещено отдельным правилом, и тест
    // проверял бы не то.
    const res = await apiRoutes.request('/users/w', {
      method: 'PATCH', headers: { Cookie: await cookie('b1', 'creator', ORG_B), 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+79990000000' }),
    }, env);
    expect(res.status).toBe(403);
    expect((await testEnv.DB.prepare("SELECT phone FROM users WHERE id='w'").first<{ phone: string }>())!.phone).toBe('+4');

    // А роль -- правит: она org-скоупная, и в чужую организацию не протекает.
    const role = await apiRoutes.request('/users/w', {
      method: 'PATCH', headers: { Cookie: await cookie('b1', 'creator', ORG_B), 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    }, env);
    expect(role.status).toBe(200);
    const { results } = await testEnv.DB.prepare("SELECT org_id, role FROM org_memberships WHERE user_id='w' ORDER BY org_id").all<{ org_id: string; role: string }>();
    expect(results).toEqual([{ org_id: ORG_A, role: 'admin' }, { org_id: ORG_B, role: 'member' }]);
  });

  it('своего отозванного сотрудника вернуть по телефону МОЖНО: согласие уже было', async () => {
    const env = await world();
    await testEnv.DB.prepare("UPDATE org_memberships SET left_at='2026-01-01' WHERE user_id='w' AND org_id=?").bind(ORG_A).run();
    const res = await apiRoutes.request('/users', {
      method: 'POST', headers: { Cookie: await asA(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+4', name: 'Сотрудник', role: 'admin' }),
    }, env);
    expect(res.status).toBe(201);
    const m = await testEnv.DB.prepare("SELECT left_at FROM org_memberships WHERE user_id='w' AND org_id=?").bind(ORG_A).first<{ left_at: string | null }>();
    expect(m!.left_at).toBeNull();
  });

  it('понижение роли меняет членство ТОЛЬКО в текущей организации', async () => {
    const env = await world();
    // both -- creator в обеих. Понижаем его в А от лица creator'а Б? Нет:
    // роль правит creator организации А, а цель -- человек с двумя членствами.
    // Для этого нужен второй creator в А.
    await testEnv.DB.prepare("INSERT INTO users (id, phone, name, current_org_id) VALUES ('boss','+9','Босс А',?)").bind(ORG_A).run();
    await testEnv.DB.prepare("INSERT INTO org_memberships (id, org_id, user_id, role, confirmed_at) VALUES ('m-boss',?, 'boss','creator',datetime('now'))").bind(ORG_A).run();

    const res = await apiRoutes.request('/users/a1', {
      method: 'PATCH', headers: { Cookie: await cookie('boss', 'creator', ORG_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'super_admin' }),
    }, env);
    expect(res.status).toBe(200);

    // Теперь то же для человека с двумя членствами: правка в А не смеет
    // задеть его роль в Б.
    const before = await testEnv.DB.prepare("SELECT role FROM org_memberships WHERE user_id='both' AND org_id=?").bind(ORG_B).first<{ role: string }>();
    await apiRoutes.request('/users/both', {
      method: 'PATCH', headers: { Cookie: await cookie('boss', 'creator', ORG_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Переименован' }),
    }, env);
    const after = await testEnv.DB.prepare("SELECT role FROM org_memberships WHERE user_id='both' AND org_id=?").bind(ORG_B).first<{ role: string }>();
    expect(after).toEqual(before);
  });

  it('липкий контекст, указывающий на отозванное членство, не воскрешает доступ', async () => {
    await world();
    // current_org_id остался на А, но членство там отозвано. resolveOrgId обязан
    // это заметить и уйти на оставшееся членство, а не поверить колонке.
    await testEnv.DB.prepare("UPDATE org_memberships SET left_at='2026-01-01' WHERE user_id='both' AND org_id=?").bind(ORG_A).run();
    expect(await resolveOrgId(testEnv.DB, 'both')).toBe(ORG_B);
  });
});


describe('шаг 2a: ветка «участник» и записи по членствам', () => {
  it('рядовой сотрудник двух организаций видит доски только текущей', async () => {
    const env = await world();
    const asA = await cookie('w', 'admin', ORG_A);
    const live = await apiRoutes.request('/projects', { headers: { Cookie: asA } }, env);
    expect((await live.json<{ id: string }[]>()).map((p) => p.id)).toEqual(['pa']);

    // Тот же человек в Б видит доски Б -- и только их.
    const asB = await cookie('w', 'admin', ORG_B);
    const liveB = await apiRoutes.request('/projects', { headers: { Cookie: asB } }, env);
    expect((await liveB.json<{ id: string }[]>()).map((p) => p.id)).toEqual(['pb']);
  });

  it('архивный список по ветке «участник» тоже не смешивает организации', async () => {
    const env = await world();
    // Сотрудник состоит в архивной доске Б. С сессией в А архивных досок у него нет.
    // Роут под requireRole('super_admin','creator'), поэтому поднимаем роль в А.
    await testEnv.DB.prepare("UPDATE org_memberships SET role='super_admin' WHERE user_id='w'").run();
    const inA = await apiRoutes.request('/projects/archived', { headers: { Cookie: await cookie('w', 'super_admin', ORG_A) } }, env);
    expect(await inA.json()).toEqual([]);
    const inB = await apiRoutes.request('/projects/archived', { headers: { Cookie: await cookie('w', 'super_admin', ORG_B) } }, env);
    expect((await inB.json<{ id: string }[]>()).map((p) => p.id)).toEqual(['pb-arch']);
  });

  it('справочник людей доски не показывает creator чужой организации', async () => {
    const env = await world();
    const res = await apiRoutes.request('/projects/pa/members', { headers: { Cookie: await cookie('both', 'creator', ORG_A) } }, env);
    const ids = (await res.json<{ id: string }[]>()).map((u) => u.id).sort();
    // b1 -- creator, и ветка `WHERE m.role='creator'` затянула бы его сюда, не
    // будь она org-условием. Это прямой путь к утечке через справочник людей.
    expect(ids).toEqual(['a1', 'both', 'w']);
  });

  it('понижение роли человека двух организаций не трогает вторую', async () => {
    const env = await world();
    await testEnv.DB.prepare("INSERT INTO users (id, phone, name, current_org_id) VALUES ('boss2','+91','Босс',?)").bind(ORG_A).run();
    await testEnv.DB.prepare("INSERT INTO org_memberships (id, org_id, user_id, role, confirmed_at) VALUES ('m-boss2',?,'boss2','creator',datetime('now'))").bind(ORG_A).run();

    const res = await apiRoutes.request('/users/w', {
      method: 'PATCH', headers: { Cookie: await cookie('boss2', 'creator', ORG_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'super_admin' }),
    }, env);
    expect(res.status).toBe(200);

    const { results } = await testEnv.DB.prepare("SELECT org_id, role FROM org_memberships WHERE user_id='w' ORDER BY org_id").all<{ org_id: string; role: string }>();
    // Повышен только в А. В Б -- как был.
    expect(results).toEqual([{ org_id: ORG_A, role: 'super_admin' }, { org_id: ORG_B, role: 'admin' }]);
  });

  it('отзыв членства в одной организации не трогает членство в другой', async () => {
    const env = await world();
    const res = await apiRoutes.request(`/orgs/${ORG_A}/members/w`, {
      method: 'DELETE', headers: { Cookie: await cookie('both', 'creator', ORG_A) },
    }, env);
    expect(res.status).toBe(200);

    const { results } = await testEnv.DB.prepare("SELECT org_id, left_at FROM org_memberships WHERE user_id='w' ORDER BY org_id").all<{ org_id: string; left_at: string | null }>();
    expect(results[0].org_id).toBe(ORG_A);
    expect(results[0].left_at).not.toBeNull();
    expect(results[1]).toMatchObject({ org_id: ORG_B, left_at: null });
    // Липкий контекст переставлен на оставшуюся организацию.
    expect((await testEnv.DB.prepare("SELECT current_org_id FROM users WHERE id='w'").first<{ current_org_id: string }>())!.current_org_id).toBe(ORG_B);
  });

  it('отзыв НЕ трогает липкий контекст, если текущая организация другая', async () => {
    const env = await world();
    // Сотрудник сейчас работает в Б (current = ORG_B), отзывают его из А.
    await testEnv.DB.prepare("UPDATE users SET current_org_id = ? WHERE id='w'").bind(ORG_B).run();
    await apiRoutes.request(`/orgs/${ORG_A}/members/w`, {
      method: 'DELETE', headers: { Cookie: await cookie('both', 'creator', ORG_A) },
    }, env);
    // Контекст обязан остаться нетронутым: человек не должен «переехать» из-за
    // события в организации, где он и не находился.
    expect((await testEnv.DB.prepare("SELECT current_org_id FROM users WHERE id='w'").first<{ current_org_id: string }>())!.current_org_id).toBe(ORG_B);
  });

  it('воскрешение отозванного членства не переписывает роль в другой организации', async () => {
    const env = await world();
    await testEnv.DB.prepare("UPDATE org_memberships SET left_at='2026-01-01' WHERE user_id='w' AND org_id=?").bind(ORG_A).run();
    // Добавляем его в А заново -- по телефону, как это делает владелец.
    const res = await apiRoutes.request('/users', {
      method: 'POST', headers: { Cookie: await cookie('both', 'creator', ORG_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+4', name: 'Сотрудник', role: 'super_admin' }),
    }, env);
    expect(res.status).toBe(201);
    const { results } = await testEnv.DB.prepare("SELECT org_id, role, left_at FROM org_memberships WHERE user_id='w' ORDER BY org_id").all<{ org_id: string; role: string; left_at: string | null }>();
    expect(results[0]).toMatchObject({ org_id: ORG_A, role: 'super_admin', left_at: null });
    // В Б роль осталась прежней -- воскрешение адресное.
    expect(results[1]).toMatchObject({ org_id: ORG_B, role: 'admin' });
  });
});
