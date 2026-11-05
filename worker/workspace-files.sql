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

CREATE TABLE IF NOT EXISTS hx_workspace_file_shares (
 org_id TEXT NOT NULL, id TEXT NOT NULL, file_id TEXT NOT NULL, created_by TEXT NOT NULL, created_login TEXT NOT NULL, request_key TEXT, request_hash TEXT,
 reusable INTEGER NOT NULL CHECK(reusable IN (0,1)), status TEXT NOT NULL CHECK(status IN ('pending','active','stopped','revoked')),
 current_revision INTEGER NOT NULL DEFAULT 0 CHECK(current_revision>=0), last_change_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(org_id,id), UNIQUE(id), UNIQUE(org_id,created_by,request_key), FOREIGN KEY(org_id,file_id) REFERENCES hx_workspace_files(org_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS hx_workspace_file_shares_file ON hx_workspace_file_shares(org_id,file_id,status,created_at DESC);
CREATE TABLE IF NOT EXISTS hx_workspace_file_share_revisions (
 org_id TEXT NOT NULL, share_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), publication_id TEXT NOT NULL, snapshot_json TEXT NOT NULL,
 snapshot_hash TEXT NOT NULL, expires_at TEXT, allow_download INTEGER NOT NULL CHECK(allow_download IN (0,1)),
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(org_id,share_id,revision), UNIQUE(org_id,share_id,publication_id),
 FOREIGN KEY(org_id,share_id) REFERENCES hx_workspace_file_shares(org_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS hx_workspace_file_share_items (
 org_id TEXT NOT NULL, share_id TEXT NOT NULL, revision INTEGER NOT NULL, position INTEGER NOT NULL CHECK(position>=0),
 file_id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(org_id,share_id,revision,position),
 UNIQUE(org_id,share_id,revision,file_id),
 FOREIGN KEY(org_id,share_id,revision) REFERENCES hx_workspace_file_share_revisions(org_id,share_id,revision) ON DELETE CASCADE,
 FOREIGN KEY(org_id,file_id,version) REFERENCES hx_workspace_file_versions(org_id,file_id,version) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS hx_workspace_file_share_items_version ON hx_workspace_file_share_items(org_id,file_id,version);
CREATE TABLE IF NOT EXISTS hx_workspace_file_share_requests (
 org_id TEXT NOT NULL, id TEXT NOT NULL, file_id TEXT NOT NULL, share_id TEXT NOT NULL, request_type TEXT NOT NULL CHECK(request_type IN ('create','update')),
 requester_id TEXT NOT NULL, requester_login TEXT NOT NULL, requester_membership TEXT NOT NULL, agent_id TEXT NOT NULL, channel TEXT NOT NULL, turn_id TEXT NOT NULL,
 request_key TEXT NOT NULL, card_id TEXT NOT NULL, nonce TEXT NOT NULL, expected_revision INTEGER NOT NULL DEFAULT 0,
 snapshot_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL, expires_at TEXT, allow_download INTEGER NOT NULL CHECK(allow_download IN (0,1)),
 status TEXT NOT NULL CHECK(status IN ('pending','approved','declined','stale','cancelled')), created_at TEXT NOT NULL,
 decided_by TEXT, decided_at TEXT, PRIMARY KEY(org_id,id), UNIQUE(org_id,requester_id,request_key), UNIQUE(org_id,card_id),
 FOREIGN KEY(org_id,file_id) REFERENCES hx_workspace_files(org_id,id) ON DELETE CASCADE,
 FOREIGN KEY(org_id,share_id) REFERENCES hx_workspace_file_shares(org_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS hx_workspace_file_share_requests_pending ON hx_workspace_file_share_requests(org_id,requester_login,status,created_at);
CREATE TABLE IF NOT EXISTS hx_workspace_file_share_events (
 org_id TEXT NOT NULL, id TEXT NOT NULL, share_id TEXT, request_id TEXT, event TEXT NOT NULL,
 actor_id TEXT, actor_login TEXT, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, PRIMARY KEY(org_id,id)
);
CREATE INDEX IF NOT EXISTS hx_workspace_file_share_events_share ON hx_workspace_file_share_events(org_id,share_id,created_at);
CREATE TRIGGER IF NOT EXISTS hx_workspace_file_share_revision_immutable BEFORE UPDATE ON hx_workspace_file_share_revisions BEGIN SELECT RAISE(ABORT,'File share revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS hx_workspace_file_share_item_immutable BEFORE UPDATE ON hx_workspace_file_share_items BEGIN SELECT RAISE(ABORT,'File share snapshot items are immutable'); END;
CREATE TRIGGER IF NOT EXISTS hx_workspace_file_share_event_immutable BEFORE UPDATE ON hx_workspace_file_share_events BEGIN SELECT RAISE(ABORT,'File share events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS hx_workspace_file_share_events_linked BEFORE INSERT ON hx_workspace_file_share_events
 WHEN NEW.share_id IS NULL OR NOT EXISTS(SELECT 1 FROM hx_workspace_file_shares s WHERE s.org_id=NEW.org_id AND s.id=NEW.share_id)
 BEGIN SELECT RAISE(ABORT,'File share events require a live share'); END;
CREATE TRIGGER IF NOT EXISTS hx_workspace_file_share_events_purge AFTER DELETE ON hx_workspace_file_shares
 BEGIN DELETE FROM hx_workspace_file_share_events WHERE org_id=OLD.org_id AND share_id=OLD.id; END;
