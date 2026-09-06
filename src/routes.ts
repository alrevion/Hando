// All /api routes. Access control is delegated to middleware.ts; handlers only
// hold business rules. Every mutating action writes an events row (system of record).
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Role, Task, TaskStatus } from './types';
import { logEvent, nowIso, uuid } from './db';
import { membershipRole, mintSession, precheckPhone, resolveOrgId, sendOtp, SESSION_COOKIE, SESSION_TTL_SECONDS, verifyOtp, verifySession } from './auth';
import { type AppEnv, requireAuth, requireProjectAccess, requireRole } from './middleware';
import { deleteMessage, getFileUrl, resolveChatId, sendDocument } from './telegram';
import { applyTransition, buildNotification } from './transition';
import { buildAssignees, confirmAssignees, myAssignee, resetAssignees, transitionAssignee, type Assignee, type TaskKind } from './assignees';
import { drainOutbox } from './outbox';

// Telegram's Bot API can only download files up to 20MB back out (uploads may be
// larger, but would then be permanently unretrievable). Enforce the download cap
// at upload time so users get a clear error instead of losing an unfetchable file.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;


export const apiRoutes = new Hono<AppEnv>();

// projectChatId и notifyTask удалены на шаге 1: адрес чата и текст сообщения
// теперь собирает transition.ts, а отправляет outbox.ts. Держать здесь второй
// путь рассылки значило бы, что «ровно один раз» доказано только для одного.

function describeOverdue(seconds: number): string {
  if (seconds <= 0) return 'Без просрочки';
  const hours = Math.floor(seconds / 3600);
  if (hours < 1) return 'Просрочка: меньше часа';
  if (hours < 24) return `Просрочка: ${hours}ч`;
  return `Просрочка: ${Math.floor(hours / 24)}д`;
}

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

apiRoutes.post('/auth/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ success: true });
});

// ------------------------------------------------------ everything below: authed

apiRoutes.use('*', requireAuth);

apiRoutes.get('/me', async (c) => {
  // Роль -- из членства в ТЕКУЩЕЙ организации, не из мёртвой users.role. Иначе
  // между 2a и 2b человек видел бы у себя роль, по которой ему уже ничего не
  // разрешено. org отдаётся клиенту: фронту нужно знать, где он находится.
  const u = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.phone, m.role AS role, m.position AS position, o.id AS org_id, o.name AS org_name
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

    await c.env.DB.prepare('UPDATE org_memberships SET left_at = NULL, role = ? WHERE org_id = ? AND user_id = ?').bind(role, orgId, existing.id).run();
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
      c.env.DB.prepare('INSERT INTO org_memberships (id, org_id, user_id, role) VALUES (?, ?, ?, ?)').bind(uuid(), orgId, id, role),
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
apiRoutes.patch('/users/:id', requireRole('super_admin', 'creator'), async (c) => {
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
    if (body.role === 'creator') return c.json({ error: 'cannot reassign creator via API' }, 400);
    if (body.role === 'super_admin' && c.get('role') !== 'creator') return c.json({ error: 'only creator can promote to super_admin' }, 403);
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

// Assignment dropdowns: id/name/role/telegram_username (no phone exposure).
//
// member сюда НЕ допускается -- это и есть смысл четвёртой роли (ADR-5).
// Справочник ВСЕЙ организации рядовому сотруднику не нужен: людей своих досок он
// видит через /projects/:id/members, который и так ограничен доской и не отдаёт
// телефонов никому кроме super_admin/creator. Поручать он по-прежнему может
// (R1-1), просто в пределах досок, где состоит.
apiRoutes.get('/users', requireRole('admin', 'super_admin', 'creator'), async (c) => {
  // phone was deliberately withheld here (any project member can hit this to
  // populate a responsible-person picker) -- but super_admin/creator need it
  // back for the Edit person modal, so send it only to them.
  const role = c.get('role');
  const extra = role === 'super_admin' || role === 'creator' ? ', u.phone' : '';
  // Ограничение идёт JOIN'ом через org_memberships, а не колонкой users.org_id,
  // которой не будет: организация человека живёт в членстве. Роль -- оттуда же,
  // иначе между 2a и 2b справочник показывал бы мёртвую users.role и
  // разжалованный виден как super_admin.
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name, m.role AS role, u.telegram_username${extra}
     FROM users u JOIN org_memberships m ON m.user_id = u.id
     WHERE m.org_id = ? AND m.left_at IS NULL ORDER BY u.name`,
  )
    .bind(c.get('orgId'))
    .all();
  return c.json(results);
});

// ---------------------------------------------------------------------- projects

// creator видит все доски СВОЕЙ организации. super_admin/admin -- только те, куда
// их добавили, или (super_admin) созданные ими самими: у каждой доски свои люди,
// роль не даёт членства автоматически.
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
apiRoutes.post('/projects', requireRole('super_admin', 'creator'), async (c) => {
  const { name, telegram_group_id } = await c.req.json<{ name?: string; telegram_group_id?: string }>().catch(() => ({}) as Record<string, undefined>);
  if (!name) return c.json({ error: 'name required' }, 400);
  if (!telegram_group_id || !telegram_group_id.replace(/\D/g, '')) return c.json({ error: 'telegram_group_id required' }, 400);
  // Validated against Telegram itself (tries both the supergroup -100 and plain
  // group - prefix) so a wrong/not-yet-added-bot group fails loudly here, not
  // silently on every notification afterward.
  const chatId = await resolveChatId(c.env, telegram_group_id);
  if (!chatId) return c.json({ error: 'Telegram group not found -- make sure the bot has been added to it' }, 400);
  const id = uuid();
  await c.env.DB.prepare('INSERT INTO projects (id, org_id, name, created_by, telegram_chat_id) VALUES (?, ?, ?, ?, ?)')
    .bind(id, c.get('orgId'), name, c.get('userId'), chatId)
    .run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), orgId: c.get('orgId'), targetType: 'project', targetId: id, action: 'created' });
  return c.json({ id, name, telegram_chat_id: chatId }, 201);
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
apiRoutes.delete('/orgs/:orgId/members/:userId', requireRole('super_admin', 'creator'), async (c) => {
  const orgId = c.get('orgId');
  // :orgId в пути обязан совпадать с организацией сессии. Иначе роут стал бы
  // единственным местом, где арендатор задаётся клиентом, а не токеном.
  if (c.req.param('orgId') !== orgId) return c.json({ error: 'forbidden' }, 403);
  const userId = c.req.param('userId');
  if (userId === c.get('userId')) return c.json({ error: 'cannot revoke your own membership' }, 403);

  const target = await membershipRole(c.env.DB, orgId, userId);
  if (!target) return c.json({ error: 'not found' }, 404);
  if (target === 'creator') return c.json({ error: 'cannot revoke the creator' }, 403);

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
    .all();
  return c.json(results);
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
  for (const uid of assignees) {
    if (!(await membershipRole(c.env.DB, orgId, uid))) {
      return c.json({ error: 'assignee is not a member of this organisation' }, 400);
    }
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
      buildNotification(c.env, created, 'created', {
        emoji: '📌', label: 'Новая задача',
        // «Принял» -- ключевая кнопка продукта: она превращает уведомление в
        // подтверждаемое поручение вместо объявления в чате.
        buttons: [[{ text: '✅ Принял', callback_data: `accept:${id}` }]],
      }, b.deadline ?? null, uid),
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
      priority?: string;
      depends_on_task_id?: string | null;
    }>()
    .catch(() => ({}) as Record<string, undefined>);
  const dependency = await resolveDependency(c.env.DB, c.get('orgId'), task.project_id, task.id, b.depends_on_task_id);
  if (!dependency.ok) return c.json({ error: 'depends_on_task_id must be another task in the same project' }, 400);
  // Тот же предикат, что и при создании: сменить адресата на человека чужой
  // организации нельзя.
  if (b.responsible_user_id !== undefined && !(await membershipRole(c.env.DB, c.get('orgId'), b.responsible_user_id))) {
    return c.json({ error: 'responsible_user_id is not a member of this organisation' }, 400);
  }
  // Смена адресата у задачи с ОДНИМ адресатом. У рассылки «сменить
  // ответственного» смысла не имеет -- там адресатов много, и правка списка
  // это отдельная операция, а не поле формы.
  if (b.responsible_user_id !== undefined) {
    if (task.kind !== 'single') return c.json({ error: 'multi-assignee task: edit assignees, not responsible_user_id' }, 409);
    await c.env.DB.prepare('UPDATE task_assignees SET user_id = ? WHERE task_id = ? AND org_id = ?')
      .bind(b.responsible_user_id, task.id, c.get('orgId'))
      .run();
  }
  const priority = b.priority && PRIORITIES.includes(b.priority) ? b.priority : null;
  // Правка содержимого status НЕ трогает: иначе «единственный писатель» стал бы
  // «единственный писатель, кроме PATCH». Возврат в todo -- это переход, и он
  // уходит в applyTransition отдельным шагом ниже.
  await c.env.DB.prepare(
    `UPDATE tasks SET title = COALESCE(?, title), description = COALESCE(?, description),
       deadline = ?,
       content_blocks = COALESCE(?, content_blocks), priority = COALESCE(?, priority),
       depends_on_task_id = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(
      b.title ?? null,
      b.description ?? null,
      b.deadline === undefined ? task.deadline : b.deadline,
      b.content_blocks ?? null,
      priority,
      b.depends_on_task_id === undefined ? task.depends_on_task_id : dependency.value,
      nowIso(),
      task.id,
    )
    .run();

  if (!reopening) {
    await logEvent(c.env.DB, { actorId: c.get('userId'), orgId: c.get('orgId'), targetType: 'task', targetId: task.id, action: 'edited' });
    return c.json({ success: true });
  }

  // ПРАВКА = НОВАЯ ЗАДАЧА. Все исполнители сбрасываются в «не принял»: Азиз
  // принимал ТУ задачу, не эту. Без сброса строка Азиза оставалась «принял»,
  // задача падала в Todo -- и он не мог взять её снова, получая «вы уже
  // принимали». Карточка застревала навсегда.
  const updated = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').bind(task.id, c.get('orgId')).first<Task>();
  await c.env.DB.batch([resetAssignees(c.env, task.id, (updated ?? task).deadline ?? null)]);

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
  await drainOutbox(c.env);
  return c.json({ success: true });
});

// Кто принимает работу: автор задачи, а после R1-1 это может быть кто угодно --
// включая рядового сотрудника, поручившего что-то директору. creator/super_admin
// остаются запасным ключом на случай, когда автор уволился: иначе его задачи
// нельзя закрыть никогда.
function isReviewer(c: Context<AppEnv>, task: Task): boolean {
  if (task.author_id && task.author_id === c.get('userId')) return true;
  const role = c.get('role');
  return role === 'creator' || role === 'super_admin';
}

// Таблица переходов задачи уехала в assignees.ts: движется теперь строка
// адресата, а статус задачи -- её свёртка.

apiRoutes.post('/tasks/:id/move', requireProjectAccess('task'), async (c) => {
  const task = c.get('task')!;
  const orgId = c.get('orgId');
  // Правило «двигает только ответственный» стало «двигает СВОЮ строку каждый
  // адресат»: у рассылки на 14 человек единственного ответственного нет.
  const mine = await myAssignee(c.env, task.id, c.get('userId'), orgId);
  if (!mine) return c.json({ error: 'only an assignee can move this task' }, 403);

  const { to } = await c.req.json<{ to?: TaskStatus }>().catch(() => ({ to: undefined }));
  if (!to) return c.json({ error: 'to required' }, 400);
  // Словарь фронта -- в состояния адресата: доска говорит статусами задачи,
  // а движется теперь строка человека.
  const target = to === 'in_progress' ? 'accepted' : to === 'done' ? 'done' : null;
  if (!target) return c.json({ error: `invalid transition ${task.status} -> ${to}` }, 409);

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

  const res = await transitionAssignee(c.env, {
    task, assignee: mine, to: target, actorId: c.get('userId'),
    notify: target === 'accepted'
      ? { emoji: '🚀', label: 'В работе', track: true }
      : { emoji: '✅', label: 'Готово', deletePrevious: true },
  });
  if (!res.ok) return c.json({ error: res.error }, 409);
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

  const res = await transitionAssignee(c.env, { task, assignee: mine, to: 'declined', actorId: c.get('userId'), reason: reason.trim() });
  if (!res.ok) return c.json({ error: res.error }, 409);

  // Уведомление АВТОРУ, а не «живым адресатам». Раньше оно шло через
  // applyTransition, а тот рассылает всем со state <> 'declined' -- то есть
  // отказавшийся из списка уже выпал, автора в списке не было никогда, и при
  // единственном адресате не уходило НИЧЕГО: задача тихо уезжала в архив, а
  // поднять её автор-сотрудник сам не может. При рассылке было ещё хуже -- письмо
  // про отказ получали тринадцать посторонних и не получал тот, кому оно нужно.
  if (task.author_id) {
    const who = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(c.get('userId')).first<{ name: string }>();
    await c.env.DB.batch([
      await buildNotification(c.env, task, 'declined', {
        emoji: '🚫', label: 'Отказ от поручения',
        extraLine: `${who?.name ?? 'Исполнитель'} отказался. Причина: ${reason.trim()}`,
      }, task.deadline ?? null, task.author_id),
    ]);
  }
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
apiRoutes.delete('/tasks/:id', requireProjectAccess('task'), requireRole('super_admin', 'creator'), async (c) => {
  const task = c.get('task')!;
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
  await c.env.DB.batch([resetAssignees(c.env, task.id, task.deadline ?? null)]);
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
apiRoutes.post('/tasks/:id/confirm', requireProjectAccess('task'), async (c) => {
  const task = c.get('task')!;
  // Гейт -- АВТОРСТВО, а не роль (ADR-3 после R1-1). Поручения идут в любую
  // сторону: сотрудник, попросивший директора, обязан иметь право принять
  // работу, а посторонний super_admin -- нет. Роль остаётся запасным ключом для
  // владельца организации: без неё некому закрыть задачу уволившегося автора.
  if (!isReviewer(c, task)) return c.json({ error: 'only the author can confirm' }, 403);
  if (task.status !== 'done') return c.json({ error: 'task is not in done' }, 409);
  if (task.confirmed_at) return c.json({ error: 'task already confirmed' }, 409);
  let overdueBy: number | null = null;
  if (task.deadline && task.done_at) {
    const late = Math.floor((Date.parse(task.done_at) - Date.parse(task.deadline)) / 1000);
    overdueBy = late > 0 ? late : 0;
  }
  // Статус не меняется: подтверждение живёт в confirmed_at. Но это переход
  // жизненного цикла, и идти он обязан тем же путём -- иначе «единая точка»
  // становится «единой точкой, кроме одного случая».
  // Строки исполнителей помечаются принятыми. Без этого состояние 'confirmed'
  // недостижимо, строки навсегда остаются в 'done' -- и cron слал «пора
  // проверить» по задачам, которые автор уже принял.
  await c.env.DB.batch([confirmAssignees(c.env, task.id)]);
  await applyTransition(c.env, {
    task, to: task.status, actorId: c.get('userId'), action: 'confirmed', overdueBy,
    set: { confirmed_at: nowIso() },
    notify: { emoji: '✔️', label: 'Подтверждено', extraLine: overdueBy == null ? undefined : describeOverdue(overdueBy) },
  });
  await drainOutbox(c.env);
  return c.json({ success: true, overdue_by: overdueBy });
});

// Reject: back to in_progress, with a reason and a fresh deadline (now + extra_days).
// Escalation timers reset so the new deadline gets its own overdue/reminder cycle.
apiRoutes.post('/tasks/:id/reject', requireProjectAccess('task'), async (c) => {
  const task = c.get('task')!;
  if (!isReviewer(c, task)) return c.json({ error: 'only the author can reject' }, 403);
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
  const { fileId, messageId } = await sendDocument(c.env, c.env.TELEGRAM_STORAGE_CHAT_ID, file, file.name);
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
