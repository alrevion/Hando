-- Ordered canvas content: a JSON array of {type:'text',text} / {type:'image',attachment_id}
-- blocks, replacing the separate description+attachments-list UI with a single
-- Notion-lite editor (text and inline photos only). NULL means "not migrated yet" --
-- readers fall back to a single text block built from `description`.
ALTER TABLE tasks ADD COLUMN content_blocks TEXT;
