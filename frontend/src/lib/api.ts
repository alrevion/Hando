// Thin fetch wrapper for the Hando API. Sessions are an HttpOnly cookie, so
// every call just needs `credentials: 'include'` -- no token handling here.
//
// ASSUMPTION (backend not visible while this was written -- reconcile against
// the real routes): endpoint paths/shapes below are inferred from the plan
// (.omc/plans/kanban-plan.md, "Implementation Steps" 2-8). See the shape
// notes on each function.

import type { ArchivedTaskEntry, Priority, Project, ProjectMember, Role, Task, TaskEvent, TaskStatus, User } from '../types';

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let code: string | undefined;
    try {
      const body = await res.json();
      message = body?.error || body?.message || message;
      code = body?.code;
    } catch {
      // no JSON body
    }
    throw new ApiError(message, res.status, code);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
const patch = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

// --- Auth ---
// Вход в браузере через бота: ссылка на бота, потом опрос. claim отвечает
// {pending} (202), пока человек не нажал «Войти», и 410, когда ключ истёк.
export const authLinkStart = () => post<{ url: string }>('/auth/link');
export const authLinkClaim = () => post<{ user?: User; pending?: boolean }>('/auth/link/claim');
// GET /api/me -> {user} when a valid session cookie is present, else 401.
export const getMe = () => get<{ user: User }>('/me');
export const authLogout = () => post<void>('/auth/logout');

// --- Projects ---
// GET /api/projects -> already filtered server-side by role/membership.
export const getProjects = () => get<Project[]>('/projects');
// telegramGroupId: raw digits as copied from an id bot -- the backend prepends
// the -100 supergroup prefix, so don't ask the user to remember it.
export const createProject = (name: string, telegramGroupId?: string) =>
  post<{ id: string; name: string; telegram_chat_id: string | null }>('/projects', { name, ...(telegramGroupId ? { telegram_group_id: telegramGroupId } : {}) });
// A "delete" is really a soft archive (backend sets archived_at, never a hard
// delete) -- these two round out the loop: see it, bring it back.
export const deleteProject = (id: string) => del<void>(`/projects/${id}`);
export const getArchivedProjects = () => get<Project[]>('/projects/archived');
export const restoreProject = (id: string) => post<void>(`/projects/${id}/restore`);

// --- Users (for admin/super_admin management + responsible-person pickers) ---
export const getUsers = () => get<User[]>('/users');
export const createUser = (input: { phone: string; name: string; role: 'super_admin' | 'admin'; telegram_username?: string }) =>
  post<User>('/users', input);
// Любое подмножество полей. telegram_username: '' стирает. Ролей две назначаемых
// (руководитель отдела, участник); сервер проверяет право и поддерево.
export const updateUser = (
  userId: string,
  input: Partial<{ name: string; phone: string; telegram_username: string; role: 'admin' | 'member' }>,
) => patch<void>(`/users/${userId}`, input);
// Заморозка и удаление из организации (раздел 19): владелец -- любого,
// руководитель отдела -- в своём поддереве. Открытые поручения вернутся авторам.
export const freezeUser = (userId: string) => post<{ ok: true; returned: number }>(`/users/${userId}/freeze`, {});
export const unfreezeUser = (userId: string) => post<{ ok: true }>(`/users/${userId}/unfreeze`, {});
export const removeOrgMember = (orgId: string, userId: string) => del<void>(`/orgs/${orgId}/members/${userId}`);
export interface PersonStats {
  done: number; on_time_pct: number | null; avg_late_days: number; accepted: number; declined: number; in_progress: number;
}
export const getUserStats = (userId: string) => get<{ all: PersonStats; last30: PersonStats }>(`/users/${userId}/stats`);
/** «Все задания»: обзор поддерева, не всей организации. */
export const getSubtreeTasks = () => get<{ tasks: Task[] }>('/org/subtree-tasks').then((r) => r.tasks);
export const getInviteLink = (orgId: string) => get<{ code: string; link: string }>(`/orgs/${orgId}/invite`);

// --- Project memberships ---
export const addMember = (projectId: string, userId: string) =>
  post<void>(`/projects/${projectId}/members`, { user_id: userId });
export const removeMember = (projectId: string, userId: string) =>
  del<void>(`/projects/${projectId}/members/${userId}`);
export const getProjectMembers = (projectId: string) =>
  get<ProjectMember[]>(`/projects/${projectId}/members`);

// --- Tasks ---
export const getTasks = (projectId: string) => get<Task[]>(`/projects/${projectId}/tasks`);
// Used to resolve a Telegram deep link (?task=<id>) to its project before the
// board for that project has even been selected.
export const getTask = (taskId: string) => get<Task>(`/tasks/${taskId}`);

export interface TaskInput {
  title: string;
  description: string;
  responsible_user_id: string;
  deadline: string | null;
  priority: Priority;
  /** Через сколько МИНУТ задача возвращается. null снимает повтор. */
  repeat_min?: number | null;
  // Predecessor task (same project) that must be done/archived first. undefined
  // = leave unchanged (edit only), null = no dependency.
  depends_on_task_id?: string | null;
}

export const createTask = (projectId: string, input: TaskInput) =>
  post<{ id: string }>(`/projects/${projectId}/tasks`, input);
// Allowed while status === 'todo' (anyone with project access), or while
// status === 'in_progress' (super_admin/creator only -- reopens it to todo).
// Backend re-enforces both. Partial + content_blocks: the create flow finalizes
// a task's canvas in a follow-up call once pending photo uploads resolve to
// real attachment ids (see BoardView.resolveBlocks), so this can't require a
// full TaskInput up front.
export const updateTask = (taskId: string, input: Partial<TaskInput> & { content_blocks?: string }) =>
  patch<Task>(`/tasks/${taskId}`, input);
/** 'started' -- не статус задачи, а отметка «сел за работу» на своей строке. */
export const moveTask = (taskId: string, status: TaskStatus | 'started') =>
  post<Task>(`/tasks/${taskId}/move`, { to: status });
/** Отметить или снять пункт списка. Возвращает список целиком -- он короткий. */
export const toggleChecklistItem = (taskId: string, index: number) =>
  post<{ checklist: { t: string; d: string | null }[] }>(`/tasks/${taskId}/checklist`, { index });
export const confirmTask = (taskId: string) =>
  post<{ success: true; overdue_by: number | null }>(`/tasks/${taskId}/confirm`);
export const rejectTask = (taskId: string, comment: string, extraDays: number) =>
  post<Task>(`/tasks/${taskId}/reject`, { comment, extra_days: extraDays });
export const deleteTask = (taskId: string) => del<void>(`/tasks/${taskId}`);
// «Не успею» и «Отказать» -- те же, что кнопки под карточкой в боте.
export const lateTask = (taskId: string, comment: string) => post<void>(`/tasks/${taskId}/late`, { comment });
export const declineTask = (taskId: string, reason: string) => post<void>(`/tasks/${taskId}/decline`, { reason });
export interface AttachmentRow { id: string; filename: string; mime_type: string; size_bytes: number; uploaded_by_name: string | null; created_at: string; }
export const getAttachments = (taskId: string) => get<AttachmentRow[]>(`/tasks/${taskId}/attachments`);
export const restoreTask = (taskId: string, comment: string) =>
  post<Task>(`/tasks/${taskId}/restore`, { comment });

// --- Archive views ---
// Project-scoped audit trail (super_admin/creator only): archived tasks with
// their event trail, plus the project-level events (create/delete, membership
// add/remove) that have no other UI surface.
export interface ProjectArchive {
  archivedTasks: ArchivedTaskEntry[];
  projectEvents: Array<TaskEvent & { actor_name: string | null }>;
}
export const getProjectArchive = (projectId: string) =>
  get<ProjectArchive>(`/projects/${projectId}/archive`);
// Personal archive (any admin): tasks where they were responsible and the
// task is done/archived.
export const getMyArchive = () => get<ArchivedTaskEntry[]>('/archive/mine');

// --- Attachments ---
// The canvas editor's photos, stored as ordinary attachment rows (Telegram-backed)
// and referenced by id from task.content_blocks. Telegram's Bot API can only
// download files up to 20MB back out, so uploads are capped there too; mirrored
// here first for an instant client-side error.
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

// FormData upload: pass empty headers so the shared request() drops its default
// application/json and the browser sets the multipart boundary itself.
export const uploadAttachment = (taskId: string, file: File) => {
  const form = new FormData();
  form.append('file', file);
  return request<{ id: string; filename: string; mime_type: string; size_bytes: number }>(
    `/tasks/${taskId}/attachments`,
    { method: 'POST', body: form, headers: {} },
  );
};

export const deleteAttachment = (attachmentId: string) => del<void>(`/attachments/${attachmentId}`);
// Inline <img src="/api/attachments/:id/download"> renders it directly -- no JS blob needed.

/**
 * Вход по подписи Telegram. Номер телефона не нужен: подпись мессенджера
 * доказывает, что это тот самый аккаунт, который уже подключён к боту.
 */
export function authTelegram(initData: string): Promise<{ user: User }> {
  return request<{ user: User }>('/auth/telegram', { method: 'POST', body: JSON.stringify({ initData }) });
}

/** Заявка на вступление в организацию (только creator/super_admin; иначе 403). */
export interface PendingMember {
  user_id: string;
  name: string;
  telegram_username: string | null;
  created_at: string;
}

export function getPendingMembers(): Promise<PendingMember[]> {
  return request<PendingMember[]>('/memberships/pending');
}

/** Роль, отдел и должность выбирают ПРИ подтверждении, а не «потом»: молчаливый
 *  «сотрудник» и был тем, из-за чего роль приходилось менять с компьютера. */
export function approveMember(
  userId: string,
  opts: { role: Role; project_id?: string; position?: string },
): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/memberships/${userId}/approve`, { method: 'POST', body: JSON.stringify(opts) });
}

export function rejectMember(userId: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/memberships/${userId}/reject`, { method: 'POST' });
}

/** Один снимок организации: доски, задачи и (только при полной загрузке) люди.
 *  `since` -- курсор `at` из прошлого ответа; тогда приедут только изменения. */
export interface OrgSnapshot {
  at: string;
  projects: Project[];
  tasks: Task[];
  users: User[] | null;
  can_see_users: boolean;
}

export function getOrgSnapshot(since?: string): Promise<OrgSnapshot> {
  return request<OrgSnapshot>(`/org/snapshot${since ? `?since=${encodeURIComponent(since)}` : ''}`);
}

/** Организация, в которой человек состоит (та же строка, что видит бот). */
export interface MyOrg {
  id: string;
  name: string;
  role: Role;
  is_current: number;
  join_code: string | null;
  owner_user_id: string | null;
  industry_pack: string | null;
  timezone: string;
  work_days: string;
  work_start: string;
  work_end: string;
  lunch_start: string | null;
  lunch_end: string | null;
  always_on: number;
  digest_enabled: number;
  digest_time: string | null;
}
export type OrgSettingsPatch = Partial<Pick<MyOrg, 'work_days' | 'work_start' | 'work_end' | 'lunch_start' | 'lunch_end' | 'always_on' | 'digest_enabled' | 'digest_time'>>;
export const updateOrgSettings = (orgId: string, patchBody: OrgSettingsPatch) =>
  request<{ ok: true }>(`/orgs/${orgId}`, { method: 'PATCH', body: JSON.stringify(patchBody) });
export const updateMe = (patchBody: { notify_mode?: 'all' | 'schedule'; remind_before_min?: number }) =>
  request<{ ok: true }>('/me', { method: 'PATCH', body: JSON.stringify(patchBody) });

/**
 * Список организаций живёт в модуле между открытиями шторки.
 *
 * Шторка профиля открывалась ПУСТОЙ и дорисовывалась после ответа сервера --
 * четверть секунды пустого места на месте списка читается как подтормаживание,
 * хотя запрос ровно один. Кэш отдаёт прошлый ответ сразу, а свежий приезжает
 * следом и молча заменяет его. Список меняется раз в месяц, поэтому устаревшие
 * полсекунды здесь дешевле, чем пустой экран каждое открытие.
 */
let orgsCache: MyOrg[] | null = null;

/** Что показать немедленно: прошлый ответ или ничего, если его ещё не было. */
export const cachedMyOrgs = (): MyOrg[] | null => orgsCache;

export const getMyOrgs = async (): Promise<MyOrg[]> => {
  const orgs = await request<MyOrg[]>('/orgs/mine');
  orgsCache = orgs;
  return orgs;
};
/** Профиль отрасли: от него зависят отделы организации и словарь разбора. */
export interface OrgPack {
  id: string;
  title: string;
  emoji: string;
  category: string;
  departments: string[];
  positions: string[];
  examples: string[];
}

export interface PackCatalog {
  categories: { id: string; title: string; emoji: string }[];
  industries: OrgPack[];
}

export const getPacks = () => request<PackCatalog>('/packs');
export const getOrgPositions = () => request<string[]>('/org/positions');

export const createOrg = (name: string, pack: string) =>
  request<{ id: string; name: string; join_code: string }>('/orgs', { method: 'POST', body: JSON.stringify({ name, pack }) });
export const joinOrgByCode = (code: string) =>
  request<{ ok: true; org_name: string }>('/orgs/join', { method: 'POST', body: JSON.stringify({ code }) });
export const switchOrg = (orgId: string) => request<{ ok: true }>(`/orgs/${orgId}/switch`, { method: 'POST' });
export const renameOrg = (orgId: string, name: string) =>
  request<{ ok: true }>(`/orgs/${orgId}`, { method: 'PATCH', body: JSON.stringify({ name }) });
export const deleteOrg = (orgId: string) => request<{ ok: true; org_id: string | null }>(`/orgs/${orgId}`, { method: 'DELETE' });
export const leaveOrg = (orgId: string) => request<{ ok: true }>(`/orgs/${orgId}/leave`, { method: 'POST' });
export const setMyName = (name: string) =>
  request<{ ok: true; name: string }>('/me', { method: 'PATCH', body: JSON.stringify({ name }) });

/**
 * Черновик: как фраза понята. Задачи ещё нет -- она появится только после
 * «Создать». Тот же черновик виден в «Черновиках» бота.
 */
export interface DraftView {
  id: string;
  title: string;
  description: string;
  deadline: string | null;
  priority: Priority;
  /** Важность названа человеком, а не поставлена по умолчанию. */
  priority_explicit: boolean;
  /** Через сколько МИНУТ задача возвращается. null -- разовая. */
  repeat_min: number | null;
  /** Задача, без которой эту нельзя начинать. */
  depends_on_task_id: string | null;
  kind: 'single' | 'each' | 'any' | 'ack';
  assignee_ids: string[];
  assignees: string[];
  heard: string;
  media_count: number;
  created_at: string;
}

/** Фраза -- в черновик: текстом или голосом. Тот же разбор, что у бота. */
export function dictateTask(
  input: ({ text: string } | { audio: Blob }) & { assignee_id?: string; mode?: 'mine' | 'assigned'; priority?: Priority },
): Promise<DraftView> {
  if ('audio' in input) {
    const form = new FormData();
    form.append('audio', input.audio, 'voice.webm');
    if (input.assignee_id) form.append('assignee_id', input.assignee_id);
    if (input.mode) form.append('mode', input.mode);
    if (input.priority) form.append('priority', input.priority);
    // Заголовок Content-Type НЕ ставим: границу multipart проставляет сам
    // браузер, и ручной заголовок её затрёт.
    return request<DraftView>('/tasks/dictate', { method: 'POST', body: form, headers: {} });
  }
  return request<DraftView>('/tasks/dictate', { method: 'POST', body: JSON.stringify(input) });
}

export const getDrafts = () => request<{ drafts: DraftView[] }>('/drafts').then((r) => r.drafts);
/** Срок принимается и как «2026-09-11»: час дописывает сервер в поясе организации. */
export const patchDraft = (
  id: string,
  patch: { title?: string; assignee_ids?: string[]; deadline?: string | null; priority?: Priority },
) => request<DraftView>(`/drafts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
// Правки едут ВМЕСТЕ с подтверждением: карточка правится на устройстве, и
// сеть трогается ровно один раз -- на «Создать».
export const confirmDraft = (id: string, edits?: DraftEdits) =>
  request<{ id: string }>(`/drafts/${id}/confirm`, { method: 'POST', body: JSON.stringify(edits ?? {}) });

export type DraftEdits = Partial<{
  title: string;
  description: string | null;
  assignee_ids: string[];
  deadline: string | null;
  priority: Priority;
  /** Через сколько МИНУТ задача возвращается. null или 0 снимает повтор. */
  repeat_min: number | null;
  /** Предшественник: только незакрытая задача. null снимает связь. */
  depends_on_task_id: string | null;
}>;
export const deleteDraft = (id: string) => request<{ ok: true }>(`/drafts/${id}`, { method: 'DELETE' });

/** Срок и срочность в два касания -- то же, что кнопки под подтверждением бота.
 *  Срок принимается и как «2026-09-11»: час дописывает сервер в поясе организации. */
export const quickEditTask = (taskId: string, patch: { deadline?: string | null; priority?: Priority }) =>
  request<{ ok: true }>(`/tasks/${taskId}/quick`, { method: 'PATCH', body: JSON.stringify(patch) });

/** «Вопрос»: диалог с помощником; история -- последние реплики, чтобы уточнения работали. */
export interface AskTurn { role: 'user' | 'assistant'; text: string }
/** Вопрос голосом: запись уходит на расшифровку, обратно -- и текст, и ответ. */
export const askByVoice = (audio: Blob) => {
  const form = new FormData();
  form.append('audio', audio, 'question.webm');
  return request<{ question: string; answer: string }>('/ask/dictate', { method: 'POST', body: form, headers: {} });
};

/**
 * Поправка словами к черновику: «не Азизу, а Беку», «срок вторник», «это
 * срочно». Возвращает РАЗНИЦУ, а не новый черновик: карточка правится на
 * устройстве, и записывать до «Создать» нечего.
 */
export type DraftPatchView = {
  heard: string;
  patch: Partial<{ title: string; description: string | null; assignee_ids: string[]; deadline: string | null; priority: Priority }>;
};

export function refineDraftByPhrase(
  id: string,
  input: { text: string } | { audio: Blob },
  current: { title: string; description: string; assignee_ids: string[]; deadline: string | null; priority: Priority },
): Promise<DraftPatchView> {
  if ('audio' in input) {
    const form = new FormData();
    form.append('audio', input.audio, 'fix.webm');
    form.append('current', JSON.stringify(current));
    return request<DraftPatchView>(`/drafts/${id}/refine`, { method: 'POST', body: form, headers: {} });
  }
  return request<DraftPatchView>(`/drafts/${id}/refine`, { method: 'POST', body: JSON.stringify({ text: input.text, current }) });
}

/** Вложение к черновику -- до того, как поручение создано. */
export const uploadDraftFile = (draftId: string, file: File) => {
  const form = new FormData();
  form.append('file', file);
  return request<DraftView>(`/drafts/${draftId}/attachments`, { method: 'POST', body: form, headers: {} });
};

export const askAssistant = (question: string, history: AskTurn[]) =>
  request<{ answer: string }>('/ask', { method: 'POST', body: JSON.stringify({ question, history: history.slice(-6) }) });
