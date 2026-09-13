-- Повтор измеряется МИНУТАМИ, а не днями.
--
-- Днями нельзя выразить «каждые два часа» и «каждые полчаса», а владелец
-- попросил интервал вплоть до минуты. Минута -- наименьшая единица, в которой
-- выражается и «через день» (2880), и «каждые 90 минут»; обратно в слова это
-- переводит repeatLabel.
--
-- Старая колонка repeat_days остаётся в схеме мёртвой: SQLite не умеет
-- удалять колонки без пересборки таблицы, а пересборка tasks ради одной
-- неиспользуемой колонки дороже, чем строка комментария здесь.
ALTER TABLE tasks ADD COLUMN repeat_min INTEGER;
ALTER TABLE drafts ADD COLUMN repeat_min INTEGER;
UPDATE tasks SET repeat_min = repeat_days * 1440 WHERE repeat_days IS NOT NULL;
UPDATE drafts SET repeat_min = repeat_days * 1440 WHERE repeat_days IS NOT NULL;
