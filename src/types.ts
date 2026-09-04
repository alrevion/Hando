// member -- четвёртая роль (ADR-5, отклонение от spec:85, решение 2026-09-04).
// Рядовой сотрудник: ведёт свои задачи, но не заводит людей и не видит
// справочник организации. Без неё учитель обязан был бы стать admin.
// Права -- здесь, в ядре. Должность -- в org_memberships.position из пакета
// отрасли; ни одна ветка кода по position не ветвится.
export type Role = 'creator' | 'super_admin' | 'admin' | 'member';
export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'archived';
export type Priority = 'urgent' | 'medium' | 'low';

// Вложение вместе с project_id своей задачи: проект тут не колонка таблицы, а
// результат JOIN -- он нужен загрузчику доступа, который ключуется на проекте.
export type Attachment = {
  id: string;
  org_id: string;
  task_id: string;
  telegram_file_id: string;
  telegram_message_id: string;
  filename: string;
  mime_type: string;
  uploaded_by: string;
  project_id: string;
};

// Членство человека в организации. С шага 2a role ЗДЕСЬ -- единственный
// авторитет; users.role мёртв до выноса в 2b (там NOT NULL CHECK, поэтому
// писать в него всё ещё обязаны).
export interface OrgMembership {
  id: string;
  org_id: string;
  user_id: string;
  role: Role;
  // Должность из пакета отрасли. Права из неё НЕ выводятся: ни одна ветка кода
  // не ветвится по position (R1-3).
  position: string | null;
  // Мягкий отзыв. Жёсткое удаление оставило бы задачи и события со ссылкой на
  // человека, которого «никогда не было».
  left_at: string | null;
  created_at: string;
}

export interface User {
  id: string;
  // Nullable с шага 2b: сотрудник подключается по invite_token через Telegram, и
  // телефон у него может не спрашиваться вовсе. UNIQUE остался ГЛОБАЛЬНЫМ --
  // человек один, организаций у него несколько.
  phone: string | null;
  name: string;
  // Роли здесь БОЛЬШЕ НЕТ: она в org_memberships. Один человек бывает creator
  // семейной группы и member школы одновременно.
  // Липкий контекст: организация, в которой человек работает сейчас. NULL
  // возможен после отзыва последнего членства.
  current_org_id: string | null;
  // Bare Telegram @handle (no leading @), no login use -- lets notifications
  // @mention the person instead of just naming them. NULL if never set.
  telegram_username: string | null;
  created_at: string;
}

export interface Project {
  id: string;
  org_id: string;
  name: string;
  created_by: string;
  created_at: string;
  archived_at: string | null;
  // Full chat_id (-100... prefix already applied), one Telegram group per project.
  telegram_chat_id: string;
}

export interface Task {
  id: string;
  // Nullable в БД до contract-релиза (ADR-1), но в коде обязателен: строк без
  // организации после бэкфилла не появляется, а тип, допускающий null, заставил
  // бы каждое место писать бессмысленный fallback.
  org_id: string;
  project_id: string;
  title: string;
  description: string;
  // JSON array of {type:'text',text} / {type:'image',attachment_id} blocks --
  // the canvas editor's content. NULL for tasks created before this existed.
  content_blocks: string | null;
  responsible_user_id: string;
  status: TaskStatus;
  priority: Priority;
  deadline: string | null;
  done_at: string | null;
  confirmed_at: string | null;
  telegram_message_id: string | null;
  last_escalated_at: string | null;
  // Single predecessor task (same project) that must be 'done'/'archived'
  // before this one can move to in_progress. NULL = no dependency.
  depends_on_task_id: string | null;
  reminder_sent_at: string | null;
  review_reminded_at: string | null;
  created_at: string;
  updated_at: string;
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

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AUTH_API_URL: string;
  AUTH_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  // Single dedicated bot-only group used across ALL projects purely as a blob
  // store for task attachments -- never a project's human-visible chat.
  TELEGRAM_STORAGE_CHAT_ID: string;
  SESSION_SECRET: string;
  // Remote MCP server (src/mcp.ts): bearer token gating /mcp, and the Sayn user
  // id every MCP-originated action is attributed to.
  MCP_API_TOKEN: string;
  MCP_USER_ID: string;
  // Организация, на которую заперт /mcp. Решение шага 2a: полноценная
  // mcp_tokens(org_id, user_id, token_hash) появится, когда MCP реально
  // понадобится второму арендатору; сейчас им не пользуется никто.
  MCP_ORG_ID: string;
}

export interface SessionPayload {
  sub: string; // user id
  // Роль В ЭТОЙ организации, не глобальная: один и тот же человек бывает
  // creator семейной группы и admin школы.
  role: Role;
  // Организация, в контексте которой выдан токен. Опционален В ТИПЕ, но не в
  // работе: так выглядят токены, выпущенные ДО деплоя 2a, и они живут ещё 12
  // часов. requireAuth догружает им org_id из БД -- ветка снимается на
  // contract-релизе вместе с ужесточением колонок до NOT NULL.
  org_id?: string;
  exp: number;
}
