// The ONLY place access-control logic lives. Every project-scoped or
// role-gated route goes through these three middlewares.
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Attachment, Env, Role, Task } from './types';
import { membershipRole, resolveOrgId, SESSION_COOKIE, verifySession } from './auth';

export type AppEnv = {
  Bindings: Env;
  Variables: { userId: string; role: Role; orgId: string; task?: Task; attachment?: Attachment };
};

// Verifies the session cookie; attaches { userId, role, orgId }. 401 if
// missing/invalid/expired.
//
// Догруз org_id -- ПЕРЕХОДНАЯ ветка. Токен живёт SESSION_TTL_SECONDS = 12ч и не
// отзывается, поэтому сразу после деплоя 2a у всех живых сессий claim'а org_id
// нет; без догруза они полсуток получали бы пустую доску или 500. Цена названа
// явно: лишний SELECT на каждый запрос от старой сессии. Приемлемо на
// 12-часовом окне, неприемлемо как постоянное состояние -- ветка снимается на
// contract-релизе вместе с ужесточением org_id до NOT NULL.
// Что доступно сессии БЕЗ организации: ровно то, что нужно экрану «создайте
// или вступите». Всё остальное -- 401, как и раньше.
const ORGLESS_OK = new Set(['GET /me', 'GET /orgs/mine', 'GET /packs', 'POST /orgs', 'POST /orgs/join', 'PATCH /me']);

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const payload = await verifySession(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE));
  if (!payload) return c.json({ error: 'unauthorized' }, 401);
  const orgId = payload.org_id ?? (await resolveOrgId(c.env.DB, payload.sub));
  // Организация не резолвится -- человека отозвали отовсюду либо членств
  // несколько и ни одно не выбрано. Первая организация создаётся В ПРИЛОЖЕНИИ
  // (раздел 18), поэтому такой сессии открыт короткий список роутов; остальное
  // лечится релогином, а не догадкой о том, чьи данные ему показать.
  if (!orgId) {
    const key = `${c.req.method} ${c.req.path.replace(/^\/api/, '')}`;
    if (!ORGLESS_OK.has(key)) return c.json({ error: 'unauthorized' }, 401);
    c.set('userId', payload.sub);
    c.set('role', 'member');
    c.set('orgId', '');
    return next();
  }

  // Членство ПЕРЕПРОВЕРЯЕТСЯ на каждом запросе, а не берётся из claim'а.
  // Токен -- stateless, живёт 12ч и не отзывается; до 2a это стоило дёшево,
  // потому что отзыв доступа проверялся только на роль-гейтах (requireRole).
  // С появлением второго арендатора цена изменилась: уволенный сотрудник читал
  // бы доску бывшего работодателя ещё полсуток. Это ровно тот отказ, ради
  // предотвращения которого существует весь шаг.
  //
  // Цена названа явно: один SELECT по индексу idx_org_memberships_user на
  // каждый авторизованный запрос. Индекс для этого и заведён. Роль берётся
  // оттуда же -- значит и понижение в должности действует сразу, а не только
  // на роль-гейтах.
  const role = await membershipRole(c.env.DB, orgId, payload.sub);
  if (!role) return c.json({ error: 'unauthorized' }, 401);

  c.set('userId', payload.sub);
  c.set('role', role);
  c.set('orgId', orgId);
  await next();
};

// Gates role-elevated actions. Re-fetches the DB user (existence + current role)
// so a de-provisioned / downgraded account can't ride a still-valid token.
export const requireRole = (...roles: Role[]): MiddlewareHandler<AppEnv> => async (c, next) => {
  // orgId берётся из контекста, выставленного requireAuth: сам verifySession
  // организацию не угадывает, иначе роль искалась бы «в любой подходящей».
  const payload = await verifySession(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE), {
    db: c.env.DB,
    allowed: roles,
    orgId: c.get('orgId') ?? null,
  });
  if (!payload) return c.json({ error: 'forbidden' }, 403);
  c.set('role', payload.role); // refreshed from org_memberships
  await next();
};

// creator проходит В ПРЕДЕЛАХ СВОЕЙ ОРГАНИЗАЦИИ. До шага 2a байпас был
// безусловным ("global oversight") -- после появления второй организации это
// означало бы, что creator семейной группы читает проекты школы.
//
// Глобального надзора после этого не остаётся ни у кого, включая оператора
// продукта. Это РЕШЕНИЕ владельца (2026-09-04), а не побочный эффект:
// платформенного флага нет, поддержка работает прямым доступом к D1.
//
// Остальные роли проходят только по явной строке project_memberships (или, у
// super_admin, как создатель доски): у каждой доски свои люди, роль сама по
// себе членства не даёт. Отказ одинаковый -- 403 -- и когда доски/задачи нет,
// и когда человек не участник (без оракула существования). Для 'task' и
// 'attachment' загруженная строка кладётся в контекст.
//
// Три источника projectId, один предикат. Раньше вложения имели собственную
// копию предиката в routes.ts (attachmentForAccess) -- ручное зеркало этой
// функции, и её комментарий сам это признавал. Копия предиката доступа означает
// два места, где его надо чинить, и одно, про которое забудут: на шаге 2a сюда
// приезжает org-условие, и зеркало разошлось бы молча.
// Помечает мидлвару, чтобы структурный тест мог доказать инвариант «ни один
// роут с параметром проекта не обходится без загрузчика доступа» перебором
// apiRoutes.routes. Перечислять роуты в тесте руками бессмысленно: список
// устаревает ровно тогда, когда кто-то добавляет тридцать первый роут -- то есть
// в единственный момент, когда проверка и нужна.
export type AccessLoader = MiddlewareHandler<AppEnv> & { accessSource: string };

export const requireProjectAccess = (source: 'project' | 'task' | 'attachment' = 'project'): AccessLoader =>
  Object.assign(
    async (c: Parameters<MiddlewareHandler<AppEnv>>[0], next: Parameters<MiddlewareHandler<AppEnv>>[1]) => {
    let projectId: string | null | undefined;

    if (source === 'attachment') {
      const attachmentId = c.req.param('id');
      const attachment = attachmentId
        ? await c.env.DB.prepare(
            `SELECT a.*, t.project_id AS project_id FROM attachments a
             JOIN tasks t ON t.id = a.task_id WHERE a.id = ?`,
          )
            .bind(attachmentId)
            .first<Attachment>()
        : null;
      if (!attachment) return c.json({ error: 'forbidden' }, 403);
      c.set('attachment', attachment);
      projectId = attachment.project_id;
    } else if (source === 'task') {
      const taskId = c.req.param('id') ?? c.req.param('taskId');
      const task = taskId
        ? await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').bind(taskId, c.get('orgId')).first<Task>()
        : null;
      if (!task) return c.json({ error: 'forbidden' }, 403);
      c.set('task', task);
      projectId = task.project_id;
    } else {
      projectId = c.req.param('projectId');
    }

    const role = c.get('role');
    const orgId = c.get('orgId');

    // Проект обязан принадлежать организации сессии -- ДО любой проверки роли.
    // Иначе байпас creator сравнивался бы с проектом чужого арендатора.
    const project = await c.env.DB.prepare('SELECT created_by FROM projects WHERE id = ? AND org_id = ?')
      .bind(projectId, orgId)
      .first<{ created_by: string }>();
    if (!project) return c.json({ error: 'forbidden' }, 403);

    if (role === 'creator') return next();

    const member = await c.env.DB.prepare('SELECT 1 FROM project_memberships WHERE project_id = ? AND user_id = ? AND org_id = ?')
      .bind(projectId, c.get('userId'), orgId)
      .first();
    if (member) return next();

    if (role === 'super_admin' && project.created_by === c.get('userId')) return next();
    return c.json({ error: 'forbidden' }, 403);
    },
    { accessSource: source },
  );
