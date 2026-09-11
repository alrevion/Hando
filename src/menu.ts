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
import { CATEGORIES, categoryButton, packButton, packsOf } from './packs';
import { digestAt, loadSchedule, scheduleCols, type OrgSchedule } from './schedule';

export const BTN = {
  tasks: '📋 Мои задачи',
  assigned: '📤 Мои поручения',
  orgs: '🏢 Организации',
  create: '➕ Создать организацию',
  join: '🔑 Вступить по коду',
  createShort: '➕ Создать',
  joinShort: '🔑 Вступить',
  requests: '📨 Заявки',
  back: '‹ Назад',
  drafts: '📝 Черновики',
  settings: '⚙️ Настройки',
  notifyAll: '🔔 Уведомления: сразу из всех',
  notifySchedule: '🕘 Уведомления: по расписанию',
  remind15: '⏰ За 15 мин',
  remind30: '⏰ За 30 мин',
  remind60: '⏰ За час',
  digestOn: '📰 Сводка: включить',
  digestOff: '📰 Сводка: выключить',
  digestTime: '🕘 Час сводки',
  invite: '🔗 Ссылка-приглашение',
  ask: '❓ Вопрос',
} as const;

/** Что бот ждёт следующим сообщением, и на каком экране человек находится. */
export type BotState = {
  await?: 'name' | 'new' | 'pack' | 'join' | 'fix' | 'late' | 'decline' | 'digest_time' | 'ask';
  /** Последние реплики диалога с помощником -- чтобы уточнения работали. */
  ask?: { role: 'user' | 'assistant'; text: string }[];
  /** Черновик, который ждёт правку после «Изменить». */
  fix?: string;
  /** Задача, по которой ждём причину «не успею» / «отказ». */
  task?: string;
  /** Код личной ссылки: заявка подаётся после знакомства, когда есть имя. */
  join?: string;
  /** Незаконченный ввод: название организации ждёт выбора профиля. */
  draft?: string;
  /** Выбранная категория отрасли: второй шаг показывает её отрасли. */
  cat?: string;
  /** Экран: по нему разбирается нажатие, потому что подписи повторяются. */
  screen?: 'main' | 'orgs' | 'settings';
};

export type OrgRow = {
  id: string; name: string; role: Role; is_current: number;
  join_code: string | null; owner_user_id: string | null;
  industry_pack: string | null;
} & Omit<OrgSchedule, 'id'>;

export async function myOrgs(env: Env, userId: string): Promise<OrgRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT o.id, o.name, m.role AS role, o.join_code, o.owner_user_id, o.industry_pack, ${scheduleCols('o')},
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
      keyboard: kb([[{ text: BTN.create }], [{ text: BTN.join }]]),
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
        // Черновики -- то, что продиктовано, но не подтверждено. Они не
        // пропадают, и кнопка нужна, чтобы к ним вернуться. «Вопрос» -- помощник.
        [{ text: BTN.drafts }, { text: BTN.ask }],
        // Профиля и подписки в боте нет (раздел 18): имя, организации и всё
        // «редкое» -- в приложении. Здесь остаётся то, что делается одной кнопкой.
        [{ text: BTN.orgs }],
      ],
      'Поручение или сообщение…',
    ),
    state: { screen: 'main' },
  };
}

/**
 * Организации: тап по названию -- переключение, без вопросов (раздел 18).
 * Заявки, личная ссылка и настройки -- рядом. Переименование, удаление и выход
 * -- в приложении.
 */
export function orgsScreen(orgs: OrgRow[], pending = 0, canInvite = false): Screen {
  const rows: { text: string }[][] = orgs.map((o) => [{ text: `${o.is_current ? '● ' : '○ '}${o.name}` }]);
  if (pending > 0) rows.push([{ text: BTN.requests }]);
  if (canInvite) rows.push([{ text: BTN.invite }]);
  if (orgs.length > 0) rows.push([{ text: BTN.settings }]);
  rows.push([{ text: BTN.createShort }, { text: BTN.joinShort }], [{ text: BTN.back }]);
  const lines = [orgs.length ? 'Ваши организации. Текущая отмечена ● — нажмите на другую, чтобы переключиться.' : 'У Вас пока нет организаций.'];
  if (pending > 0) lines.push(`Заявок на вступление: ${pending}`);
  return { text: lines.join('\n'), keyboard: kb(rows), state: { screen: 'orgs' } };
}

/**
 * Выбор профиля отрасли -- второй шаг создания организации, в ДВА экрана.
 *
 * Отраслей сотня, и плоским списком кнопок это нечитаемо. Сначала категория
 * (пятнадцать), затем отрасль внутри неё. Профиль спрашивается сразу: от него
 * зависят отделы, которые заведутся, и словарь разбора, а спросить позже
 * значило бы переименовывать уже заполненные доски.
 *
 * По две кнопки в ряд: подписи длинные, в три ряда они обрезаются на узком экране.
 */
export function categoryScreen(orgName: string): Screen {
  const rows: { text: string }[][] = [];
  for (let i = 0; i < CATEGORIES.length; i += 2) {
    rows.push(CATEGORIES.slice(i, i + 2).map((c) => ({ text: categoryButton(c) })));
  }
  return {
    text: [
      `«${orgName}» -- чем занимаетесь?`,
      '',
      'От этого зависят отделы и то, какие слова я буду понимать как срочные.',
    ].join('\n'),
    keyboard: kb(rows),
    state: { await: 'pack', draft: orgName },
  };
}

/** Второй шаг: отрасли выбранной категории. Сотня в один экран не влезает. */
export function industryScreen(orgName: string, categoryId: string): Screen {
  const list = packsOf(categoryId);
  const rows: { text: string }[][] = [];
  for (let i = 0; i < list.length; i += 2) {
    rows.push(list.slice(i, i + 2).map((p) => ({ text: packButton(p) })));
  }
  rows.push([{ text: BTN.back }]);
  return {
    text: 'Уточните -- от этого зависят отделы:',
    keyboard: kb(rows),
    state: { await: 'pack', draft: orgName, cat: categoryId },
  };
}

export type NotifyPrefs = { notify_mode: 'all' | 'schedule'; remind_before_min: number };

export async function notifyPrefs(env: Env, userId: string): Promise<NotifyPrefs> {
  const row = await env.DB.prepare("SELECT COALESCE(notify_mode, 'all') AS notify_mode, COALESCE(remind_before_min, 30) AS remind_before_min FROM users WHERE id = ?")
    .bind(userId).first<NotifyPrefs>();
  return row ?? { notify_mode: 'all', remind_before_min: 30 };
}

export async function setNotifyPrefs(env: Env, userId: string, patch: Partial<NotifyPrefs>): Promise<void> {
  const sets: string[] = []; const vals: unknown[] = [];
  if (patch.notify_mode) { sets.push('notify_mode = ?'); vals.push(patch.notify_mode); }
  if (patch.remind_before_min !== undefined) { sets.push('remind_before_min = ?'); vals.push(patch.remind_before_min); }
  if (!sets.length) return;
  await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, userId).run();
}

/**
 * Настройки: режим уведомлений и «за N минут» -- человека; сводка -- организации
 * (только владельцу). Текущее состояние -- в тексте, кнопки статичны: подпись
 * reply-кнопки -- это протокол, счётчик в ней сделал бы её подвижной мишенью.
 */
export function settingsScreen(prefs: NotifyPrefs, org: OrgSchedule & { name: string }, isOwner: boolean): Screen {
  const lines = [
    `Настройки · «${org.name}»`,
    '',
    `Уведомления: ${prefs.notify_mode === 'all' ? 'сразу из всех организаций' : 'по графику каждой организации'}`,
    `Напоминать до срока: за ${prefs.remind_before_min} мин`,
  ];
  if (isOwner) {
    lines.push('', org.always_on
      ? 'График: 24/7'
      : `График: ${org.work_start}–${org.work_end}${org.lunch_start && org.lunch_end ? `, обед ${org.lunch_start}–${org.lunch_end}` : ''}`);
    lines.push(`Сводка: ${org.digest_enabled ? `в ${digestAt(org)}` : 'выключена'}`);
    lines.push('', 'График работы меняется в приложении: Ещё → Организация.');
  }
  const rows: { text: string }[][] = [
    [{ text: prefs.notify_mode === 'all' ? BTN.notifySchedule : BTN.notifyAll }],
    [{ text: BTN.remind15 }, { text: BTN.remind30 }, { text: BTN.remind60 }],
  ];
  if (isOwner) rows.push([{ text: org.digest_enabled ? BTN.digestOff : BTN.digestOn }, { text: BTN.digestTime }]);
  rows.push([{ text: BTN.back }]);
  return { text: lines.join('\n'), keyboard: kb(rows), state: { screen: 'settings' } };
}

/** Экран диалога с помощником: любой текст или голос -- вопрос, «Назад» -- выход. */
export function askScreen(): Screen {
  return {
    text: 'Спросите что угодно: «как отметить выполненную?», «за что взяться сначала?», «что у меня горит на неделе?». Можно голосом.',
    keyboard: kb([[{ text: BTN.back }]], 'Ваш вопрос…'),
    state: { screen: 'main', await: 'ask', ask: [] },
  };
}

/** Тезисы для /start и /help (раздел 23): что умеет и куда нажимать. */
export const START_TIPS = [
  'Что умеет Hando:',
  '• Напишите или наговорите поручение — «Азизу завтра до трёх подготовить отчёт». Я покажу черновик, вы нажмёте «Создать».',
  '• Адресат получит карточку и ответит кнопками: Принять · Не успею · Отказать.',
  '• Напомню за час и в срок, а утром пришлю сводку на день.',
  '• Сдать работу, увидеть этапы, людей и аналитику — в приложении.',
].join('\n');


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

/** Владелец: колонка owner_user_id или членство creator. Один предикат на все правки организации. */
export async function isOrgOwner(env: Env, userId: string, orgId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM orgs o WHERE o.id = ? AND o.archived_at IS NULL AND (
       o.owner_user_id = ? OR EXISTS (SELECT 1 FROM org_memberships m
         WHERE m.org_id = o.id AND m.user_id = ? AND m.role = 'creator'
           AND m.left_at IS NULL AND m.confirmed_at IS NOT NULL))`,
  ).bind(orgId, userId, userId).first();
  return Boolean(row);
}

export type OrgSettingsPatch = Partial<Pick<OrgSchedule, 'work_days' | 'work_start' | 'work_end' | 'lunch_start' | 'lunch_end' | 'always_on' | 'digest_enabled' | 'digest_time'>>;

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** График и сводка организации. Проверяет и право, и форму значений: ввод приходит и из бота, и из приложения. */
export async function updateOrgSettings(env: Env, userId: string, orgId: string, patch: OrgSettingsPatch): Promise<boolean> {
  if (!(await isOrgOwner(env, userId, orgId))) return false;
  const sets: string[] = []; const vals: unknown[] = [];
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
  if (patch.work_days !== undefined) {
    if (!/^[1-7](,[1-7])*$/.test(patch.work_days)) return false;
    put('work_days', patch.work_days);
  }
  for (const col of ['work_start', 'work_end', 'digest_time', 'lunch_start', 'lunch_end'] as const) {
    const v = patch[col];
    if (v === undefined) continue;
    if (v === null) { if (col === 'work_start' || col === 'work_end') return false; put(col, null); continue; }
    if (!HM.test(v)) return false;
    put(col, v);
  }
  if (patch.always_on !== undefined) put('always_on', patch.always_on ? 1 : 0);
  if (patch.digest_enabled !== undefined) put('digest_enabled', patch.digest_enabled ? 1 : 0);
  if (!sets.length) return true;
  // Начало раньше конца, обед внутри дня: иначе «рабочее время» не наступало
  // бы никогда, и все напоминания по графику молчали бы.
  const cur = await loadSchedule(env, orgId);
  const next = { ...cur, ...patch } as OrgSchedule;
  const min = (v: string) => { const [h, m] = v.split(':').map(Number); return h * 60 + m; };
  if (min(next.work_start) >= min(next.work_end)) return false;
  if (next.lunch_start && next.lunch_end && !(min(next.work_start) <= min(next.lunch_start) && min(next.lunch_start) < min(next.lunch_end) && min(next.lunch_end) <= min(next.work_end))) return false;
  await env.DB.prepare(`UPDATE orgs SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, orgId).run();
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
