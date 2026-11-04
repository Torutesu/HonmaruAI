CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL, disabled_at INTEGER
);
CREATE INDEX IF NOT EXISTS mcp_oauth_clients_owner ON mcp_oauth_clients(owner_id);
CREATE TABLE IF NOT EXISTS mcp_oauth_requests (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, resource TEXT NOT NULL,
  scopes TEXT NOT NULL, state TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
);
CREATE TABLE IF NOT EXISTS mcp_oauth_grants (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
  membership_since TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT NOT NULL, sso_backed INTEGER NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS mcp_oauth_grants_user ON mcp_oauth_grants(user_id, org_id);
CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  code_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
);
CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
  token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('access','refresh')),
  expires_at INTEGER NOT NULL, consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS mcp_oauth_tokens_grant ON mcp_oauth_tokens(grant_id);
