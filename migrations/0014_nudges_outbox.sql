-- Шаг 4c: поводы личного слоя едут ТЕМ ЖЕ outbox, что и уведомления о задачах.
--
-- Для этого notifications.task_id обязан стать nullable: повод вида «сводка дня»
-- к конкретной задаче не привязан. Альтернатива -- второй путь отправки для
-- поводов -- означала бы, что тихие часы (единственная точка отправки) его не
-- накрывают, и «тихо» перестало бы быть свойством системы.
--
-- Пересборка, а не ALTER: SQLite не умеет снимать NOT NULL. Таблица -- очередь,
-- она мала и по природе эфемерна, поэтому пересборка здесь дёшева и безопасна.
CREATE TABLE notifications_new (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  assignee_id TEXT REFERENCES users(id),
  org_id TEXT REFERENCES orgs(id),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  scheduled_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);

INSERT INTO notifications_new (id, task_id, assignee_id, org_id, kind, payload, scheduled_at, sent_at, attempts)
SELECT id, task_id, assignee_id, org_id, kind, payload, scheduled_at, sent_at, attempts FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;
CREATE INDEX idx_notifications_pending ON notifications(sent_at, scheduled_at);
