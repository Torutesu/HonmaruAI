CREATE TABLE IF NOT EXISTS hx_workspace_files (
 org_id TEXT NOT NULL, id TEXT NOT NULL, scope TEXT NOT NULL, path TEXT NOT NULL,
 created_by TEXT NOT NULL, created_login TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 current_version INTEGER NOT NULL DEFAULT 0 CHECK(current_version>=0),
 PRIMARY KEY(org_id,id), UNIQUE(org_id,scope,path)
);
CREATE TABLE IF NOT EXISTS hx_workspace_file_versions (
 org_id TEXT NOT NULL, file_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
 operation_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('content','deleted')),
 object_key TEXT, content_hash TEXT, content_type TEXT, size INTEGER,
 created_by TEXT NOT NULL, created_login TEXT NOT NULL, created_at TEXT NOT NULL, restored_from INTEGER,
 PRIMARY KEY(org_id,file_id,version), UNIQUE(org_id,operation_id),
 FOREIGN KEY(org_id,file_id) REFERENCES hx_workspace_files(org_id,id) ON DELETE CASCADE,
 CHECK((kind='deleted' AND object_key IS NULL AND content_hash IS NULL AND content_type IS NULL AND size IS NULL AND restored_from IS NULL)
 OR (kind='content' AND object_key IS NOT NULL AND content_hash IS NOT NULL AND content_type IS NOT NULL AND size>=0)),
 CHECK(restored_from IS NULL OR (restored_from>0 AND restored_from<version))
);
CREATE TABLE IF NOT EXISTS hx_workspace_file_public_urls (
 org_id TEXT NOT NULL, file_id TEXT NOT NULL, version INTEGER NOT NULL,
 id TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
 created_by TEXT NOT NULL, created_login TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,file_id,version),
 FOREIGN KEY(org_id,file_id,version) REFERENCES hx_workspace_file_versions(org_id,file_id,version) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS hx_workspace_files_listing ON hx_workspace_files(org_id,path,id);
CREATE TABLE IF NOT EXISTS hx_workspace_file_purges (
 org_id TEXT NOT NULL, file_id TEXT NOT NULL, version INTEGER NOT NULL,
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT NOT NULL,
 PRIMARY KEY(org_id,file_id,version),
 FOREIGN KEY(org_id,file_id,version) REFERENCES hx_workspace_file_versions(org_id,file_id,version) ON DELETE CASCADE
);
CREATE TRIGGER IF NOT EXISTS hx_workspace_file_version_immutable BEFORE UPDATE ON hx_workspace_file_versions
 WHEN NOT (NEW.created_by='deleted-user' AND NEW.created_login='deleted-user'
 AND NOT EXISTS(SELECT 1 FROM users WHERE github_id=OLD.created_by)
 AND NEW.org_id IS OLD.org_id AND NEW.file_id IS OLD.file_id AND NEW.version IS OLD.version AND NEW.operation_id IS OLD.operation_id AND NEW.kind IS OLD.kind AND NEW.object_key IS OLD.object_key AND NEW.content_hash IS OLD.content_hash AND NEW.content_type IS OLD.content_type AND NEW.size IS OLD.size AND NEW.created_at IS OLD.created_at AND NEW.restored_from IS OLD.restored_from)
 BEGIN SELECT RAISE(ABORT,'File versions are immutable'); END;
CREATE TABLE IF NOT EXISTS hx_workspace_file_uploads (
 org_id TEXT NOT NULL, id TEXT NOT NULL, file_id TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE,
 created_by TEXT NOT NULL, expected_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('uploading','cleanup')),
 PRIMARY KEY(org_id,id)
);
CREATE INDEX IF NOT EXISTS hx_workspace_file_uploads_due ON hx_workspace_file_uploads(expires_at);
CREATE TABLE IF NOT EXISTS hx_file_account_erasures (
 user_id TEXT PRIMARY KEY, login TEXT, requested_at INTEGER NOT NULL, next_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hx_file_account_erasures_due ON hx_file_account_erasures(next_at);

CREATE TABLE IF NOT EXISTS hx_workspace_file_origins (org_id TEXT NOT NULL, file_id TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('human','agent')), PRIMARY KEY(org_id,file_id), FOREIGN KEY(org_id,file_id) REFERENCES hx_workspace_files(org_id,id) ON DELETE CASCADE);

CREATE TABLE IF NOT EXISTS hx_file_share_requests (
 org_id TEXT NOT NULL,id TEXT NOT NULL,file_id TEXT NOT NULL,file_scope TEXT NOT NULL,file_version INTEGER NOT NULL,content_hash TEXT NOT NULL,content_type TEXT NOT NULL,size INTEGER NOT NULL,requester_id TEXT NOT NULL,requester_login TEXT NOT NULL,request_key TEXT NOT NULL,expires_at TEXT NOT NULL,allow_download INTEGER NOT NULL DEFAULT 0 CHECK(allow_download IN (0,1)),requester_membership TEXT,source_agent_id TEXT,source_message_id TEXT,source_scope TEXT,source_turn_hash TEXT,source_session_created_at TEXT,status TEXT NOT NULL CHECK(status IN ('pending','approved','declined','stale','cancelled')),approver_id TEXT,approver_login TEXT,decision_at TEXT,created_at TEXT NOT NULL,PRIMARY KEY(org_id,id),UNIQUE(org_id,requester_id,request_key),FOREIGN KEY(org_id,file_id) REFERENCES hx_workspace_files(org_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS hx_public_file_shares (
 org_id TEXT NOT NULL,id TEXT NOT NULL,request_id TEXT NOT NULL,file_id TEXT NOT NULL,file_scope TEXT NOT NULL,file_version INTEGER NOT NULL,content_hash TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,allow_download INTEGER NOT NULL CHECK(allow_download IN (0,1)),created_by TEXT NOT NULL,created_login TEXT NOT NULL,created_at TEXT NOT NULL,revoked_at TEXT,revoked_by TEXT,PRIMARY KEY(org_id,id),UNIQUE(org_id,request_id),FOREIGN KEY(org_id,request_id) REFERENCES hx_file_share_requests(org_id,id) ON DELETE CASCADE,FOREIGN KEY(org_id,file_id,file_version) REFERENCES hx_workspace_file_versions(org_id,file_id,version) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS hx_file_share_audit (org_id TEXT NOT NULL,id INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL,share_id TEXT,actor_id TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('proposed','approved','declined','revoked','expired','stale')),details TEXT NOT NULL,created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS hx_external_resource_grants (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, resource_type TEXT NOT NULL CHECK (resource_type IN ('workspace','room','thread','app','file')), resource_id TEXT NOT NULL CHECK (length(trim(resource_id)) BETWEEN 1 AND 200), recipient_github_id TEXT NOT NULL REFERENCES users(github_id) ON DELETE CASCADE, permission TEXT NOT NULL CHECK (permission IN ('view','edit')), granted_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, granted_at TEXT NOT NULL, expires_at TEXT CHECK (expires_at IS NULL OR expires_at > granted_at), revoked_at TEXT, revoked_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, CHECK (resource_type != 'workspace' OR resource_id = org_id));
CREATE UNIQUE INDEX IF NOT EXISTS idx_hx_external_resource_grants_active ON hx_external_resource_grants(org_id, resource_type, resource_id, recipient_github_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hx_external_resource_grants_recipient ON hx_external_resource_grants(org_id, recipient_github_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS hx_external_file_invites (
 id TEXT PRIMARY KEY,
 org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
 file_id TEXT NOT NULL,
 invited_email TEXT NOT NULL CHECK(length(trim(invited_email)) BETWEEN 3 AND 254),
 permission TEXT NOT NULL CHECK(permission='view'),
 access_expires_at TEXT,
 token_hash TEXT NOT NULL UNIQUE,
 created_by TEXT REFERENCES users(github_id) ON DELETE SET NULL,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL CHECK(expires_at>created_at),
 redemption_id TEXT UNIQUE,
 redeemed_at TEXT,
 redeemed_by TEXT REFERENCES users(github_id) ON DELETE SET NULL,
 created_grant_id TEXT REFERENCES hx_external_resource_grants(id) ON DELETE SET NULL,
 revoked_at TEXT,
 revoked_by TEXT REFERENCES users(github_id) ON DELETE SET NULL,
 FOREIGN KEY(org_id,file_id) REFERENCES hx_workspace_files(org_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_hx_external_file_invites_active ON hx_external_file_invites(org_id,file_id,revoked_at,expires_at);
CREATE INDEX IF NOT EXISTS idx_hx_external_file_invites_redeemed ON hx_external_file_invites(org_id,redeemed_by,redeemed_at);
CREATE TABLE IF NOT EXISTS hx_external_file_invites_v2 ( id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, file_id TEXT NOT NULL, invited_email TEXT NOT NULL CHECK(length(trim(invited_email)) BETWEEN 3 AND 254), permission TEXT NOT NULL CHECK(permission IN ('view','edit')), access_expires_at TEXT, token_hash TEXT NOT NULL UNIQUE, created_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at>created_at), redemption_id TEXT UNIQUE, redeemed_at TEXT, redeemed_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, created_grant_id TEXT REFERENCES hx_external_resource_grants(id) ON DELETE SET NULL, revoked_at TEXT, revoked_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, FOREIGN KEY(org_id,file_id) REFERENCES hx_workspace_files(org_id,id) ON DELETE CASCADE );
CREATE INDEX IF NOT EXISTS idx_hx_external_file_invites_v2_active ON hx_external_file_invites_v2(org_id,file_id,revoked_at,expires_at);
CREATE INDEX IF NOT EXISTS idx_hx_external_file_invites_v2_redeemed ON hx_external_file_invites_v2(org_id,redeemed_by,redeemed_at);
