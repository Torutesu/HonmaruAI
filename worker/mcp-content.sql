CREATE TABLE IF NOT EXISTS mcp_content_mutations (
  org_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, actor_id, connection_id, request_id)
);
CREATE TABLE IF NOT EXISTS mcp_file_uploads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation TEXT NOT NULL,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','uploading','uploaded','complete','failed')),
  file_id TEXT,
  expires_at INTEGER NOT NULL
);
