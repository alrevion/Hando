-- Счётчик промахов разбора: чем именно разобрана фраза.
--
-- Не журнал, а счётчик: сама фраза нигде не хранится, строк ровно по числу
-- «организация × день × слой». Вопрос, на который таблица отвечает, один:
-- «как часто правил не хватает». Доля llm + fallback и решает, нужен ли нам
-- векторный слой поверх правил, или он окупится на единицах случаев.
--
--   SELECT source, SUM(n) FROM parse_stats GROUP BY source;
CREATE TABLE parse_stats (
  org_id TEXT NOT NULL,
  -- День в UTC. Час не нужен: решение принимается по неделям, а не по минутам.
  day TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('pattern','llm','fallback')),
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, day, source)
);
