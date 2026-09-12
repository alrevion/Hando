// Иерархия по приглашениям -- шаг 4 концепции (раздел 19).
//
// Дерево: кто кого пригласил. Владелец видит всё; руководитель отдела -- свои
// доски и своё поддерево; участник -- людей своих досок. Заявка по личной
// ссылке приходит её хозяину. Заморозка и удаление возвращают открытые
// поручения авторам вопросом «кому переназначить?».
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { botApp } from '../src/bot';
import { createOrg } from '../src/signup';
import { apiRoutes } from '../src/routes';
import { drainOutbox } from '../src/outbox';
import { mintSession } from '../src/auth';
import { cookie, envWith, ORG_A, SECRET, stubTelegram } from './fixture';
import type { Env } from '../src/types';

let restore: { mockRestore(): void } | null = null;
afterEach(() => { restore?.mockRestore(); restore = null; });
const tg = () => (restore = stubTelegram()) as ReturnType<typeof stubTelegram>;
type Sent = { chat_id: string; text: string; reply_markup?: { inline_keyboard?: { text: string; url?: string }[][] } };
const sent = (spy: ReturnType<typeof stubTelegram>) =>
  (spy.mock.calls as unknown as [string, { body?: string }][])
    .filter(([u]) => u.includes('/sendMessage')).map(([, i]) => JSON.parse(String(i.body)) as Sent);

// boss -> a1 -> w1 (доска p1: boss, a1, w1); boss -> a2 -> w2 (доска p2: a2, w2).
const world = async () => {
  const env = await envWith({
    users: [
      { id: 'boss', phone: '+1', name: 'Директор', role: 'creator' },
      { id: 'a1', phone: '+2', name: 'Алия Маркетинг', role: 'admin' },
      { id: 'a2', phone: '+3', name: 'Бахтияр Бухгалтер', role: 'admin' },
      { id: 'w1', phone: '+4', name: 'Азиз Каримов', role: 'member' },
      { id: 'w2', phone: '+5', name: 'Вика Счетовод', role: 'member' },
    ],
    memberships: [
      { project_id: 'p1', user_id: 'boss' }, { project_id: 'p1', user_id: 'a1' }, { project_id: 'p1', user_id: 'w1' },
      { project_id: 'p2', user_id: 'a2' }, { project_id: 'p2', user_id: 'w2' },
    ],
    projects: [{ id: 'p1', telegram_chat_id: '-100111', created_by: 'boss' }, { id: 'p2', telegram_chat_id: '-100222', created_by: 'boss' }],
    tasks: [{ id: 't1', project_id: 'p1', title: 'Отчёт по рекламе', status: 'todo', responsible_user_id: 'w1', author_id: 'boss' }],
  });
  const tree: [string, string][] = [['a1', 'boss'], ['a2', 'boss'], ['w1', 'a1'], ['w2', 'a2']];
  for (const [u, by] of tree) {
    await testEnv.DB.prepare('UPDATE org_memberships SET invited_by = ? WHERE org_id = ? AND user_id = ?').bind(by, ORG_A, u).run();
  }
  return env;
};
const api = async (env: Env, path: string, method = 'GET', body?: unknown, who = 'boss', role = 'creator') =>
  apiRoutes.request(path, {
    method, headers: { Cookie: await cookie(who, role, ORG_A), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env);
const ids = async (res: Response) => (await res.json<{ id: string }[]>()).map((u) => u.id).sort();
const hook = (env: Env, update: unknown) =>
  botApp.request('/webhook', {
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  }, env);
const say = (env: Env, tgId: string, text: string) =>
  hook(env, { message: { chat: { id: tgId, type: 'private' }, from: { id: tgId, first_name: 'Новый', username: 'newbie' }, text } });
const press = (env: Env, tgId: string, data: string) =>
  hook(env, { callback_query: { id: 'cb', from: { id: tgId, first_name: 'Ч' }, data, message: { chat: { id: tgId }, message_id: 7 } } });

describe('видимость по дереву', () => {
  it('владелец -- всех; руководитель -- доски и поддерево; участник -- людей своих досок', async () => {
    const env = await world();
    expect(await ids(await api(env, '/users'))).toEqual(['a1', 'a2', 'boss', 'w1', 'w2']);
    expect(await ids(await api(env, '/users', 'GET', undefined, 'a1', 'admin'))).toEqual(['a1', 'boss', 'w1']);
    expect(await ids(await api(env, '/users', 'GET', undefined, 'a2', 'admin'))).toEqual(['a2', 'w2']);
    expect(await ids(await api(env, '/users', 'GET', undefined, 'w1', 'member'))).toEqual(['a1', 'boss', 'w1']);
    // Снимок отдаёт тот же список всем ролям.
    const snap = await (await api(env, '/org/snapshot', 'GET', undefined, 'w2', 'member')).json<{ users: { id: string }[]; can_see_users: boolean }>();
    expect(snap.can_see_users).toBe(true);
    expect(snap.users.map((u) => u.id).sort()).toEqual(['a2', 'w2']);
  });

  it('создатель числится участником отделов, которые завёл вместе с организацией', async () => {
    const env = await envWith({ users: [{ id: 'boss', phone: '+1', name: 'Директор', role: 'creator' }], memberships: [], tasks: [] });
    tg();
    await testEnv.DB.prepare("INSERT INTO users (id, phone, name, telegram_user_id, onboarded_at) VALUES ('f1', '+7', 'Отец', 'tg-f1', datetime('now'))").run();
    const { orgId } = await createOrg(env, 'f1', 'Семья', 'home_family');
    // Отделы профиля -- доски, и владелец обязан быть НА КАЖДОЙ: видимость
    // людей считается по участию, и без строки его не увидел бы никто из
    // добавленных им же.
    const boards = (await testEnv.DB.prepare('SELECT id FROM projects WHERE org_id = ?').bind(orgId).all<{ id: string }>()).results;
    expect(boards.length).toBeGreaterThan(0);
    const mine = (await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM project_memberships WHERE org_id = ? AND user_id = ?')
      .bind(orgId, 'f1').first<{ n: number }>())!.n;
    expect(mine).toBe(boards.length);
  });

  it('задача с ЧУЖОЙ доски видна исполнителю: иначе принятое поручение пропадает', async () => {
    const env = await world();
    tg();
    // Вика состоит только на p2. Владелец поручает ей задачу на p1 -- членом
    // p1 она от этого не становится, но задача обязана быть в её снимке:
    // карточку в Telegram она получила и приняла.
    expect((await api(env, '/projects/p1/tasks', 'POST', { title: 'Собрать вещи', responsible_user_id: 'w2' }, 'boss', 'creator')).status).toBe(201);
    const snap = await (await api(env, '/org/snapshot', 'GET', undefined, 'w2', 'member'))
      .json<{ projects: { id: string }[]; tasks: { title: string; project_name: string }[] }>();
    const seen = snap.tasks.find((t) => t.title === 'Собрать вещи')!;
    expect(seen).toBeTruthy();
    // Имя доски приезжает с задачей -- в списке своих досок чужой p1 нет и быть не должно.
    expect(seen.project_name).toBeTruthy();
    expect(snap.projects.map((p) => p.id)).toEqual(['p2']);
  });

  it('поручать можно только видимым: чужой отдел -- отказ, у владельца -- нет границ', async () => {
    const env = await world();
    tg();
    expect((await api(env, '/projects/p2/tasks', 'POST', { title: 'Х', responsible_user_id: 'w1' }, 'a2', 'admin')).status).toBe(400);
    expect((await api(env, '/projects/p2/tasks', 'POST', { title: 'Х', responsible_user_id: 'w2' }, 'a2', 'admin')).status).toBe(201);
    expect((await api(env, '/projects/p1/tasks', 'POST', { title: 'Х', responsible_user_id: 'w2' }, 'boss', 'creator')).status).toBe(201);
    // Диктовка: имя из чужого отдела не узнаётся вовсе.
    const d = await (await api(env, '/tasks/dictate', 'POST', { text: 'Азизу подготовить отчёт', mode: 'assigned' }, 'a2', 'admin')).json<{ id: string; assignee_ids: string[] }>();
    expect(d.assignee_ids).toEqual([]);
    expect((await api(env, `/drafts/${d.id}`, 'PATCH', { assignee_ids: ['w1'] }, 'a2', 'admin')).status).toBe(400);
    expect((await api(env, `/drafts/${d.id}`, 'PATCH', { assignee_ids: ['w2'] }, 'a2', 'admin')).status).toBe(200);
  });

  it('бот: имя из чужого отдела не узнаётся, а замороженному не подтвердить', async () => {
    const env = await world();
    tg();
    // a2 диктует «Азизу» -- Азиз в чужом отделе: адресат не узнан, черновик на себя.
    await say(env, 'tg-a2', 'Азизу подготовить отчёт');
    const d = (await testEnv.DB.prepare("SELECT id, assignee_ids FROM drafts WHERE author_id='a2'").first<{ id: string; assignee_ids: string }>())!;
    expect(JSON.parse(d.assignee_ids)).toEqual(['a2']);
    // a1 диктует Азизу (свой), но до «Создать» Азиза заморозили.
    await say(env, 'tg-a1', 'Азизу подготовить отчёт');
    const d1 = (await testEnv.DB.prepare("SELECT id FROM drafts WHERE author_id='a1'").first<{ id: string }>())!;
    await testEnv.DB.prepare('UPDATE org_memberships SET frozen_at = ? WHERE org_id = ? AND user_id = ?').bind('2026-01-01', ORG_A, 'w1').run();
    await press(env, 'tg-a1', `dc:${d1.id}`);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM tasks WHERE title = ?').bind('Подготовить отчёт').first<{ n: number }>())!.n).toBe(0);
    expect((await api(env, `/drafts/${d1.id}/confirm`, 'POST', {}, 'a1', 'admin')).status).toBe(409);
  });

  it('«Все задания» -- поддерево, не вся организация', async () => {
    const env = await world();
    const titles = async (who: string, role: string) => {
      const r = await api(env, '/org/subtree-tasks', 'GET', undefined, who, role);
      if (r.status !== 200) return r.status;
      return (await r.json<{ tasks: { title: string }[] }>()).tasks.map((t) => t.title);
    };
    expect(await titles('a1', 'admin')).toEqual(['Отчёт по рекламе']); // адресат w1 в поддереве a1
    expect(await titles('a2', 'admin')).toEqual([]);
    expect(await titles('boss', 'creator')).toEqual(['Отчёт по рекламе']);
    expect(await titles('w1', 'member')).toBe(403);
  });
});

describe('личная ссылка-приглашение', () => {
  it('заявка приходит хозяину ссылки; он подтверждает и сажает на свою доску', async () => {
    const env = await world();
    const spy = tg();
    expect((await api(env, `/orgs/${ORG_A}/invite`, 'GET', undefined, 'w1', 'member')).status).toBe(403);
    const { code, link } = await (await api(env, `/orgs/${ORG_A}/invite`, 'GET', undefined, 'a1', 'admin')).json<{ code: string; link: string }>();
    expect(link).toBe(`https://t.me/hando_ai_bot?start=j_${code}`);

    // Незнакомец: сначала имя, потом заявка -- в ней должно стоять имя.
    await say(env, 'tg-new', `/start j_${code}`);
    expect(sent(spy).at(-1)!.text).toContain('Как к Вам обращаться');
    await say(env, 'tg-new', 'Нигора Юсупова');
    const card = sent(spy).find((m) => m.chat_id === 'tg-a1')!;
    expect(card.text).toContain('К Вам просится в «org-a»: Нигора Юсупова (@newbie)');
    expect(card.reply_markup!.inline_keyboard!.flat().map((b) => b.text)).toEqual(['✅ Принять', '✖️ Отклонить', '💬 Написать']);
    expect(card.reply_markup!.inline_keyboard!.flat().find((b) => b.url)!.url).toBe('https://t.me/newbie');
    expect(sent(spy).some((m) => m.chat_id === 'tg-boss' && m.text.includes('просится'))).toBe(false);

    const newbie = (await testEnv.DB.prepare("SELECT id FROM users WHERE telegram_user_id = 'tg-new'").first<{ id: string }>())!;
    const m = await testEnv.DB.prepare('SELECT invited_by, confirmed_at FROM org_memberships WHERE org_id = ? AND user_id = ?').bind(ORG_A, newbie.id).first<{ invited_by: string; confirmed_at: string | null }>();
    expect(m).toEqual({ invited_by: 'a1', confirmed_at: null });

    // Заявки: владелец видит все, a2 -- не эту.
    expect((await (await api(env, '/memberships/pending')).json<{ user_id: string }[]>()).map((r) => r.user_id)).toEqual([newbie.id]);
    expect(await (await api(env, '/memberships/pending', 'GET', undefined, 'a2', 'admin')).json()).toEqual([]);
    expect((await api(env, `/memberships/${newbie.id}/approve`, 'POST', { role: 'member' }, 'a2', 'admin')).status).toBe(404);

    await press(env, 'tg-a1', `join_ok:${newbie.id}`);
    await press(env, 'tg-a1', `jr:${newbie.id}:m`);
    const after = await testEnv.DB.prepare('SELECT confirmed_at, role FROM org_memberships WHERE org_id = ? AND user_id = ?').bind(ORG_A, newbie.id).first<{ confirmed_at: string | null; role: string }>();
    expect(after!.confirmed_at).not.toBeNull();
    expect(after!.role).toBe('member');
    const board = await testEnv.DB.prepare('SELECT project_id FROM project_memberships WHERE user_id = ?').bind(newbie.id).first<{ project_id: string }>();
    expect(board!.project_id).toBe('p1');
    // И теперь она в поддереве a1.
    expect(await ids(await api(env, '/users', 'GET', undefined, 'a1', 'admin'))).toEqual(['a1', 'boss', newbie.id, 'w1'].sort());
  });

  it('руководитель отдела заводит доску и принимает работу в своём поддереве', async () => {
    const env = await world();
    tg();
    expect((await api(env, '/projects', 'POST', { name: 'Наружка' }, 'a1', 'admin')).status).toBe(201);
    expect((await api(env, '/projects', 'POST', { name: 'Х' }, 'w1', 'member')).status).toBe(403);
    // Задача, которую поручил w1 (в поддереве a1) -- сдана; a1 принимает, a2 -- нет.
    await testEnv.DB.prepare("UPDATE tasks SET author_id = 'w1', status = 'done', done_at = '2026-09-10T00:00:00.000Z' WHERE id = 't1'").run();
    await testEnv.DB.prepare("UPDATE task_assignees SET state = 'done', done_at = '2026-09-10T00:00:00.000Z' WHERE task_id = 't1'").run();
    expect((await api(env, '/tasks/t1/confirm', 'POST', {}, 'a2', 'admin')).status).toBe(403);
    expect((await api(env, '/tasks/t1/confirm', 'POST', {}, 'a1', 'admin')).status).toBe(200);
  });

  it('ролей две при подтверждении: super_admin не выдаётся', async () => {
    const env = await world();
    tg();
    expect((await api(env, '/users/w1', 'PATCH', { role: 'super_admin' })).status).toBe(400);
    expect((await api(env, '/users/w1', 'PATCH', { role: 'admin' }, 'a2', 'admin')).status).toBe(403);
    expect((await api(env, '/users/w1', 'PATCH', { role: 'admin' }, 'a1', 'admin')).status).toBe(200);
  });
});

describe('заморозка и удаление', () => {
  const inbox = async () => (await testEnv.DB.prepare('SELECT kind, assignee_id, payload FROM notifications').all<{ kind: string; assignee_id: string; payload: string }>()).results;

  it('заморозка: задачи возвращаются автору с кнопками, строки не трогаются, уведомления замороженному гаснут', async () => {
    const env = await world();
    tg();
    expect((await api(env, '/users/w1/freeze', 'POST', {}, 'a2', 'admin')).status).toBe(403); // не его поддерево
    const res = await api(env, '/users/w1/freeze', 'POST', {}, 'a1', 'admin');
    expect(res.status).toBe(200);
    expect((await res.json<{ returned: number }>()).returned).toBe(1);
    const back = (await inbox()).find((n) => n.kind === 'returned')!;
    expect(back.assignee_id).toBe('boss');
    const p = JSON.parse(back.payload) as { text: string; keyboard: { text: string }[][] };
    expect(p.text).toContain('Заморожен: Азиз Каримов');
    expect(p.keyboard.flat().map((b) => b.text)).toEqual(['👤 Переназначить', '🗑 Отменить задачу', '📱 Открыть']);
    expect((await testEnv.DB.prepare("SELECT state FROM task_assignees WHERE task_id='t1'").first<{ state: string }>())!.state).toBe('pending');
    // Поручать замороженному нельзя; уведомление ему гасится, а не ждёт.
    expect((await api(env, '/projects/p1/tasks', 'POST', { title: 'Х', responsible_user_id: 'w1' })).status).toBe(400);
    await testEnv.DB.prepare("INSERT INTO notifications (id, task_id, assignee_id, org_id, kind, payload) VALUES ('n1','t1','w1',?,'x',?)")
      .bind(ORG_A, JSON.stringify({ recipient_user_id: 'w1', text: 'T', delete_message_id: null, track: false })).run();
    expect(await drainOutbox(env)).toBe(0);
    expect((await testEnv.DB.prepare("SELECT sent_at FROM notifications WHERE id='n1'").first<{ sent_at: string | null }>())!.sent_at).not.toBeNull();
    // Разморозка.
    expect((await api(env, '/users/w1/unfreeze', 'POST', {}, 'a1', 'admin')).status).toBe(200);
    expect((await api(env, '/projects/p1/tasks', 'POST', { title: 'Х', responsible_user_id: 'w1' })).status).toBe(201);
  });

  it('удаление: история остаётся, задачи возвращаются автору, человеку приходит весть', async () => {
    const env = await world();
    const spy = tg();
    expect((await api(env, `/orgs/${ORG_A}/members/w1`, 'DELETE', undefined, 'a1', 'admin')).status).toBe(200);
    // Исключённому пишем НАПРЯМУЮ: очередь проверяет членство при отправке, а
    // его больше нет -- письмо не ушло бы никогда, и задачи просто исчезли бы
    // у человека без объяснений.
    expect(sent(spy).some((m) => m.text.includes('Вас исключили'))).toBe(true);
    expect((await inbox()).some((n) => n.kind === 'returned' && JSON.parse(n.payload).text.includes('Удалён из организации: Азиз Каримов'))).toBe(true);
    const m = await testEnv.DB.prepare('SELECT left_at FROM org_memberships WHERE org_id = ? AND user_id = ?').bind(ORG_A, 'w1').first<{ left_at: string | null }>();
    expect(m!.left_at).not.toBeNull();
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id='t1'").first<{ n: number }>())!.n).toBe(1);
  });
});

describe('удаление организации перевыпускает куку', () => {
  it('единственная организация: кука без организации, а не 401 до перезагрузки', async () => {
    const env = await world();
    tg();
    const res = await api(env, `/orgs/${ORG_A}`, 'DELETE');
    expect(res.status).toBe(200);
    expect(await res.json<{ org_id: string | null }>()).toMatchObject({ org_id: null });
    // Кука пришла в ответе -- следующий запрос идёт уже с ней, и это НЕ 401.
    const fresh = `session=${/session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]}`;
    const me = await apiRoutes.request('/me', { headers: { Cookie: fresh } }, env);
    expect(me.status).toBe(200);
    expect((await me.json<{ user: { org_id: string | null } }>()).user.org_id).toBeNull();
  });

  it('осталась вторая организация -- кука выпускается на неё', async () => {
    const env = await world();
    tg();
    await testEnv.DB.prepare("INSERT INTO orgs (id, name, timezone) VALUES ('org-2', 'Вторая', 'Asia/Tashkent')").run();
    await testEnv.DB.prepare(
      `INSERT INTO org_memberships (id, org_id, user_id, role, confirmed_at, created_at)
       VALUES ('m-2', 'org-2', 'boss', 'creator', datetime('now'), datetime('now'))`,
    ).run();
    const res = await api(env, `/orgs/${ORG_A}`, 'DELETE');
    expect(await res.json<{ org_id: string | null }>()).toMatchObject({ org_id: 'org-2' });
    const fresh = `session=${/session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]}`;
    const snap = await apiRoutes.request('/org/snapshot', { headers: { Cookie: fresh } }, env);
    expect(snap.status).toBe(200);
  });
});

describe('сессия без организации', () => {
  it('открыт только экран «создайте или вступите»; после создания -- обычная сессия', async () => {
    const env = await envWith({ users: [{ id: 'boss', phone: '+1', name: 'Директор', role: 'creator' }], memberships: [], tasks: [] });
    tg();
    await testEnv.DB.prepare("INSERT INTO users (id, phone, name, telegram_user_id, onboarded_at) VALUES ('lone', '+9', 'Один', 'tg-lone', datetime('now'))").run();
    const orgless = `session=${await mintSession(SECRET, { sub: 'lone', role: 'member', org_id: null })}`;
    const me = await apiRoutes.request('/me', { headers: { Cookie: orgless } }, env);
    expect(me.status).toBe(200);
    expect((await me.json<{ user: { org_id: string | null; pending: string[] } }>()).user).toMatchObject({ org_id: null, pending: [] });
    expect((await apiRoutes.request('/org/snapshot', { headers: { Cookie: orgless } }, env)).status).toBe(401);
    const created = await apiRoutes.request('/orgs', { method: 'POST', headers: { Cookie: orgless, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Своя', pack: 'family' }) }, env);
    expect(created.status).toBe(201);
    const fresh = created.headers.get('set-cookie')!.split(';')[0];
    expect((await apiRoutes.request('/org/snapshot', { headers: { Cookie: fresh } }, env)).status).toBe(200);
    // Семья -- 24/7.
    const o = await testEnv.DB.prepare('SELECT always_on, quiet_hours FROM orgs WHERE name = ?').bind('Своя').first();
    expect(o).toEqual({ always_on: 1, quiet_hours: 0 });
  });
});
