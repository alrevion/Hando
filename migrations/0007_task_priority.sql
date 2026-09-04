-- Task priority for the board's priority filter chips.
ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('urgent', 'medium', 'low'));
