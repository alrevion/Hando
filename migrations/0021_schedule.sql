-- График работы организации, сводка, настройки уведомлений человека и
-- журнал напоминаний (шаг 3 концепции, раздел 21).
ALTER TABLE orgs ADD COLUMN work_days TEXT NOT NULL DEFAULT '1,2,3,4,5';
ALTER TABLE orgs ADD COLUMN work_start TEXT NOT NULL DEFAULT '09:00';
ALTER TABLE orgs ADD COLUMN work_end TEXT NOT NULL DEFAULT '18:00';
ALTER TABLE orgs ADD COLUMN lunch_start TEXT DEFAULT '13:00';
ALTER TABLE orgs ADD COLUMN lunch_end TEXT DEFAULT '14:00';
-- 24/7: семья и личные дела. Графика нет, «до завтра» -- до 23:59.
ALTER TABLE orgs ADD COLUMN always_on INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orgs ADD COLUMN digest_enabled INTEGER NOT NULL DEFAULT 1;
-- NULL = в начало рабочего дня.
ALTER TABLE orgs ADD COLUMN digest_time TEXT;

-- Режим уведомлений человека: сразу из всех организаций или по графику каждой.
ALTER TABLE users ADD COLUMN notify_mode TEXT NOT NULL DEFAULT 'all' CHECK (notify_mode IN ('all','schedule'));
-- «За N минут до срока» -- настройка человека, не организации.
ALTER TABLE users ADD COLUMN remind_before_min INTEGER NOT NULL DEFAULT 30;

-- Сводка уходит раз в день на человека в организации.
ALTER TABLE org_memberships ADD COLUMN digest_sent_on TEXT;

-- Журнал напоминаний по СТРОКЕ адресата (task_assignees.id), не по человеку:
-- у одного человека много задач, и одна строка на всех означала бы, что
-- повторяется только первая. Разовые виды -- INSERT OR IGNORE, повторяющиеся
-- -- INSERT OR REPLACE с новым sent_at; интервал считает cron.
CREATE TABLE reminders (
  assignee_row_id TEXT NOT NULL REFERENCES task_assignees(id),
  kind TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (assignee_row_id, kind)
);
