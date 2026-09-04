-- Lets task notifications @mention the responsible person (a plain name in
-- the message text doesn't ping anyone in Telegram) instead of just naming them.
ALTER TABLE users ADD COLUMN telegram_username TEXT;
