// Иерархия по приглашениям (раздел 19).
//
// Видимость строится по ДЕРЕВУ «кто кого пригласил», а не по плоскому
// «руководитель видит всё»: руководитель маркетинга видит своих людей и то, что
// они делают, но не видит бухгалтерию. Владелец видит всё. Участник -- людей
// своих досок. Роли три: creator, admin (руководитель отдела), member.
import type { Env, Role, Task } from './types';
import { nowIso, uuid } from './db';
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
  aliases: string | null; frozen_at: string | null; invited_by: string | null; phone?: string | null;
};

/** Действующие участники, видимые человеку. Замороженные видны (с пометкой), но поручать им нельзя. */
export async function visibleMembers(env: Env, orgId: string, userId: string, role: Role, withPhone = false): Promise<Member[]> {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, m.role AS role, m.position AS position, u.telegram_username, u.aliases, m.frozen_at, m.invited_by${withPhone ? ', u.phone' : ''}
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
