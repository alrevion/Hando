-- Шаг 3, EXPAND: адресаты и виды поручений (ломающая миграция №4).
--
-- Аддитивная: новая таблица + nullable-колонки. Contract (удаление
-- responsible_user_id пересборкой tasks) идёт ОТДЕЛЬНЫМ релизом -- он необратим.

-- Строка адресата. Одна задача -- много адресатов, у каждого СВОЁ состояние и
-- СВОИ таймеры.
--
-- Таймеры переехали сюда обязательно, а не «заодно»: сегодня это по-задачные
-- флаги (scheduled.ts), и при 14 адресатах первая же отправка гасит флаг --
-- остальные 13 не получат ничего никогда. Критерий «14 независимых состояний»
-- строками без таймеров не выполняется.
--
-- Автомат состояний (ADR-3):
--   pending --accept--> accepted --done--> done --confirm--> confirmed
--                                              \--reject--> accepted (новый срок)
--   pending/accepted --decline--> declined   («не возьмусь» / «взялся и не смог»)
-- Переход accepted -> declined разрешён намеренно: запрет оставлял бы человеку
-- только rejected, который требует done, то есть вынуждал бы врать про выполнение.
CREATE TABLE task_assignees (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  org_id TEXT REFERENCES orgs(id),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','accepted','done','confirmed','rejected','declined')),
  accepted_at TEXT,
  acknowledged_at TEXT,
  done_at TEXT,
  -- Персональный срок: у рассылки на 14 человек сроки могут отличаться.
  due_at TEXT,
  -- Три таймера на КАЖДОГО адресата -- см. комментарий выше.
  last_escalated_at TEXT,
  reminder_sent_at TEXT,
  review_reminded_at TEXT,
  declined_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_task_assignees_unique ON task_assignees(task_id, user_id);
CREATE INDEX idx_task_assignees_user ON task_assignees(user_id, state);
-- Индекс под проходы cron: они ищут незакрытые строки с наступившим сроком.
CREATE INDEX idx_task_assignees_due ON task_assignees(state, due_at);

-- kind -- вид поручения:
--   single  один адресат (сегодняшнее поведение и поручение себе);
--   each    каждый делает своё (рассылка: 14 независимых состояний);
--   any     достаточно одного (кто первый взял, тот и делает).
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'single' CHECK (kind IN ('single','each','any'));

-- author_id -- ПРЕДИКАТ АВТОРИЗАЦИИ, а не поле отчётности: после R1-1 поручения
-- идут в любую сторону, и гейт confirm/reject переезжает с роли на авторство.
-- Иначе сотрудник, поручивший что-то директору, не смог бы принять работу.
ALTER TABLE tasks ADD COLUMN author_id TEXT REFERENCES users(id);
ALTER TABLE tasks ADD COLUMN closed_by_author_at TEXT;
-- Личный слой (шаг 4c): напоминание себе без адресата-исполнителя.
ALTER TABLE tasks ADD COLUMN remind_at TEXT;
-- Откуда пришла задача: ui | bot | voice | forward | mcp. Нужен для метрик пилота.
ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'ui';
-- Ссылка на исходное голосовое во вложениях -- «покажи, что я тогда сказал».
ALTER TABLE tasks ADD COLUMN origin_audio_id TEXT REFERENCES attachments(id);
ALTER TABLE tasks ADD COLUMN declined_reason TEXT;
-- Свободная ссылка на сущность пакета отрасли (класс, кабинет, столик).
ALTER TABLE tasks ADD COLUMN entity_ref TEXT;

-- ---------------------------------------------------------------- бэкфилл
-- Идемпотентно по WHERE NOT EXISTS / IS NULL (правило ADR-1).

-- Каждая существующая задача получает ровно одного адресата -- нынешнего
-- ответственного. Состояние выводится из статуса задачи: иначе все 
-- незакрытые задачи выглядели бы непринятыми и посыпались бы напоминания.
INSERT INTO task_assignees (id, task_id, user_id, org_id, state, accepted_at, done_at, due_at,
                            last_escalated_at, reminder_sent_at, review_reminded_at)
SELECT 'a-' || t.id, t.id, t.responsible_user_id, t.org_id,
  CASE
    WHEN t.confirmed_at IS NOT NULL THEN 'confirmed'
    WHEN t.status = 'done' THEN 'done'
    WHEN t.status = 'in_progress' THEN 'accepted'
    WHEN t.status = 'archived' AND t.done_at IS NOT NULL THEN 'done'
    ELSE 'pending'
  END,
  CASE WHEN t.status IN ('in_progress','done') THEN t.updated_at ELSE NULL END,
  t.done_at, t.deadline, t.last_escalated_at, t.reminder_sent_at, t.review_reminded_at
FROM tasks t
WHERE NOT EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = t.responsible_user_id);

-- Автор: тот, кто создал задачу по журналу. Где события нет (задачи старше
-- журнала) -- автором назначается нынешний ответственный: это делает задачу
-- подтверждаемой, а NULL означал бы задачу, которую никто не может принять.
UPDATE tasks SET author_id = COALESCE(
  (SELECT e.actor_id FROM events e
    WHERE e.target_type = 'task' AND e.target_id = tasks.id AND e.action = 'created' AND e.actor_id IS NOT NULL
    LIMIT 1),
  responsible_user_id
) WHERE author_id IS NULL;
