-- Шаг 4a: подключение Telegram, онбординг; плюс хранилище поводов для шага 4c.

-- telegram_user_id -- атрибут ИДЕНТИЧНОСТИ, поэтому на users, а не в членстве:
-- один Telegram-аккаунт на три организации даёт ОДНО подключение и один список
-- «Моё» (R1-2). Организацию выбирает users.current_org_id (создан в 2a).
ALTER TABLE users ADD COLUMN telegram_user_id TEXT;
CREATE UNIQUE INDEX idx_users_telegram ON users(telegram_user_id);

-- Одноразовая ссылка ?start=inv_xxxx. Сотрудник подключается по ней, и телефон у
-- него можно не спрашивать вовсе -- ради этого phone стал nullable в 2b.
ALTER TABLE users ADD COLUMN invite_token TEXT;
CREATE UNIQUE INDEX idx_users_invite ON users(invite_token);
ALTER TABLE users ADD COLUMN connected_at TEXT;
-- Как человека называют вслух: «Азиз», «Азизбек», «завуч». JSON-массив.
-- Нужен разбору речи (4b) -- имя, разрешающееся в двух организациях сразу, идёт
-- в переспрос, а не в догадку.
ALTER TABLE users ADD COLUMN aliases TEXT;

-- Тихие часы -- настройка ОРГАНИЗАЦИИ, а не константа кода (шаг 4d). У семейной
-- группы и у ресторана представления о «тихо» разные, и у ресторана вечер -- это
-- рабочее время. Включены по умолчанию: молчать ночью -- безопасное поведение.
ALTER TABLE orgs ADD COLUMN quiet_hours INTEGER NOT NULL DEFAULT 1;

-- Поводы личного слоя (шаг 4c). Без хранилища три из пяти принятых метрик не
-- имеют знаменателя: «доля поводов с содержательной кнопкой» и «доля поводов без
-- нажатия» считаются по строкам, а не по отправленным сообщениям.
CREATE TABLE nudges (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  -- Повод: stale_task | unconfirmed | idle_project | digest
  kind TEXT NOT NULL,
  -- Была ли предложена содержательная кнопка (не «ок»): метрика ≥40%.
  actionable INTEGER NOT NULL DEFAULT 0,
  task_id TEXT REFERENCES tasks(id),
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Нажатие в течение суток: метрика «без нажатия ≤50%».
  acted_at TEXT
);
-- Потолок «2 повода в день» считается этим индексом.
CREATE INDEX idx_nudges_user_day ON nudges(user_id, sent_at);
