-- Task dependency chain ("can't start B until A is done"), the T-1-day
-- deadline-approaching reminder, and the 2-day stale-review-nudge escalation.
ALTER TABLE tasks ADD COLUMN depends_on_task_id TEXT REFERENCES tasks(id);
ALTER TABLE tasks ADD COLUMN reminder_sent_at TEXT;
ALTER TABLE tasks ADD COLUMN review_reminded_at TEXT;
