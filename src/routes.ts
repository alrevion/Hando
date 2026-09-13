// All /api routes. Access control is delegated to middleware.ts; handlers only
// hold business rules. Every mutating action writes an events row (system of record).
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env, Role, Task, TaskStatus } from './types';
import { chunks, logEvent, nowIso, uuid } from './db';
import { membershipRole, mintSession, precheckPhone, resolveOrgId, sendOtp, SESSION_COOKIE, SESSION_TTL_SECONDS, verifyInitData, verifyOtp, verifySession } from './auth';
import { type AppEnv, requireAuth, requireProjectAccess, requireRole } from './middleware';
import { deleteMessage, editMessageText, getFileUrl, resolveChatId, sendDocument, sendMessage } from './telegram';
import { applyTransition, assigneeButtons, buildNotification } from './transition';
import { buildAssignees, canTransition, confirmWork, declineAssignee, lateAssignee, loadAssignees, myAssignee, reassignTask, resetAssignees, startWork, transitionAssignee, type Assignee, type AssigneeState, type TaskKind } from './assignees';
import { drainOutbox } from './outbox';
import { commandTaskByPhrase, setTaskDeadline } from './intake';
import { toggleItem } from './checklist';
import {
  assigneesOf, confirmDraft, draftAssignable, getDraft, listDrafts, logMiss, mediaOf, patchDraft, removeDraft, renderCreated, renderDraft,
  saveDraft, type DraftPatch, type DraftRow,
} from './drafts';
import { CATEGORIES, PACKS, pack } from './packs';
import { learnAlias, localIso, parseTask, refineDraft, transcribe } from './parse';
import { approveJoin, canCreateOrg, createOrg, inviteCodeFor, inviteLink, joinByCode, notifyApprover, pendingRequests, rejectJoin } from './signup';
import { assignableMembers, canAssign, canManageMember, returnOpenTasks, setFrozen, subtreeOf, visibleMembers, visibleTasks, visibleUserIds } from './hierarchy';
import { deleteOrg, leaveOrg, myOrgs, renameOrg, setDisplayName, setNotifyPrefs, switchOrg, updateOrgSettings, type OrgSettingsPatch } from './menu';
import { askAssistant, type AskTurn } from './assistant';
import { dayEnd, hm, loadSchedule, weekEndDay } from './schedule';

// Telegram's Bot API can only download files up to 20MB back out (uploads may be
// larger, but would then be permanently unretrievable). Enforce the download cap
// at upload time so users get a clear error instead of losing an unfetchable file.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;


export const apiRoutes = new Hono<AppEnv>();

// projectChatId и notifyTask удалены на шаге 1: адрес чата и текст сообщения
// теперь собирает transition.ts, а отправляет outbox.ts. Держать здесь второй
// путь рассылки значило бы, что «ровно один раз» доказано только для одного.

// Shared by both archive views: attach each task's event trail with actor
// names resolved (null actor = system, e.g. auto-archive). N+1 is fine here --
// an internal tool's archive is never more than a handful of tasks at a time.
async function withEventTrail(db: D1Database, orgId: string, tasks: Record<string, unknown>[]) {
  const out = [];
  for (const task of tasks) {
    const { results: events } = await db
      .prepare(
        `SELECT e.*, u.name AS actor_name FROM events e
         LEFT JOIN users u ON u.id = e.actor_id
         WHERE e.target_type = 'task' AND e.target_id = ? AND e.org_id = ?
         ORDER BY e.created_at ASC`,
      )
      .bind(task.id, orgId)
      .all();
    out.push({ task, events });
  }
  return out;
}

// ---------------------------------------------------------------- auth (public)

apiRoutes.post('/auth/login', async (c) => {
  const { phone } = await c.req.json<{ phone?: string }>().catch(() => ({ phone: undefined }));
  if (!phone) return c.json({ error: 'phone required' }, 400);
  // Pre-check FIRST: unregistered phone is rejected without ever calling auth-api.
  const user = await precheckPhone(c.env.DB, phone);
  if (!user) return c.json({ error: 'phone not registered', code: 'PHONE_NOT_REGISTERED' }, 404);
  if (!(await sendOtp(c.env, phone))) return c.json({ error: 'otp send failed' }, 502);
  return c.json({ success: true });
});

apiRoutes.post('/auth/verify', async (c) => {
  const { phone, code } = await c.req.json<{ phone?: string; code?: string }>().catch(() => ({ phone: undefined, code: undefined }));
  if (!phone || !code) return c.json({ error: 'phone and code required' }, 400);
  const user = await precheckPhone(c.env.DB, phone);
  if (!user) return c.json({ error: 'phone not registered', code: 'PHONE_NOT_REGISTERED' }, 404);
  if (!(await verifyOtp(c.env, phone, code))) return c.json({ error: 'invalid code' }, 401);

  // Роль и организация -- из членства, не из мёртвой users.role. Одно членство --
  // вход сразу; несколько без выбранного current -- resolveOrgId вернёт null, и
  // человеку придётся выбрать организацию (экран выбора -- шаг 5).
  const orgId = await resolveOrgId(c.env.DB, user.id);
  if (!orgId) return c.json({ error: 'no active organisation for this account' }, 403);
  const role = await membershipRole(c.env.DB, orgId, user.id);
  if (!role) return c.json({ error: 'no active organisation for this account' }, 403);
  const token = await mintSession(c.env.SESSION_SECRET, { sub: user.id, role, org_id: orgId });
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: SESSION_TTL_SECONDS });
  return c.json({ user: { id: user.id, name: user.name, role, org_id: orgId } });
});

/**
 * Вход из мини-приложения Telegram. Публичный роут -- он ДО requireAuth, как и
 * остальные /auth/*: человек тут ещё без сессии, он её и получает.
 *
 * Телефон и OTP не нужны: подпись Telegram доказывает, что это тот самый
 * аккаунт, который уже подключён к боту. Второй способ входа, а не замена
 * первого -- у кого-то бот не подключён, и он входит по номеру.
 */
apiRoutes.post('/auth/telegram', async (c) => {
  const { initData } = await c.req.json<{ initData?: string }>().catch(() => ({}) as Record<string, undefined>);
  const tg = await verifyInitData(c.env.TELEGRAM_BOT_TOKEN, initData ?? '');
  if (!tg) return c.json({ error: 'invalid initData' }, 401);

  // Человек должен быть уже подключён к боту: мини-приложение не заводит людей,
  // это делает регистрация в самом боте. Иначе появился бы второй путь создания
  // пользователей, о котором не знает подтверждение владельцем.
  const user = await c.env.DB.prepare('SELECT id, name FROM users WHERE telegram_user_id = ?')
    .bind(tg.id)
    .first<{ id: string; name: string }>();
  if (!user) return c.json({ error: 'not connected', code: 'CONNECT_BOT_FIRST' }, 403);

  let orgId = await resolveOrgId(c.env.DB, user.id);
  if (!orgId) {
    // Несколько членств и ни одно не выбрано -- берём первое по времени: это
    // лучше, чем показывать человеку с двумя организациями «создайте первую».
    const first = await c.env.DB.prepare(
      `SELECT m.org_id FROM org_memberships m JOIN orgs o ON o.id = m.org_id
       WHERE m.user_id = ? AND m.left_at IS NULL AND m.confirmed_at IS NOT NULL AND o.archived_at IS NULL
       ORDER BY m.created_at LIMIT 1`,
    ).bind(user.id).first<{ org_id: string }>();
    if (first) {
      await c.env.DB.prepare('UPDATE users SET current_org_id = ? WHERE id = ?').bind(first.org_id, user.id).run();
      orgId = first.org_id;
    }
  }
  const role = orgId ? await membershipRole(c.env.DB, orgId, user.id) : null;
  if (!orgId || !role) {
    // Первая организация создаётся В ПРИЛОЖЕНИИ (раздел 18): сессия без
    // организации законна и открывает экран «создайте или вступите».
    const token = await mintSession(c.env.SESSION_SECRET, { sub: user.id, role: 'member', org_id: null });
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: SESSION_TTL_SECONDS });
    return c.json({ user: { id: user.id, name: user.name, role: 'member', org_id: null } });
  }

  const token = await mintSession(c.env.SESSION_SECRET, { sub: user.id, role, org_id: orgId });
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: SESSION_TTL_SECONDS });
  return c.json({ user: { id: user.id, name: user.name, role, org_id: orgId } });
});

apiRoutes.post('/auth/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ success: true });
});

// ------------------------------------------------------ everything below: authed

apiRoutes.use('*', requireAuth);

apiRoutes.get('/me', async (c) => {
  if (!c.get('orgId')) {
    // Без организации: имя, настройки и список заявок, которые ждут решения.
    const u = await c.env.DB.prepare("SELECT id, name, COALESCE(notify_mode,'all') AS notify_mode, COALESCE(remind_before_min,30) AS remind_before_min FROM users WHERE id = ?")
      .bind(c.get('userId')).first<{ id: string; name: string }>();
    if (!u) return c.json({ error: 'not found' }, 404);
    const { results: pending } = await c.env.DB.prepare(
      `SELECT o.name FROM org_memberships m JOIN orgs o ON o.id = m.org_id
       WHERE m.user_id = ? AND m.confirmed_at IS NULL AND m.left_at IS NULL AND o.archived_at IS NULL`,
    ).bind(c.get('userId')).all<{ name: string }>();
    return c.json({ user: { ...u, role: 'member', org_id: null, org_name: null, pending: pending.map((p) => p.name) } });
  }
  // Роль -- из членства в ТЕКУЩЕЙ организации, не из мёртвой users.role. Иначе
  // между 2a и 2b человек видел бы у себя роль, по которой ему уже ничего не
  // разрешено. org отдаётся клиенту: фронту нужно знать, где он находится.
  const u = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.phone, m.role AS role, m.position AS position, o.id AS org_id, o.name AS org_name,
            COALESCE(u.notify_mode, 'all') AS notify_mode, COALESCE(u.remind_before_min, 30) AS remind_before_min
     FROM users u
     JOIN org_memberships m ON m.user_id = u.id AND m.org_id = ? AND m.left_at IS NULL
     JOIN orgs o ON o.id = m.org_id
     WHERE u.id = ?`,
  )
    .bind(c.get('orgId'), c.get('userId'))
    .first();
  return u ? c.json({ user: u }) : c.json({ error: 'not found' }, 404);
});

// ------------------------------------------------------------------------- users

// Strips a leading @ so the stored value is always bare -- callers that
// display/mention it are the ones responsible for adding the @ back.
function normalizeUsername(raw: string | undefined): string | null {
  const trimmed = raw?.trim().replace(/^@/, '');
  return trimmed ? trimmed : null;
}

// creator creates super_admin; super_admin creates admin. Coarse gate in middleware;
// the "only creator makes super_admin" sub-rule is the one domain check below.
apiRoutes.post('/users', requireRole('super_admin', 'creator'), async (c) => {
  const { phone, name, role, telegram_username } = await c.req
    .json<{ phone?: string; name?: string; role?: Role; telegram_username?: string }>()
    .catch(() => ({}) as Record<string, undefined>);
  if (!phone || !name || !role) return c.json({ error: 'phone, name, role required' }, 400);
  if (role === 'creator') return c.json({ error: 'cannot create creator via API' }, 400);
  if (!['super_admin', 'admin', 'member'].includes(role)) return c.json({ error: 'unknown role' }, 400);
  if (role === 'super_admin' && c.get('role') !== 'creator') return c.json({ error: 'only creator can create super_admin' }, 403);

  const orgId = c.get('orgId');
  const username = normalizeUsername(telegram_username);
  const trimmed = phone.trim();

  // Телефон глобально уникален, а человек -- глобальный (R1-2). Значит «этот
  // телефон уже есть» перестало быть ошибкой: это штатный сценарий первого дня
  // ровно для той персоны, ради которой R1-2 вводился -- владелец добавляет в
  // кафе бухгалтера, уже заведённого в его школе. Слепой catch разбирается на
  // три случая явно.
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE phone = ?').bind(trimmed).first<{ id: string }>();
  if (existing) {
    const already = await c.env.DB
      .prepare('SELECT left_at FROM org_memberships WHERE org_id = ? AND user_id = ?')
      .bind(orgId, existing.id)
      .first<{ left_at: string | null }>();
    if (already && already.left_at === null) return c.json({ error: 'already a member of this organisation' }, 409);

    // ЧУЖОГО ЧЕЛОВЕКА ПО ОДНОМУ ТЕЛЕФОНУ ПРИСОЕДИНИТЬ НЕЛЬЗЯ.
    //
    // Раньше здесь молча создавалось членство. План описывал сценарий «владелец
    // добавляет в кафе своего бухгалтера из школы», где согласие подразумевалось
    // самим фактом, что это его человек. Но код не мог отличить этот случай от
    // «беру телефон постороннего»: имя, роль и организацию задаёт вызывающий, а
    // жертва не получает даже уведомления.
    //
    // Цена была не в самом графте: получив членство, атакующий проходил гейт
    // PATCH /users/:id и переписывал ГЛОБАЛЬНУЮ идентичность жертвы (телефон),
    // после чего входил под ней и попадал в ЕЁ организации.
    //
    // Возврат СВОЕГО отозванного сотрудника разрешён: членство уже было, то есть
    // согласие когда-то состоялось. Присоединение нового идёт через приглашение,
    // которое человек гасит сам.
    if (!already) return c.json({ error: 'this phone already belongs to a person; send them an invite instead', code: 'INVITE_REQUIRED' }, 409);

    // confirmed_at проставляется сразу: заводит человека сам владелец, и он же
    // подтверждающий. Ожидание одобрения нужно только тому, кто вступил ПО КОДУ.
    await c.env.DB.prepare("UPDATE org_memberships SET left_at = NULL, role = ?, confirmed_at = ? WHERE org_id = ? AND user_id = ?").bind(role, nowIso(), orgId, existing.id).run();
    await logEvent(c.env.DB, { actorId: c.get('userId'), orgId, targetType: 'user', targetId: existing.id, action: 'membership_restored' });
    return c.json({ id: existing.id, phone: trimmed, name, role, telegram_username: username }, 201);
  }

  const id = uuid();
  // Пишем в ОБЕ: users.role ради NOT NULL CHECK из 0001_init (снимется в 2b),
  // членство -- ради истины. Без строки в org_memberships созданный человек не
  // принадлежал бы никому и не смог бы войти.
  try {
    await c.env.DB.batch([
      // users.role снята пересборкой 2b: роль живёт только в членстве.
      c.env.DB.prepare('INSERT INTO users (id, phone, name, telegram_username, current_org_id) VALUES (?, ?, ?, ?, ?)').bind(id, trimmed, name, username, orgId),
      // confirmed_at сразу -- см. выше: подтверждает тот, кто заводит.
      c.env.DB.prepare('INSERT INTO org_memberships (id, org_id, user_id, role, confirmed_at) VALUES (?, ?, ?, ?, ?)').bind(uuid(), orgId, id, role, nowIso()),
    ]);
  } catch {
    return c.json({ error: 'could not create user' }, 500);
  }
  await logEvent(c.env.DB, { actorId: c.get('userId'), orgId, targetType: 'user', targetId: id, action: 'created' });
  return c.json({ id, phone: trimmed, name, role, telegram_username: username }, 201);
});

// Edit any subset of name/phone/telegram_username/role -- all optional and
// independent (send only what changed). Was telegram_username-only; broadened
// because there was previously no way to fix a name/phone typo at all.
apiRoutes.patch('/users/:id', requireRole('admin', 'super_admin', 'creator'), async (c) => {
  const body = await c.req.json<{ name?: string; phone?: string; telegram_username?: string; role?: Role }>().catch(() => ({}) as Record<string, undefined>);
  const targetId = c.req.param('id');
  const orgId = c.get('orgId');

  // Человек глобальный, поэтому «существует» больше не значит «мой». Правит
  // только тот, кто состоит в моей организации; тот же opaque 404, что и везде.
  const targetRole = await membershipRole(c.env.DB, orgId, targetId);
  if (!targetRole) return c.json({ error: 'not found' }, 404);

  if (body.role !== undefined) {
    // Nobody edits their own role, super_admin included -- otherwise a
    // super_admin could just demote-proof or promote themselves.
    if (targetId === c.get('userId')) return c.json({ error: 'cannot change your own role' }, 403);
    if (targetRole === 'creator') return c.json({ error: "cannot change the creator's role" }, 403);
    // Ролей три (решение 10.09): владелец, руководитель отдела, участник.
    if (body.role !== 'admin' && body.role !== 'member') return c.json({ error: 'role must be admin or member' }, 400);
    // Руководитель отдела меняет роли только в своём поддереве.
    if (!(await canManageMember(c.env, orgId, c.get('userId'), c.get('role'), targetId))) return c.json({ error: 'forbidden' }, 403);
  }
  // Идентичность (имя, телефон, username) -- только владельцу.
  if ((body.name !== undefined || body.phone !== undefined || 'telegram_username' in body) && c.get('role') === 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  if (body.name !== undefined && !body.name.trim()) return c.json({ error: 'name cannot be empty' }, 400);
  if (body.phone !== undefined && !body.phone.trim()) return c.json({ error: 'phone cannot be empty' }, 400);

  // ИДЕНТИЧНОСТЬ ОБЩЕГО ЧЕЛОВЕКА НЕ ПРИНАДЛЕЖИТ ОДНОМУ АРЕНДАТОРУ.
  //
  // users глобальные (R1-2): один человек живёт в нескольких организациях. Право
  // править его имя и ТЕЛЕФОН выдавалось по членству в одной из них -- значит
  // любая организация могла переписать его точку входа и войти под ним в
  // остальные. Роль правится по-прежнему: она и так org-скоупная.
  const identityEdit = body.name !== undefined || body.phone !== undefined || 'telegram_username' in body;
  if (identityEdit) {
    const elsewhere = await c.env.DB
      .prepare('SELECT 1 FROM org_memberships WHERE user_id = ? AND org_id <> ? AND left_at IS NULL')
      .bind(targetId, orgId)
      .first();
    if (elsewhere) {
      return c.json({ error: 'this person belongs to other organisations; only their role can be changed here' }, 403);
    }
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) {
    sets.push('name = ?');
    binds.push(body.name.trim());
  }
  if (body.phone !== undefined) {
    sets.push('phone = ?');
    binds.push(body.phone.trim());
  }
  if ('telegram_username' in body) {
    sets.push('telegram_username = ?');
    binds.push(normalizeUsername(body.telegram_username));
  }
  // Роль пишется ТОЛЬКО в членство: колонка users.role снята пересборкой 2b.
  // Правка идентичности (имя/телефон/username) и правка роли -- две разные
  // записи, и вторая может быть единственной.
  if (sets.length === 0 && body.role === undefined) return c.json({ error: 'nothing to update' }, 400);
  try {
    const writes = [];
    if (sets.length > 0) {
      binds.push(targetId);
      writes.push(c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds));
    }
    if (body.role !== undefined) {
      writes.push(c.env.DB.prepare('UPDATE org_memberships SET role = ? WHERE org_id = ? AND user_id = ?').bind(body.role, orgId, targetId));
    }
    await c.env.DB.batch(writes);
  } catch {
    return c.json({ error: 'phone already exists' }, 409);
  }

  await logEvent(c.env.DB, { actorId: c.get('userId'), orgId: c.get('orgId'), targetType: 'user', targetId, action: 'edited' });
  return c.json({ success: true });
});

// Карточка человека: сдано в срок, средняя просрочка, принял/отказался, в
// работе сейчас -- за всё время и за 30 дней. Видит тот, кто видит человека.
apiRoutes.get('/users/:id/stats', async (c) => {
  const targetId = c.req.param('id');
  const orgId = c.get('orgId');
  const visible = await visibleUserIds(c.env, orgId, c.get('userId'), c.get('role'));
  if (visible !== 'all' && !visible.has(targetId)) return c.json({ error: 'not found' }, 404);
  if (!(await membershipRole(c.env.DB, orgId, targetId))) return c.json({ error: 'not found' }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT a.state, a.accepted_at, a.done_at, a.due_at, a.created_at, t.status AS task_status
     FROM task_assignees a JOIN tasks t ON t.id = a.task_id
     WHERE a.user_id = ? AND a.org_id = ?`,
  ).bind(targetId, orgId).all<{ state: string; accepted_at: string | null; done_at: string | null; due_at: string | null; created_at: string; task_status: string }>();
  const since = Date.now() - 30 * 86400_000;
  const parse = (v: string) => Date.parse(v.includes('T') ? v : `${v.replace(' ', 'T')}Z`);
  const stats = (rows: typeof results) => {
    const done = rows.filter((r) => (r.state === 'done' || r.state === 'confirmed') && r.done_at);
    const dated = done.filter((r) => r.due_at);
    const late = dated.filter((r) => parse(r.done_at!) > parse(r.due_at!));
    const avgLateDays = late.length
      ? late.reduce((s, r) => s + (parse(r.done_at!) - parse(r.due_at!)) / 86400_000, 0) / late.length
      : 0;
    return {
      done: done.length,
      on_time_pct: dated.length ? Math.round(((dated.length - late.length) / dated.length) * 100) : null,
      avg_late_days: Math.round(avgLateDays * 10) / 10,
      accepted: rows.filter((r) => r.accepted_at).length,
      declined: rows.filter((r) => r.state === 'declined').length,
      in_progress: rows.filter((r) => (r.state === 'accepted' || r.state === 'rejected') && r.task_status !== 'archived').length,
    };
  };
  return c.json({ all: stats(results), last30: stats(results.filter((r) => parse(r.created_at) >= since)) });
});

// Справочник людей -- ПО ДЕРЕВУ (раздел 19): владелец видит всех, руководитель
// отдела -- своё поддерево и людей своих досок, участник -- людей своих досок.
// Телефон -- только владельцу (модалка правки человека).
apiRoutes.get('/users', async (c) => {
  const role = c.get('role');
  const withPhone = role === 'super_admin' || role === 'creator';
  const rows = await visibleMembers(c.env, c.get('orgId'), c.get('userId'), role, withPhone);
  return c.json(rows.map(({ aliases: _a, ...u }) => { void _a; return u; }));
});

// ---------------------------------------------------------------------- projects

// creator видит все доски СВОЕЙ организации. super_admin/admin -- только те, куда
// их добавили, или (super_admin) созданные ими самими: у каждой доски свои люди,
// роль не даёт членства автоматически.
// Заявки на вступление. Отдельно от /users НАМЕРЕННО: подавший заявку ещё не
// сотрудник -- ему нельзя поручать и его нельзя показывать среди коллег, пока
// владелец не решил. Экран нужен потому, что сообщение с кнопкой в Telegram
// теряется среди уведомлений, а заявка обязана дождаться ответа.
apiRoutes.get('/memberships/pending', requireRole('admin', 'super_admin', 'creator'), async (c) =>
  c.json(await pendingRequests(c.env, c.get('orgId'), c.get('userId'))));

apiRoutes.post('/memberships/:userId/approve', requireRole('admin', 'super_admin', 'creator'), async (c) => {
  const applicantId = c.req.param('userId');
  const b = await c.req.json<{ role?: string; project_id?: string; position?: string }>()
    .catch(() => ({}) as Record<string, undefined>);
  // Роль и отдел выбирают ПРИ подтверждении -- иначе каждый вступивший молча
  // становился рядовым, и поменять это можно было только с компьютера.
  // Владельца отсюда не выдают: это делает approveJoin.
  const role = (['member', 'admin'] as const).find((r) => r === b.role) ?? 'member';
  // Право проверяется ВНУТРИ approveJoin по членству, а не только по роли из
  // сессии: организация в адресе не участвует, она берётся из сессии.
  const ok = await approveJoin(c.env, c.get('userId'), c.get('orgId'), applicantId, role, b.project_id, b.position);
  if (!ok) return c.json({ error: 'no pending request' }, 404);
  const tg = await c.env.DB.prepare('SELECT telegram_user_id FROM users WHERE id = ?')
    .bind(applicantId).first<{ telegram_user_id: string | null }>();
  if (tg?.telegram_user_id) await sendMessage(c.env, tg.telegram_user_id, 'Вас приняли. Ваши задачи — кнопка «Мои задачи».');
  return c.json({ ok: true });
});

apiRoutes.post('/memberships/:userId/reject', requireRole('admin', 'super_admin', 'creator'), async (c) => {
  const ok = await rejectJoin(c.env, c.get('userId'), c.get('orgId'), c.req.param('userId'));
  return ok ? c.json({ ok: true }) : c.json({ error: 'no pending request' }, 404);
});

// Задача одной фразой -- текстом или голосом, тем же путём, что в боте.
//
// ПАРИТЕТ: разбор (parseTask) и создание (createFromDraft) здесь ровно те же
// функции, что обслуживают бота. Своя ветка создания задач разошлась бы с
// ботом в мелочах -- источник, уведомления, вложение -- и разошлась бы молча.
//
// Тело либо JSON {text}, либо multipart с полем audio: приложение записывает
// голос там, где браузер это умеет, и падает на текст там, где не умеет.
apiRoutes.post('/tasks/dictate', async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const type = c.req.header('content-type') ?? '';

  let phrase = '';
  let forced: string | null = null;
  let mode: 'mine' | 'assigned' = 'mine';
  let priorityOverride: 'urgent' | 'medium' | 'low' | null = null;
  if (type.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const audio = form.get('audio');
    forced = (form.get('assignee_id') as string | null) || null;
    mode = form.get('mode') === 'assigned' ? 'assigned' : 'mine';
    const p = form.get('priority');
    priorityOverride = typeof p === 'string' && PRIORITIES.includes(p) ? (p as 'urgent' | 'medium' | 'low') : null;
    // Сужение через typeof, а не instanceof: form.get отдаёт «строка или файл»,
    // и instanceof по такому объединению typescript не пропускает.
    if (!audio || typeof audio === 'string') return c.json({ error: 'audio required' }, 400);
    const name = (audio as { name?: string }).name || 'voice.webm';
    const text = await transcribe(c.env, audio as Blob, name);
    if (!text) return c.json({ error: 'Не удалось разобрать запись', code: 'TRANSCRIBE_FAILED' }, 422);
    phrase = text;
  } else {
    const b = await c.req.json<{ text?: string; assignee_id?: string; mode?: string; priority?: string }>()
      .catch(() => ({}) as Record<string, undefined>);
    phrase = (b.text ?? '').trim();
    forced = b.assignee_id ?? null;
    mode = b.mode === 'assigned' ? 'assigned' : 'mine';
    priorityOverride = PRIORITIES.includes(b.priority ?? '') ? (b.priority as 'urgent' | 'medium' | 'low') : null;
  }
  if (!phrase) return c.json({ error: 'text required' }, 400);

  // Справочник -- только ПОДТВЕРЖДЁННЫЕ участники: разбор не должен находить
  // заявителя, которого ещё не приняли.
  // Справочник -- те, КОМУ МОЖНО ПОРУЧАТЬ (дерево, раздел 19), а не вся организация.
  const people = await assignableMembers(c.env, orgId, userId, c.get('role'));
  const roster = people.map((p) => ({ id: p.id, name: p.name, aliases: p.aliases ? (JSON.parse(p.aliases) as string[]) : undefined }));

  const org = await c.env.DB.prepare('SELECT timezone, industry_pack FROM orgs WHERE id = ?').bind(orgId)
    .first<{ timezone: string; industry_pack: string }>();
  const sched0 = await loadSchedule(c.env, orgId);
  const draft = await parseTask(c.env, phrase, roster, userId, org?.timezone ?? 'Asia/Tashkent', new Date(), org?.industry_pack, dayEnd(sched0), weekEndDay(sched0));
  if (draft.ambiguous.length > 0) {
    return c.json({ error: 'Уточните, кого вы имели в виду', code: 'AMBIGUOUS', ambiguous: draft.ambiguous }, 409);
  }
  // Выбранный в форме человек ПЕРЕБИВАЕТ разбор: явный выбор всегда точнее
  // догадки по фразе. Чужой идентификатор -- отказ, а не молчаливое
  // игнорирование: иначе устаревший выбор в форме тихо уехал бы не тому.
  if (forced) {
    if (!roster.some((p) => p.id === forced)) return c.json({ error: 'Такого человека нет в организации' }, 400);
    draft.assigneeIds = [forced];
  }
  if (priorityOverride) draft.priority = priorityOverride;

  // ПОРУЧЕНИЕ БЕЗ УЗНАННОГО АДРЕСАТА -- вопрос, а не догадка.
  //
  // Человек нажал «+» на поручениях и сказал «нужно Еве приготовить сырники».
  // Евы в организации нет, разбор никого не нашёл и по общему правилу записал
  // бы задачу НА АВТОРА. Здесь адресат просто остаётся пустым: карточка
  // черновика спросит «кому?», и без ответа её не подтвердить.
  if (mode === 'assigned' && !forced && draft.assigneeIds.length === 1 && draft.assigneeIds[0] === userId) {
    draft.assigneeIds = [];
  }

  // Задача НЕ создаётся: это черновик, и его ещё подтвердят. Разбор
  // ошибается, и «не тому» должно ловиться до того, как поручение ушло.
  const row = await saveDraft(c.env, { userId, orgId }, draft, phrase, []);
  return c.json(await draftView(c.env, row), 201);
});

// ------------------------------------------------------------ черновики
//
// Те же черновики, что в боте: продиктованное в приложении видно в
// «Черновиках» бота, и наоборот. Карточка в чате правится вслед за правкой
// здесь -- иначе человек нажал бы «Создать» на уже созданном.

/** Черновик для ответа: имена вместо идентификаторов, счётчик вложений. */
async function draftView(env: Env, row: DraftRow) {
  const ids = assigneesOf(row);
  const names = ids.length === 0 ? [] : (await env.DB.prepare(
    `SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).bind(...ids).all<{ id: string; name: string }>()).results;
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    deadline: row.deadline,
    priority: row.priority,
    priority_explicit: row.priority_explicit === 1,
    repeat_days: row.repeat_days,
    kind: row.kind,
    assignee_ids: ids,
    assignees: ids.map((id) => names.find((n) => n.id === id)?.name ?? '—'),
    heard: row.heard,
    media_count: mediaOf(row).filter((m) => !m.hasAudio).length,
    created_at: row.created_at,
  };
}

/** Черновик по адресу -- только СВОЙ и в СВОЕЙ организации; иначе 404 без деталей. */
async function ownDraft(c: Context<AppEnv>): Promise<DraftRow | null> {
  const row = await getDraft(c.env, c.req.param('id') ?? '');
  if (!row || row.author_id !== c.get('userId') || row.org_id !== c.get('orgId')) return null;
  return row;
}

async function orgTz(env: Env, orgId: string): Promise<string> {
  const org = await env.DB.prepare('SELECT timezone FROM orgs WHERE id = ?').bind(orgId).first<{ timezone: string }>();
  return org?.timezone ?? 'Asia/Tashkent';
}

/** «2026-09-11» -> конец рабочего дня организации в её поясе. */
function atDayEnd(ymd: string, sched: Awaited<ReturnType<typeof loadSchedule>>): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const end = hm(dayEnd(sched));
  return new Date(Date.parse(localIso(y, m, d, Math.floor(end / 60), sched.timezone)) + (end % 60) * 60000).toISOString();
}

apiRoutes.get('/drafts', async (c) => {
  const rows = await listDrafts(c.env, c.get('userId'), c.get('orgId'));
  return c.json({ drafts: await Promise.all(rows.map((r) => draftView(c.env, r))) });
});

/**
 * Проверяет и применяет правки черновика. Один разбор тела на два маршрута:
 * PATCH (бот и список черновиков) и подтверждение с правками одним запросом
 * (карточка в приложении). Две копии этих проверок разошлись бы на первой же
 * правке, а цена расхождения -- поручение не тому человеку.
 */
async function applyDraftEdits(
  c: Context<AppEnv>, row: DraftRow, b: Record<string, unknown>,
): Promise<{ row: DraftRow } | { error: string }> {
  const patch: DraftPatch = {};
  if (b.title !== undefined) {
    const t = String(b.title).trim();
    if (t.length < 2 || t.length > 200) return { error: 'bad title' };
    patch.title = t;
  }
  if (b.description !== undefined) {
    const d = b.description === null ? null : String(b.description).slice(0, 4000);
    patch.description = d && d.trim() ? d : null;
  }
  if (b.assignee_ids !== undefined) {
    if (!Array.isArray(b.assignee_ids)) return { error: 'bad assignees' };
    const ids = (b.assignee_ids as unknown[]).map(String);
    // Только те, кому этот человек вправе поручать (дерево): чужой id -- отказ.
    if (!(await canAssign(c.env, c.get('orgId'), c.get('userId'), c.get('role'), ids))) {
      return { error: 'Такого человека нет в организации' };
    }
    patch.assigneeIds = [...new Set(ids)];
  }
  const sched = await loadSchedule(c.env, c.get('orgId'));
  if (b.deadline !== undefined) {
    const dl = b.deadline;
    if (dl === null) patch.deadline = null;
    else if (typeof dl === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dl)) {
      // Дата без часа -- конец рабочего дня по графику, как у кнопок бота.
      patch.deadline = atDayEnd(dl, sched);
    } else if (typeof dl === 'string' && !Number.isNaN(Date.parse(dl))) patch.deadline = new Date(dl).toISOString();
    else return { error: 'bad deadline' };
  }
  if (b.repeat_days !== undefined) {
    const r = b.repeat_days === null || b.repeat_days === 0 ? null : Number(b.repeat_days);
    if (r !== null && (!Number.isInteger(r) || r < 1 || r > 365)) return { error: 'bad repeat' };
    patch.repeatDays = r;
  }
  if (b.priority !== undefined) {
    if (!PRIORITIES.includes(String(b.priority))) return { error: 'bad priority' };
    patch.priority = String(b.priority) as DraftRow['priority'];
    patch.priorityExplicit = true;
  }
  const updated = (await patchDraft(c.env, row.id, patch))!;
  // Карточка в чате правится вслед: иначе человек нажал бы «Создать» на
  // карточке со старым сроком.
  if (updated.telegram_chat_id) await renderDraft(c.env, updated, updated.telegram_chat_id, sched.timezone);
  return { row: updated };
}

apiRoutes.patch('/drafts/:id', async (c) => {
  const row = await ownDraft(c);
  if (!row) return c.json({ error: 'not found' }, 404);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const res = await applyDraftEdits(c, row, b);
  if ('error' in res) return c.json({ error: res.error }, 400);
  return c.json(await draftView(c.env, res.row));
});

apiRoutes.post('/drafts/:id/confirm', async (c) => {
  let row = await ownDraft(c);
  if (!row) return c.json({ error: 'not found' }, 404);

  // Правки едут ВМЕСТЕ с подтверждением, одним запросом.
  //
  // Раньше каждое нажатие в карточке (срок, важность, кому) уходило на сервер
  // отдельно, и человек ждал сеть на каждый чип. Теперь карточка правится
  // на устройстве, а сюда приезжает уже итог. Отдельный PATCH остался: им
  // пользуется бот и правка черновика в списке.
  const edits = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  if (edits && Object.keys(edits).length > 0) {
    const res = await applyDraftEdits(c, row, edits);
    if ('error' in res) return c.json({ error: res.error }, 400);
    row = res.row;
  }

  if (row.title.trim().length < 2) return c.json({ error: 'Напишите тему — чего это касается', code: 'NO_TITLE' }, 400);
  // Адресаты перепроверяются при подтверждении: с момента разбора кого-то
  // могли заморозить или отозвать.
  if (!(await draftAssignable(c.env, row))) return c.json({ error: 'Кому-то из адресатов сейчас поручать нельзя', code: 'NOT_ASSIGNABLE' }, 409);
  const taskId = await confirmDraft(c.env, row);
  if (!taskId) return c.json({ error: 'Вас не добавили ни на одну доску', code: 'NO_BOARD' }, 409);
  if (row.telegram_chat_id) await renderCreated(c.env, row, row.telegram_chat_id, await orgTz(c.env, c.get('orgId')), taskId);
  await drainOutbox(c.env);
  return c.json({ id: taskId }, 201);
});

/**
 * Вложение к ЧЕРНОВИКУ. У задачи такой маршрут был всегда, у черновика -- нет,
 * и приложить файл до создания было нельзя вовсе: приходилось сперва создать
 * поручение, а потом его править. Файл ложится в тот же склад (бот-группа) и
 * доезжает до задачи вместе с подтверждением -- как вложение, присланное боту.
 */
/**
 * ПОПРАВКА СЛОВАМИ: «не Азизу, а Беку», «срок вторник», «это срочно», «Ивия --
 * это Ева». В боте так правят с самого начала -- ответом на карточку; в
 * приложении правили только руками по полям, и одно и то же действие выглядело
 * в двух поверхностях по-разному.
 *
 * Маршрут НИЧЕГО НЕ ПИШЕТ в базу. Он получает то, что человек видит на экране
 * сейчас (карточка правится на устройстве), разбирает фразу поверх этих
 * значений и возвращает разницу. Записать -- дело кнопки «Создать», как и
 * раньше: иначе поправка голосом молча сохраняла бы черновик, а отмена
 * перестала бы отменять.
 */
apiRoutes.post('/drafts/:id/refine', async (c) => {
  const row = await ownDraft(c);
  if (!row) return c.json({ error: 'not found' }, 404);

  const type = c.req.header('content-type') ?? '';
  let phrase = '';
  let seen: Record<string, unknown> = {};
  if (type.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const audio = form.get('audio');
    if (!audio || typeof audio === 'string') return c.json({ error: 'audio required' }, 400);
    const name = (audio as { name?: string }).name || 'voice.webm';
    const text = await transcribe(c.env, audio as Blob, name);
    if (!text) return c.json({ error: 'Не удалось разобрать запись. Напишите текстом.' }, 422);
    phrase = text;
    const cur = form.get('current');
    if (typeof cur === 'string') seen = JSON.parse(cur) as Record<string, unknown>;
  } else {
    const b = await c.req.json<{ text?: string; current?: Record<string, unknown> }>().catch(() => ({}) as Record<string, undefined>);
    phrase = (b.text ?? '').trim().slice(0, 1000);
    seen = b.current ?? {};
  }
  if (!phrase) return c.json({ error: 'text required' }, 400);

  // За основу -- то, что на экране; чего экран не прислал, берём из строки.
  const current = {
    title: typeof seen.title === 'string' ? seen.title : row.title,
    assigneeIds: Array.isArray(seen.assignee_ids) ? (seen.assignee_ids as unknown[]).map(String) : assigneesOf(row),
    deadline: seen.deadline === null || typeof seen.deadline === 'string' ? (seen.deadline as string | null) : row.deadline,
    priority: (PRIORITIES.includes(String(seen.priority)) ? String(seen.priority) : row.priority) as DraftRow['priority'],
    priorityExplicit: row.priority_explicit === 1,
  };

  const people = await assignableMembers(c.env, c.get('orgId'), c.get('userId'), c.get('role'));
  const roster = people.map((p) => ({ id: p.id, name: p.name, aliases: p.aliases ? (JSON.parse(p.aliases) as string[]) : undefined }));
  const org = await c.env.DB.prepare('SELECT industry_pack FROM orgs WHERE id = ?').bind(c.get('orgId')).first<{ industry_pack: string }>();
  const sched = await loadSchedule(c.env, c.get('orgId'));
  const patch = await refineDraft(c.env, current, phrase, roster, sched.timezone, org?.industry_pack, new Date(), dayEnd(sched), weekEndDay(sched));

  // Поправка = разобрали неверно; отмечаем промах так же, как бот.
  if (Object.keys(patch).length > 0) await logMiss(c.env, c.get('userId'), c.get('orgId'));

  // Поправка научила систему новому прозвищу -- запоминаем, как и в боте.
  const to = patch.assigneeIds?.[0];
  if (to && !current.assigneeIds.includes(to)) await learnAlias(c.env, phrase, roster, to);

  return c.json({
    heard: phrase,
    patch: {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.assigneeIds !== undefined ? { assignee_ids: patch.assigneeIds } : {}),
      ...(patch.deadline !== undefined ? { deadline: patch.deadline } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    },
  });
});

apiRoutes.post('/drafts/:id/attachments', async (c) => {
  const row = await ownDraft(c);
  if (!row) return c.json({ error: 'not found' }, 404);
  const declaredLen = Number(c.req.header('content-length') ?? 0);
  if (declaredLen > MAX_ATTACHMENT_BYTES + 4096) return c.json({ error: 'Файл больше 20 МБ' }, 413);
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: 'file required' }, 400);
  if (file.size > MAX_ATTACHMENT_BYTES) return c.json({ error: 'Файл больше 20 МБ' }, 413);

  const mime = file.type || 'application/octet-stream';
  // Склад -- бот-группа Telegram, и она может не ответить. Молчаливая пятисотка
  // выглядит как «кнопка не работает»: человек жмёт ещё раз, а причина не
  // названа. Говорим прямо.
  const stored = await sendDocument(c.env, c.env.TELEGRAM_STORAGE_CHAT_ID, file, file.name).catch(() => null);
  if (!stored) return c.json({ error: 'Файл не сохранился. Попробуйте ещё раз или пришлите его боту в чат.' }, 502);
  const { fileId } = stored;
  const media = [...mediaOf(row), {
    kind: mime.startsWith('image/') ? 'photo' as const : 'document' as const,
    fileId, filename: file.name, mimeType: mime, sizeBytes: file.size, hasAudio: false,
  }];
  const updated = (await patchDraft(c.env, row.id, { media }))!;
  if (updated.telegram_chat_id) await renderDraft(c.env, updated, updated.telegram_chat_id, await orgTz(c.env, c.get('orgId')));
  return c.json(await draftView(c.env, updated), 201);
});

apiRoutes.delete('/drafts/:id', async (c) => {
  const row = await ownDraft(c);
  if (!row) return c.json({ error: 'not found' }, 404);
  await removeDraft(c.env, row.id);
  if (row.telegram_chat_id && row.telegram_message_id) {
    await editMessageText(c.env, row.telegram_chat_id, row.telegram_message_id, '✖ Черновик удалён.');
  }
  return c.json({ ok: true });
});

// Срок и срочность кнопками -- то же, что кнопки под подтверждением в боте.
// Один роут на оба поля: это одна и та же правка «в два касания», и два
// отдельных роута означали бы две записи в реестре ради одного действия.
apiRoutes.patch('/tasks/:id/quick', requireProjectAccess('task'), async (c) => {
  // Задачу и доступ к её доске грузит штатная мидлвара, а не свой SELECT:
  // структурный инвариант шага 0 требует именно её, и он прав -- своя выборка
  // однажды забудет проверку доски.
  const task = c.get('task')!;
  const b = await c.req.json<{ deadline?: string | null; priority?: string }>()
    .catch(() => ({}) as Record<string, undefined>);

  // Правит автор или руководитель организации: срок и срочность -- требование
  // поручителя, а не исполнителя.
  const role = c.get('role');
  if (task.author_id !== c.get('userId') && role !== 'creator' && role !== 'super_admin') {
    return c.json({ error: 'not allowed' }, 403);
  }

  if (b.priority !== undefined) {
    if (!PRIORITIES.includes(b.priority)) return c.json({ error: 'bad priority' }, 400);
    await c.env.DB.prepare('UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ? AND org_id = ?')
      .bind(b.priority, nowIso(), task.id, c.get('orgId')).run();
  }
  if (b.deadline !== undefined) {
    // «2026-09-11» приходит из системного выбора даты; час дописывается ЗДЕСЬ,
    // в поясе организации, а не на клиенте: у телефона свой пояс, и «пятница»
    // у сотрудника в другом городе означала бы другой момент.
    let iso = b.deadline;
    if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) iso = atDayEnd(iso, await loadSchedule(c.env, c.get('orgId')));
    // Срок ложится и в задачу, и в строки адресатов: напоминание считает по ним.
    await setTaskDeadline(c.env, task.id, c.get('orgId'), iso);
  }
  return c.json({ ok: true });
});

// ------------------------------------------------------------ организации
//
// ПАРИТЕТ С БОТОМ. Всё, что человек делает кнопками в боте, он должен делать и
// в приложении -- и наоборот. Логика ОДНА: эти роуты вызывают те же функции,
// что экраны бота (menu.ts, signup.ts), а не свою копию правил. Копия правил
// доступа разошлась бы с ботом на первой же правке, и разошлась бы молча.
//
// Единственное, чего здесь быть не может: создание САМОЙ ПЕРВОЙ организации.
// Сессия приложения выдаётся только тому, у кого организация уже есть (иначе в
// куке нечего писать), поэтому первый вход -- через бота. Вторую и следующие
// приложение заводит наравне с ботом.
apiRoutes.get('/orgs/mine', async (c) => c.json(await myOrgs(c.env, c.get('userId'))));

/** Перевыпуск куки: организация лежит В claim'ах, и после смены её надо обновить. */
async function reissue(c: Context<AppEnv>, userId: string, orgId: string): Promise<void> {
  const role = await membershipRole(c.env.DB, orgId, userId);
  if (!role) return;
  const token = await mintSession(c.env.SESSION_SECRET, { sub: userId, role, org_id: orgId });
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: SESSION_TTL_SECONDS });
}

// Профили отрасли -- одним списком, чтобы приложение не держало свою копию:
// две копии словаря разошлись бы на первой правке, и бот с приложением стали
// бы заводить разные отделы под одним названием профиля.
apiRoutes.get('/packs', async (c) => c.json({
  categories: CATEGORIES.map((k) => ({ id: k.id, title: k.title, emoji: k.emoji })),
  industries: PACKS.map((p) => ({
    id: p.id, title: p.title, emoji: p.emoji, category: p.category,
    departments: p.departments, positions: p.positions, examples: p.examples,
  })),
}));

/** Должности профиля организации -- ими подписан выбор при подтверждении заявки. */
apiRoutes.get('/org/positions', async (c) => {
  const org = await c.env.DB.prepare('SELECT industry_pack FROM orgs WHERE id = ?').bind(c.get('orgId'))
    .first<{ industry_pack: string }>();
  return c.json(pack(org?.industry_pack).positions);
});

apiRoutes.post('/orgs', async (c) => {
  if (!(await canCreateOrg(c.env, c.get('userId')))) return c.json({ error: 'Слишком много организаций', code: 'ORG_CAP' }, 429);
  const { name, pack } = await c.req.json<{ name?: string; pack?: string }>().catch(() => ({}) as Record<string, undefined>);
  if (!name?.trim()) return c.json({ error: 'name required' }, 400);
  const { orgId, code } = await createOrg(c.env, c.get('userId'), name.trim(), pack ?? 'generic');
  // Создатель сразу оказывается внутри созданного -- как и в боте.
  await reissue(c, c.get('userId'), orgId);
  return c.json({ id: orgId, name: name.trim(), join_code: code }, 201);
});

apiRoutes.post('/orgs/join', async (c) => {
  const { code } = await c.req.json<{ code?: string }>().catch(() => ({}) as Record<string, undefined>);
  if (!code?.trim()) return c.json({ error: 'code required' }, 400);
  const res = await joinByCode(c.env, c.get('userId'), code.trim());
  if (!res.ok) return c.json({ error: res.reason, code: res.reason }, 409);
  // Карточка решающему -- та же, что шлёт бот: заявка обязана дойти
  // независимо от того, откуда её подали.
  await notifyApprover(c.env, res, c.get('userId'));
  return c.json({ ok: true, org_name: res.orgName });
});

apiRoutes.post('/orgs/:orgId/switch', async (c) => {
  const orgId = c.req.param('orgId');
  if (!(await switchOrg(c.env, c.get('userId'), orgId))) return c.json({ error: 'not a member' }, 403);
  await reissue(c, c.get('userId'), orgId);
  return c.json({ ok: true });
});

apiRoutes.patch('/orgs/:orgId', async (c) => {
  const b = await c.req.json<{ name?: string } & OrgSettingsPatch>().catch(() => ({}) as Record<string, undefined>);
  const orgId = c.req.param('orgId');
  // Право владельца проверяется ВНУТРИ renameOrg/updateOrgSettings -- там же, где для бота.
  if (b.name !== undefined) {
    if (!b.name.trim()) return c.json({ error: 'name required' }, 400);
    if (!(await renameOrg(c.env, c.get('userId'), orgId, b.name.trim()))) return c.json({ error: 'not allowed' }, 403);
  }
  const { name: _n, ...settings } = b;
  void _n;
  if (Object.keys(settings).length > 0) {
    if (!(await updateOrgSettings(c.env, c.get('userId'), orgId, settings))) return c.json({ error: 'not allowed or bad value' }, 403);
  } else if (b.name === undefined) return c.json({ error: 'nothing to update' }, 400);
  return c.json({ ok: true });
});

/**
 * Организация лежит В КЛЕЙМАХ куки, а не читается из базы на каждом запросе.
 * Значит удаление или выход обязаны выпустить куку заново -- иначе следующий
 * же запрос уходит со ссылкой на архивную организацию и получает 401. Ровно
 * это и видел человек: «unauthorized» сразу после удаления, и только
 * перезагрузка приложения (новый вход по initData) возвращала его в строй.
 *
 * Организаций не осталось -- кука выпускается БЕЗ организации, а не гасится:
 * человек остаётся собой и попадает на экран «создайте или вступите».
 */
async function reissueAfterOrgChange(c: Context<AppEnv>, userId: string): Promise<string | null> {
  const next = await resolveOrgId(c.env.DB, userId);
  const role = next ? await membershipRole(c.env.DB, next, userId) : null;
  const orgId = next && role ? next : null;
  const token = await mintSession(c.env.SESSION_SECRET, { sub: userId, role: role ?? 'member', org_id: orgId });
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: SESSION_TTL_SECONDS });
  return orgId;
}

apiRoutes.delete('/orgs/:orgId', async (c) => {
  const ok = await deleteOrg(c.env, c.get('userId'), c.req.param('orgId'));
  if (!ok) return c.json({ error: 'not allowed' }, 403);
  return c.json({ ok: true, org_id: await reissueAfterOrgChange(c, c.get('userId')) });
});

apiRoutes.post('/orgs/:orgId/leave', async (c) => {
  const ok = await leaveOrg(c.env, c.get('userId'), c.req.param('orgId'));
  if (!ok) return c.json({ error: 'not allowed' }, 403);
  return c.json({ ok: true, org_id: await reissueAfterOrgChange(c, c.get('userId')) });
});

/** Своё имя -- то, которое видят коллеги в поручениях. В боте это «Профиль». */
// Личная ссылка-приглашение: заявка по ней приходит её хозяину, не владельцу.
apiRoutes.get('/orgs/:orgId/invite', requireRole('admin', 'super_admin', 'creator'), async (c) => {
  if (c.req.param('orgId') !== c.get('orgId')) return c.json({ error: 'forbidden' }, 403);
  const code = await inviteCodeFor(c.env, c.get('orgId'), c.get('userId'));
  if (!code) return c.json({ error: 'forbidden' }, 403);
  return c.json({ code, link: inviteLink(code) });
});

// «Все задания»: обзор ПОДДЕРЕВА, не всей организации -- маркетинг не видит
// бухгалтерию. Владелец видит всё.
apiRoutes.get('/org/subtree-tasks', requireRole('admin', 'super_admin', 'creator'), async (c) => {
  const orgId = c.get('orgId');
  // ТО ЖЕ правило, что у снимка: руководитель отдела видит свой отдел и своё
  // поддерево, а не всю компанию. Прежде здесь была вторая реализация, и она
  // отдавала «Руководителю» всю организацию, хотя снимок отдавал ему только
  // его доски -- один человек видел разный объём на двух экранах.
  const rows = await visibleTasks(c.env, orgId, c.get('userId'), c.get('role'));
  return c.json({ tasks: await attachAssignees(c.env, orgId, rows) });
});

// Заморозка (отпуск, болезнь): новых задач и уведомлений нет, открытые
// возвращаются авторам вопросом «кому переназначить?». Удаление -- то же плюс left_at.
async function manageTarget(c: Context<AppEnv>, targetId: string): Promise<Role | Response> {
  const orgId = c.get('orgId');
  const target = await membershipRole(c.env.DB, orgId, targetId);
  if (!target) return c.json({ error: 'not found' }, 404);
  if (target === 'creator') return c.json({ error: 'cannot touch the creator' }, 403);
  if (!(await canManageMember(c.env, orgId, c.get('userId'), c.get('role'), targetId))) return c.json({ error: 'forbidden' }, 403);
  return target;
}

apiRoutes.post('/users/:id/freeze', requireRole('admin', 'super_admin', 'creator'), async (c) => {
  const targetId = c.req.param('id');
  const gate = await manageTarget(c, targetId);
  if (gate instanceof Response) return gate;
  await setFrozen(c.env, c.get('orgId'), targetId, true);
  const returned = await returnOpenTasks(c.env, c.get('orgId'), targetId, c.get('userId'), 'Заморожен');
  await logEvent(c.env.DB, { actorId: c.get('userId'), orgId: c.get('orgId'), targetType: 'membership', targetId: c.get('orgId'), action: 'frozen', comment: targetId });
  await drainOutbox(c.env);
  return c.json({ ok: true, returned });
});

apiRoutes.post('/users/:id/unfreeze', requireRole('admin', 'super_admin', 'creator'), async (c) => {
  const targetId = c.req.param('id');
  const gate = await manageTarget(c, targetId);
  if (gate instanceof Response) return gate;
  await setFrozen(c.env, c.get('orgId'), targetId, false);
  await logEvent(c.env.DB, { actorId: c.get('userId'), orgId: c.get('orgId'), targetType: 'membership', targetId: c.get('orgId'), action: 'unfrozen', comment: targetId });
  return c.json({ ok: true });
});

// «Вопрос» -- тот же помощник, что кнопка в боте: как пользоваться и за что взяться.
/**
 * Вопрос ГОЛОСОМ. В боте спросить голосом можно было всегда, в приложении --
 * нет: расшифровка жила только на пути создания задачи, и записанный вопрос
 * уехал бы в черновик поручения. Тот же whisper, тот же помощник, просто
 * вход -- файл.
 */
/**
 * Команда по действующей задаче из приложения -- тот же путь, что в боте.
 *
 * Экран «Вопрос» принимает и голос, и текст, и человек, сказавший туда «взял в
 * работу отчёт», ждёт действия, а не рассказа о кнопках. Разошлись бы две
 * ветки -- в боте команда работала бы, в приложении нет, и объяснить это было
 * бы нечем.
 */
async function taskCommand(c: Context<AppEnv>, question: string): Promise<string | null> {
  const sched = await loadSchedule(c.env, c.get('orgId'));
  const org = await c.env.DB.prepare('SELECT industry_pack FROM orgs WHERE id = ?')
    .bind(c.get('orgId')).first<{ industry_pack: string | null }>();
  const done = await commandTaskByPhrase(
    c.env, { userId: c.get('userId'), orgId: c.get('orgId') }, question,
    sched.timezone, org?.industry_pack, dayEnd(sched), weekEndDay(sched),
  );
  if (!done) return null;
  await drainOutbox(c.env);
  return done.text;
}

apiRoutes.post('/ask/dictate', async (c) => {
  const form = await c.req.parseBody();
  const audio = form.audio;
  if (!(audio instanceof File)) return c.json({ error: 'audio required' }, 400);
  if (audio.size > MAX_ATTACHMENT_BYTES) return c.json({ error: 'Запись слишком длинная' }, 413);
  const question = (await transcribe(c.env, audio, audio.name || 'voice.webm'))?.trim();
  if (!question) return c.json({ error: 'Не удалось разобрать запись. Напишите текстом.' }, 422);
  const command = await taskCommand(c, question);
  if (command) return c.json({ question, answer: command });
  const me = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(c.get('userId')).first<{ name: string }>();
  const answer = await askAssistant(c.env, { userId: c.get('userId'), orgId: c.get('orgId'), role: c.get('role'), name: me?.name ?? '' }, question, []);
  // Вопрос возвращается тоже: человек должен видеть, что именно услышано.
  return c.json({ question, answer });
});

apiRoutes.post('/ask', async (c) => {
  const b = await c.req.json<{ question?: string; history?: AskTurn[] }>().catch(() => ({}) as Record<string, undefined>);
  const question = (b.question ?? '').trim().slice(0, 2000);
  if (!question) return c.json({ error: 'question required' }, 400);
  const history = Array.isArray(b.history)
    ? b.history.filter((h) => (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string').slice(-6)
        .map((h) => ({ role: h.role, text: h.text.slice(0, 2000) }))
    : [];
  const command = await taskCommand(c, question);
  if (command) return c.json({ answer: command });
  const me = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(c.get('userId')).first<{ name: string }>();
  const answer = await askAssistant(c.env, { userId: c.get('userId'), orgId: c.get('orgId'), role: c.get('role'), name: me?.name ?? '' }, question, history);
  return c.json({ answer });
});

apiRoutes.patch('/me', async (c) => {
  const b = await c.req.json<{ name?: string; notify_mode?: string; remind_before_min?: number }>().catch(() => ({}) as Record<string, undefined>);
  if (b.name !== undefined) {
    if (!b.name.trim()) return c.json({ error: 'name required' }, 400);
    if (!(await setDisplayName(c.env, c.get('userId'), b.name.trim()))) return c.json({ error: 'name too short' }, 400);
  }
  // Настройки уведомлений -- те же, что в боте под «Организации → Настройки».
  if (b.notify_mode !== undefined && b.notify_mode !== 'all' && b.notify_mode !== 'schedule') return c.json({ error: 'bad notify_mode' }, 400);
  if (b.remind_before_min !== undefined && (!Number.isInteger(b.remind_before_min) || b.remind_before_min < 0 || b.remind_before_min > 1440)) {
    return c.json({ error: 'bad remind_before_min' }, 400);
  }
  await setNotifyPrefs(c.env, c.get('userId'), {
    notify_mode: b.notify_mode as 'all' | 'schedule' | undefined,
    remind_before_min: b.remind_before_min,
  });
  if (b.name === undefined && b.notify_mode === undefined && b.remind_before_min === undefined) return c.json({ error: 'nothing to update' }, 400);
  return c.json({ ok: true, name: b.name?.trim() });
});

// ОДИН снимок всей организации вместо «список досок плюс запрос на каждую».
//
// Раньше каждый сквозной экран (Мои задачи, Поручения, Календарь, Люди) держал
// свою копию данных и грузил её с нуля при появлении: переключение вкладки
// означало N+1 запросов и надпись «Загрузка…» на уже виденных данных. Здесь
// приложение берёт всё разом и дальше просит только ИЗМЕНЕНИЯ.
//
// `since` -- метка времени прошлого ответа. Сравнение обязано идти через
// datetime(), а не строками: updated_at лежит в базе в ДВУХ форматах --
// «2026-09-07 08:22:06» от DEFAULT datetime('now') и «2026-09-07T08:22:06.000Z»
// от nowIso(). Строкой пробел (0x20) меньше «T», и все строки первого формата
// всегда оказывались бы «старее» любого курсора. datetime() приводит оба к
// одному виду. Запас в две секунды -- на потерю долей секунды при этом
// приведении и на строки, записанные в ту же секунду, что и прошлый ответ:
// лишняя строка безобидна, клиент кладёт её поверх своей по id.
apiRoutes.get('/org/snapshot', async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const role = c.get('role');
  const since = c.req.query('since');
  const at = nowIso();

  // Те же правила видимости досок, что в GET /projects.
  const { results: projects } = role === 'creator'
    ? await c.env.DB.prepare('SELECT * FROM projects WHERE org_id = ? AND archived_at IS NULL ORDER BY created_at DESC')
        .bind(orgId).all()
    : await c.env.DB.prepare(
        `SELECT DISTINCT p.* FROM projects p
         LEFT JOIN project_memberships m ON m.project_id = p.id AND m.user_id = ?
         WHERE p.org_id = ? AND p.archived_at IS NULL AND (m.user_id IS NOT NULL OR p.created_by = ?)
         ORDER BY p.created_at DESC`,
      ).bind(userId, orgId, userId).all();

  // Задачи -- по ОБЩЕМУ правилу видимости (hierarchy.visibleTasks), тому же,
  // что у «Всех заданий». Списки досок и задач считаются отдельно намеренно:
  // доска, на которой человек не состоит, не должна попадать в «Организацию»
  // как его отдел, а задача с неё -- обязана быть видна, если она его.
  const tasks = await visibleTasks(c.env, orgId, userId, role, since);

  // Справочник людей едет только с ПОЛНЫМ снимком: он меняется на порядки реже
  // задач, а опрос идёт каждые несколько секунд. Видимость -- по дереву
  // (раздел 19), поэтому список есть у всех ролей, но у каждой свой.
  const users = since ? null
    : (await visibleMembers(c.env, orgId, userId, role, role === 'creator' || role === 'super_admin'))
        .map(({ aliases: _a, ...u }) => { void _a; return u; });

  return c.json({
    at,
    projects,
    tasks: await attachAssignees(c.env, orgId, tasks as Record<string, unknown>[]),
    users,
    can_see_users: true,
  });
});

/** Адресаты -- одним запросом на весь список, а не по запросу на карточку. */
async function attachAssignees(env: Env, orgId: string, tasks: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const taskIds = (tasks as { id: string }[]).map((t) => t.id);
  if (taskIds.length === 0) return [];
  const rows: { task_id: string; user_id: string; state: string; started_at: string | null; due_at: string | null; user_name: string }[] = [];
  // Кусками: предел D1 -- 100 параметров на запрос.
  for (const part of chunks(taskIds)) {
    const { results } = await env.DB.prepare(
      `SELECT a.task_id, a.user_id, a.state, a.started_at, a.due_at, u.name AS user_name
       FROM task_assignees a JOIN users u ON u.id = a.user_id
       WHERE a.org_id = ? AND a.task_id IN (${part.map(() => '?').join(',')}) ORDER BY a.created_at`,
    ).bind(orgId, ...part).all<{ task_id: string; user_id: string; state: string; started_at: string | null; due_at: string | null; user_name: string }>();
    rows.push(...results);
  }
  const byTask = new Map<string, unknown[]>();
  for (const r of rows) {
    const list = byTask.get(r.task_id);
    const one = { user_id: r.user_id, user_name: r.user_name, state: r.state, due_at: r.due_at };
    if (list) list.push(one);
    else byTask.set(r.task_id, [one]);
  }
  return tasks.map((t) => ({ ...t, assignees: byTask.get(t.id as string) ?? [] }));
}

apiRoutes.get('/projects', async (c) => {
  const role = c.get('role');
  const orgId = c.get('orgId');
  if (role === 'creator') {
    const { results } = await c.env.DB.prepare('SELECT * FROM projects WHERE org_id = ? AND archived_at IS NULL ORDER BY created_at DESC').bind(orgId).all();
    return c.json(results);
  }
  const userId = c.get('userId');
  const { results } = await c.env.DB.prepare(
    `SELECT DISTINCT p.* FROM projects p
     LEFT JOIN project_memberships m ON m.project_id = p.id AND m.user_id = ?
     WHERE p.org_id = ? AND p.archived_at IS NULL AND (m.user_id IS NOT NULL OR p.created_by = ?)
     ORDER BY p.created_at DESC`,
  )
    .bind(userId, orgId, userId)
    .all();
  return c.json(results);
});

// Registered before POST/DELETE below so the literal "archived" path can't be
// swallowed by a later :projectId route (none currently overlaps, but keep it first).
// Список ограничен ТЕМ ЖЕ предикатом членства, что и GET /projects выше -- иначе
// super_admin видел бы в списке чужую доску, а на «Восстановить» получал 403 от
// :projectId/restore. Показывать кнопку, которая заведомо не сработает, хуже, чем
// не показывать строку. Ограничение по организации приезжает сюда на шаге 2a.
apiRoutes.get('/projects/archived', requireRole('super_admin', 'creator'), async (c) => {
  const orgId = c.get('orgId');
  if (c.get('role') === 'creator') {
    const { results } = await c.env.DB.prepare('SELECT * FROM projects WHERE org_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC').bind(orgId).all();
    return c.json(results);
  }
  const userId = c.get('userId');
  const { results } = await c.env.DB.prepare(
    `SELECT DISTINCT p.* FROM projects p
     LEFT JOIN project_memberships m ON m.project_id = p.id AND m.user_id = ?
     WHERE p.org_id = ? AND p.archived_at IS NOT NULL AND (m.user_id IS NOT NULL OR p.created_by = ?)
     ORDER BY p.archived_at DESC`,
  )
    .bind(userId, orgId, userId)
    .all();
  return c.json(results);
});

// telegram_group_id is the raw group id (digits only, as copied from an id bot) --
// different projects post to different Telegram groups, so this is required per project.
// Доска = отдел. Заводит владелец и руководитель отдела (раздел 19); создатель
// сразу на ней -- иначе руководитель завёл бы доску, которой сам не видит.
// Группа Telegram не обязательна: уведомления идут людям лично (ADR-4).
apiRoutes.post('/projects', requireRole('admin', 'super_admin', 'creator'), async (c) => {
  const { name, telegram_group_id } = await c.req.json<{ name?: string; telegram_group_id?: string }>().catch(() => ({}) as Record<string, undefined>);
  if (!name?.trim()) return c.json({ error: 'name required' }, 400);
  let chatId: string | null = null;
  if (telegram_group_id && telegram_group_id.replace(/\D/g, '')) {
    // Validated against Telegram itself (tries both the supergroup -100 and plain
    // group - prefix) so a wrong/not-yet-added-bot group fails loudly here, not
    // silently on every notification afterward.
    chatId = await resolveChatId(c.env, telegram_group_id);
    if (!chatId) return c.json({ error: 'Telegram group not found — make sure the bot has been added to it' }, 400);
  }
  const id = uuid();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO projects (id, org_id, name, created_by, telegram_chat_id) VALUES (?, ?, ?, ?, ?)')
      .bind(id, c.get('orgId'), name.trim().slice(0, 60), c.get('userId'), chatId),
    c.env.DB.prepare('INSERT OR IGNORE INTO project_memberships (id, project_id, user_id, org_id) VALUES (?, ?, ?, ?)')
      .bind(uuid(), id, c.get('userId'), c.get('orgId')),
  ]);
  await logEvent(c.env.DB, { actorId: c.get('userId'), orgId: c.get('orgId'), targetType: 'project', targetId: id, action: 'created' });
  return c.json({ id, name: name.trim().slice(0, 60), telegram_chat_id: chatId }, 201);
});

// Soft-delete: sets archived_at. Tasks stay visible via the Archive tab; the
// escalation sweep already excludes tasks whose project is archived.
apiRoutes.delete('/projects/:projectId', requireProjectAccess('project'), requireRole('super_admin', 'creator'), async (c) => {
  const id = c.req.param('projectId');
  const res = await c.env.DB.prepare('UPDATE projects SET archived_at = ? WHERE id = ? AND org_id = ? AND archived_at IS NULL').bind(nowIso(), id, c.get('orgId')).run();
  if (!res.meta.changes) return c.json({ error: 'not found' }, 404);
  await logEvent(c.env.DB, { actorId: c.get('userId'), orgId: c.get('orgId'), targetType: 'project', targetId: id, action: 'deleted' });
  return c.json({ success: true });
});

apiRoutes.post('/projects/:projectId/restore', requireProjectAccess('project'), requireRole('super_admin', 'creator'), async (c) => {
  const id = c.req.param('projectId');
  const res = await c.env.DB.prepare('UPDATE projects SET archived_at = NULL WHERE id = ? AND org_id = ? AND archived_at IS NOT NULL').bind(id, c.get('orgId')).run();
  if (!res.meta.changes) return c.json({ error: 'not found' }, 404);
  await logEvent(c.env.DB, { actorId: c.get('userId'), orgId: c.get('orgId'), targetType: 'project', targetId: id, action: 'restored' });
  return c.json({ success: true });
});

// Per-project Archive tab: archived tasks in this project, each with its full
// attributable event trail (who created/edited/deleted/restored/confirmed it),
// PLUS the project-level audit trail (project created/deleted, members added/
// removed) -- these are logged (see /projects and /projects/:id/members above)
// but otherwise have no UI, which is a real gap against "all destructive/admin
// actions ... visible to creator". Scoped to status='archived' for tasks since
// the UI offers a Restore action per entry, and only archived tasks are restorable.
apiRoutes.get('/projects/:projectId/archive', requireProjectAccess('project'), requireRole('super_admin', 'creator'), async (c) => {
  const projectId = c.req.param('projectId');
  const { results: tasks } = await c.env.DB.prepare(
    "SELECT * FROM tasks WHERE project_id = ? AND org_id = ? AND status = 'archived' ORDER BY updated_at DESC",
  )
    .bind(projectId, c.get('orgId'))
    .all();
  const { results: projectEvents } = await c.env.DB.prepare(
    `SELECT e.*, u.name AS actor_name FROM events e
     LEFT JOIN users u ON u.id = e.actor_id
     WHERE (e.target_type = 'project' OR e.target_type = 'membership') AND e.target_id = ? AND e.org_id = ?
     ORDER BY e.created_at DESC`,
  )
    .bind(projectId, c.get('orgId'))
    .all();
  return c.json({ archivedTasks: await withEventTrail(c.env.DB, c.get('orgId'), tasks), projectEvents });
});

// Personal archive: read-only accountability view for the signed-in user --
// tasks they were responsible for that are done or archived. No restore here
// (restoring is a project-archive action gated to super_admin/creator).
apiRoutes.get('/archive/mine', async (c) => {
  const { results: tasks } = await c.env.DB.prepare(
    // «Мои» -- через строку адресата: колонки ответственного больше нет.
    // org_id обязателен: человек глобальный (R1-2), и без организации личный
    // архив смешал бы задачи школы и кафе в одном списке.
    `SELECT t.* FROM tasks t
     JOIN task_assignees a ON a.task_id = t.id AND a.user_id = ?
     WHERE t.org_id = ? AND t.status IN ('done', 'archived') ORDER BY t.updated_at DESC`,
  )
    .bind(c.get('userId'), c.get('orgId'))
    .all();
  return c.json(await withEventTrail(c.env.DB, c.get('orgId'), tasks));
});

// List members: powers the responsible-person picker (any project-scoped role)
// and the membership-management screen. Each board has its own people --
// only the global creator and this project's own creator show up without an
// explicit project_memberships row (is_member: false, so the UI knows not to
// offer a Remove button for them); everyone else must be an actual member.
apiRoutes.get('/projects/:projectId/members', requireProjectAccess('project'), async (c) => {
  const projectId = c.req.param('projectId');
  // Same phone/telegram_username privacy gate as GET /users -- this list also
  // feeds the plain responsible-person picker, which any project member can hit.
  const role = c.get('role');
  const extra = role === 'super_admin' || role === 'creator' ? ', u.telegram_username, u.phone' : '';
  const orgId = c.get('orgId');
  // Роль -- из членства в организации, не из мёртвой users.role; и сам список
  // людей теперь выводится из org_memberships, а не из глобальной users.
  // `WHERE role='creator'` тоже стало org-условием: creator чужой организации в
  // этот список попадать не должен.
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name, m.role AS role${extra},
       CASE WHEN u.id IN (SELECT user_id FROM project_memberships WHERE project_id = ? AND org_id = ?) THEN 1 ELSE 0 END AS is_member
     FROM users u
     JOIN org_memberships m ON m.user_id = u.id AND m.org_id = ? AND m.left_at IS NULL
     WHERE m.role = 'creator'
        OR u.id = (SELECT created_by FROM projects WHERE id = ? AND org_id = ?)
        OR u.id IN (SELECT user_id FROM project_memberships WHERE project_id = ? AND org_id = ?)
     ORDER BY u.name`,
  )
    .bind(projectId, orgId, orgId, projectId, orgId, projectId, orgId)
    .all();
  return c.json(results);
});

apiRoutes.post('/projects/:projectId/members', requireProjectAccess('project'), requireRole('super_admin', 'creator'), async (c) => {
  const projectId = c.req.param('projectId');
  const { user_id } = await c.req.json<{ user_id?: string }>().catch(() => ({ user_id: undefined }));
  if (!user_id) return c.json({ error: 'user_id required' }, 400);
  // Тело приходит от клиента, поэтому id проверяется до вставки. Раньше
  // несуществующий id падал в общий catch ниже и отдавал 409 «already a member
  // or invalid»: ошибка была, но неотличима от повторного добавления, и опечатка
  // в id выглядела как «он уже в проекте». Ограничение «тот же арендатор» --
  // шаг 2a через org_memberships, здесь его предмета ещё нет.
  // С шага 2a предикат ужесточён: не «существует в users», а «состоит в МОЕЙ
  // организации». users глобальны (R1-2), поэтому одного существования мало --
  // иначе в доску школы добавляется человек из чужого кафе.
  const orgId = c.get('orgId');
  if (!(await membershipRole(c.env.DB, orgId, user_id))) return c.json({ error: 'user_id not found' }, 400);
  const id = uuid();
  try {
    await c.env.DB.prepare('INSERT INTO project_memberships (id, project_id, user_id, org_id) VALUES (?, ?, ?, ?)').bind(id, projectId, user_id, orgId).run();
  } catch {
    return c.json({ error: 'already a member or invalid' }, 409);
  }
  // target_id is the project (not the membership row) so both membership events
  // are queryable by project id alongside 'project' events for the audit view.
  await logEvent(c.env.DB, { actorId: c.get('userId'), orgId: c.get('orgId'), targetType: 'membership', targetId: projectId, action: 'membership_added', comment: user_id });
  return c.json({ id }, 201);
});

apiRoutes.delete('/projects/:projectId/members/:userId', requireProjectAccess('project'), requireRole('super_admin', 'creator'), async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.req.param('userId');
  const res = await c.env.DB.prepare('DELETE FROM project_memberships WHERE project_id = ? AND user_id = ? AND org_id = ?').bind(projectId, userId, c.get('orgId')).run();
  if (!res.meta.changes) return c.json({ error: 'not found' }, 404);
  await logEvent(c.env.DB, { actorId: c.get('userId'), orgId: c.get('orgId'), targetType: 'membership', targetId: projectId, action: 'membership_removed', comment: userId });
  return c.json({ success: true });
});

// Мягкий отзыв членства в организации. Мягкий, а не DELETE: жёсткое удаление
// оставило бы задачи и события со ссылкой на человека, которого «никогда не
// было», и инвариант «у каждой строки есть автор» покраснел бы навсегда после
// первого увольнения.
apiRoutes.delete('/orgs/:orgId/members/:userId', requireRole('admin', 'super_admin', 'creator'), async (c) => {
  const orgId = c.get('orgId');
  // :orgId в пути обязан совпадать с организацией сессии. Иначе роут стал бы
  // единственным местом, где арендатор задаётся клиентом, а не токеном.
  if (c.req.param('orgId') !== orgId) return c.json({ error: 'forbidden' }, 403);
  const userId = c.req.param('userId');
  if (userId === c.get('userId')) return c.json({ error: 'cannot revoke your own membership' }, 403);

  const gate = await manageTarget(c, userId);
  if (gate instanceof Response) return gate;

  // История остаётся (иначе рассыпается аналитика); открытые поручения --
  // авторам с кнопками переназначения, ДО отзыва: очередь проверяет членство.
  await returnOpenTasks(c.env, orgId, userId, c.get('userId'), 'Удалён из организации');
  // Человеку сообщаем САМИ, а не через очередь: очередь проверяет членство при
  // отправке, а его больше нет -- письмо никогда бы не ушло. Молчание тут
  // хуже всего: задачи просто исчезают, и человек думает, что сломалось.
  const gone = await c.env.DB.prepare('SELECT telegram_user_id FROM users WHERE id = ?').bind(userId).first<{ telegram_user_id: string | null }>();
  const org = await c.env.DB.prepare('SELECT name FROM orgs WHERE id = ?').bind(orgId).first<{ name: string }>();
  if (gone?.telegram_user_id) {
    await sendMessage(c.env, gone.telegram_user_id,
      `Вас исключили из «${org?.name ?? 'организации'}». Её задачи больше не видны, история сохранена. Если это ошибка -- напишите тому, кто вас приглашал.`);
  }
  await drainOutbox(c.env);
  await c.env.DB.prepare('UPDATE org_memberships SET left_at = ? WHERE org_id = ? AND user_id = ? AND left_at IS NULL')
    .bind(nowIso(), orgId, userId)
    .run();

  // Ревалидация липкого контекста: если отозвали ТЕКУЩУЮ организацию человека,
  // current переставляется на любую оставшуюся либо обнуляется. Без этого его
  // следующий запрос резолвился бы в организацию, из которой его уволили.
  const rest = await c.env.DB
    .prepare('SELECT org_id FROM org_memberships WHERE user_id = ? AND left_at IS NULL LIMIT 1')
    .bind(userId)
    .first<{ org_id: string }>();
  await c.env.DB.prepare('UPDATE users SET current_org_id = ? WHERE id = ? AND current_org_id = ?')
    .bind(rest?.org_id ?? null, userId, orgId)
    .run();

  await logEvent(c.env.DB, { actorId: c.get('userId'), orgId, targetType: 'membership', targetId: orgId, action: 'membership_revoked', comment: userId });
  return c.json({ success: true });
});

// Board data (polled ~5s by the frontend).
apiRoutes.get('/projects/:projectId/tasks', requireProjectAccess('project'), async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM tasks WHERE project_id = ? AND org_id = ? AND status IN ('todo','in_progress','done') ORDER BY created_at",
  )
    .bind(c.req.param('projectId'), c.get('orgId'))
    .all<Record<string, unknown>>();

  // Адресаты приезжают ВМЕСТЕ с задачами, одним запросом на доску.
  //
  // До contract-релиза шага 3 исполнитель был колонкой tasks.responsible_user_id,
  // и фронту хватало её. Колонки больше нет -- «кто делает» живёт строками
  // task_assignees, потому что адресатов бывает много. Отдавать их отдельным
  // запросом на каждую карточку значило бы N+1 на доске, которую опрашивают
  // каждые 5 секунд.
  const { results: rows } = await c.env.DB.prepare(
    `SELECT a.task_id, a.user_id, a.state, a.due_at, u.name AS user_name
     FROM task_assignees a
     JOIN tasks t ON t.id = a.task_id
     JOIN users u ON u.id = a.user_id
     WHERE t.project_id = ? AND a.org_id = ?
     ORDER BY a.created_at`,
  )
    .bind(c.req.param('projectId'), c.get('orgId'))
    .all<{ task_id: string; user_id: string; state: string; due_at: string | null; user_name: string }>();

  const byTask = new Map<string, unknown[]>();
  for (const r of rows) {
    const list = byTask.get(r.task_id) ?? [];
    list.push({ user_id: r.user_id, user_name: r.user_name, state: r.state, due_at: r.due_at });
    byTask.set(r.task_id, list);
  }
  return c.json(results.map((t) => ({ ...t, assignees: byTask.get(t.id as string) ?? [] })));
});

// ------------------------------------------------------------------------- tasks

const PRIORITIES = ['urgent', 'medium', 'low'];

// depends_on_task_id must name a task in the SAME project and not itself --
// the single-level "B can't start until A is done" chain from POST /tasks/:id/move.
async function resolveDependency(
  db: D1Database,
  orgId: string,
  projectId: string,
  selfId: string | null,
  dependsOnTaskId: string | null | undefined,
): Promise<{ ok: true; value: string | null } | { ok: false }> {
  if (dependsOnTaskId === undefined) return { ok: true, value: null };
  if (dependsOnTaskId === null) return { ok: true, value: null };
  if (dependsOnTaskId === selfId) return { ok: false };
  // org_id избыточен рядом с проверкой project_id -- но только пока проект
  // гарантированно свой. Держим его явно: тело запроса приходит от клиента, и
  // предикат «та же доска» не должен зависеть от чужого предиката.
  const dep = await db.prepare('SELECT project_id FROM tasks WHERE id = ? AND org_id = ?').bind(dependsOnTaskId, orgId).first<{ project_id: string }>();
  if (!dep || dep.project_id !== projectId) return { ok: false };
  return { ok: true, value: dependsOnTaskId };
}

apiRoutes.post('/projects/:projectId/tasks', requireProjectAccess('project'), async (c) => {
  const projectId = c.req.param('projectId');
  const b = await c.req
    .json<{
      title?: string;
      description?: string;
      responsible_user_id?: string;
      assignee_ids?: string[];
      kind?: string;
      deadline?: string;
      content_blocks?: string;
      priority?: string;
      depends_on_task_id?: string | null;
    }>()
    .catch(() => ({}) as Record<string, undefined>);
  const orgId = c.get('orgId');

  // Адресатов может быть много (R1-1: поручать можно в любую сторону и кому
  // угодно). Старое тело с одним responsible_user_id продолжает работать -- фронт
  // до шага 5 шлёт именно его.
  const assignees = b.assignee_ids?.length ? b.assignee_ids : b.responsible_user_id ? [b.responsible_user_id] : [];
  if (!b.title || assignees.length === 0) return c.json({ error: 'title and at least one assignee required' }, 400);
  const kind = b.kind && ['single', 'each', 'any', 'ack'].includes(b.kind) ? (b.kind as TaskKind) : assignees.length > 1 ? 'each' : 'single';
  if (kind === 'single' && assignees.length > 1) return c.json({ error: 'kind=single takes exactly one assignee' }, 400);
  // Границу «поручает только директор» держала социальная норма; R1-1 её снял
  // (поручать может кто угодно кому угодно), а R1-2 сделал users глобальными.
  // Значит произвольный id из тела мог бы стать адресатом -- и уведомление с
  // заголовком задачи ушло бы человеку чужой организации. Проверяется КАЖДЫЙ.
  // Плюс дерево (раздел 19): владелец -- кому угодно, руководитель отдела --
  // поддереву и людям своих досок, участник -- людям своих досок. Замороженным -- никому.
  if (!(await canAssign(c.env, orgId, c.get('userId'), c.get('role'), assignees))) {
    return c.json({ error: 'assignee is not a member of this organisation' }, 400);
  }
  const priority = b.priority && PRIORITIES.includes(b.priority) ? b.priority : 'medium';
  const dependency = await resolveDependency(c.env.DB, c.get('orgId'), projectId, null, b.depends_on_task_id);
  if (!dependency.ok) return c.json({ error: 'depends_on_task_id must be another task in the same project' }, 400);
  const id = uuid();
  const created = {
    id, org_id: orgId, project_id: projectId, title: b.title,
    kind, author_id: c.get('userId'),
    deadline: b.deadline ?? null, telegram_message_id: null,
  } as Task;
  const now = nowIso();
  // Задача, событие и уведомление -- одним batch. Создание не переход, но болезнь
  // та же: до шага 1 три записи шли порознь, и падение между второй и третьей
  // оставляло задачу, о которой исполнителю никто не сказал.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO tasks (id, org_id, project_id, title, description, kind, author_id, source, status, deadline, content_blocks, priority, depends_on_task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?)`,
    ).bind(id, orgId, projectId, b.title, b.description ?? '', kind, c.get('userId'), 'ui', b.deadline ?? null, b.content_blocks ?? null, priority, dependency.value),
    ...buildAssignees(c.env, created, assignees, b.deadline ?? null),
    // Форма и порядок бинда совпадают с logEvent (db.ts) намеренно: INSERT в
    // events существует в трёх местах, и расхождение здесь читалось бы как
    // «в этой таблице колонки означают разное в зависимости от вызывающего».
    c.env.DB.prepare(
      `INSERT INTO events (id, actor_id, org_id, target_type, target_id, action, comment, overdue_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(uuid(), c.get('userId'), orgId, 'task', id, 'created', null, null, now),
    // Каждому адресату -- своё письмо со своей кнопкой: у рассылки на 14 человек
    // одного получателя нет.
    ...(await Promise.all(assignees.map((uid) =>
      // Та же карточка, что у задач из бота: субъект -- автор, иначе «От кого»
      // печатало бы имя самого получателя.
      buildNotification(c.env, created, 'created', { emoji: '📌', label: 'Вам поручено', buttons: assigneeButtons(created, uid) },
        b.deadline ?? null, uid, c.get('userId')),
    ))),
  ]);
  await drainOutbox(c.env);
  return c.json({ id }, 201);
});

// Single task -- used by the Telegram deep link (?task=<id>) to resolve which
// project to open before the frontend can show it.
apiRoutes.get('/tasks/:id', requireProjectAccess('task'), async (c) => {
  return c.json(c.get('task')!);
});

// Edit-lock: a card is editable only while in Todo.
apiRoutes.patch('/tasks/:id', requireProjectAccess('task'), async (c) => {
  const task = c.get('task')!;
  const role = c.get('role');
  // super_admin/creator may also reach in and fix an in-progress task -- doing so
  // reopens it to todo (whoever "took" it must pick it back up deliberately).
  const reopening = task.status === 'in_progress';
  if (reopening && role !== 'super_admin' && role !== 'creator') {
    return c.json({ error: 'only super_admin/creator can edit a task that is in progress' }, 403);
  }
  if (task.status !== 'todo' && !reopening) return c.json({ error: 'task is locked (editable only in todo)' }, 409);
  const b = await c.req
    .json<{
      title?: string;
      description?: string;
      responsible_user_id?: string;
      deadline?: string | null;
      content_blocks?: string;
      repeat_days?: number | null;
      priority?: string;
      depends_on_task_id?: string | null;
    }>()
    .catch(() => ({}) as Record<string, undefined>);
  const dependency = await resolveDependency(c.env.DB, c.get('orgId'), task.project_id, task.id, b.depends_on_task_id);
  if (!dependency.ok) return c.json({ error: 'depends_on_task_id must be another task in the same project' }, 400);
  // Тот же предикат, что и при создании: сменить адресата на человека чужой
  // организации нельзя.
  if (b.responsible_user_id !== undefined && !(await canAssign(c.env, c.get('orgId'), c.get('userId'), c.get('role'), [b.responsible_user_id]))) {
    return c.json({ error: 'responsible_user_id is not a member of this organisation' }, 400);
  }
  // Смена адресата у задачи с ОДНИМ адресатом. У рассылки «сменить
  // ответственного» смысла не имеет -- там адресатов много, и правка списка
  // это отдельная операция, а не поле формы.
  if (b.responsible_user_id !== undefined && task.kind !== 'single') {
    return c.json({ error: 'multi-assignee task: edit assignees, not responsible_user_id' }, 409);
  }
  // Сама смена -- ПОСЛЕ правки содержимого и ниже по коду: новый человек
  // обязан увидеть новый заголовок и новый срок, а не прежние.
  const reassignTo = b.responsible_user_id;
  const priority = b.priority && PRIORITIES.includes(b.priority) ? b.priority : null;
  // Правка содержимого status НЕ трогает: иначе «единственный писатель» стал бы
  // «единственный писатель, кроме PATCH». Возврат в todo -- это переход, и он
  // уходит в applyTransition отдельным шагом ниже.
  await c.env.DB.prepare(
    `UPDATE tasks SET title = COALESCE(?, title), description = COALESCE(?, description),
       deadline = ?, repeat_days = ?,
       content_blocks = COALESCE(?, content_blocks), priority = COALESCE(?, priority),
       depends_on_task_id = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(
      b.title ?? null,
      b.description ?? null,
      b.deadline === undefined ? task.deadline : b.deadline,
      // Повтор снимается передачей null -- COALESCE такого не умеет.
      b.repeat_days === undefined ? task.repeat_days : (b.repeat_days || null),
      b.content_blocks ?? null,
      priority,
      b.depends_on_task_id === undefined ? task.depends_on_task_id : dependency.value,
      nowIso(),
      task.id,
    )
    .run();

  if (!reopening) {
    await logEvent(c.env.DB, { actorId: c.get('userId'), orgId: c.get('orgId'), targetType: 'task', targetId: task.id, action: 'edited' });
    await handoff(c, task, reassignTo);
    return c.json({ success: true });
  }

  // ПРАВКА = НОВАЯ ЗАДАЧА. Все исполнители сбрасываются в «не принял»: Азиз
  // принимал ТУ задачу, не эту. Без сброса строка Азиза оставалась «принял»,
  // задача падала в Todo -- и он не мог взять её снова, получая «вы уже
  // принимали». Карточка застревала навсегда.
  const updated = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').bind(task.id, c.get('orgId')).first<Task>();
  await c.env.DB.batch(resetAssignees(c.env, task.id, (updated ?? task).deadline ?? null));

  // Переход делается ПОСЛЕ правки содержимого и сброса строк, чтобы уведомление
  // ушло с новым заголовком и сроком, а статус сошёлся со строками.
  await applyTransition(c.env, {
    task: updated ?? task,
    to: 'todo',
    actorId: c.get('userId'),
    action: 'edited_reopened',
    set: { telegram_message_id: null },
    notify: { emoji: '↩️', label: 'Возвращено в TODO (отредактировано)', deletePrevious: true },
  });
  await handoff(c, task, reassignTo);
  await drainOutbox(c.env);
  return c.json({ success: true });
});

/**
 * Смена адресата у задачи с одним исполнителем -- ТОТ ЖЕ путь, что кнопка
 * «Переназначить» в боте: прежняя строка отказывается, новая заводится
 * заново, журнал напоминаний чистится, а новый человек получает «Вам
 * поручено» с кнопками. Прямая подмена user_id всего этого не делала:
 * задача молча меняла хозяина, и ни один из двоих об этом не узнавал.
 */
async function handoff(c: Context<AppEnv>, task: Task, toUserId: string | undefined): Promise<void> {
  if (!toUserId) return;
  const fresh = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?')
    .bind(task.id, task.org_id).first<Task>();
  await reassignTask(c.env, fresh ?? task, toUserId, c.get('userId'));
  await drainOutbox(c.env);
}

// Кто принимает работу: автор задачи, а после R1-1 это может быть кто угодно --
// включая рядового сотрудника, поручившего что-то директору. creator/super_admin
// остаются запасным ключом на случай, когда автор уволился: иначе его задачи
// нельзя закрыть никогда.
async function isReviewer(c: Context<AppEnv>, task: Task): Promise<boolean> {
  if (task.author_id && task.author_id === c.get('userId')) return true;
  const role = c.get('role');
  if (role === 'creator' || role === 'super_admin') return true;
  // Руководитель отдела принимает работу в своём поддереве (раздел 19): то, что
  // поручили его люди.
  if (role === 'admin' && task.author_id) return (await subtreeOf(c.env, c.get('orgId'), c.get('userId'))).has(task.author_id);
  return false;
}

// Таблица переходов задачи уехала в assignees.ts: движется теперь строка
// адресата, а статус задачи -- её свёртка.

apiRoutes.post('/tasks/:id/move', requireProjectAccess('task'), async (c) => {
  let task = c.get('task')!;
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const { to } = await c.req.json<{ to?: TaskStatus | 'started' }>().catch(() => ({ to: undefined }));
  if (!to) return c.json({ error: 'to required' }, 400);

  // «Сел за работу» -- не переход состояния, а отметка времени поверх
  // accepted, поэтому ветка своя и короткая. Двигает ТОЛЬКО сам исполнитель:
  // за человека решить, что он начал, нельзя -- это он знает, а не автор.
  if (to === 'started') {
    const mine = await myAssignee(c.env, task.id, userId, orgId);
    if (!mine) return c.json({ error: 'only an assignee can start this task' }, 403);
    if (!(await startWork(c.env, task, mine, userId))) return c.json({ error: 'task is not accepted' }, 409);
    await drainOutbox(c.env);
    return c.json({ success: true });
  }

  // Словарь фронта -- в состояния адресата: доска говорит статусами задачи,
  // а движется теперь строка человека.
  const target = to === 'in_progress' ? 'accepted' : to === 'done' ? 'done' : null;
  if (!target) return c.json({ error: `invalid transition ${task.status} -> ${to}` }, 409);

  // Правило «двигает только ответственный» стало «двигает СВОЮ строку каждый
  // адресат»: у рассылки на 14 человек единственного ответственного нет.
  // Автор (и тот, кто принимает работу) двигает ЗА адресатов: стрелки на
  // карточке поручения -- механизм доски, а исполнитель может и не открывать
  // приложение. Ведёт по цепочке pending -> accepted -> done одним нажатием.
  const mine = await myAssignee(c.env, task.id, userId, orgId);
  const rows = mine ? [mine]
    : (await isReviewer(c, task))
      ? (await loadAssignees(c.env, task.id, orgId)).filter((r) => canTransition(r.state, target) || (target === 'done' && r.state === 'pending'))
      : null;
  if (!rows) return c.json({ error: 'only an assignee can move this task' }, 403);
  if (!rows.length) return c.json({ error: `invalid transition ${task.status} -> ${to}` }, 409);

  // "Draft the contract" must be done before "review the contract" can start --
  // a single predecessor task that has to reach done/archived first.
  if (target === 'accepted' && task.depends_on_task_id) {
    const dep = await c.env.DB.prepare('SELECT title, status FROM tasks WHERE id = ? AND org_id = ?')
      .bind(task.depends_on_task_id, orgId)
      .first<{ title: string; status: TaskStatus }>();
    if (dep && dep.status !== 'done' && dep.status !== 'archived') {
      return c.json({ error: `blocked: "${dep.title}" must be finished first` }, 409);
    }
  }

  // ЗАДАЧА СЕБЕ проверки не требует. Человек поручил её сам себе, сам сделал --
  // и отдельное «примите работу» у него же спрашивать незачем: очередь «сдано,
  // на проверке» копилась бы из собственных дел, которые никто не проверит.
  const live = await loadAssignees(c.env, task.id, orgId);
  const selfTask = task.author_id === userId
    && live.filter((a) => a.state !== 'declined').every((a) => a.user_id === userId);

  const notify = target === 'accepted'
    ? { emoji: '🚀', label: 'Принято', track: true }
    : { emoji: '✅', label: 'Готово', deletePrevious: true };
  for (const row of rows) {
    // Цепочка -- только за исполнителя: сам он идёт по этапам, как и в боте.
    const steps: AssigneeState[] = !mine && target === 'done' && row.state === 'pending' ? ['accepted', 'done'] : [target];
    let assignee = row;
    for (const step of steps) {
      const res = await transitionAssignee(c.env, { task, assignee, to: step, actorId: userId, notify: step === target ? notify : undefined });
      if (!res.ok) return c.json({ error: res.error }, 409);
      assignee = { ...assignee, state: step, accepted_at: assignee.accepted_at ?? nowIso() };
      // Свёртка читает статус из объекта: после перехода он уже другой.
      task = (await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(task.id).first<Task>()) ?? task;
    }
  }
  if (target === 'done' && selfTask) {
    const fresh = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(task.id).first<Task>();
    if (fresh && fresh.status === 'done' && !fresh.confirmed_at) await confirmWork(c.env, fresh, userId, false);
  }
  await drainOutbox(c.env);
  return c.json({ success: true });
});

// Отказ адресата. Без этого маршрута состояние declined недостижимо, а автомат
// ADR-3 существовал бы только на бумаге.
//
// Терминал -- уведомление АВТОРУ: спека требует «отказ возвращается автору», и
// закрытие задачи в архив этому удовлетворяет только при таком уведомлении --
// поднять из архива автор-сотрудник сам не может (роут под requireRole).
apiRoutes.post('/tasks/:id/decline', requireProjectAccess('task'), async (c) => {
  const task = c.get('task')!;
  const mine = await myAssignee(c.env, task.id, c.get('userId'), c.get('orgId'));
  if (!mine) return c.json({ error: 'only an assignee can decline' }, 403);
  const { reason } = await c.req.json<{ reason?: string }>().catch(() => ({ reason: undefined }));
  if (!reason || !reason.trim()) return c.json({ error: 'reason required' }, 400);

  const res = await declineAssignee(c.env, task, mine, c.get('userId'), reason.trim());
  if (!res.ok) return c.json({ error: res.error }, 409);
  await drainOutbox(c.env);
  return c.json({ success: true });
});

// «Не успею» -- тем же путём, что кнопка бота: строка не меняется, автору
// уходит комментарий с кнопками «перенести · оставить · переназначить».
apiRoutes.post('/tasks/:id/late', requireProjectAccess('task'), async (c) => {
  const task = c.get('task')!;
  const mine = await myAssignee(c.env, task.id, c.get('userId'), c.get('orgId'));
  if (!mine) return c.json({ error: 'only an assignee can report' }, 403);
  const { comment } = await c.req.json<{ comment?: string }>().catch(() => ({ comment: undefined }));
  if (!comment || !comment.trim()) return c.json({ error: 'comment required' }, 400);
  if (!(await lateAssignee(c.env, task, mine, c.get('userId'), comment))) return c.json({ error: 'not in progress' }, 409);
  await drainOutbox(c.env);
  return c.json({ success: true });
});

// Список адресатов задачи с их состояниями -- то самое «кто на каком этапе».
apiRoutes.get('/tasks/:id/assignees', requireProjectAccess('task'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT a.*, u.name AS user_name FROM task_assignees a
     JOIN users u ON u.id = a.user_id
     WHERE a.task_id = ? AND a.org_id = ? ORDER BY a.created_at`,
  ).bind(c.get('task')!.id, c.get('orgId')).all();
  return c.json(results);
});

// Delete = archive (never hard delete). super_admin/creator only.
apiRoutes.delete('/tasks/:id', requireProjectAccess('task'), async (c) => {
  const task = c.get('task')!;
  // Удаляет автор или владелец -- те же, кто отменяет кнопкой в боте.
  if (!(await isReviewer(c, task))) return c.json({ error: 'only the author can delete' }, 403);
  await applyTransition(c.env, {
    task, to: 'archived', actorId: c.get('userId'), action: 'deleted',
    set: { telegram_message_id: null },
    notify: { emoji: '🗑', label: 'Архивировано', deletePrevious: true },
  });
  await drainOutbox(c.env);
  return c.json({ success: true });
});

// Restore requires a comment; un-deletes back to editable todo.
apiRoutes.post('/tasks/:id/restore', requireProjectAccess('task'), requireRole('super_admin', 'creator'), async (c) => {
  const task = c.get('task')!;
  const { comment } = await c.req.json<{ comment?: string }>().catch(() => ({ comment: undefined }));
  if (!comment || !comment.trim()) return c.json({ error: 'comment required' }, 400);
  if (task.status !== 'archived') return c.json({ error: 'only archived tasks can be restored' }, 409);
  // Восстановление -- тот же чистый лист, что и правка: задача возвращается к
  // людям заново, а не с чужими отметками полугодовой давности.
  await c.env.DB.batch(resetAssignees(c.env, task.id, task.deadline ?? null));
  await applyTransition(c.env, {
    task, to: 'todo', actorId: c.get('userId'), action: 'restored', comment,
    set: { done_at: null },
    notify: { emoji: '♻️', label: 'Восстановлено', extraLine: `Комментарий: ${comment}` },
  });
  await drainOutbox(c.env);
  return c.json({ success: true });
});

// Confirm completion. Computes overdue_by vs deadline (0 if on time, null if no deadline).
// confirmed_at guards against re-confirming and lets the board hide Confirm/Reject
// once done (a Done card otherwise looks identical whether confirmed or not).
// Пункт списка. Отмечает ЛЮБОЙ, кто задачу видит: покупки отмечает тот, кто в
// магазине, и спрашивать у него роль незачем -- задача всё равно закрывается
// целиком и отдельным действием.
apiRoutes.post('/tasks/:id/checklist', requireProjectAccess('task'), async (c) => {
  const task = c.get('task')!;
  const { index } = await c.req.json<{ index?: number }>().catch(() => ({ index: undefined }));
  if (!Number.isInteger(index)) return c.json({ error: 'index required' }, 400);
  const items = await toggleItem(c.env, task, index as number);
  if (!items) return c.json({ error: 'no such item' }, 409);
  return c.json({ checklist: items });
});

apiRoutes.post('/tasks/:id/confirm', requireProjectAccess('task'), async (c) => {
  const task = c.get('task')!;
  // Гейт -- АВТОРСТВО, а не роль (ADR-3 после R1-1). Поручения идут в любую
  // сторону: сотрудник, попросивший директора, обязан иметь право принять
  // работу, а посторонний super_admin -- нет. Роль остаётся запасным ключом для
  // владельца организации: без неё некому закрыть задачу уволившегося автора.
  if (!(await isReviewer(c, task))) return c.json({ error: 'only the author can confirm' }, 403);
  if (task.status !== 'done') return c.json({ error: 'task is not in done' }, 409);
  if (task.confirmed_at) return c.json({ error: 'task already confirmed' }, 409);
  const overdueBy = await confirmWork(c.env, task, c.get('userId'));
  await drainOutbox(c.env);
  return c.json({ success: true, overdue_by: overdueBy });
});

// Reject: back to in_progress, with a reason and a fresh deadline (now + extra_days).
// Escalation timers reset so the new deadline gets its own overdue/reminder cycle.
apiRoutes.post('/tasks/:id/reject', requireProjectAccess('task'), async (c) => {
  const task = c.get('task')!;
  if (!(await isReviewer(c, task))) return c.json({ error: 'only the author can reject' }, 403);
  if (task.status !== 'done') return c.json({ error: 'task is not in done' }, 409);
  const { comment, extra_days } = await c.req.json<{ comment?: string; extra_days?: number }>().catch(() => ({}) as Record<string, undefined>);
  if (!comment || !comment.trim()) return c.json({ error: 'comment required' }, 400);
  const days = Number(extra_days);
  if (!Number.isInteger(days) || days < 1) return c.json({ error: 'extra_days must be a positive integer' }, 400);
  const newDeadline = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  // Отклоняется работа КАЖДОГО, кто её сдал: у рассылки сдавших может быть
  // несколько, и вернуть в работу надо всех. Таймеры гасятся на СТРОКАХ --
  // в tasks их больше нет, и новый срок обязан получить собственный цикл
  // напоминаний, иначе проживёт без единого предупреждения.
  const { results: done } = await c.env.DB.prepare(
    "SELECT * FROM task_assignees WHERE task_id = ? AND org_id = ? AND state = 'done'",
  ).bind(task.id, c.get('orgId')).all<Assignee>();
  if (done.length === 0) return c.json({ error: 'nobody has submitted this task' }, 409);

  for (const a of done) {
    await transitionAssignee(c.env, {
      task, assignee: a, to: 'rejected', actorId: c.get('userId'), reason: comment, dueAt: newDeadline,
      notify: { emoji: '❌', label: 'Отклонено, возвращено в работу', extraLine: `Причина: ${comment}` },
    });
  }
  // Срок самой задачи тоже сдвигается: доска показывает его, а не персональные.
  await applyTransition(c.env, {
    task, to: 'in_progress', actorId: c.get('userId'), action: 'rejected', comment,
    set: { done_at: null, confirmed_at: null, deadline: newDeadline },
  });
  await drainOutbox(c.env);
  return c.json({ success: true });
});

// ------------------------------------------------------------------- attachments

// Upload: multipart file -> Telegram storage chat -> attachments row. No status
// restriction (supporting reference material, not a scope-changing edit). Size is
// checked BEFORE any Telegram call so an oversize file never leaves our Worker.
apiRoutes.post('/tasks/:id/attachments', requireProjectAccess('task'), async (c) => {
  const task = c.get('task')!;
  // Cheap pre-filter on the client-supplied Content-Length so an obviously oversize
  // upload is rejected before we buffer the multipart body into isolate memory.
  // Client-supplied, so not authoritative -- the file.size check below is the real guard.
  const declaredLen = Number(c.req.header('content-length') ?? 0);
  if (declaredLen > MAX_ATTACHMENT_BYTES + 4096) return c.json({ error: 'file exceeds the 20MB limit' }, 413);
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: 'file required' }, 400);
  if (file.size > MAX_ATTACHMENT_BYTES) return c.json({ error: 'file exceeds the 20MB limit' }, 413);

  const mime = file.type || 'application/octet-stream';
  const stored = await sendDocument(c.env, c.env.TELEGRAM_STORAGE_CHAT_ID, file, file.name).catch(() => null);
  if (!stored) return c.json({ error: 'Файл не сохранился. Попробуйте ещё раз или пришлите его боту в чат.' }, 502);
  const { fileId, messageId } = stored;
  const id = uuid();
  await c.env.DB.prepare(
    `INSERT INTO attachments (id, org_id, task_id, telegram_file_id, telegram_message_id, filename, mime_type, size_bytes, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, c.get('orgId'), task.id, fileId, messageId, file.name, mime, file.size, c.get('userId'))
    .run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), orgId: c.get('orgId'), targetType: 'task', targetId: task.id, action: 'attachment_added', comment: file.name });
  return c.json({ id, filename: file.name, mime_type: mime, size_bytes: file.size }, 201);
});

// List attachments for a task (uploader resolved to a display name).
apiRoutes.get('/tasks/:id/attachments', requireProjectAccess('task'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.filename, a.mime_type, a.size_bytes, a.uploaded_by, u.name AS uploaded_by_name, a.created_at
     FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
     WHERE a.task_id = ? AND a.org_id = ? ORDER BY a.created_at`,
  )
    .bind(c.get('task')!.id, c.get('orgId'))
    .all();
  return c.json(results);
});

// Download: real proxy (never a redirect) so the browser never sees a Telegram
// URL. Fetch the file server-side and stream the bytes back under our own headers.
apiRoutes.get('/attachments/:id/download', requireProjectAccess('attachment'), async (c) => {
  const att = c.get('attachment')!;
  const url = await getFileUrl(c.env, att.telegram_file_id);
  const upstream = await fetch(url);
  if (!upstream.ok || !upstream.body) return c.json({ error: 'file unavailable' }, 502);
  // Strip chars that could break/inject the Content-Disposition header.
  const safeName = att.filename.replace(/[\r\n"\\]/g, '');
  return new Response(upstream.body, {
    headers: {
      'Content-Type': att.mime_type,
      'Content-Disposition': `attachment; filename="${safeName}"`,
      // Belt-and-suspenders: Content-Disposition:attachment already blocks inline
      // rendering of attacker-influenced bytes/mime-type, this just closes the gap fully.
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

// Delete: uploader OR super_admin/creator. Also deletes the underlying Telegram
// message (best-effort, reusing deleteMessage) so the storage chat stays bounded.
apiRoutes.delete('/attachments/:id', requireProjectAccess('attachment'), async (c) => {
  const att = c.get('attachment')!;
  // Fresh DB read for the elevated bypass (not the token's role) -- same
  // de-provisioning/downgrade guard requireRole() applies everywhere else.
  const fresh = await verifySession(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE), { db: c.env.DB, allowed: ['super_admin', 'creator'], orgId: c.get('orgId') });
  if (!fresh && att.uploaded_by !== c.get('userId')) return c.json({ error: 'forbidden' }, 403);

  await deleteMessage(c.env, c.env.TELEGRAM_STORAGE_CHAT_ID, att.telegram_message_id);
  await c.env.DB.prepare('DELETE FROM attachments WHERE id = ? AND org_id = ?').bind(att.id, c.get('orgId')).run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), orgId: c.get('orgId'), targetType: 'task', targetId: att.task_id, action: 'attachment_deleted', comment: att.filename });
  return c.json({ success: true });
});
