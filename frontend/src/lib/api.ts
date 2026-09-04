// Thin fetch wrapper for the Sayn API. Sessions are an HttpOnly cookie, so
// every call just needs `credentials: 'include'` -- no token handling here.
//
// ASSUMPTION (backend not visible while this was written -- reconcile against
// the real routes): endpoint paths/shapes below are inferred from the plan
// (.omc/plans/kanban-plan.md, "Implementation Steps" 2-8). See the shape
// notes on each function.

import type { ArchivedTaskEntry, Priority, Project, ProjectMember, Task, TaskEvent, TaskStatus, User } from '../types';

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
// POST /api/auth/login {phone} -> 200 {} on success, or a 404 with
// {error, code: 'PHONE_NOT_REGISTERED'} for a phone with no provisioned account.
export const authLogin = (phone: string) => post<void>('/auth/login', { phone });
// POST /api/auth/verify {phone, code} -> sets session cookie, returns {user}.
export const authVerify = (phone: string, code: string) =>
  post<{ user: User }>('/auth/verify', { phone, code });
// GET /api/me -> {user} when a valid session cookie is present, else 401.
export const getMe = () => get<{ user: User }>('/me');
export const authLogout = () => post<void>('/auth/logout');

// --- Projects ---
// GET /api/projects -> already filtered server-side by role/membership.
export const getProjects = () => get<Project[]>('/projects');
// telegramGroupId: raw digits as copied from an id bot -- the backend prepends
// the -100 supergroup prefix, so don't ask the user to remember it.
export const createProject = (name: string, telegramGroupId: string) =>
  post<{ id: string; name: string; telegram_chat_id: string }>('/projects', { name, telegram_group_id: telegramGroupId });
// A "delete" is really a soft archive (backend sets archived_at, never a hard
// delete) -- these two round out the loop: see it, bring it back.
export const deleteProject = (id: string) => del<void>(`/projects/${id}`);
export const getArchivedProjects = () => get<Project[]>('/projects/archived');
export const restoreProject = (id: string) => post<void>(`/projects/${id}/restore`);

// --- Users (for admin/super_admin management + responsible-person pickers) ---
export const getUsers = () => get<User[]>('/users');
export const createUser = (input: { phone: string; name: string; role: 'super_admin' | 'admin'; telegram_username?: string }) =>
  post<User>('/users', input);
// Any subset of these -- e.g. { telegram_username } alone, or all four at once
// from the edit-person modal. telegram_username: '' clears it. Promoting role
// to super_admin is creator-only; the backend re-enforces it.
export const updateUser = (
  userId: string,
  input: Partial<{ name: string; phone: string; telegram_username: string; role: 'admin' | 'super_admin' }>,
) => patch<void>(`/users/${userId}`, input);

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
export const moveTask = (taskId: string, status: TaskStatus) =>
  post<Task>(`/tasks/${taskId}/move`, { to: status });
export const confirmTask = (taskId: string) =>
  post<{ success: true; overdue_by: number | null }>(`/tasks/${taskId}/confirm`);
export const rejectTask = (taskId: string, comment: string, extraDays: number) =>
  post<Task>(`/tasks/${taskId}/reject`, { comment, extra_days: extraDays });
export const deleteTask = (taskId: string) => del<void>(`/tasks/${taskId}`);
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
