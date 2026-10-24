/* Column additions for databases created before these columns existed.

   Every statement here is expected to fail on a database that schema.sql has
   already created from scratch, because schema.sql declares these columns
   inside CREATE TABLE. D1 aborts a file at its first error, so this file holds
   *only* ALTERs — nothing after them that needs to run. Anything that must run
   unconditionally belongs in schema.sql, which is idempotent by construction.

   The deploy applies this file statement by statement and tolerates
   "duplicate column name" for each, which is the already-applied signal. */

ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN password_salt TEXT;
ALTER TABLE invites ADD COLUMN expires_at TEXT;
ALTER TABLE invites ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 1;
ALTER TABLE invites ADD COLUMN uses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN notify_email INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memberships ADD COLUMN title TEXT;
ALTER TABLE invites ADD COLUMN ref TEXT;
ALTER TABLE users ADD COLUMN aliases TEXT;
ALTER TABLE users ADD COLUMN inbound_token TEXT;
ALTER TABLE users ADD COLUMN handle TEXT;
ALTER TABLE users ADD COLUMN name_locked INTEGER NOT NULL DEFAULT 0;

/* After the ALTER above, and never in schema.sql: that file runs first, so on a
   database predating the column this index would be created against a column
   that does not exist yet and fail the deploy. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
/* Same reasoning, for the column added just above: on a database predating it,
   an index in schema.sql would be built against a column that does not exist
   yet and would fail the deploy. */
CREATE INDEX IF NOT EXISTS idx_invites_ref ON invites(org_id, ref);
/* Same again: inbound_token lives only on databases that have run the ALTER. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_inbound_token ON users(inbound_token);
/* And for the username, added just above. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle ON users(handle);

ALTER TABLE complimentary_access ADD COLUMN rc_synced_at TEXT;
ALTER TABLE complimentary_access ADD COLUMN rc_attempted_at TEXT;
ALTER TABLE complimentary_access ADD COLUMN rc_operation_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE complimentary_access ADD COLUMN deletion_requested_at TEXT;
ALTER TABLE org_github ADD COLUMN composio_user TEXT;
ALTER TABLE channel_messages ADD COLUMN edited_at TEXT;
ALTER TABLE channel_messages ADD COLUMN deleted_at TEXT;
ALTER TABLE channel_messages ADD COLUMN parent_id TEXT;
ALTER TABLE channel_messages ADD COLUMN pinned_at TEXT;
ALTER TABLE channel_messages ADD COLUMN pinned_by TEXT;
CREATE INDEX IF NOT EXISTS idx_channel_messages_parent ON channel_messages(org_id, parent_id);
ALTER TABLE memberships ADD COLUMN status_emoji TEXT;
ALTER TABLE memberships ADD COLUMN status_text TEXT;
ALTER TABLE memberships ADD COLUMN status_until TEXT;
ALTER TABLE memberships ADD COLUMN away_until TEXT;
ALTER TABLE memberships ADD COLUMN delegate_login TEXT;
ALTER TABLE users ADD COLUMN timezone TEXT;
ALTER TABLE routines ADD COLUMN channel TEXT;
ALTER TABLE businesses ADD COLUMN description TEXT;
ALTER TABLE connector_sync_state ADD COLUMN org_id TEXT;
ALTER TABLE invites ADD COLUMN channels TEXT;
ALTER TABLE businesses ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN push_while_active INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN notify_paused_until TEXT;
ALTER TABLE users ADD COLUMN notify_schedule TEXT;
ALTER TABLE sessions ADD COLUMN client TEXT;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
ALTER TABLE sessions ADD COLUMN place TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
ALTER TABLE api_tokens ADD COLUMN scopes TEXT;
ALTER TABLE users ADD COLUMN notify_keywords TEXT;
ALTER TABLE audit_events ADD COLUMN enc INTEGER NOT NULL DEFAULT 0;
-- The phase 1 rows still to move (migrateLegacyAudit, every 15 minutes):
-- without it each run read the whole audit log to find there were none.
-- Here and not in schema.sql, which runs before the column above exists.
CREATE INDEX IF NOT EXISTS idx_audit_legacy ON audit_events(org_id) WHERE enc = 0;
ALTER TABLE sessions ADD COLUMN reauth_at TEXT;
ALTER TABLE sessions ADD COLUMN auth_method TEXT;
ALTER TABLE sessions ADD COLUMN longest_idle_ms INTEGER;
ALTER TABLE businesses ADD COLUMN archived_at TEXT;
ALTER TABLE memberships ADD COLUMN joined_via TEXT;
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE sessions ADD COLUMN sso_org_id TEXT;
ALTER TABLE audit_principal_keys ADD COLUMN shred_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN sso_connection_id TEXT;
ALTER TABLE sso_states ADD COLUMN connection_id TEXT;
ALTER TABLE sso_states ADD COLUMN browser_hash TEXT;
ALTER TABLE sso_handoffs ADD COLUMN browser_hash TEXT;
ALTER TABLE join_requests ADD COLUMN role TEXT;
ALTER TABLE join_requests ADD COLUMN via TEXT;
ALTER TABLE sessions ADD COLUMN sso_subject TEXT;
ALTER TABLE sessions ADD COLUMN sso_sid TEXT;
ALTER TABLE sessions ADD COLUMN sso_refresh TEXT;
ALTER TABLE sessions ADD COLUMN sso_checked_at TEXT;
ALTER TABLE users ADD COLUMN translate_messages INTEGER NOT NULL DEFAULT 1;
ALTER TABLE org_ai_settings ADD COLUMN gemini_key TEXT;
ALTER TABLE channel_messages ADD COLUMN previews_hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sso_connections ADD COLUMN idp_slo_url TEXT;
ALTER TABLE custom_agents ADD COLUMN avatar_url TEXT;
ALTER TABLE custom_agents ADD COLUMN provider TEXT;
/* Cursor hands each follow-up to a run of its own. */
ALTER TABLE ai_teammate_runs ADD COLUMN remote_turn TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_github ON sessions(github_id);
CREATE INDEX IF NOT EXISTS idx_sessions_sso_connection ON sessions(sso_connection_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_github_id);
CREATE INDEX IF NOT EXISTS idx_cards_org_created ON cards(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_channel_messages_author ON channel_messages(org_id, author_login, created_at);
CREATE INDEX IF NOT EXISTS idx_push_queue_created ON push_queue(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_reads_read ON activity_reads(read_at);
CREATE TABLE IF NOT EXISTS session_workspaces (token TEXT NOT NULL, org_id TEXT NOT NULL, last_seen_at TEXT NOT NULL, ended_at TEXT, PRIMARY KEY (token, org_id));
CREATE INDEX IF NOT EXISTS idx_session_workspaces_org ON session_workspaces(org_id);
CREATE TABLE IF NOT EXISTS workspace_activity (org_id TEXT NOT NULL, login TEXT NOT NULL, last_active_at TEXT NOT NULL, client TEXT, PRIMARY KEY (org_id, login));
CREATE INDEX IF NOT EXISTS idx_workspace_activity_seen ON workspace_activity(org_id, last_active_at);
/* Android phones (FCM) beside iPhones (APNs). Every token registered before
   this column existed came from the iPhone app. */
ALTER TABLE device_tokens ADD COLUMN platform TEXT NOT NULL DEFAULT 'ios';
/* Which iPhone app a token is for (apns.js targetFor). */
ALTER TABLE device_tokens ADD COLUMN app_id TEXT;
CREATE TABLE IF NOT EXISTS apple_identities (subject TEXT PRIMARY KEY, user_github_id TEXT NOT NULL, email TEXT, created_at TEXT NOT NULL, last_login_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_apple_identities_user ON apple_identities(user_github_id);
/* Apple's refresh token (sealed) and the app it was issued to, so deleting an
   account can revoke the person's Sign in with Apple authorization. */
ALTER TABLE apple_identities ADD COLUMN refresh_token TEXT;
ALTER TABLE apple_identities ADD COLUMN client_id TEXT;
/* An inline reply: the message it answers (schema.sql says why). */
ALTER TABLE channel_messages ADD COLUMN reply_to_id TEXT;
/* A retried send names the message it already posted, and gets that one back. */
ALTER TABLE channel_messages ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_messages_client ON channel_messages(org_id, author_login, client_id) WHERE client_id IS NOT NULL;

ALTER TABLE push_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_queue ADD COLUMN lease_until TEXT;
ALTER TABLE push_queue ADD COLUMN last_error TEXT;
/* A thread reply sent to the conversation as well (schema.sql says why). */
ALTER TABLE channel_messages ADD COLUMN also_channel INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduled_messages ADD COLUMN also_channel INTEGER NOT NULL DEFAULT 0;
/* Proxies: an agent's words for a person who was mentioned (schema.sql). */
ALTER TABLE channel_messages ADD COLUMN on_behalf_of TEXT;
ALTER TABLE ai_teammate_runs ADD COLUMN on_behalf_of TEXT;
/* Auto-build: an issue or a report posted in a channel starts the teammate (schema.sql). */
ALTER TABLE ai_teammates ADD COLUMN auto_build INTEGER NOT NULL DEFAULT 1;
/* The SSO sign-ins checked with their provider every fifteen minutes (sso.js
   checkSsoGrants): only those rows, so other sessions write no index row. Here,
   not in schema.sql: its columns are added above (test/migration.test.js). */
CREATE INDEX IF NOT EXISTS idx_sessions_sso_check ON sessions(sso_checked_at) WHERE auth_method = 'sso' AND sso_refresh IS NOT NULL;
/* Agent tokens expire (mcp.js): NULL is a token from before, given ninety
   days from its next use. sso_backed: made from a sign-in through the
   workspace's SSO, so it still opens a workspace that requires SSO. */
ALTER TABLE api_tokens ADD COLUMN expires_at TEXT;
ALTER TABLE api_tokens ADD COLUMN sso_backed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_invites ADD COLUMN sso_backed INTEGER NOT NULL DEFAULT 0;
/* Whether a repository's workspace lets in everyone with write access on
   GitHub by themselves (governance.js). */
ALTER TABLE org_governance ADD COLUMN github_auto_join INTEGER;

/* Room rules survive Simple / Harness switches. */
CREATE TABLE IF NOT EXISTS hx_room_guidelines (org_id TEXT NOT NULL, channel TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (org_id, channel));

CREATE TABLE IF NOT EXISTS hx_memory_scopes (memory_id TEXT PRIMARY KEY REFERENCES hx_agent_memories(id) ON DELETE CASCADE, org_id TEXT NOT NULL, channel TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'context');

CREATE TABLE IF NOT EXISTS hx_workflow_run_definitions (run_id TEXT PRIMARY KEY REFERENCES hx_workflow_runs(id) ON DELETE CASCADE, org_id TEXT NOT NULL, definition TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS hx_app_access (org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, visibility TEXT NOT NULL CHECK (visibility IN ('workspace', 'private')), version INTEGER NOT NULL, PRIMARY KEY (org_id, app_id));

CREATE TABLE IF NOT EXISTS hx_skill_access (org_id TEXT NOT NULL, skill_id TEXT NOT NULL REFERENCES hx_skills(id) ON DELETE CASCADE, visibility TEXT NOT NULL CHECK (visibility IN ('workspace', 'private')), version INTEGER NOT NULL, PRIMARY KEY (org_id, skill_id));

CREATE TABLE IF NOT EXISTS hx_gateways (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS hx_gateway_jobs (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, gateway_id TEXT NOT NULL REFERENCES hx_gateways(id), created_by TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, lease_hash TEXT, lease_until INTEGER, deadline INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, UNIQUE(org_id, created_by, request_id));
CREATE INDEX IF NOT EXISTS hx_gateway_jobs_queue ON hx_gateway_jobs(gateway_id, status, created_at);
/* When the daily job claimed a workspace's deletion, and how far through the
   Jam recordings it got (workspaceDeletion.js). */
ALTER TABLE workspace_deletions ADD COLUMN purge_started_at TEXT;
ALTER TABLE workspace_deletions ADD COLUMN purge_cursor TEXT;
/* An invitation held for approval keeps its channels and its sender (schema.sql). */
ALTER TABLE join_requests ADD COLUMN channels TEXT;
ALTER TABLE join_requests ADD COLUMN invited_by TEXT;
/* A scheduled message held by the cron run sending it (schema.sql). */
ALTER TABLE scheduled_messages ADD COLUMN lease_until TEXT;
CREATE TABLE IF NOT EXISTS channel_thread_details (org_id TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE, title TEXT NOT NULL, version INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (org_id, message_id));

CREATE TABLE IF NOT EXISTS channel_thread_pins (org_id TEXT NOT NULL, user_id TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY (org_id,user_id,message_id));
CREATE TABLE IF NOT EXISTS channel_thread_shares ( id TEXT PRIMARY KEY, org_id TEXT NOT NULL, channel TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE, created_by TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, snapshot TEXT NOT NULL, digest TEXT NOT NULL, access_digest TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT );
CREATE INDEX IF NOT EXISTS idx_thread_shares_org ON channel_thread_shares(org_id,message_id);
CREATE TABLE IF NOT EXISTS channel_thread_share_policy ( org_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL );

CREATE TABLE IF NOT EXISTS channel_thread_mutes (org_id TEXT NOT NULL, login TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE, PRIMARY KEY (org_id,login,message_id));
CREATE INDEX IF NOT EXISTS idx_channel_thread_mutes_message ON channel_thread_mutes(org_id,message_id,login);
ALTER TABLE channel_messages ADD COLUMN pin_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hx_skills ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
ALTER TABLE custom_agents ADD COLUMN created_by_login TEXT;

CREATE TABLE IF NOT EXISTS hx_skill_files (org_id TEXT NOT NULL, skill_id TEXT NOT NULL REFERENCES hx_skills(id) ON DELETE CASCADE, path TEXT NOT NULL, size INTEGER NOT NULL CHECK (size >= 0 AND size <= 1048576), content BLOB NOT NULL, PRIMARY KEY (org_id, skill_id, path));

CREATE TABLE IF NOT EXISTS hx_member_departures (org_id TEXT NOT NULL, user_id TEXT NOT NULL, nonce TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (org_id, user_id));

ALTER TABLE hx_skills ADD COLUMN owner_id TEXT;

CREATE TABLE IF NOT EXISTS hx_room_access (org_id TEXT NOT NULL, channel TEXT NOT NULL, version INTEGER NOT NULL, mutation_id TEXT, PRIMARY KEY (org_id,channel));
CREATE TABLE IF NOT EXISTS hx_room_roles (org_id TEXT NOT NULL, channel TEXT NOT NULL, subject_kind TEXT NOT NULL CHECK(subject_kind IN ('person','agent')), subject_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')), member_since TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(org_id,channel,subject_kind,subject_id));

ALTER TABLE hx_room_access ADD COLUMN deleted_at TEXT;

CREATE TABLE IF NOT EXISTS hx_room_creations (org_id TEXT NOT NULL, user_id TEXT NOT NULL, request_id TEXT NOT NULL, channel TEXT NOT NULL, fingerprint TEXT NOT NULL, member_since TEXT NOT NULL, nonce TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(org_id,user_id,request_id), UNIQUE(org_id,channel));

CREATE TABLE IF NOT EXISTS hx_room_appearance (org_id TEXT NOT NULL, channel TEXT NOT NULL, color TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(org_id,channel));

ALTER TABLE channel_reads ADD COLUMN read_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS hx_room_visuals (org_id TEXT NOT NULL, channel TEXT NOT NULL, object_key TEXT NOT NULL, content_type TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(org_id,channel));

CREATE TABLE IF NOT EXISTS hx_room_hooks (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, channel TEXT NOT NULL, name TEXT NOT NULL, creator_id TEXT NOT NULL, member_since TEXT NOT NULL, secret_hash TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_hx_room_hooks_room ON hx_room_hooks(org_id,channel,created_at);
CREATE TABLE IF NOT EXISTS hx_room_hook_events (event_key TEXT PRIMARY KEY, hook_id TEXT NOT NULL, org_id TEXT NOT NULL, channel TEXT NOT NULL, payload_hash TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS hx_room_hook_dispatch (message_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','cancelled')), attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_hx_room_hook_dispatch_due ON hx_room_hook_dispatch(status,next_attempt,lease_until);

ALTER TABLE ai_teammate_runs ADD COLUMN room_hook_source TEXT;

CREATE INDEX IF NOT EXISTS idx_teammate_runs_hook ON ai_teammate_runs(org_id,room_hook_source,channel,status);

CREATE TABLE IF NOT EXISTS hx_agent_assignments ( id TEXT PRIMARY KEY, org_id TEXT NOT NULL, source_message_id TEXT NOT NULL, initial_agent_id TEXT NOT NULL, current_agent_id TEXT NOT NULL, channel TEXT NOT NULL, thread_id TEXT NOT NULL, actor_id TEXT NOT NULL, session_key TEXT NOT NULL, source_hash TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('running','pending','finished','failed','cancelled','interrupted')), visited TEXT NOT NULL, hop_limit INTEGER NOT NULL CHECK(hop_limit BETWEEN 1 AND 8), mutation_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(org_id,source_message_id,initial_agent_id) );
CREATE INDEX IF NOT EXISTS idx_hx_agent_assignments_source ON hx_agent_assignments(org_id,source_message_id);
CREATE TABLE IF NOT EXISTS hx_agent_handoffs ( org_id TEXT NOT NULL, operation_id TEXT NOT NULL, assignment_id TEXT NOT NULL, source_generation INTEGER NOT NULL, source_agent_id TEXT NOT NULL, target_agent_id TEXT NOT NULL, brief TEXT NOT NULL, message_body TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, PRIMARY KEY(org_id,operation_id), UNIQUE(assignment_id,source_generation) );
CREATE TABLE IF NOT EXISTS hx_agent_handoff_dispatch ( org_id TEXT NOT NULL, operation_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','cancelled')), attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(org_id,operation_id) );
CREATE INDEX IF NOT EXISTS idx_hx_agent_handoff_dispatch_due ON hx_agent_handoff_dispatch(status,next_attempt,lease_until);

CREATE TABLE IF NOT EXISTS hx_agent_request_dispatch (org_id TEXT NOT NULL, message_id TEXT NOT NULL, session_key TEXT NOT NULL, agent_ids TEXT NOT NULL, source_hash TEXT NOT NULL, locale TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','cancelled')), attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(org_id,message_id));
CREATE INDEX IF NOT EXISTS idx_hx_agent_request_dispatch_due ON hx_agent_request_dispatch(status,next_attempt,lease_until);

ALTER TABLE ai_teammate_runs ADD COLUMN turn_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ai_teammate_runs ADD COLUMN result_delivery_id TEXT;
CREATE TABLE IF NOT EXISTS ai_teammate_result_dispatch (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, run_id TEXT NOT NULL, turn_version INTEGER NOT NULL, agent_id TEXT NOT NULL, payload TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','published','cancelled')), attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, UNIQUE(org_id,run_id,turn_version));
CREATE INDEX IF NOT EXISTS idx_teammate_result_pending ON ai_teammate_result_dispatch(status,next_attempt,lease_until);
