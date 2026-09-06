// Меню бота на ПОСТОЯННОЙ клавиатуре.
//
// Почему не инлайновая. Инлайновая клавиатура живёт внутри одного сообщения:
// оно уезжает вверх под уведомлениями, и меню исчезает вместе с ним. Reply-
// клавиатура закреплена внизу экрана -- это навигация приложения, доступная
// всегда. Инлайновая остаётся там, где кнопка привязана к ОБЪЕКТУ: «Принял» на
// этой задаче, «Принять» на этой заявке. Такие кнопки и должны жить при своём
// сообщении.
//
// Reply-кнопка присылает боту свой ТЕКСТ, поэтому подписи -- часть протокола, а
// не оформление. Они собраны в BTN: строка в двух местах однажды разойдётся, и
// кнопка перестанет работать молча.
import type { Env, Role } from './types';
import { nowIso } from './db';
import type { ReplyKeyboard } from './telegram';

export const BTN = {
  tasks: '📋 Мои задачи',
  assigned: '📤 Мои поручения',
  orgs: '🏢 Организации',
  billing: '💳 Подписка',
  profile: '👤 Профиль',
  create: '➕ Создать организацию',
  join: '🔑 Вступить по коду',
  createShort: '➕ Создать',
  joinShort: '🔑 Вступить',
  rename: '✏️ Переименовать',
  remove: '🗑 Удалить',
  switch: '↪️ Переключиться сюда',
  leave: '🚪 Выйти из организации',
  editName: '✏️ Изменить имя',
  back: '‹ Назад',
  yes: '❌ Да, удалить',
} as const;

/** Что бот ждёт следующим сообщением, и на каком экране человек находится. */
export type BotState = {
  await?: 'name' | 'new' | 'join' | 'rename';
  /** Экран: по нему разбирается нажатие, потому что подписи повторяются. */
  screen?: 'main' | 'orgs' | 'org' | 'profile' | 'billing' | 'confirm_delete';
  /** Организация, открытая в карточке. */
  org?: string;
};

export type OrgRow = {
  id: string; name: string; role: Role; is_current: number;
  join_code: string | null; owner_user_id: string | null;
};

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

export async function setState(env: Env, userId: string, state: BotState | null): Promise<void> {
  await env.DB.prepare('UPDATE users SET bot_state = ? WHERE id = ?')
    .bind(state ? JSON.stringify(state) : null, userId).run();
}

export async function getState(env: Env, userId: string): Promise<BotState> {
  const row = await env.DB.prepare('SELECT bot_state FROM users WHERE id = ?').bind(userId).first<{ bot_state: string | null }>();
  if (!row?.bot_state) return {};
  try {
    return JSON.parse(row.bot_state) as BotState;
  } catch {
    return {};
  }
}

// --------------------------------------------------------------------- экраны

export type Screen = { text: string; keyboard: ReplyKeyboard; state: BotState };

const kb = (rows: { text: string; web_app?: { url: string } }[][], placeholder?: string): ReplyKeyboard => ({
  keyboard: rows,
  resize_keyboard: true,
  // Клавиатура не прячется после нажатия: она и есть навигация.
  is_persistent: true,
  input_field_placeholder: placeholder,
});

/** Знакомство: единственный экран без кнопок -- ответ тут произвольный. */
export function askNameScreen(): Screen {
  return {
    text: 'Здравствуйте! Как к Вам обращаться?\n\nНапишите имя и фамилию — их будут видеть коллеги в поручениях.',
    keyboard: { keyboard: [], resize_keyboard: true, input_field_placeholder: 'Например: Азиз Каримов' },
    state: { await: 'name' },
  };
}

/**
 * Главный экран.
 *
 * Порядок первого ряда зависит от РОЛИ, и это не косметика. Директор открывает
 * бота, чтобы посмотреть, как идут его поручения; сотрудник -- чтобы увидеть,
 * что делать ему. Первой кнопкой у каждого стоит то, ради чего он пришёл.
 *
 * Кнопки мини-приложения здесь НЕТ намеренно: у Telegram для этого есть своя
 * кнопка меню слева от строки ввода. Дублировать её в клавиатуре -- значит
 * занимать место под то, что и так на экране.
 */
export function mainScreen(name: string, orgs: OrgRow[]): Screen {
  if (orgs.length === 0) {
    return {
      text: `${name}, чтобы начать — создайте организацию или вступите в существующую по коду.`,
      keyboard: kb([[{ text: BTN.create }], [{ text: BTN.join }], [{ text: BTN.profile }]]),
      state: { screen: 'main' },
    };
  }
  const current = orgs.find((o) => o.is_current) ?? orgs[0];
  const boss = current.role === 'creator' || current.role === 'super_admin';
  return {
    text: `Сейчас Вы в «${current.name}».\n\nНапишите или наговорите поручение — я поставлю задачу.`,
    keyboard: kb(
      [
        boss ? [{ text: BTN.assigned }, { text: BTN.tasks }] : [{ text: BTN.tasks }, { text: BTN.assigned }],
        [{ text: BTN.orgs }],
        [{ text: BTN.billing }],
        [{ text: BTN.profile }],
      ],
      'Поручение или сообщение…',
    ),
    state: { screen: 'main' },
  };
}

/**
 * Подписка. Биллинга ещё нет, и экран об этом говорит прямо, а не рисует
 * несуществующие тарифы: платит владелец организации, и когда оплата появится,
 * ему важно понимать, за что именно.
 */
export function billingScreen(orgs: OrgRow[], userId: string): Screen {
  const owned = orgs.filter((o) => o.owner_user_id === userId || o.role === 'creator');
  const lines = ['Подписка', ''];
  if (owned.length === 0) {
    lines.push('Вы не владеете организациями — за них платит их владелец.');
  } else {
    lines.push('Вы платите за:');
    for (const o of owned) lines.push(`• ${o.name}`);
    lines.push('', 'Сейчас всё бесплатно: оплата ещё не подключена.');
  }
  return { text: lines.join('\n'), keyboard: kb([[{ text: BTN.back }]]), state: { screen: 'billing' } };
}

export function orgsScreen(orgs: OrgRow[]): Screen {
  return {
    text: orgs.length ? 'Ваши организации. Текущая отмечена ●' : 'У Вас пока нет организаций.',
    keyboard: kb([
      ...orgs.map((o) => [{ text: `${o.is_current ? '● ' : '○ '}${o.name}` }]),
      [{ text: BTN.createShort }, { text: BTN.joinShort }],
      [{ text: BTN.back }],
    ]),
    state: { screen: 'orgs' },
  };
}

/** Карточка организации. Кнопки зависят от прав: чужую фирму не переименовать. */
export function orgScreen(org: OrgRow, userId: string): Screen {
  const isOwner = org.owner_user_id === userId || org.role === 'creator';
  const lines = [`«${org.name}»`, `Ваша роль: ${roleName(org.role)}`];
  if (isOwner && org.join_code) lines.push('', `Код для сотрудников: ${org.join_code}`);

  const rows: { text: string }[][] = [];
  if (!org.is_current) rows.push([{ text: BTN.switch }]);
  if (isOwner) rows.push([{ text: BTN.rename }, { text: BTN.remove }]);
  else rows.push([{ text: BTN.leave }]);
  rows.push([{ text: BTN.back }]);

  return { text: lines.join('\n'), keyboard: kb(rows), state: { screen: 'org', org: org.id } };
}

export function confirmDeleteScreen(org: OrgRow): Screen {
  return {
    text: `Удалить «${org.name}»?\n\nЗадачи и история сохранятся, но организация исчезнет у всех её сотрудников.`,
    keyboard: kb([[{ text: BTN.yes }], [{ text: BTN.back }]]),
    state: { screen: 'confirm_delete', org: org.id },
  };
}

export function profileScreen(name: string, orgs: OrgRow[]): Screen {
  const lines = [`Вас зовут: ${name}`];
  if (orgs.length) {
    lines.push('', 'Организации:');
    for (const o of orgs) lines.push(`${o.is_current ? '● ' : '○ '}${o.name} — ${roleName(o.role)}`);
  }
  return {
    text: lines.join('\n'),
    keyboard: kb([[{ text: BTN.editName }], [{ text: BTN.back }]]),
    state: { screen: 'profile' },
  };
}

function roleName(role: Role): string {
  return role === 'creator' ? 'владелец' : role === 'super_admin' ? 'администратор' : role === 'admin' ? 'сотрудник' : 'участник';
}

// --------------------------------------------------------------------- действия

/** Имя для обращения. Его видят коллеги в поручениях, поэтому оно обязательно. */
export async function setDisplayName(env: Env, userId: string, name: string): Promise<boolean> {
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 60);
  if (clean.length < 2) return false;
  await env.DB.prepare('UPDATE users SET name = ?, onboarded_at = COALESCE(onboarded_at, ?) WHERE id = ?')
    .bind(clean, nowIso(), userId).run();
  return true;
}

export async function isOnboarded(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?').bind(userId).first<{ onboarded_at: string | null }>();
  return Boolean(row?.onboarded_at);
}

export async function switchOrg(env: Env, userId: string, orgId: string): Promise<boolean> {
  const ok = await env.DB.prepare(
    `SELECT 1 FROM org_memberships m JOIN orgs o ON o.id = m.org_id
      WHERE m.org_id = ? AND m.user_id = ? AND m.left_at IS NULL AND m.confirmed_at IS NOT NULL AND o.archived_at IS NULL`,
  ).bind(orgId, userId).first();
  if (!ok) return false;
  await env.DB.prepare('UPDATE users SET current_org_id = ? WHERE id = ?').bind(orgId, userId).run();
  return true;
}

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
 * вся история работы. Убирается видимость, а не труд. Липкий контекст всех, кто
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

  await env.DB.batch([
    env.DB.prepare('UPDATE orgs SET archived_at = ? WHERE id = ?').bind(nowIso(), orgId),
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
