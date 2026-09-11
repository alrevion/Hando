-- Иерархия по приглашениям (раздел 19): кто кого пригласил, личная ссылка
-- приглашающего, заморозка.
ALTER TABLE org_memberships ADD COLUMN invited_by TEXT REFERENCES users(id);
ALTER TABLE org_memberships ADD COLUMN invite_code TEXT;
ALTER TABLE org_memberships ADD COLUMN frozen_at TEXT;
CREATE INDEX idx_org_memberships_invite ON org_memberships(invite_code);
