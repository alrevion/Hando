// Кнопочное меню бота.
//
// Команды вида «/создать Название» -- интерфейс для разработчика, а не для
// человека: их надо помнить и печатать без ошибок. Здесь всё то же самое
// делается кнопками, а печатать нужно только то, что бот и так не мог бы знать
// -- название организации или код.
//
// Диалог состоит из двух шагов: нажатие ставит ОЖИДАНИЕ (users.bot_state),
// следующее сообщение это ожидание закрывает. Больше состояний не нужно:
// длинных сценариев в меню нет намеренно, каждый шаг завершается сам.
import type { Env, Role } from './types';
import { nowIso } from './db';
import type { InlineKeyboard } from './telegram';

export type Awaiting = { await: 'new' } | { await: 'join' } | { await: 'ren'; org: string };

export type OrgRow = { id: string; name: string; role: Role; is_current: number; join_code: string | null; owner_user_id: string | null };

/** Организации человека: только действующие членства и неудалённые организации. */
export async function myOrgs(env: Env, userId: string): Promise<OrgRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT o.id, o.name, m.role AS role, o.join_code, o.owner_user_id,
            CASE WHEN u.current_org_id = o.id THEN 1 ELSE 0 END AS is_current
     FROM org_memberships m
     JOIN orgs o ON o.id = m.org_id
     JOIN users u ON u.id = m.user_id
     WHERE m.user_id = ? AND m.left_at IS NULL AND m.confirmed_at IS NOT NULL AND o.archived_at IS NULL
     ORDER BY is_current DESC, o.name`,
  ).bind(userId).all<OrgRow>();
  return results;
}

export async function setAwaiting(env: Env, userId: string, state: Awaiting | null): Promise<void> {
  await env.DB.prepare('UPDATE users SET bot_state = ? WHERE id = ?')
    .bind(state ? JSON.stringify(state) : null, userId)
    .run();
}

export async function getAwaiting(env: Env, userId: string): Promise<Awaiting | null> {
  const row = await env.DB.prepare('SELECT bot_state FROM users WHERE id = ?').bind(userId).first<{ bot_state: string | null }>();
  if (!row?.bot_state) return null;
  try {
    return JSON.parse(row.bot_state) as Awaiting;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------- экраны

export type Screen = { text: string; keyboard: InlineKeyboard };

/** Главный экран. Вид зависит от того, есть ли у человека организации. */
export function mainScreen(name: string, orgs: OrgRow[]): Screen {
  if (orgs.length === 0) {
    return {
      text: `Здравствуйте, ${name}.\n\nЧтобы начать, создайте организацию или вступите в существующую по коду.`,
      keyboard: { inline_keyboard: [
        [{ text: '➕ Создать организацию', callback_data: 'm:new' }],
        [{ text: '🔑 Вступить по коду', callback_data: 'm:join' }],
      ] },
    };
  }
  const current = orgs.find((o) => o.is_current) ?? orgs[0];
  return {
    text: `Здравствуйте, ${name}.\n\nСейчас вы в «${current.name}».`,
    keyboard: { inline_keyboard: [
      [{ text: '📋 Мои задачи', callback_data: 'm:tasks' }],
      [{ text: '🏢 Организации', callback_data: 'm:orgs' }],
    ] },
  };
}

/** Список организаций: текущая помечена, каждая -- кнопка. */
export function orgsScreen(orgs: OrgRow[]): Screen {
  const rows = orgs.map((o) => [{
    text: `${o.is_current ? '● ' : '○ '}${o.name}`,
    callback_data: `m:org:${o.id}`,
  }]);
  return {
    text: orgs.length ? 'Ваши организации:' : 'У вас пока нет организаций.',
    keyboard: { inline_keyboard: [
      ...rows,
      [{ text: '➕ Создать', callback_data: 'm:new' }, { text: '🔑 Вступить', callback_data: 'm:join' }],
      [{ text: '‹ Назад', callback_data: 'm:main' }],
    ] },
  };
}

/**
 * Карточка организации. Набор кнопок зависит от прав:
 * переименование и удаление -- только владельцу, иначе сотрудник переименовал бы
 * чужую фирму.
 */
export function orgScreen(org: OrgRow, userId: string): Screen {
  const isOwner = org.owner_user_id === userId || org.role === 'creator';
  const lines = [`«${org.name}»`, `Ваша роль: ${roleName(org.role)}`];
  if (isOwner && org.join_code) lines.push('', `Код для сотрудников: ${org.join_code}`);

  const buttons: InlineKeyboard['inline_keyboard'] = [];
  if (!org.is_current) buttons.push([{ text: '↪️ Переключиться сюда', callback_data: `m:sw:${org.id}` }]);
  if (isOwner) {
    buttons.push([{ text: '✏️ Переименовать', callback_data: `m:ren:${org.id}` }]);
    buttons.push([{ text: '🗑 Удалить', callback_data: `m:del:${org.id}` }]);
  } else {
    buttons.push([{ text: '🚪 Выйти', callback_data: `m:leave:${org.id}` }]);
  }
  buttons.push([{ text: '‹ Назад', callback_data: 'm:orgs' }]);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: buttons } };
}

/** Подтверждение удаления. Отдельным экраном: удаление необратимо для владельца. */
export function confirmDeleteScreen(org: OrgRow): Screen {
  return {
    text: `Удалить «${org.name}»?\n\nЗадачи и история сохранятся, но организация исчезнет у всех её сотрудников.`,
    keyboard: { inline_keyboard: [
      [{ text: '❌ Да, удалить', callback_data: `m:delok:${org.id}` }],
      [{ text: '‹ Отмена', callback_data: `m:org:${org.id}` }],
    ] },
  };
}

function roleName(role: Role): string {
  return role === 'creator' ? 'владелец' : role === 'super_admin' ? 'администратор' : role === 'admin' ? 'сотрудник' : 'участник';
}

// --------------------------------------------------------------------- действия

/** Переключение текущей организации. Только на ту, где человек действительно состоит. */
export async function switchOrg(env: Env, userId: string, orgId: string): Promise<boolean> {
  const ok = await env.DB.prepare(
    `SELECT 1 FROM org_memberships m JOIN orgs o ON o.id = m.org_id
      WHERE m.org_id = ? AND m.user_id = ? AND m.left_at IS NULL AND m.confirmed_at IS NOT NULL AND o.archived_at IS NULL`,
  ).bind(orgId, userId).first();
  if (!ok) return false;
  await env.DB.prepare('UPDATE users SET current_org_id = ? WHERE id = ?').bind(orgId, userId).run();
  return true;
}

/** Переименование. Только владельцу. */
export async function renameOrg(env: Env, userId: string, orgId: string, name: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE orgs SET name = ? WHERE id = ? AND archived_at IS NULL AND (
       owner_user_id = ? OR EXISTS (SELECT 1 FROM org_memberships m
         WHERE m.org_id = orgs.id AND m.user_id = ? AND m.role = 'creator'
           AND m.left_at IS NULL AND m.confirmed_at IS NOT NULL))`,
  ).bind(name.trim().slice(0, 60), orgId, userId, userId).run();
  return Boolean(res.meta.changes);
}

/**
 * Мягкое удаление организации.
 *
 * Строки не стираются: на организацию ссылаются задачи, события и вложения --
 * вся история работы. Удаляется видимость, а не труд. Липкий контекст всех, кто
 * там был, переставляется, иначе они упрутся в 401 на следующем же запросе.
 */
export async function deleteOrg(env: Env, userId: string, orgId: string): Promise<boolean> {
  const owner = await env.DB.prepare(
    `SELECT 1 FROM orgs o WHERE o.id = ? AND o.archived_at IS NULL AND (
       o.owner_user_id = ? OR EXISTS (SELECT 1 FROM org_memberships m
         WHERE m.org_id = o.id AND m.user_id = ? AND m.role = 'creator'
           AND m.left_at IS NULL AND m.confirmed_at IS NOT NULL))`,
  ).bind(orgId, userId, userId).first();
  if (!owner) return false;

  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare('UPDATE orgs SET archived_at = ? WHERE id = ?').bind(now, orgId),
    // Всем, кто там работал, контекст переставляется на любую оставшуюся
    // организацию либо обнуляется -- то же правило, что при отзыве членства.
    env.DB.prepare(
      `UPDATE users SET current_org_id = (
         SELECT m.org_id FROM org_memberships m JOIN orgs o ON o.id = m.org_id
          WHERE m.user_id = users.id AND m.org_id <> ? AND m.left_at IS NULL
            AND m.confirmed_at IS NOT NULL AND o.archived_at IS NULL LIMIT 1)
       WHERE current_org_id = ?`,
    ).bind(orgId, orgId),
  ]);
  return true;
}

/** Выход из чужой организации. Владелец выйти не может -- он её удаляет. */
export async function leaveOrg(env: Env, userId: string, orgId: string): Promise<boolean> {
  const m = await env.DB.prepare('SELECT role FROM org_memberships WHERE org_id = ? AND user_id = ? AND left_at IS NULL')
    .bind(orgId, userId).first<{ role: Role }>();
  if (!m || m.role === 'creator') return false;
  await env.DB.batch([
    env.DB.prepare('UPDATE org_memberships SET left_at = ? WHERE org_id = ? AND user_id = ?').bind(nowIso(), orgId, userId),
    env.DB.prepare(
      `UPDATE users SET current_org_id = (
         SELECT m.org_id FROM org_memberships m JOIN orgs o ON o.id = m.org_id
          WHERE m.user_id = users.id AND m.org_id <> ? AND m.left_at IS NULL
            AND m.confirmed_at IS NOT NULL AND o.archived_at IS NULL LIMIT 1)
       WHERE id = ? AND current_org_id = ?`,
    ).bind(orgId, userId, orgId),
  ]);
  return true;
}
