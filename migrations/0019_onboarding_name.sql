-- Знакомство: бот спрашивает, как к человеку обращаться.
--
-- Имя из Telegram (first_name) для обращения не годится: у половины людей там
-- латиница, никнейм или пусто. А имя видят коллеги в поручениях -- «Позвонить
-- yakov_w» читается плохо.
--
-- NULL = знакомство не пройдено, и /start спрашивает имя. Существующие люди
-- считаются знакомыми: их заводил директор руками и имя указывал сам.
ALTER TABLE users ADD COLUMN onboarded_at TEXT;
UPDATE users SET onboarded_at = created_at WHERE onboarded_at IS NULL AND name IS NOT NULL AND name <> '';
