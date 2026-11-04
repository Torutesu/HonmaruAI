CREATE TABLE IF NOT EXISTS mcp_scheduled_authority (
  scheduled_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  membership_since TEXT NOT NULL,
  token_id TEXT,
  grant_id TEXT,
  CHECK ((token_id IS NULL) != (grant_id IS NULL))
);

CREATE TABLE IF NOT EXISTS mcp_conversation_requests (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  membership_since TEXT NOT NULL,
  channel TEXT,
  creation_nonce TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id, connection_id, request_id)
);
