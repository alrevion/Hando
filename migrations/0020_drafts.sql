-- Черновики поручений (шаг 1 концепции, Часть III).
--
-- Задача больше не создаётся с голоса сразу: сначала черновик, и создаёт его
-- только подтверждение -- разбор может ошибиться, и «самая главная кнопка» это
-- «Создать». Черновики не пропадают: их дополняют, правят и удаляют, пока не
-- подтвердят. Отдельная таблица, а не tasks.status = 'draft': статус задачи --
-- свёртка строк адресатов с единственным писателем, и «черновик» в неё не
-- вписывается ни по смыслу, ни по инварианту.
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL DEFAULT '',
  -- JSON-массив id адресатов: черновик правится по частям, и хранить его
  -- строками адресатов до создания задачи было бы преждевременно.
  assignee_ids TEXT NOT NULL DEFAULT '[]',
  deadline TEXT,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('urgent','medium','low')),
  -- Названа ли важность словами. Если нет -- карточка предлагает кнопки.
  priority_explicit INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'single' CHECK (kind IN ('single','each','any','ack')),
  -- Исходная фраза: и для правок, и чтобы человек видел, что именно услышано.
  heard TEXT NOT NULL DEFAULT '',
  -- JSON-массив вложений (file_id и описание): файлы, присланные к черновику.
  media TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'pattern',
  -- Карточка черновика в чате: редактируется на месте, а не шлётся заново.
  telegram_chat_id TEXT,
  telegram_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_drafts_author ON drafts(author_id, org_id, created_at);
