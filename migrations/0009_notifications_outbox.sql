-- Outbox для уведомлений (шаг 1 плана).
--
-- Зачем таблица, а не прямая отправка: db.batch() атомарен, а вызов Telegram --
-- сетевой и вне транзакции. Отправка до записи даёт сообщение без состояния;
-- запись до отправки -- состояние без сообщения, а ретрай даёт дубль. Переход
-- кладёт строку сюда в ТОМ ЖЕ batch, отправка идёт отдельным проходом и
-- дедуплицируется по sent_at. Без этого «ровно один раз» недостижимо.
--
-- Схема сразу с полями будущих шагов, чтобы не пересобирать таблицу дважды:
--   assignee_id -- NULL до шага 3, где появляется пер-адресатный веер;
--   org_id      -- NULL, бэкфиллится на шаге 2a.
-- Без них таблица пересобиралась бы и на 2a, и на 3.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  assignee_id TEXT REFERENCES users(id),
  org_id TEXT,
  kind TEXT NOT NULL,
  -- JSON: chat_id, text, а также delete_message_id и track -- см. src/outbox.ts.
  payload TEXT NOT NULL,
  scheduled_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);

-- Единственный запрос прохода отправки: неотправленные, в порядке появления.
CREATE INDEX idx_notifications_pending ON notifications(sent_at, scheduled_at);
