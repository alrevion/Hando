-- Шаг 2a: организации, АДДИТИВНАЯ часть (ломающая миграция №1).
--
-- Аддитивная -- значит откатывается редеплоем предыдущей версии Worker'а:
-- добавленные колонки nullable, добавленные таблицы никто не читает. Пересборки
-- таблиц (users, events) идут отдельным релизом 2b именно поэтому: они
-- необратимы физически, и в одном релизе лишили бы откатываемости и эту часть.

-- Организация. timezone -- не косметика: cron Workers идёт в UTC, Ташкент UTC+5,
-- и без пояса «тихие часы 20:00-08:00» дали бы молчание с 01:00 до 13:00 по месту
-- и сообщения в 03:00.
CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Пакет отрасли: должности и словарь берутся оттуда, права -- нет (R1-3).
  industry_pack TEXT NOT NULL DEFAULT 'generic',
  calendar TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Tashkent',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Идентичность отделена от членства (ADR-5, пересмотрен по R1-2).
-- users -- глобальные: владелец трёх бизнесов и семейной группы остаётся ОДНИМ
-- человеком, иначе личный слой ломается у того, кто платит.
-- role здесь -- ЕДИНСТВЕННЫЙ авторитет с момента 2a; users.role становится
-- мёртвой колонкой до выноса в 2b (там NOT NULL CHECK, поэтому писать в неё всё
-- ещё обязаны).
-- position -- должность из пакета отрасли; ни одна ветка кода по ней не ветвится.
-- left_at -- мягкий отзыв: жёсткое удаление членства оставило бы события и задачи
-- со ссылкой на человека, которого «никогда не было».
CREATE TABLE org_memberships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('creator','super_admin','admin')),
  position TEXT,
  left_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Одно членство на пару: повторное добавление обязано быть 409, а не вторым рядом.
CREATE UNIQUE INDEX idx_org_memberships_unique ON org_memberships(org_id, user_id);
CREATE INDEX idx_org_memberships_user ON org_memberships(user_id, left_at);

-- Липкий контекст: в какой организации человек сейчас. Нужен ЗДЕСЬ, а не в 2b --
-- на него опираются выдача сессии и резолв токена без claim org_id.
ALTER TABLE users ADD COLUMN current_org_id TEXT REFERENCES orgs(id);

-- org_id на шесть тенантных таблиц. Nullable по ADR-1: ужесточение до NOT NULL --
-- отдельный contract-релиз, иначе миграция и код обязаны выкатиться атомарно.
-- users в этом списке НЕТ: организация человека живёт в членстве, не в колонке.
ALTER TABLE projects ADD COLUMN org_id TEXT REFERENCES orgs(id);
ALTER TABLE project_memberships ADD COLUMN org_id TEXT REFERENCES orgs(id);
ALTER TABLE tasks ADD COLUMN org_id TEXT REFERENCES orgs(id);
ALTER TABLE events ADD COLUMN org_id TEXT REFERENCES orgs(id);
ALTER TABLE attachments ADD COLUMN org_id TEXT REFERENCES orgs(id);
-- notifications.org_id уже создана в 0009 (nullable, специально «с полями будущих
-- шагов, чтобы не пересобирать дважды») -- здесь она только бэкфиллится. Внешнего
-- ключа на orgs у неё нет: добавить его к существующей колонке в SQLite можно
-- только пересборкой таблицы, а это 2b.

-- ---------------------------------------------------------------- бэкфилл
-- Пилотная организация. Идентификатор фиксированный, а не сгенерированный:
-- миграция -- это SQL-файл, uuid() тут неоткуда взять, а стабильный id нужен
-- запирающей проверке MCP (MCP_ORG_ID в wrangler.jsonc).
INSERT INTO orgs (id, name, industry_pack) VALUES ('org-pilot', 'Пилотная организация', 'school');

-- Каждый существующий человек получает членство со своей нынешней ролью.
-- Идемпотентно по WHERE NOT EXISTS -- аналог правила ADR-1 для новой таблицы:
-- повторный прогон миграции не создаёт второго членства.
INSERT INTO org_memberships (id, org_id, user_id, role)
SELECT 'm-' || u.id, 'org-pilot', u.id, u.role FROM users u
WHERE NOT EXISTS (SELECT 1 FROM org_memberships m WHERE m.org_id = 'org-pilot' AND m.user_id = u.id);

UPDATE users SET current_org_id = 'org-pilot' WHERE current_org_id IS NULL;

UPDATE projects            SET org_id = 'org-pilot' WHERE org_id IS NULL;
UPDATE project_memberships SET org_id = 'org-pilot' WHERE org_id IS NULL;
UPDATE tasks               SET org_id = 'org-pilot' WHERE org_id IS NULL;
UPDATE events              SET org_id = 'org-pilot' WHERE org_id IS NULL;
UPDATE attachments         SET org_id = 'org-pilot' WHERE org_id IS NULL;
UPDATE notifications       SET org_id = 'org-pilot' WHERE org_id IS NULL;
