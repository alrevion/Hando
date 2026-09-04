-- Task attachments. Files live in a single dedicated Telegram storage group
-- (bot-only, TELEGRAM_STORAGE_CHAT_ID) -- never a project's human-visible group.
-- telegram_message_id is kept so removing an attachment can also delete the
-- underlying Telegram message, keeping the storage chat from growing unbounded.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  telegram_file_id TEXT NOT NULL,
  telegram_message_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_attachments_task ON attachments(task_id);
