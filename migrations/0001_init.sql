-- Sayn schema. tasks holds denormalized latest-state for board rendering;
-- events is the append-only system of record for who-did-what (audit trail).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('creator', 'super_admin', 'admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);

CREATE TABLE project_memberships (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, user_id)
);
CREATE INDEX idx_memberships_user ON project_memberships(user_id);
CREATE INDEX idx_memberships_project ON project_memberships(project_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  responsible_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'done', 'archived')) DEFAULT 'todo',
  deadline TEXT,
  done_at TEXT,
  telegram_message_id TEXT,
  last_escalated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_status_deadline ON tasks(status, deadline);
CREATE INDEX idx_tasks_responsible ON tasks(responsible_user_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('task', 'project', 'membership', 'user')),
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  comment TEXT,
  overdue_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_target ON events(target_type, target_id);
