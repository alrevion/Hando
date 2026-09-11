// Авторегистрация: человек заводит себя сам, без ручного ввода директором.
//
// Модель (решение владельца 2026-09-06): человек подключает бота и дальше либо
// СОЗДАЁТ свою организацию -- тогда он её владелец и плательщик, -- либо
// ВСТУПАЕТ по коду в чужую, и там его подтверждает тот, кто код выдал.
// Директор платит за всю свою организацию; кто зарегистрировался сам, платит
// только за свои.
//
// ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ ССЫЛКИ-ПРИГЛАШЕНИЯ. Ссылка одноразовая и её выдают
// лично -- она даёт доступ сразу. Код многоразовый, его раздают в общем чате,
// поэтому сам по себе он доступа НЕ даёт: только заявку. Это разные предметы, и
// смешивать их нельзя.
import type { Env, Role } from './types';
import { nowIso, uuid } from './db';
import { pack } from './packs';
import { sendMessage, type InlineButton } from './telegram';

/**
 * Код вступления: шесть символов из алфавита без похожих начертаний.
 *
 * Исключены 0/O, 1/I/L -- код диктуют голосом и переписывают с экрана, и
 * «нолик или буква О» стоит дороже, чем лишний символ алфавита. Энтропия
 * 32^6 ~ 10^9: для кода, который сам по себе доступа не даёт, а лишь создаёт
 * заявку на подтверждение, этого достаточно.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generateJoinCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** Человек, подключивший бота, но ещё не выбравший организацию. */
export type PendingSignup = { userId: string; name: string };

/**
 * Заводит человека по его Telegram-аккаунту, если такого ещё нет.
 *
 * Телефон НЕ спрашивается: он nullable с шага 2b именно ради этого пути.
 * Возвращает id -- существующий или созданный.
 */
export async function ensureUser(env: Env, tgId: string, name: string, username: string | null): Promise<string> {
  const existing = await env.DB.prepare('SELECT id FROM users WHERE telegram_user_id = ?').bind(tgId).first<{ id: string }>();
  if (existing) return existing.id;
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO users (id, name, telegram_user_id, telegram_username, connected_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(id, name, tgId, username, nowIso()).run();
  return id;
}

/**
 * Создаёт организацию, в которой человек -- владелец и плательщик.
 *
 * Членство подтверждено сразу: подтверждать себя самому не у кого, и это не
 * дыра -- он создал организацию, в ней пока никого больше нет.
 */
export async function createOrg(
  env: Env,
  userId: string,
  name: string,
  /** Профиль отрасли: от него зависят отделы и словарь разбора. */
  packId = 'generic',
): Promise<{ orgId: string; code: string; departments: string[] }> {
  const orgId = uuid();
  const code = generateJoinCode();
  const now = nowIso();
  const profile = pack(packId);
  // Семья и личные дела живут 24/7: графика нет, ночного пола тоже.
  const home = profile.category === 'home';
  await env.DB.batch([
    env.DB.prepare('INSERT INTO orgs (id, name, join_code, owner_user_id, industry_pack, always_on, quiet_hours) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(orgId, name, code, userId, profile.id, home ? 1 : 0, home ? 0 : 1),
    env.DB.prepare('INSERT INTO org_memberships (id, org_id, user_id, role, confirmed_at) VALUES (?, ?, ?, ?, ?)')
      .bind(uuid(), orgId, userId, 'creator', now),
    // Липкий контекст: человек сразу оказывается в созданной организации.
    env.DB.prepare('UPDATE users SET current_org_id = ? WHERE id = ?').bind(orgId, userId),
  ]);
  // Отделы профиля -- сразу досками. Раз доска = отдел, набор досок и есть
  // структура организации, и заводить её вручную после каждого создания
  // значило бы просить человека повторить то, что он уже сказал выбором профиля.
  await env.DB.batch(profile.departments.map((dept) =>
    env.DB.prepare('INSERT INTO projects (id, org_id, name, created_by, telegram_chat_id) VALUES (?, ?, ?, ?, NULL)')
      .bind(uuid(), orgId, dept, userId)));
  return { orgId, code, departments: profile.departments };
}

/**
 * Доска, на которую кладут задачи, пока других нет.
 *
 * Организация без доски -- тупик: tasks.project_id NOT NULL, класть задачу
 * некуда, и бот на любую фразу отвечал «Не получилось создать задачу». Своей
 * группы Telegram у этой доски нет (telegram_chat_id NULL) -- уведомления и
 * так идут людям лично через очередь, а не в группу.
 */
export async function ensureDefaultProject(env: Env, orgId: string, createdBy: string): Promise<string> {
  const existing = await env.DB
    .prepare('SELECT id FROM projects WHERE org_id = ? AND archived_at IS NULL ORDER BY created_at LIMIT 1')
    .bind(orgId)
    .first<{ id: string }>();
  if (existing) return existing.id;
  // Название берётся из профиля организации: у школы первая доска называется
  // «Учебная часть», а не «Задачи». Досок нет только у организаций, созданных
  // до профилей, -- для них профиль generic и название прежнее.
  const org = await env.DB.prepare('SELECT industry_pack FROM orgs WHERE id = ?').bind(orgId)
    .first<{ industry_pack: string }>();
  const id = uuid();
  await env.DB.prepare('INSERT INTO projects (id, org_id, name, created_by, telegram_chat_id) VALUES (?, ?, ?, ?, NULL)')
    .bind(id, orgId, pack(org?.industry_pack).departments[0], createdBy)
    .run();
  return id;
}

export type JoinResult =
  | { ok: true; orgId: string; orgName: string; approverId: string | null; approverTgId: string | null; applicantName: string }
  | { ok: false; reason: 'unknown_code' | 'already_member' | 'already_pending' };

const BOSS_ROLES: Role[] = ['creator', 'super_admin'];

/**
 * Заявка на вступление: членство с confirmed_at = NULL и отметкой, кто позвал.
 * По общему коду зовёт владелец, по личной ссылке -- её хозяин: так дерево
 * приглашений строится само.
 */
async function requestMembership(
  env: Env, userId: string, org: { id: string; name: string }, approverId: string | null,
): Promise<JoinResult> {
  const existing = await env.DB.prepare('SELECT confirmed_at, left_at FROM org_memberships WHERE org_id = ? AND user_id = ?')
    .bind(org.id, userId)
    .first<{ confirmed_at: string | null; left_at: string | null }>();
  if (existing && existing.left_at === null) {
    return { ok: false, reason: existing.confirmed_at ? 'already_member' : 'already_pending' };
  }
  const applicant = await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(userId).first<{ name: string }>();
  if (existing) {
    // Возвращается тот, кого когда-то отозвали: заявка заводится заново, а не
    // воскрешает прежний доступ молча.
    await env.DB.prepare('UPDATE org_memberships SET left_at = NULL, confirmed_at = NULL, role = ?, invited_by = ?, frozen_at = NULL WHERE org_id = ? AND user_id = ?')
      .bind('member', approverId, org.id, userId)
      .run();
  } else {
    // Роль по умолчанию -- member: рядовой участник. Повысить может тот, кто
    // подтверждает. Обратное (дать admin и потом отбирать) опаснее.
    await env.DB.prepare('INSERT INTO org_memberships (id, org_id, user_id, role, confirmed_at, invited_by) VALUES (?, ?, ?, ?, NULL, ?)')
      .bind(uuid(), org.id, userId, 'member', approverId)
      .run();
  }
  const approver = approverId
    ? await env.DB.prepare('SELECT telegram_user_id FROM users WHERE id = ?').bind(approverId).first<{ telegram_user_id: string | null }>()
    : null;
  return { ok: true, orgId: org.id, orgName: org.name, approverId, approverTgId: approver?.telegram_user_id ?? null, applicantName: applicant?.name ?? 'Сотрудник' };
}

/**
 * Личная ссылка-приглашение: своя у каждого, кто вправе приглашать (владелец,
 * руководитель отдела). Код многоразовый и даёт только заявку -- ЕМУ.
 */
export async function inviteCodeFor(env: Env, orgId: string, userId: string): Promise<string | null> {
  const m = await env.DB.prepare(
    'SELECT role, invite_code FROM org_memberships WHERE org_id = ? AND user_id = ? AND left_at IS NULL AND confirmed_at IS NOT NULL',
  ).bind(orgId, userId).first<{ role: Role; invite_code: string | null }>();
  if (!m || m.role === 'member') return null;
  if (m.invite_code) return m.invite_code;
  const code = generateJoinCode() + generateJoinCode().slice(0, 2);
  await env.DB.prepare('UPDATE org_memberships SET invite_code = ? WHERE org_id = ? AND user_id = ?').bind(code, orgId, userId).run();
  return code;
}

export const BOT_USERNAME = 'hando_ai_bot';
export const inviteLink = (code: string) => `https://t.me/${BOT_USERNAME}?start=j_${code}`;

/** Заявка по личной ссылке: приглашающий -- хозяин кода, заявка уходит ему. */
export async function joinByInvite(env: Env, userId: string, code: string): Promise<JoinResult> {
  const row = await env.DB.prepare(
    `SELECT m.user_id AS inviter, o.id, o.name FROM org_memberships m JOIN orgs o ON o.id = m.org_id
     WHERE m.invite_code = ? AND m.left_at IS NULL AND m.confirmed_at IS NOT NULL AND o.archived_at IS NULL`,
  ).bind(code.trim()).first<{ inviter: string; id: string; name: string }>();
  if (!row) return { ok: false, reason: 'unknown_code' };
  if (row.inviter === userId) return { ok: false, reason: 'already_member' };
  return requestMembership(env, userId, { id: row.id, name: row.name }, row.inviter);
}

/**
 * Карточка заявки тому, кто решает: ФИО и контакт в Telegram -- самозванец с
 * чужим именем выдаёт себя пустой перепиской. Одна и та же из бота и из API.
 */
export async function notifyApprover(env: Env, res: Extract<JoinResult, { ok: true }>, applicantId: string): Promise<void> {
  if (!res.approverTgId) return;
  const u = await env.DB.prepare('SELECT telegram_username FROM users WHERE id = ?').bind(applicantId).first<{ telegram_username: string | null }>();
  const rows: InlineButton[][] = [[
    { text: '✅ Принять', callback_data: `join_ok:${applicantId}` },
    { text: '✖️ Отклонить', callback_data: `join_no:${applicantId}` },
  ]];
  if (u?.telegram_username) rows.push([{ text: '💬 Написать', url: `https://t.me/${u.telegram_username}` }]);
  await sendMessage(env, res.approverTgId,
    `К Вам просится в «${res.orgName}»: ${res.applicantName}${u?.telegram_username ? ` (@${u.telegram_username})` : ''}`,
    { inline_keyboard: rows });
}

/**
 * Заявка на вступление по коду. Доступа НЕ даёт -- создаёт членство с
 * confirmed_at = NULL, которое обязан подтвердить владелец.
 */
export async function joinByCode(env: Env, userId: string, code: string): Promise<JoinResult> {
  const org = await env.DB.prepare('SELECT id, name, owner_user_id FROM orgs WHERE join_code = ? AND archived_at IS NULL')
    .bind(code.trim().toUpperCase())
    .first<{ id: string; name: string; owner_user_id: string | null }>();
  // Неизвестный код -- отказ без подробностей: перебор кодов не должен
  // подсказывать, какие организации существуют.
  if (!org) return { ok: false, reason: 'unknown_code' };
  return requestMembership(env, userId, org, org.owner_user_id);
}

/** Кто вправе решить заявку: владелец -- любую, руководитель отдела -- по своей ссылке. */
async function canDecide(env: Env, approverId: string, orgId: string, applicantId: string): Promise<boolean> {
  const approver = await env.DB
    .prepare('SELECT role FROM org_memberships WHERE org_id = ? AND user_id = ? AND left_at IS NULL AND confirmed_at IS NOT NULL')
    .bind(orgId, approverId)
    .first<{ role: Role }>();
  if (!approver) return false;
  if (BOSS_ROLES.includes(approver.role)) return true;
  if (approver.role !== 'admin') return false;
  const req = await env.DB.prepare('SELECT invited_by FROM org_memberships WHERE org_id = ? AND user_id = ? AND confirmed_at IS NULL AND left_at IS NULL')
    .bind(orgId, applicantId).first<{ invited_by: string | null }>();
  return req?.invited_by === approverId;
}

/**
 * Подтверждение заявки владельцем.
 *
 * Проверяет, что подтверждающий -- ДЕЙСТВУЮЩИЙ creator/super_admin именно этой
 * организации. Без этой проверки кнопку можно переслать кому угодно: сообщение
 * с ней живёт в Telegram и от нас не зависит.
 */
export async function approveJoin(
  env: Env,
  approverId: string,
  orgId: string,
  applicantId: string,
  role: Role = 'member',
  /** Отдел (доска), куда сажают новичка. По умолчанию -- первый в организации. */
  projectId?: string,
  /** Должность из профиля отрасли. Права не даёт, но её видят коллеги. */
  position?: string,
): Promise<boolean> {
  if (!(await canDecide(env, approverId, orgId, applicantId))) return false;

  // Владельца с кнопки не выдают: владелец у организации один, и передача
  // владения -- отдельное осознанное действие, а не выбор под уведомлением.
  // super_admin больше не выдаётся (решение 10.09: ролей три).
  if (role === 'creator' || role === 'super_admin') return false;

  const res = await env.DB
    .prepare(`UPDATE org_memberships SET confirmed_at = ?, role = ?, position = COALESCE(?, position)
              WHERE org_id = ? AND user_id = ? AND confirmed_at IS NULL AND left_at IS NULL`)
    .bind(nowIso(), role, position ?? null, orgId, applicantId)
    .run();
  if (!res.meta.changes) return false;

  // Доступ к доске, а не только к организации. И список досок, и задачи в
  // приложении выбираются через project_memberships -- без строки человек
  // видит пустое приложение, а бот отказывается принимать у него задачи.
  // Поэтому подтверждение сразу сажает новичка на доску организации.
  // Отдел выбран при подтверждении -- проверяем, что он ИЗ ЭТОЙ организации:
  // идентификатор приходит из кнопки, а кнопку можно переслать.
  const own = projectId
    ? await env.DB.prepare('SELECT id FROM projects WHERE id = ? AND org_id = ? AND archived_at IS NULL')
        .bind(projectId, orgId).first<{ id: string }>()
    : null;
  // Отдел по умолчанию -- доска ПРИНИМАЮЩЕГО: руководитель отдела сажает
  // новичка к себе, а не на первую доску организации.
  const approverBoard = own ? null : await env.DB.prepare(
    `SELECT pm.project_id AS id FROM project_memberships pm JOIN projects p ON p.id = pm.project_id
     WHERE pm.org_id = ? AND pm.user_id = ? AND p.archived_at IS NULL ORDER BY p.created_at LIMIT 1`,
  ).bind(orgId, approverId).first<{ id: string }>();
  const target = own?.id ?? approverBoard?.id ?? await ensureDefaultProject(env, orgId, approverId);
  await env.DB
    .prepare('INSERT OR IGNORE INTO project_memberships (id, project_id, user_id, org_id) VALUES (?, ?, ?, ?)')
    .bind(uuid(), target, applicantId, orgId)
    .run();

  // Липкий контекст ставится только если человек ещё нигде не работает: у
  // состоящего в трёх организациях подтверждение четвёртой не должно
  // перебрасывать его туда без спроса.
  await env.DB.prepare('UPDATE users SET current_org_id = ? WHERE id = ? AND current_org_id IS NULL').bind(orgId, applicantId).run();
  await env.DB.prepare(
    `INSERT INTO events (id, actor_id, org_id, target_type, target_id, action, comment, overdue_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(uuid(), approverId, orgId, 'membership', orgId, 'join_approved', applicantId, null, nowIso()).run();
  return true;
}

/** Отклонение заявки: строка удаляется, человек может подать её снова. */
export async function rejectJoin(env: Env, approverId: string, orgId: string, applicantId: string): Promise<boolean> {
  if (!(await canDecide(env, approverId, orgId, applicantId))) return false;
  const res = await env.DB
    .prepare('DELETE FROM org_memberships WHERE org_id = ? AND user_id = ? AND confirmed_at IS NULL')
    .bind(orgId, applicantId)
    .run();
  return Boolean(res.meta.changes);
}

/** Заявка, ожидающая решения владельца. */
export type PendingRequest = { user_id: string; name: string; telegram_username: string | null; created_at: string; invited_by: string | null };

/**
 * Заявки, которые вправе решить этот человек: владелец -- все, руководитель
 * отдела -- поданные по его ссылке. Живут в базе, а не только в отправленном
 * сообщении: сообщение с кнопкой тонет среди уведомлений.
 */
export async function pendingRequests(env: Env, orgId: string, viewerId?: string): Promise<PendingRequest[]> {
  const { results } = await env.DB.prepare(
    `SELECT u.id AS user_id, u.name, u.telegram_username, m.created_at, m.invited_by
     FROM org_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.org_id = ? AND m.confirmed_at IS NULL AND m.left_at IS NULL
     ORDER BY m.created_at`,
  ).bind(orgId).all<PendingRequest>();
  if (!viewerId) return results;
  const viewer = await env.DB.prepare('SELECT role FROM org_memberships WHERE org_id = ? AND user_id = ? AND left_at IS NULL AND confirmed_at IS NOT NULL')
    .bind(orgId, viewerId).first<{ role: Role }>();
  if (!viewer) return [];
  return BOSS_ROLES.includes(viewer.role) ? results : results.filter((r) => r.invited_by === viewerId);
}

/**
 * Организация, в которой этот человек вправе решить эту заявку.
 *
 * Нужна из-за предела Telegram: в callback_data кнопки помещается 64 байта, а
 * «join_ok:» с двумя UUID -- это 81, и Telegram отвергал ВСЁ сообщение с
 * кнопками (заявка не доходила до владельца молча). Организацию в кнопку
 * больше не кладём, она ищется здесь -- и поиск заодно есть проверка права:
 * берутся только организации, где нажавший -- действующий creator/super_admin.
 */
export async function pendingOrgFor(env: Env, approverId: string, applicantId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT m.org_id FROM org_memberships m
     JOIN org_memberships a ON a.org_id = m.org_id AND a.user_id = ?
       AND a.left_at IS NULL AND a.confirmed_at IS NOT NULL
       AND (a.role IN ('creator','super_admin') OR (a.role = 'admin' AND m.invited_by = a.user_id))
     WHERE m.user_id = ? AND m.confirmed_at IS NULL AND m.left_at IS NULL
     ORDER BY m.created_at LIMIT 1`,
  ).bind(approverId, applicantId).first<{ org_id: string }>();
  return row?.org_id ?? null;
}

/** Отделы организации по порядку -- ими подписаны кнопки выбора при подтверждении. */
export async function orgDepartments(env: Env, orgId: string): Promise<{ id: string; name: string }[]> {
  const { results } = await env.DB
    .prepare('SELECT id, name FROM projects WHERE org_id = ? AND archived_at IS NULL ORDER BY created_at, rowid')
    .bind(orgId).all<{ id: string; name: string }>();
  return results;
}

/**
 * Отделы, куда ЭТОТ человек вправе сажать новичка: владелец -- в любой,
 * руководитель отдела -- только в свои доски (раздел 19). Нет своих -- любой.
 */
export async function departmentsFor(env: Env, orgId: string, approverId: string): Promise<{ id: string; name: string }[]> {
  const all = await orgDepartments(env, orgId);
  const approver = await env.DB.prepare('SELECT role FROM org_memberships WHERE org_id = ? AND user_id = ? AND left_at IS NULL AND confirmed_at IS NOT NULL')
    .bind(orgId, approverId).first<{ role: Role }>();
  if (!approver || BOSS_ROLES.includes(approver.role)) return all;
  const { results } = await env.DB.prepare('SELECT project_id FROM project_memberships WHERE org_id = ? AND user_id = ?')
    .bind(orgId, approverId).all<{ project_id: string }>();
  const mine = new Set(results.map((r) => r.project_id));
  const own = all.filter((d) => mine.has(d.id));
  return own.length ? own : all;
}
