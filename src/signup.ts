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
export async function createOrg(env: Env, userId: string, name: string): Promise<{ orgId: string; code: string }> {
  const orgId = uuid();
  const code = generateJoinCode();
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO orgs (id, name, join_code, owner_user_id) VALUES (?, ?, ?, ?)').bind(orgId, name, code, userId),
    env.DB.prepare('INSERT INTO org_memberships (id, org_id, user_id, role, confirmed_at) VALUES (?, ?, ?, ?, ?)')
      .bind(uuid(), orgId, userId, 'creator', now),
    // Липкий контекст: человек сразу оказывается в созданной организации.
    env.DB.prepare('UPDATE users SET current_org_id = ? WHERE id = ?').bind(orgId, userId),
  ]);
  return { orgId, code };
}

export type JoinResult =
  | { ok: true; orgId: string; orgName: string; ownerTgId: string | null; applicantName: string }
  | { ok: false; reason: 'unknown_code' | 'already_member' | 'already_pending' };

/**
 * Заявка на вступление по коду. Доступа НЕ даёт -- создаёт членство с
 * confirmed_at = NULL, которое обязан подтвердить владелец.
 */
export async function joinByCode(env: Env, userId: string, code: string): Promise<JoinResult> {
  const org = await env.DB.prepare('SELECT id, name, owner_user_id FROM orgs WHERE join_code = ?')
    .bind(code.trim().toUpperCase())
    .first<{ id: string; name: string; owner_user_id: string | null }>();
  // Неизвестный код -- отказ без подробностей: перебор кодов не должен
  // подсказывать, какие организации существуют.
  if (!org) return { ok: false, reason: 'unknown_code' };

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
    await env.DB.prepare('UPDATE org_memberships SET left_at = NULL, confirmed_at = NULL, role = ? WHERE org_id = ? AND user_id = ?')
      .bind('member', org.id, userId)
      .run();
  } else {
    // Роль по умолчанию -- member: рядовой сотрудник. Повысить может владелец
    // при подтверждении. Обратное (дать admin и потом отбирать) опаснее.
    await env.DB.prepare('INSERT INTO org_memberships (id, org_id, user_id, role, confirmed_at) VALUES (?, ?, ?, ?, NULL)')
      .bind(uuid(), org.id, userId, 'member')
      .run();
  }

  const owner = org.owner_user_id
    ? await env.DB.prepare('SELECT telegram_user_id FROM users WHERE id = ?').bind(org.owner_user_id).first<{ telegram_user_id: string | null }>()
    : null;
  return { ok: true, orgId: org.id, orgName: org.name, ownerTgId: owner?.telegram_user_id ?? null, applicantName: applicant?.name ?? 'Сотрудник' };
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
): Promise<boolean> {
  const approver = await env.DB
    .prepare("SELECT role FROM org_memberships WHERE org_id = ? AND user_id = ? AND left_at IS NULL AND confirmed_at IS NOT NULL")
    .bind(orgId, approverId)
    .first<{ role: Role }>();
  if (!approver || (approver.role !== 'creator' && approver.role !== 'super_admin')) return false;

  const res = await env.DB
    .prepare('UPDATE org_memberships SET confirmed_at = ?, role = ? WHERE org_id = ? AND user_id = ? AND confirmed_at IS NULL AND left_at IS NULL')
    .bind(nowIso(), role, orgId, applicantId)
    .run();
  if (!res.meta.changes) return false;

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
  const approver = await env.DB
    .prepare("SELECT role FROM org_memberships WHERE org_id = ? AND user_id = ? AND left_at IS NULL AND confirmed_at IS NOT NULL")
    .bind(orgId, approverId)
    .first<{ role: Role }>();
  if (!approver || (approver.role !== 'creator' && approver.role !== 'super_admin')) return false;
  const res = await env.DB
    .prepare('DELETE FROM org_memberships WHERE org_id = ? AND user_id = ? AND confirmed_at IS NULL')
    .bind(orgId, applicantId)
    .run();
  return Boolean(res.meta.changes);
}
