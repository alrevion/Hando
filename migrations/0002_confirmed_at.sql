-- Fast "already confirmed" check without scanning events. events remains the
-- system of record for the audit trail; this is a denormalized render/guard field.
ALTER TABLE tasks ADD COLUMN confirmed_at TEXT;
