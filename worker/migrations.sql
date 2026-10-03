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
