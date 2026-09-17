-- Номера телефонов Hando не хранит: их пришлось бы держать на серверах в
-- РУз. Личность человека -- его Telegram-аккаунт; вход -- подписью
-- мини-приложения или кнопкой в боте (0033). На момент миграции номер не
-- заполнен ни у кого.
--
-- DROP COLUMN в SQLite не снимает колонку с UNIQUE -- значит пересборка.
--
-- ПОРЯДОК ВАЖЕН. Внешние ключи в D1 включены, и DROP TABLE users засчитывает
-- каждую ссылку на неё как нарушение. Способ 0011 (новая таблица ДО удаления,
-- потом RENAME) на живых данных падает: строки, вставленные в users_new до
-- удаления, счётчик нарушений не гасят. Поэтому: копия без ограничений ->
-- удаление -> таблица сразу под именем users -> вставка. Вставка строк
-- родителя и гасит отложенные нарушения. Каскадов на users нет -- удаление
-- ничего в дочерних таблицах не стирает.
PRAGMA defer_foreign_keys = true;

CREATE TABLE users_keep AS SELECT id, name, telegram_username, current_org_id, created_at, telegram_user_id, invite_token,
  connected_at, aliases, bot_state, menu_message_id, onboarded_at, notify_mode, remind_before_min FROM users;

DROP TABLE users;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  telegram_username TEXT,
  current_org_id TEXT REFERENCES orgs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  telegram_user_id TEXT,
  invite_token TEXT,
  connected_at TEXT,
  aliases TEXT,
  bot_state TEXT,
  menu_message_id TEXT,
  onboarded_at TEXT,
  notify_mode TEXT NOT NULL DEFAULT 'all' CHECK (notify_mode IN ('all','schedule')),
  remind_before_min INTEGER NOT NULL DEFAULT 30
);

INSERT INTO users SELECT * FROM users_keep;
DROP TABLE users_keep;

CREATE UNIQUE INDEX idx_users_telegram ON users(telegram_user_id);
CREATE UNIQUE INDEX idx_users_invite ON users(invite_token);
CREATE INDEX idx_users_pending_signup ON users(telegram_user_id) WHERE current_org_id IS NULL;
