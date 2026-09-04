// All /api routes. Access control is delegated to middleware.ts; handlers only
// hold business rules. Every mutating action writes an events row (system of record).
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env, Role, TaskStatus } from './types';
import { logEvent, nowIso, uuid } from './db';
import { mintSession, precheckPhone, sendOtp, SESSION_COOKIE, SESSION_TTL_SECONDS, verifyOtp, verifySession } from './auth';
import { type AppEnv, requireAuth, requireProjectAccess, requireRole } from './middleware';
import { deleteMessage, getFileUrl, resolveChatId, sendDocument, sendMessage } from './telegram';

// Telegram's Bot API can only download files up to 20MB back out (uploads may be
// larger, but would then be permanently unretrievable). Enforce the download cap
// at upload time so users get a clear error instead of losing an unfetchable file.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

// Fixed custom domain (wrangler.jsonc routes) -- used only to build deep links
// in Telegram notifications, not worth an env var for a single stable value.
const APP_URL = 'https://sayn.alrevion.com';

export const apiRoutes = new Hono<AppEnv>();

async function projectChatId(db: D1Database, projectId: string): Promise<string> {
  const row = await db.prepare('SELECT telegram_chat_id FROM projects WHERE id = ?').bind(projectId).first<{ telegram_chat_id: string }>();
  return row?.telegram_chat_id ?? '';
}

// Every board movement gets a permanent log line in the project's group (not
// tracked/deleted -- that's only the in-progress escalation seed message's job).
// Returns the sent message id, which only the in_progress mover cares about.
async function notifyTask(
  env: Env,
  task: { id: string; project_id: string; title: string; responsible_user_id: string; deadline?: string | null },
  emoji: string,
  label: string,
  extraLine?: string,
): Promise<string | null> {
  // @username actually pings them in Telegram; a plain name in message text doesn't.
  const resp = await env.DB.prepare('SELECT name, telegram_username FROM users WHERE id = ?').bind(task.responsible_user_id).first<{ name: string; telegram_username: string | null }>();
  const who = resp ? (resp.telegram_username ? `@${resp.telegram_username} (${resp.name})` : resp.name) : '—';
  const lines = [`${emoji} ${label}: "${task.title}"`, `Ответственный: ${who}`];
  if (task.deadline) lines.push(`Дедлайн: ${task.deadline}`);
  if (extraLine) lines.push(extraLine);
  lines.push(`${APP_URL}/?task=${task.id}`);
  return sendMessage(env, await projectChatId(env.DB, task.project_id), lines.join('\n'));
}

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
async function withEventTrail(db: D1Database, tasks: Record<string, unknown>[]) {
  const out = [];
  for (const task of tasks) {
    const { results: events } = await db
      .prepare(
        `SELECT e.*, u.name AS actor_name FROM events e
         LEFT JOIN users u ON u.id = e.actor_id
         WHERE e.target_type = 'task' AND e.target_id = ?
         ORDER BY e.created_at ASC`,
      )
      .bind(task.id)
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

  const token = await mintSession(c.env.SESSION_SECRET, { sub: user.id, role: user.role });
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: SESSION_TTL_SECONDS });
  return c.json({ user: { id: user.id, name: user.name, role: user.role } });
});

apiRoutes.post('/auth/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ success: true });
});

// ------------------------------------------------------ everything below: authed

apiRoutes.use('*', requireAuth);

apiRoutes.get('/me', async (c) => {
  const u = await c.env.DB.prepare('SELECT id, name, role, phone FROM users WHERE id = ?').bind(c.get('userId')).first();
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
  if (role === 'super_admin' && c.get('role') !== 'creator') return c.json({ error: 'only creator can create super_admin' }, 403);

  const id = uuid();
  const username = normalizeUsername(telegram_username);
  try {
    await c.env.DB.prepare('INSERT INTO users (id, phone, name, role, telegram_username) VALUES (?, ?, ?, ?, ?)').bind(id, phone.trim(), name, role, username).run();
  } catch {
    return c.json({ error: 'phone already exists' }, 409);
  }
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'user', targetId: id, action: 'created' });
  return c.json({ id, phone, name, role, telegram_username: username }, 201);
});

// Edit any subset of name/phone/telegram_username/role -- all optional and
// independent (send only what changed). Was telegram_username-only; broadened
// because there was previously no way to fix a name/phone typo at all.
apiRoutes.patch('/users/:id', requireRole('super_admin', 'creator'), async (c) => {
  const body = await c.req.json<{ name?: string; phone?: string; telegram_username?: string; role?: Role }>().catch(() => ({}) as Record<string, undefined>);
  const targetId = c.req.param('id');

  if (body.role !== undefined) {
    // Nobody edits their own role, super_admin included -- otherwise a
    // super_admin could just demote-proof or promote themselves.
    if (targetId === c.get('userId')) return c.json({ error: 'cannot change your own role' }, 403);
    const target = await c.env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(targetId).first<{ role: Role }>();
    if (!target) return c.json({ error: 'not found' }, 404);
    if (target.role === 'creator') return c.json({ error: "cannot change the creator's role" }, 403);
    if (body.role === 'creator') return c.json({ error: 'cannot reassign creator via API' }, 400);
    if (body.role === 'super_admin' && c.get('role') !== 'creator') return c.json({ error: 'only creator can promote to super_admin' }, 403);
  }
  if (body.name !== undefined && !body.name.trim()) return c.json({ error: 'name cannot be empty' }, 400);
  if (body.phone !== undefined && !body.phone.trim()) return c.json({ error: 'phone cannot be empty' }, 400);

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
  if (body.role !== undefined) {
    sets.push('role = ?');
    binds.push(body.role);
  }
  if (sets.length === 0) return c.json({ error: 'nothing to update' }, 400);
  binds.push(targetId);
  try {
    await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  } catch {
    return c.json({ error: 'phone already exists' }, 409);
  }

  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'user', targetId, action: 'edited' });
  return c.json({ success: true });
});

// Assignment dropdowns: id/name/role/telegram_username (no phone exposure).
apiRoutes.get('/users', async (c) => {
  // phone was deliberately withheld here (any project member can hit this to
  // populate a responsible-person picker) -- but super_admin/creator need it
  // back for the Edit person modal, so send it only to them.
  const role = c.get('role');
  const extra = role === 'super_admin' || role === 'creator' ? ', phone' : '';
  const { results } = await c.env.DB.prepare(`SELECT id, name, role, telegram_username${extra} FROM users ORDER BY name`).all();
  return c.json(results);
});

// ---------------------------------------------------------------------- projects

// creator sees every board (global oversight). super_admin/admin only see boards
// they were explicitly added to, or (super_admin only) created themselves --
// each board has its own people, holding the role isn't automatic membership.
apiRoutes.get('/projects', async (c) => {
  const role = c.get('role');
  if (role === 'creator') {
    const { results } = await c.env.DB.prepare('SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at DESC').all();
    return c.json(results);
  }
  const userId = c.get('userId');
  const { results } = await c.env.DB.prepare(
    `SELECT DISTINCT p.* FROM projects p
     LEFT JOIN project_memberships m ON m.project_id = p.id AND m.user_id = ?
     WHERE p.archived_at IS NULL AND (m.user_id IS NOT NULL OR p.created_by = ?)
     ORDER BY p.created_at DESC`,
  )
    .bind(userId, userId)
    .all();
  return c.json(results);
});

// Registered before POST/DELETE below so the literal "archived" path can't be
// swallowed by a later :projectId route (none currently overlaps, but keep it first).
apiRoutes.get('/projects/archived', requireRole('super_admin', 'creator'), async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM projects WHERE archived_at IS NOT NULL ORDER BY archived_at DESC').all();
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
  await c.env.DB.prepare('INSERT INTO projects (id, name, created_by, telegram_chat_id) VALUES (?, ?, ?, ?)')
    .bind(id, name, c.get('userId'), chatId)
    .run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'project', targetId: id, action: 'created' });
  return c.json({ id, name, telegram_chat_id: chatId }, 201);
});

// Soft-delete: sets archived_at. Tasks stay visible via the Archive tab; the
// escalation sweep already excludes tasks whose project is archived.
apiRoutes.delete('/projects/:projectId', requireRole('super_admin', 'creator'), async (c) => {
  const id = c.req.param('projectId');
  const res = await c.env.DB.prepare('UPDATE projects SET archived_at = ? WHERE id = ? AND archived_at IS NULL').bind(nowIso(), id).run();
  if (!res.meta.changes) return c.json({ error: 'not found' }, 404);
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'project', targetId: id, action: 'deleted' });
  return c.json({ success: true });
});

apiRoutes.post('/projects/:projectId/restore', requireRole('super_admin', 'creator'), async (c) => {
  const id = c.req.param('projectId');
  const res = await c.env.DB.prepare('UPDATE projects SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL').bind(id).run();
  if (!res.meta.changes) return c.json({ error: 'not found' }, 404);
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'project', targetId: id, action: 'restored' });
  return c.json({ success: true });
});

// Per-project Archive tab: archived tasks in this project, each with its full
// attributable event trail (who created/edited/deleted/restored/confirmed it),
// PLUS the project-level audit trail (project created/deleted, members added/
// removed) -- these are logged (see /projects and /projects/:id/members above)
// but otherwise have no UI, which is a real gap against "all destructive/admin
// actions ... visible to creator". Scoped to status='archived' for tasks since
// the UI offers a Restore action per entry, and only archived tasks are restorable.
apiRoutes.get('/projects/:projectId/archive', requireRole('super_admin', 'creator'), async (c) => {
  const projectId = c.req.param('projectId');
  const { results: tasks } = await c.env.DB.prepare(
    "SELECT * FROM tasks WHERE project_id = ? AND status = 'archived' ORDER BY updated_at DESC",
  )
    .bind(projectId)
    .all();
  const { results: projectEvents } = await c.env.DB.prepare(
    `SELECT e.*, u.name AS actor_name FROM events e
     LEFT JOIN users u ON u.id = e.actor_id
     WHERE (e.target_type = 'project' OR e.target_type = 'membership') AND e.target_id = ?
     ORDER BY e.created_at DESC`,
  )
    .bind(projectId)
    .all();
  return c.json({ archivedTasks: await withEventTrail(c.env.DB, tasks), projectEvents });
});

// Personal archive: read-only accountability view for the signed-in user --
// tasks they were responsible for that are done or archived. No restore here
// (restoring is a project-archive action gated to super_admin/creator).
apiRoutes.get('/archive/mine', async (c) => {
  const { results: tasks } = await c.env.DB.prepare(
    "SELECT * FROM tasks WHERE responsible_user_id = ? AND status IN ('done', 'archived') ORDER BY updated_at DESC",
  )
    .bind(c.get('userId'))
    .all();
  return c.json(await withEventTrail(c.env.DB, tasks));
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
  const extra = role === 'super_admin' || role === 'creator' ? ', telegram_username, phone' : '';
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, role${extra},
       CASE WHEN id IN (SELECT user_id FROM project_memberships WHERE project_id = ?) THEN 1 ELSE 0 END AS is_member
     FROM users
     WHERE role = 'creator'
        OR id = (SELECT created_by FROM projects WHERE id = ?)
        OR id IN (SELECT user_id FROM project_memberships WHERE project_id = ?)
     ORDER BY name`,
  )
    .bind(projectId, projectId, projectId)
    .all();
  return c.json(results);
});

apiRoutes.post('/projects/:projectId/members', requireProjectAccess('project'), requireRole('super_admin', 'creator'), async (c) => {
  const projectId = c.req.param('projectId');
  const { user_id } = await c.req.json<{ user_id?: string }>().catch(() => ({ user_id: undefined }));
  if (!user_id) return c.json({ error: 'user_id required' }, 400);
  const id = uuid();
  try {
    await c.env.DB.prepare('INSERT INTO project_memberships (id, project_id, user_id) VALUES (?, ?, ?)').bind(id, projectId, user_id).run();
  } catch {
    return c.json({ error: 'already a member or invalid' }, 409);
  }
  // target_id is the project (not the membership row) so both membership events
  // are queryable by project id alongside 'project' events for the audit view.
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'membership', targetId: projectId, action: 'membership_added', comment: user_id });
  return c.json({ id }, 201);
});

apiRoutes.delete('/projects/:projectId/members/:userId', requireProjectAccess('project'), requireRole('super_admin', 'creator'), async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.req.param('userId');
  const res = await c.env.DB.prepare('DELETE FROM project_memberships WHERE project_id = ? AND user_id = ?').bind(projectId, userId).run();
  if (!res.meta.changes) return c.json({ error: 'not found' }, 404);
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'membership', targetId: projectId, action: 'membership_removed', comment: userId });
  return c.json({ success: true });
});

// Board data (polled ~5s by the frontend).
apiRoutes.get('/projects/:projectId/tasks', requireProjectAccess('project'), async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM tasks WHERE project_id = ? AND status IN ('todo','in_progress','done') ORDER BY created_at",
  )
    .bind(c.req.param('projectId'))
    .all();
  return c.json(results);
});

// ------------------------------------------------------------------------- tasks

const PRIORITIES = ['urgent', 'medium', 'low'];

// depends_on_task_id must name a task in the SAME project and not itself --
// the single-level "B can't start until A is done" chain from POST /tasks/:id/move.
async function resolveDependency(
  db: D1Database,
  projectId: string,
  selfId: string | null,
  dependsOnTaskId: string | null | undefined,
): Promise<{ ok: true; value: string | null } | { ok: false }> {
  if (dependsOnTaskId === undefined) return { ok: true, value: null };
  if (dependsOnTaskId === null) return { ok: true, value: null };
  if (dependsOnTaskId === selfId) return { ok: false };
  const dep = await db.prepare('SELECT project_id FROM tasks WHERE id = ?').bind(dependsOnTaskId).first<{ project_id: string }>();
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
      deadline?: string;
      content_blocks?: string;
      priority?: string;
      depends_on_task_id?: string | null;
    }>()
    .catch(() => ({}) as Record<string, undefined>);
  if (!b.title || !b.responsible_user_id) return c.json({ error: 'title and responsible_user_id required' }, 400);
  const priority = b.priority && PRIORITIES.includes(b.priority) ? b.priority : 'medium';
  const dependency = await resolveDependency(c.env.DB, projectId, null, b.depends_on_task_id);
  if (!dependency.ok) return c.json({ error: 'depends_on_task_id must be another task in the same project' }, 400);
  const id = uuid();
  await c.env.DB.prepare(
    `INSERT INTO tasks (id, project_id, title, description, responsible_user_id, status, deadline, content_blocks, priority, depends_on_task_id)
     VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?)`,
  )
    .bind(id, projectId, b.title, b.description ?? '', b.responsible_user_id, b.deadline ?? null, b.content_blocks ?? null, priority, dependency.value)
    .run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'task', targetId: id, action: 'created' });
  await notifyTask(c.env, { id, project_id: projectId, title: b.title, responsible_user_id: b.responsible_user_id, deadline: b.deadline ?? null }, '📌', 'Новая задача');
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
  const dependency = await resolveDependency(c.env.DB, task.project_id, task.id, b.depends_on_task_id);
  if (!dependency.ok) return c.json({ error: 'depends_on_task_id must be another task in the same project' }, 400);
  if (reopening && task.telegram_message_id) {
    await deleteMessage(c.env, await projectChatId(c.env.DB, task.project_id), task.telegram_message_id);
  }
  const priority = b.priority && PRIORITIES.includes(b.priority) ? b.priority : null;
  await c.env.DB.prepare(
    `UPDATE tasks SET title = COALESCE(?, title), description = COALESCE(?, description),
       responsible_user_id = COALESCE(?, responsible_user_id), deadline = ?, status = ?, telegram_message_id = ?,
       content_blocks = COALESCE(?, content_blocks), priority = COALESCE(?, priority),
       depends_on_task_id = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(
      b.title ?? null,
      b.description ?? null,
      b.responsible_user_id ?? null,
      b.deadline === undefined ? task.deadline : b.deadline,
      reopening ? 'todo' : task.status,
      reopening ? null : task.telegram_message_id,
      b.content_blocks ?? null,
      priority,
      b.depends_on_task_id === undefined ? task.depends_on_task_id : dependency.value,
      nowIso(),
      task.id,
    )
    .run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'task', targetId: task.id, action: reopening ? 'edited_reopened' : 'edited' });
  if (reopening) {
    await notifyTask(
      c.env,
      {
        id: task.id,
        project_id: task.project_id,
        title: b.title ?? task.title,
        responsible_user_id: b.responsible_user_id ?? task.responsible_user_id,
        deadline: b.deadline === undefined ? task.deadline : b.deadline,
      },
      '↩️',
      'Возвращено в TODO (отредактировано)',
    );
  }
  return c.json({ success: true });
});

// Valid transitions only: todo->in_progress, in_progress->done. Everything else 409
// (incl. done->in_progress, which is the confirm/reject flow's job, not a move).
const TRANSITIONS: Record<string, TaskStatus[]> = { todo: ['in_progress'], in_progress: ['done'] };

apiRoutes.post('/tasks/:id/move', requireProjectAccess('task'), async (c) => {
  const task = c.get('task')!;
  // Whoever the task is assigned to is the one who does the work, so only
  // they move it through the board -- no role-based override here, not even
  // super_admin/creator (their own tasks are moved by them, same as anyone else).
  if (task.responsible_user_id !== c.get('userId')) {
    return c.json({ error: 'only the responsible person can move this task' }, 403);
  }
  const { to } = await c.req.json<{ to?: TaskStatus }>().catch(() => ({ to: undefined }));
  if (!to) return c.json({ error: 'to required' }, 400);
  if (!(TRANSITIONS[task.status] ?? []).includes(to)) return c.json({ error: `invalid transition ${task.status} -> ${to}` }, 409);

  // "Draft the contract" must be done before "review the contract" can start --
  // a single predecessor task that has to reach done/archived first.
  if (to === 'in_progress' && task.depends_on_task_id) {
    const dep = await c.env.DB.prepare('SELECT title, status FROM tasks WHERE id = ?').bind(task.depends_on_task_id).first<{ title: string; status: TaskStatus }>();
    if (dep && dep.status !== 'done' && dep.status !== 'archived') {
      return c.json({ error: `blocked: "${dep.title}" must be finished first` }, 409);
    }
  }

  const chatId = await projectChatId(c.env.DB, task.project_id);

  if (to === 'in_progress') {
    // Seed message the escalation cycle later replaces.
    const msgId = await notifyTask(c.env, task, '🚀', 'В работе');
    await c.env.DB.prepare('UPDATE tasks SET status = ?, telegram_message_id = ?, updated_at = ? WHERE id = ?').bind('in_progress', msgId, nowIso(), task.id).run();
  } else {
    // Reached done: clear the live escalation/seed message, announce completion.
    if (task.telegram_message_id) await deleteMessage(c.env, chatId, task.telegram_message_id);
    await c.env.DB.prepare('UPDATE tasks SET status = ?, done_at = ?, telegram_message_id = NULL, updated_at = ? WHERE id = ?').bind('done', nowIso(), nowIso(), task.id).run();
    await notifyTask(c.env, task, '✅', 'Готово');
  }
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'task', targetId: task.id, action: `moved_${to}` });
  return c.json({ success: true });
});

// Delete = archive (never hard delete). super_admin/creator only.
apiRoutes.delete('/tasks/:id', requireProjectAccess('task'), requireRole('super_admin', 'creator'), async (c) => {
  const task = c.get('task')!;
  if (task.telegram_message_id) await deleteMessage(c.env, await projectChatId(c.env.DB, task.project_id), task.telegram_message_id);
  await c.env.DB.prepare("UPDATE tasks SET status = 'archived', telegram_message_id = NULL, updated_at = ? WHERE id = ?").bind(nowIso(), task.id).run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'task', targetId: task.id, action: 'deleted' });
  await notifyTask(c.env, task, '🗑', 'Архивировано');
  return c.json({ success: true });
});

// Restore requires a comment; un-deletes back to editable todo.
apiRoutes.post('/tasks/:id/restore', requireProjectAccess('task'), requireRole('super_admin', 'creator'), async (c) => {
  const task = c.get('task')!;
  const { comment } = await c.req.json<{ comment?: string }>().catch(() => ({ comment: undefined }));
  if (!comment || !comment.trim()) return c.json({ error: 'comment required' }, 400);
  if (task.status !== 'archived') return c.json({ error: 'only archived tasks can be restored' }, 409);
  await c.env.DB.prepare("UPDATE tasks SET status = 'todo', done_at = NULL, updated_at = ? WHERE id = ?").bind(nowIso(), task.id).run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'task', targetId: task.id, action: 'restored', comment });
  await notifyTask(c.env, task, '♻️', 'Восстановлено', `Комментарий: ${comment}`);
  return c.json({ success: true });
});

// Confirm completion. Computes overdue_by vs deadline (0 if on time, null if no deadline).
// confirmed_at guards against re-confirming and lets the board hide Confirm/Reject
// once done (a Done card otherwise looks identical whether confirmed or not).
apiRoutes.post('/tasks/:id/confirm', requireProjectAccess('task'), requireRole('super_admin', 'creator'), async (c) => {
  const task = c.get('task')!;
  if (task.status !== 'done') return c.json({ error: 'task is not in done' }, 409);
  if (task.confirmed_at) return c.json({ error: 'task already confirmed' }, 409);
  let overdueBy: number | null = null;
  if (task.deadline && task.done_at) {
    const late = Math.floor((Date.parse(task.done_at) - Date.parse(task.deadline)) / 1000);
    overdueBy = late > 0 ? late : 0;
  }
  await c.env.DB.prepare('UPDATE tasks SET confirmed_at = ?, updated_at = ? WHERE id = ?').bind(nowIso(), nowIso(), task.id).run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'task', targetId: task.id, action: 'confirmed', overdueBy });
  await notifyTask(c.env, task, '✔️', 'Подтверждено', overdueBy == null ? undefined : describeOverdue(overdueBy));
  return c.json({ success: true, overdue_by: overdueBy });
});

// Reject: back to in_progress, with a reason and a fresh deadline (now + extra_days).
// Escalation timers reset so the new deadline gets its own overdue/reminder cycle.
apiRoutes.post('/tasks/:id/reject', requireProjectAccess('task'), requireRole('super_admin', 'creator'), async (c) => {
  const task = c.get('task')!;
  if (task.status !== 'done') return c.json({ error: 'task is not in done' }, 409);
  const { comment, extra_days } = await c.req.json<{ comment?: string; extra_days?: number }>().catch(() => ({}) as Record<string, undefined>);
  if (!comment || !comment.trim()) return c.json({ error: 'comment required' }, 400);
  const days = Number(extra_days);
  if (!Number.isInteger(days) || days < 1) return c.json({ error: 'extra_days must be a positive integer' }, 400);
  const newDeadline = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  await c.env.DB.prepare(
    `UPDATE tasks SET status = 'in_progress', done_at = NULL, confirmed_at = NULL, deadline = ?,
       last_escalated_at = NULL, reminder_sent_at = NULL, review_reminded_at = NULL, updated_at = ? WHERE id = ?`,
  )
    .bind(newDeadline, nowIso(), task.id)
    .run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'task', targetId: task.id, action: 'rejected', comment });
  await notifyTask(c.env, { ...task, deadline: newDeadline }, '❌', 'Отклонено, возвращено в работу', `Причина: ${comment}`);
  return c.json({ success: true });
});

// ------------------------------------------------------------------- attachments

type AttachmentRow = {
  id: string;
  task_id: string;
  telegram_file_id: string;
  telegram_message_id: string;
  filename: string;
  mime_type: string;
  uploaded_by: string;
  project_id: string; // joined from tasks
};

// /attachments/:id/* routes key on the attachment id, so requireProjectAccess('task')
// (which keys on a task id param) can't be used directly -- mirror it here. Loads
// the attachment joined to its owning task and returns it only if the caller may
// access that project. Same opaque null (caller returns 403, no existence leak).
async function attachmentForAccess(c: Context<AppEnv>, attachmentId: string): Promise<AttachmentRow | null> {
  const row = await c.env.DB.prepare(
    `SELECT a.*, t.project_id AS project_id FROM attachments a
     JOIN tasks t ON t.id = a.task_id WHERE a.id = ?`,
  )
    .bind(attachmentId)
    .first<AttachmentRow>();
  if (!row) return null;
  const role = c.get('role');
  if (role === 'creator') return row;
  const member = await c.env.DB.prepare('SELECT 1 FROM project_memberships WHERE project_id = ? AND user_id = ?')
    .bind(row.project_id, c.get('userId'))
    .first();
  if (member) return row;
  if (role === 'super_admin') {
    const project = await c.env.DB.prepare('SELECT created_by FROM projects WHERE id = ?').bind(row.project_id).first<{ created_by: string }>();
    if (project?.created_by === c.get('userId')) return row;
  }
  return null;
}

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
    `INSERT INTO attachments (id, task_id, telegram_file_id, telegram_message_id, filename, mime_type, size_bytes, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, task.id, fileId, messageId, file.name, mime, file.size, c.get('userId'))
    .run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'task', targetId: task.id, action: 'attachment_added', comment: file.name });
  return c.json({ id, filename: file.name, mime_type: mime, size_bytes: file.size }, 201);
});

// List attachments for a task (uploader resolved to a display name).
apiRoutes.get('/tasks/:id/attachments', requireProjectAccess('task'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.filename, a.mime_type, a.size_bytes, a.uploaded_by, u.name AS uploaded_by_name, a.created_at
     FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
     WHERE a.task_id = ? ORDER BY a.created_at`,
  )
    .bind(c.get('task')!.id)
    .all();
  return c.json(results);
});

// Download: real proxy (never a redirect) so the browser never sees a Telegram
// URL. Fetch the file server-side and stream the bytes back under our own headers.
apiRoutes.get('/attachments/:id/download', async (c) => {
  const att = await attachmentForAccess(c, c.req.param('id'));
  if (!att) return c.json({ error: 'forbidden' }, 403);
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
apiRoutes.delete('/attachments/:id', async (c) => {
  const att = await attachmentForAccess(c, c.req.param('id'));
  if (!att) return c.json({ error: 'forbidden' }, 403);
  // Fresh DB read for the elevated bypass (not the token's role) -- same
  // de-provisioning/downgrade guard requireRole() applies everywhere else.
  const fresh = await verifySession(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE), { db: c.env.DB, allowed: ['super_admin', 'creator'] });
  if (!fresh && att.uploaded_by !== c.get('userId')) return c.json({ error: 'forbidden' }, 403);

  await deleteMessage(c.env, c.env.TELEGRAM_STORAGE_CHAT_ID, att.telegram_message_id);
  await c.env.DB.prepare('DELETE FROM attachments WHERE id = ?').bind(att.id).run();
  await logEvent(c.env.DB, { actorId: c.get('userId'), targetType: 'task', targetId: att.task_id, action: 'attachment_deleted', comment: att.filename });
  return c.json({ success: true });
});
