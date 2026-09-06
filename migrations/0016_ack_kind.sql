-- Вид поручения 'ack' -- «ознакомиться», а не «выполнить» (решение владельца
-- 2026-09-06).
--
-- Приказ, расписание, объявление: делать нечего, нужно знать, что прочитали.
-- Сегодня такая рассылка либо висит вечно недоделанной, либо каждый жмёт
-- «Готово», что означает неправду -- он ничего не делал.
--
-- ПОЧЕМУ СЕЙЧАС: список допустимых видов -- это CHECK, а поменять его в SQLite
-- можно только пересборкой таблицы. База пуста, поэтому пересборка ничего не
-- стоит; с живыми задачами это был бы отдельный необратимый релиз. Тот же довод,
-- по которому роль member заводилась заранее в 2b.
--
-- Пересборка тянет три индекса и две ссылки на tasks: attachments.task_id,
-- task_assignees.task_id и самоссылку depends_on_task_id.
CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES orgs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content_blocks TEXT,
  author_id TEXT REFERENCES users(id),
  -- ack: «принял» И ЕСТЬ закрытие. Свёртка (assignees.rollup) считает
  -- 'accepted' закрытым состоянием только для этого вида.
  kind TEXT NOT NULL DEFAULT 'single' CHECK (kind IN ('single','each','any','ack')),
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

INSERT INTO tasks_new SELECT
  id, org_id, project_id, title, description, content_blocks, author_id, kind, status,
  priority, deadline, done_at, confirmed_at, closed_by_author_at, remind_at, source,
  origin_audio_id, declined_reason, entity_ref, telegram_message_id, depends_on_task_id,
  created_at, updated_at
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_status_deadline ON tasks(status, deadline);
CREATE INDEX idx_tasks_author ON tasks(author_id);
