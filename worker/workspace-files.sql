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
