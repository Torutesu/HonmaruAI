CREATE TABLE IF NOT EXISTS mcp_scheduled_authority (
  scheduled_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  membership_since TEXT NOT NULL,
  token_id TEXT,
  grant_id TEXT,
  CHECK ((token_id IS NULL) != (grant_id IS NULL))
);
