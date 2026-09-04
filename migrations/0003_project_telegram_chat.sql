-- Telegram group is per-project (different projects post to different groups),
-- not a single global chat. Stored as the full chat_id (with the -100 supergroup
-- prefix already applied at the API layer) so telegram.ts never has to think
-- about the prefix.
ALTER TABLE projects ADD COLUMN telegram_chat_id TEXT;
