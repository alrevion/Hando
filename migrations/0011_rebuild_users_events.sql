-- Шаг 2b: пересборки users и events (ломающие миграции №2 и №3).
--
-- НЕОБРАТИМО: старые таблицы удаляются. Поэтому релиз идёт один, после зелёного
-- 2a, и проверяется PRAGMA foreign_key_check плюс сверкой COUNT(*) до и после.
--
-- Порядок важен: PRAGMA foreign_keys в D1 включён, поэтому пересборка идёт через
-- PRAGMA legacy_alter_table + переименование, а не через DROP исходной таблицы
-- при живых ссылках. D1 выполняет файл в одной транзакции.

-- ============================================================ users
-- Что меняется:
--   phone -> nullable. Сотрудник подключается по invite_token через Telegram, и
--     телефон у него может не спрашиваться вовсе; NOT NULL делал это невозможным.
--     UNIQUE остаётся ГЛОБАЛЬНЫМ: человек теперь один, организаций у него много.
--   role -> УДАЛЯЕТСЯ. Единственный авторитет с шага 2a -- org_memberships.role.
--   telegram_username -> ОСТАЁТСЯ здесь: это атрибут идентичности, как и телефон,
--     один на человека независимо от организации.
--   current_org_id -> переносится как есть (создан в 2a).
CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  phone TEXT UNIQUE,
  name TEXT NOT NULL,
  telegram_username TEXT,
  current_org_id TEXT REFERENCES orgs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO users_new (id, phone, name, telegram_username, current_org_id, created_at)
SELECT id, phone, name, telegram_username, current_org_id, created_at FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- ============================================================ events
-- CHECK (target_type IN (...)) не допускает новых типов, а в SQLite это
-- пересборка, а не ALTER -- на append-only журнале аудита.
-- Добавлены 'assignee' (строка адресата, шаг 3) и 'org' (события организации:
-- отзыв членства сейчас пишется как 'membership', но у самой организации тоже
-- есть жизненный цикл).
-- Колонка называется action, а не type: критерий спеки events.type='miss'
-- операционализуется как action='miss'.
CREATE TABLE events_new (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id),
  org_id TEXT REFERENCES orgs(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('task', 'project', 'membership', 'user', 'assignee', 'org')),
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  comment TEXT,
  overdue_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO events_new (id, actor_id, org_id, target_type, target_id, action, comment, overdue_by, created_at)
SELECT id, actor_id, org_id, target_type, target_id, action, comment, overdue_by, created_at FROM events;

DROP TABLE events;
ALTER TABLE events_new RENAME TO events;

CREATE INDEX idx_events_target ON events(target_type, target_id);
CREATE INDEX idx_events_org ON events(org_id, created_at);

-- ============================================================ роль member
-- Четвёртая роль (ADR-5, отклонение от spec:85 -- решение принято 2026-09-04).
-- Обоснование: без неё учитель обязан быть admin, а admin ведёт задачи и видит
-- справочник людей своих досок. Окно пересборки здесь бесплатное -- добавить
-- значение в CHECK позже стоило бы ещё одной необратимой миграции.
-- Права в ядре (creator/super_admin/admin/member), должности -- в пакете отрасли
-- (org_memberships.position); ни одна ветка кода не ветвится по position.
CREATE TABLE org_memberships_new (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('creator','super_admin','admin','member')),
  position TEXT,
  left_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO org_memberships_new (id, org_id, user_id, role, position, left_at, created_at)
SELECT id, org_id, user_id, role, position, left_at, created_at FROM org_memberships;

DROP TABLE org_memberships;
ALTER TABLE org_memberships_new RENAME TO org_memberships;

CREATE UNIQUE INDEX idx_org_memberships_unique ON org_memberships(org_id, user_id);
CREATE INDEX idx_org_memberships_user ON org_memberships(user_id, left_at);
