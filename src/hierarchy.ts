// Иерархия по приглашениям (раздел 19).
//
// Видимость строится по ДЕРЕВУ «кто кого пригласил», а не по плоскому
// «руководитель видит всё»: руководитель маркетинга видит своих людей и то, что
// они делают, но не видит бухгалтерию. Владелец видит всё. Участник -- людей
// своих досок. Роли три: creator, admin (руководитель отдела), member.
import type { Env, Role, Task } from './types';
import { chunks, nowIso, uuid } from './db';
import { buildNotification } from './transition';
import type { InlineButton } from './telegram';

const BOSS: Role[] = ['creator', 'super_admin'];

/** Все, кого человек пригласил, и дальше по дереву. Себя не включает. */
export async function subtreeOf(env: Env, orgId: string, userId: string): Promise<Set<string>> {
  const { results } = await env.DB.prepare(
    `SELECT user_id, invited_by FROM org_memberships
     WHERE org_id = ? AND left_at IS NULL AND confirmed_at IS NOT NULL AND invited_by IS NOT NULL`,
  ).bind(orgId).all<{ user_id: string; invited_by: string }>();
  const children = new Map<string, string[]>();
  for (const r of results) {
    const list = children.get(r.invited_by) ?? [];
    list.push(r.user_id);
    children.set(r.invited_by, list);
  }
  const seen = new Set<string>();
  const queue = [userId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const kid of children.get(cur) ?? []) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      queue.push(kid);
    }
  }
  seen.delete(userId);
  return seen;
}

/** Люди досок, где человек состоит. Себя не включает. */
async function boardMates(env: Env, orgId: string, userId: string): Promise<Set<string>> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT b.user_id FROM project_memberships a
     JOIN project_memberships b ON b.project_id = a.project_id AND b.org_id = a.org_id
     WHERE a.org_id = ? AND a.user_id = ? AND b.user_id <> ?`,
  ).bind(orgId, userId, userId).all<{ user_id: string }>();
  return new Set(results.map((r) => r.user_id));
}

/**
 * Кого человек видит (и кому может поручать): владелец -- всех; руководитель
 * отдела -- своё поддерево и людей своих досок; участник -- людей своих досок.
 * 'all' -- без ограничения.
 */
export async function visibleUserIds(env: Env, orgId: string, userId: string, role: Role): Promise<Set<string> | 'all'> {
  if (BOSS.includes(role)) return 'all';
  const set = await boardMates(env, orgId, userId);
  set.add(userId);
  if (role === 'admin') for (const id of await subtreeOf(env, orgId, userId)) set.add(id);
  return set;
}

export type Member = {
  id: string; name: string; role: Role; position: string | null; telegram_username: string | null;
  aliases: string | null; frozen_at: string | null; invited_by: string | null;
};

/** Действующие участники, видимые человеку. Замороженные видны (с пометкой), но поручать им нельзя. */
export async function visibleMembers(env: Env, orgId: string, userId: string, role: Role): Promise<Member[]> {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, m.role AS role, m.position AS position, u.telegram_username, u.aliases, m.frozen_at, m.invited_by
     FROM users u JOIN org_memberships m ON m.user_id = u.id
     WHERE m.org_id = ? AND m.left_at IS NULL AND m.confirmed_at IS NOT NULL ORDER BY u.name, u.id`,
  ).bind(orgId).all<Member>();
  const visible = await visibleUserIds(env, orgId, userId, role);
  return visible === 'all' ? results : results.filter((m) => visible.has(m.id));
}

/** Кому можно поручать: видимые, действующие, не замороженные. */
export async function assignableMembers(env: Env, orgId: string, userId: string, role: Role): Promise<Member[]> {
  return (await visibleMembers(env, orgId, userId, role)).filter((m) => !m.frozen_at);
}

export async function canAssign(env: Env, orgId: string, userId: string, role: Role, targetIds: string[]): Promise<boolean> {
  const ok = new Set((await assignableMembers(env, orgId, userId, role)).map((m) => m.id));
  return targetIds.every((id) => ok.has(id));
}

/** Право менять человека (роль, заморозка, удаление): владелец -- любого, руководитель отдела -- в своём поддереве. */
export async function canManageMember(env: Env, orgId: string, actorId: string, role: Role, targetId: string): Promise<boolean> {
  if (targetId === actorId) return false;
  if (BOSS.includes(role)) return true;
  if (role !== 'admin') return false;
  return (await subtreeOf(env, orgId, actorId)).has(targetId);
}

/**
 * Открытые поручения человека возвращаются авторам вопросом «кому
 * переназначить?». СТРОКИ НЕ ТРОГАЮТСЯ: у единственного адресата отказ увёл бы
 * задачу в архив (свёртка), а переназначение и так гасит прежние строки, когда
 * автор нажмёт кнопку. Замороженный тем временем молчит на уровне очереди.
 */
export async function returnOpenTasks(env: Env, orgId: string, userId: string, actorId: string, why: string): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT t.* FROM task_assignees a JOIN tasks t ON t.id = a.task_id
     WHERE a.user_id = ? AND a.org_id = ? AND a.state IN ('pending','accepted','rejected')
       AND t.status NOT IN ('archived','done') AND t.author_id IS NOT NULL AND t.author_id <> ?`,
  ).bind(userId, orgId, userId).all<Task>();
  const who = await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(userId).first<{ name: string }>();
  const writes: D1PreparedStatement[] = [];
  for (const task of results) {
    const buttons: InlineButton[][] = [[
      ...(task.kind !== 'each' ? [{ text: '👤 Переназначить', callback_data: `ra:${task.id}:` }] : []),
      { text: '🗑 Отменить задачу', callback_data: `cancel:${task.id}` },
    ]];
    writes.push(await buildNotification(env, task, 'returned', {
      emoji: '↩️', label: `${why}: ${who?.name ?? 'сотрудник'}`, extraLine: 'Кому переназначить?', buttons,
    }, task.deadline ?? null, task.author_id as string, userId));
    writes.push(env.DB.prepare(
      `INSERT INTO events (id, actor_id, org_id, target_type, target_id, action, comment, overdue_by, created_at)
       VALUES (?, ?, ?, 'task', ?, 'returned', ?, NULL, ?)`,
    ).bind(uuid(), actorId, orgId, task.id, userId, nowIso()));
  }
  if (writes.length) await env.DB.batch(writes);
  return results.length;
}

export async function setFrozen(env: Env, orgId: string, userId: string, frozen: boolean): Promise<void> {
  await env.DB.prepare('UPDATE org_memberships SET frozen_at = ? WHERE org_id = ? AND user_id = ? AND left_at IS NULL')
    .bind(frozen ? nowIso() : null, orgId, userId).run();
}

// ------------------------------------------------ ЧТО ЧЕЛОВЕК ВИДИТ ИЗ ЗАДАЧ
//
// ОДНО ПРАВИЛО НА ВСЁ ПРИЛОЖЕНИЕ. Раньше их было два и они расходились:
// снимок организации отдавал владельцу все доски, а руководителю только его
// собственные, зато «Все задания» отдавали обоим вообще всё. Один и тот же
// человек видел разный объём на двух экранах, и объяснить это было нечем.
//
//   владелец и руководитель организации -- вся организация;
//   руководитель отдела -- свои доски и своё поддерево по дереву приглашений;
//   участник -- свои доски и то, где он автор или исполнитель.
//
// Это же правило отвечает на вопрос «зачем владельцу видеть задания
// подчинённых Азиза»: видеть он их может, но только на экране «Все задания»,
// который открывают намеренно. В личные списки и календарь они не попадают --
// там фильтр по себе, а уведомления о чужих задачах не приходят вовсе.

export type TaskScope = 'all' | { projectIds: string[]; userIds: string[] };

export async function visibleTaskScope(env: Env, orgId: string, userId: string, role: Role): Promise<TaskScope> {
  if (BOSS.includes(role)) return 'all';
  const { results: boards } = await env.DB.prepare(
    `SELECT DISTINCT p.id FROM projects p
     LEFT JOIN project_memberships m ON m.project_id = p.id AND m.user_id = ?
     WHERE p.org_id = ? AND p.archived_at IS NULL AND (m.user_id IS NOT NULL OR p.created_by = ?)`,
  ).bind(userId, orgId, userId).all<{ id: string }>();
  const userIds = [userId, ...(role === 'admin' ? await subtreeOf(env, orgId, userId) : [])];
  return { projectIds: boards.map((b) => b.id), userIds };
}

/**
 * Видимые задачи организации. Единственное место, где живёт правило выше.
 *
 * since -- догрузка: БЕЗ фильтра по статусу, потому что ушедшая в архив задача
 * обязана доехать до клиента, иначе она навсегда останется у него на экране.
 * Имя доски едет вместе с задачей: доска может быть чужой, и в списке своих
 * досок её нет и быть не должно.
 */
export async function visibleTasks(
  env: Env, orgId: string, userId: string, role: Role, since?: string | null,
): Promise<Record<string, unknown>[]> {
  const scope = await visibleTaskScope(env, orgId, userId, role);
  const head = `SELECT DISTINCT t.*, p.name AS project_name FROM tasks t
     JOIN projects p ON p.id = t.project_id AND p.archived_at IS NULL
     WHERE t.org_id = ? AND `;
  const tail = ` AND ${since ? "datetime(t.updated_at) >= datetime(?, '-2 seconds')" : "t.status IN ('todo','in_progress','done')"}
     ORDER BY t.created_at`;
  const sinceBind = since ? [since] : [];

  if (scope === 'all') {
    return (await env.DB.prepare(head + '1 = 1' + tail).bind(orgId, ...sinceBind).all<Record<string, unknown>>()).results;
  }
  // Кусками по людям: предел D1 -- 100 параметров на запрос, а список
  // подчинённых сам по себе не ограничен. Куски объединяются по id.
  const ph = scope.projectIds.map(() => '?').join(',');
  const seen = new Map<string, Record<string, unknown>>();
  for (const part of chunks(scope.userIds, 35)) {
    const uh = part.map(() => '?').join(',');
    const where = [
      scope.projectIds.length > 0 ? `t.project_id IN (${ph})` : null,
      `t.author_id IN (${uh})`,
      `EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id IN (${uh}))`,
    ].filter(Boolean).join(' OR ');
    const { results } = await env.DB.prepare(head + `(${where})` + tail)
      .bind(orgId, ...scope.projectIds, ...part, ...part, ...sinceBind)
      .all<Record<string, unknown>>();
    for (const r of results) seen.set(r.id as string, r);
  }
  return [...seen.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}
