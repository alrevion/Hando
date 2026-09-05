-- Шаг 3, CONTRACT: удаление tasks.responsible_user_id (ломающая миграция №5).
--
-- НЕОБРАТИМО и идёт ОДНО в релизе. Это второй необратимый релиз плана; первым
-- был 2b. DROP COLUMN здесь невозможен: SQLite отказывает, когда колонка
-- проиндексирована (idx_tasks_responsible) ИЛИ названа во внешнем ключе -- тут
-- выполнены оба условия. Значит пересборка, тянущая attachments.task_id,
-- самоссылку tasks.depends_on_task_id и три индекса.
--
-- Предусловие: у каждой задачи есть строка в task_assignees. Оно обеспечено
-- бэкфиллом 0012 и проверяется инвариантом №1 -- после этой миграции инварианты
-- 1-3 снимаются с CI (им больше не на что ссылаться), а №4 (author_id) остаётся
-- навсегда: это предикат авторизации, а не проверка бэкфилла.
CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES orgs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content_blocks TEXT,
  -- Кто делает -- в task_assignees. Здесь остался только АВТОР: после R1-1
  -- поручения идут в любую сторону, и «кто попросил» -- предикат авторизации.
  author_id TEXT REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'single' CHECK (kind IN ('single','each','any')),
  status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'done', 'archived')) DEFAULT 'todo',
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('urgent', 'medium', 'low')),
  deadline TEXT,
  done_at TEXT,
  confirmed_at TEXT,
  closed_by_author_at TEXT,
  remind_at TEXT,
  source TEXT NOT NULL DEFAULT 'ui',
  origin_audio_id TEXT REFERENCES attachments(id),
  declined_reason TEXT,
  entity_ref TEXT,
  telegram_message_id TEXT,
  depends_on_task_id TEXT REFERENCES tasks(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO tasks_new (id, org_id, project_id, title, description, content_blocks, author_id, kind,
                       status, priority, deadline, done_at, confirmed_at, closed_by_author_at,
                       remind_at, source, origin_audio_id, declined_reason, entity_ref,
                       telegram_message_id, depends_on_task_id, created_at, updated_at)
SELECT id, org_id, project_id, title, description, content_blocks, author_id, kind,
       status, priority, deadline, done_at, confirmed_at, closed_by_author_at,
       remind_at, source, origin_audio_id, declined_reason, entity_ref,
       telegram_message_id, depends_on_task_id, created_at, updated_at
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_status_deadline ON tasks(status, deadline);
-- idx_tasks_responsible НЕ пересоздаётся: колонки больше нет. Его роль
-- («задачи этого человека») теперь у idx_task_assignees_user.
CREATE INDEX idx_tasks_author ON tasks(author_id);
