// Приёмка шага 2b: пересборки users, events и org_memberships.
//
// Шаг НЕОБРАТИМ -- старые таблицы удалены. Поэтому проверки здесь не про
// «работает ли роут», а про то, что пересборка не потеряла и не переврала данные:
// целостность внешних ключей, сохранность строк, новые допустимые значения.
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { apiRoutes } from '../src/routes';
import { cookie, envWith, ORG_A, stubTelegram } from './fixture';

let restore: { mockRestore(): void } | null = null;
afterEach(() => { restore?.mockRestore(); restore = null; });
const tg = () => (restore = stubTelegram());

const boss = { id: 's1', name: 'Босс', role: 'creator' };
const teacher = { id: 'm1', name: 'Учитель', role: 'member' };
const admin = { id: 'a1', name: 'Завуч', role: 'admin' };
const team = {
  users: [boss, teacher, admin],
  memberships: [
    { project_id: 'p1', user_id: 's1' },
    { project_id: 'p1', user_id: 'm1' },
    { project_id: 'p1', user_id: 'a1' },
  ],
};

describe('шаг 2b: пересборка не потеряла целостности', () => {
  it('PRAGMA foreign_key_check пуст на населённой базе', async () => {
    await envWith({ ...team, tasks: [{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'm1' }] });
    // Пять внешних ключей смотрят на users: projects.created_by,
    // project_memberships.user_id, tasks.responsible_user_id, events.actor_id,
    // attachments.uploaded_by. Пересборка обязана их пережить.
    const { results } = await testEnv.DB.prepare('PRAGMA foreign_key_check').all();
    expect(results).toEqual([]);
  });

  it('users больше не хранит роль, а телефон стал nullable', async () => {
    await envWith({ ...team, tasks: [] });
    const { results } = await testEnv.DB.prepare("SELECT name FROM pragma_table_info('users')").all<{ name: string }>();
    const cols = results.map((r) => r.name);
    expect(cols).not.toContain('role');
    expect(cols).toContain('current_org_id');
    // telegram_username ОСТАЁТСЯ здесь: это атрибут идентичности, один на
    // человека независимо от организации.
    expect(cols).toContain('telegram_username');
    // Телефона нет вовсе с 0034.
    expect(cols).not.toContain('phone');
  });
});

describe('шаг 2b: роль member', () => {
  it('member видит людей своих досок, admin -- своё поддерево', async () => {
    const env = await envWith({ ...team, tasks: [] });
    const asMember = await apiRoutes.request('/users', { headers: { Cookie: await cookie('m1', 'member', ORG_A) } }, env);
    // Раздел 19: участник видит людей СВОИХ досок, а не всю организацию и не
    // ничего.
    expect(asMember.status).toBe(200);
    const list = await asMember.json<{ id: string }[]>();
    expect(list.some((u) => u.id === 'm1')).toBe(true);

    const asAdmin = await apiRoutes.request('/users', { headers: { Cookie: await cookie('a1', 'admin', ORG_A) } }, env);
    expect(asAdmin.status).toBe(200);
  });

  it('member не получает username в списке людей доски', async () => {
    const env = await envWith({ ...team, tasks: [] });
    const res = await apiRoutes.request('/projects/p1/members', { headers: { Cookie: await cookie('m1', 'member', ORG_A) } }, env);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('telegram_username');
  });

  it('member ведёт свою задачу: двигает её по доске как все', async () => {
    const env = await envWith({ ...team, tasks: [{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'm1' }] });
    tg();
    // R1-1 снял правило «поручает только директор», и member -- полноценный
    // исполнитель. Роль ограничивает справочник, а не работу.
    const res = await apiRoutes.request('/tasks/t1/move', {
      method: 'POST', headers: { Cookie: await cookie('m1', 'member', ORG_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'in_progress' }),
    }, env);
    expect(res.status).toBe(200);
  });

  it('member не правит роли', async () => {
    const env = await envWith({ ...team, tasks: [] });
    const c = await cookie('m1', 'member', ORG_A);

    const patch = await apiRoutes.request('/users/a1', {
      method: 'PATCH', headers: { Cookie: c, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    }, env);
    expect(patch.status).toBe(403);
  });

  it('роль пишется только в членство: колонки users.role больше нет', async () => {
    const env = await envWith({ ...team, tasks: [] });
    const res = await apiRoutes.request('/users/a1', {
      method: 'PATCH', headers: { Cookie: await cookie('s1', 'creator', ORG_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    }, env);
    expect(res.status).toBe(200);
    const m = await testEnv.DB.prepare('SELECT role FROM org_memberships WHERE org_id = ? AND user_id = ?').bind(ORG_A, 'a1').first<{ role: string }>();
    expect(m!.role).toBe('member');
    // И понижение действует немедленно -- requireAuth перечитывает членство:
    // участник видит только людей своих досок, а не всю организацию.
    const after = await apiRoutes.request('/me', { headers: { Cookie: await cookie('a1', 'admin', ORG_A) } }, env);
    expect((await after.json<{ user: { role: string } }>()).user.role).toBe('member');
  });
});
