// Mirrors the backend's shared types (repo root src/types.ts). Duplicated here
// rather than imported across the Vite/Worker build boundary.

export type Role = 'creator' | 'super_admin' | 'admin';
export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'archived';
export type Priority = 'urgent' | 'medium' | 'low';

export interface User {
  id: string;
  phone: string;
  name: string;
  role: Role;
  // Bare Telegram @handle (no leading @) -- lets task notifications @mention
  // this person instead of just naming them. NULL if never set.
  telegram_username: string | null;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  archived_at: string | null;
  telegram_chat_id: string;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  content_blocks: string | null;
  responsible_user_id: string;
  status: TaskStatus;
  priority: Priority;
  deadline: string | null;
  done_at: string | null;
  confirmed_at: string | null;
  telegram_message_id: string | null;
  last_escalated_at: string | null;
  // Single predecessor task (same project) that must be done/archived before
  // this one can move to in_progress. NULL = no dependency.
  depends_on_task_id: string | null;
  reminder_sent_at: string | null;
  review_reminded_at: string | null;
  created_at: string;
  updated_at: string;
}

// GET /projects/:id/members annotates each row with whether it's an actual
// project_memberships row (removable) vs. only visible implicitly (the global
// creator, or this project's own creator without ever being formally added).
export interface ProjectMember extends User {
  is_member: boolean;
}

// The task canvas: an ordered sequence of text blocks, inline photos, and
// generic file attachments (any type, shown as a name+size row instead of a
// preview). Persisted as task.content_blocks (JSON).
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment_id: string }
  | { type: 'file'; attachment_id: string; filename: string; mime_type: string; size_bytes: number };

// content_blocks is NULL for tasks saved before this existed -- fall back to
// wrapping the plain-text description as a single block.
export function parseContentBlocks(task: Pick<Task, 'content_blocks' | 'description'>): ContentBlock[] {
  if (task.content_blocks) {
    try {
      const parsed = JSON.parse(task.content_blocks);
      if (Array.isArray(parsed)) return parsed as ContentBlock[];
    } catch {
      // malformed -- fall through to the description fallback
    }
  }
  return task.description ? [{ type: 'text', text: task.description }] : [];
}

export interface TaskEvent {
  id: string;
  actor_id: string | null;
  target_type: 'task' | 'project' | 'membership' | 'user';
  target_id: string;
  action: string;
  comment: string | null;
  overdue_by: number | null;
  created_at: string;
}

// Frontend-only shape for the archive views: a task plus the trail of events
// recorded against it (create/archive/restore/confirm/reject), each annotated
// with the acting user's display name (null actor = system/auto-archive).
export interface ArchivedTaskEntry {
  task: Task;
  events: Array<TaskEvent & { actor_name: string | null }>;
}
