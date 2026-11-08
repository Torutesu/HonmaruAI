/* Ordered compatibility migrations for databases deployed before current schema.

   schema.sql runs first and must never reference a column that is introduced
   below. The deploy applies each line here as one D1 statement, in order.
   Duplicate-column ALTER errors are the already-applied signal; dependent
   backfills and triggers belong after their required ALTER. */

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
CREATE INDEX IF NOT EXISTS idx_channel_thread_page ON channel_messages(org_id, parent_id, created_at) WHERE deleted_at IS NULL;
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
ALTER TABLE org_ai_settings ADD COLUMN daily_budget_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE org_ai_settings ADD COLUMN weekly_budget_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE org_ai_settings ADD COLUMN monthly_budget_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE org_ai_settings ADD COLUMN budget_action TEXT NOT NULL DEFAULT 'warn';
ALTER TABLE org_ai_settings ADD COLUMN budget_revision INTEGER NOT NULL DEFAULT 0;
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
ALTER TABLE hx_app_access ADD COLUMN change_token TEXT;
CREATE TABLE IF NOT EXISTS hx_app_person_access (org_id TEXT NOT NULL, app_id TEXT NOT NULL, user_github_id TEXT NOT NULL, permission TEXT NOT NULL CHECK (permission IN ('none','view','edit')), updated_at TEXT NOT NULL, PRIMARY KEY (org_id,app_id,user_github_id), FOREIGN KEY (app_id) REFERENCES hx_apps(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_hx_app_person_access_user ON hx_app_person_access(org_id,user_github_id,app_id);
CREATE TRIGGER IF NOT EXISTS hx_app_person_access_membership_deleted AFTER DELETE ON memberships BEGIN DELETE FROM hx_app_person_access WHERE org_id=OLD.org_id AND user_github_id=OLD.user_github_id; END;

CREATE TABLE IF NOT EXISTS hx_skill_access (org_id TEXT NOT NULL, skill_id TEXT NOT NULL REFERENCES hx_skills(id) ON DELETE CASCADE, visibility TEXT NOT NULL CHECK (visibility IN ('workspace', 'private')), version INTEGER NOT NULL, PRIMARY KEY (org_id, skill_id));

CREATE TABLE IF NOT EXISTS hx_gateways (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS hx_gateway_acp_agents (org_id TEXT NOT NULL, gateway_id TEXT NOT NULL REFERENCES hx_gateways(id), agent_key TEXT NOT NULL, last_seen_at INTEGER NOT NULL, PRIMARY KEY(gateway_id,agent_key));
CREATE TABLE IF NOT EXISTS hx_gateway_jobs (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, gateway_id TEXT NOT NULL REFERENCES hx_gateways(id), created_by TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, lease_hash TEXT, lease_until INTEGER, deadline INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, UNIQUE(org_id, created_by, request_id));
ALTER TABLE hx_gateway_jobs ADD COLUMN acp_progress TEXT;
ALTER TABLE hx_gateway_jobs ADD COLUMN acp_progress_at INTEGER;
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
ALTER TABLE channel_messages ADD COLUMN content_version INTEGER NOT NULL DEFAULT 0;
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
CREATE TABLE IF NOT EXISTS hx_line_room_hooks (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, channel_secret TEXT, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS hx_room_hook_dispatch (message_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','cancelled')), attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_hx_room_hook_dispatch_due ON hx_room_hook_dispatch(status,next_attempt,lease_until);

ALTER TABLE ai_teammate_runs ADD COLUMN room_hook_source TEXT;

CREATE INDEX IF NOT EXISTS idx_teammate_runs_hook ON ai_teammate_runs(org_id,room_hook_source,channel,status);

CREATE TABLE IF NOT EXISTS hx_agent_assignments ( id TEXT PRIMARY KEY, org_id TEXT NOT NULL, source_message_id TEXT NOT NULL, initial_agent_id TEXT NOT NULL, current_agent_id TEXT NOT NULL, channel TEXT NOT NULL, thread_id TEXT NOT NULL, actor_id TEXT NOT NULL, actor_membership TEXT, session_key TEXT NOT NULL, source_hash TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('running','pending','finished','failed','cancelled','interrupted')), visited TEXT NOT NULL, hop_limit INTEGER NOT NULL CHECK(hop_limit BETWEEN 1 AND 8), mutation_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(org_id,source_message_id,initial_agent_id) );
CREATE INDEX IF NOT EXISTS idx_hx_agent_assignments_source ON hx_agent_assignments(org_id,source_message_id);
CREATE TABLE IF NOT EXISTS hx_agent_handoffs ( org_id TEXT NOT NULL, operation_id TEXT NOT NULL, assignment_id TEXT NOT NULL, source_generation INTEGER NOT NULL, source_agent_id TEXT NOT NULL, target_agent_id TEXT NOT NULL, brief TEXT NOT NULL, message_body TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE, wake_grant_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY(org_id,operation_id), UNIQUE(assignment_id,source_generation) );
CREATE TABLE IF NOT EXISTS hx_agent_handoff_dispatch ( org_id TEXT NOT NULL, operation_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','cancelled')), attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(org_id,operation_id) );
CREATE INDEX IF NOT EXISTS idx_hx_agent_handoff_dispatch_due ON hx_agent_handoff_dispatch(status,next_attempt,lease_until);

CREATE TABLE IF NOT EXISTS hx_agent_request_dispatch (org_id TEXT NOT NULL, message_id TEXT NOT NULL, session_key TEXT NOT NULL, agent_ids TEXT NOT NULL, source_hash TEXT NOT NULL, locale TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','cancelled')), attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(org_id,message_id));
CREATE INDEX IF NOT EXISTS idx_hx_agent_request_dispatch_due ON hx_agent_request_dispatch(status,next_attempt,lease_until);

ALTER TABLE ai_teammate_runs ADD COLUMN turn_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ai_teammate_runs ADD COLUMN result_delivery_id TEXT;
CREATE TABLE IF NOT EXISTS ai_teammate_result_dispatch (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, run_id TEXT NOT NULL, turn_version INTEGER NOT NULL, agent_id TEXT NOT NULL, payload TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','published','cancelled')), attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, UNIQUE(org_id,run_id,turn_version));
CREATE INDEX IF NOT EXISTS idx_teammate_result_pending ON ai_teammate_result_dispatch(status,next_attempt,lease_until);

ALTER TABLE ai_teammate_runs ADD COLUMN assignment_id TEXT;
ALTER TABLE ai_teammate_runs ADD COLUMN assignment_generation INTEGER;
ALTER TABLE ai_teammate_runs ADD COLUMN assignment_agent_id TEXT;
ALTER TABLE ai_teammate_result_dispatch ADD COLUMN assignment_id TEXT;
ALTER TABLE ai_teammate_result_dispatch ADD COLUMN assignment_generation INTEGER;
ALTER TABLE ai_teammate_result_dispatch ADD COLUMN assignment_agent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_teammate_runs_assignment ON ai_teammate_runs(org_id,assignment_id,assignment_generation,status);
CREATE INDEX IF NOT EXISTS idx_teammate_result_assignment ON ai_teammate_result_dispatch(org_id,assignment_id,assignment_generation,status);

CREATE TABLE IF NOT EXISTS hx_app_automation_state (org_id TEXT NOT NULL, app_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, draft TEXT NOT NULL, published TEXT, release_id TEXT, published_at TEXT, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY(org_id,app_id));

CREATE TABLE IF NOT EXISTS hx_app_automation_bindings (org_id TEXT NOT NULL, app_id TEXT NOT NULL, declaration_key TEXT NOT NULL, workflow_id TEXT NOT NULL, applied TEXT NOT NULL, release_id TEXT NOT NULL, PRIMARY KEY(org_id,app_id,declaration_key), UNIQUE(org_id,workflow_id));

CREATE TABLE IF NOT EXISTS hx_app_automation_releases (org_id TEXT NOT NULL, app_id TEXT NOT NULL, request_id TEXT NOT NULL, request TEXT NOT NULL, release_id TEXT NOT NULL, revision INTEGER NOT NULL, app_version INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(org_id,app_id,request_id));

ALTER TABLE hx_followups ADD COLUMN origin_workflow_id TEXT;
ALTER TABLE hx_followups ADD COLUMN origin_release_id TEXT;

CREATE INDEX IF NOT EXISTS idx_hx_runs_active ON hx_workflow_runs(org_id, workflow_id) WHERE status IN ('running','waiting');

CREATE TABLE IF NOT EXISTS hx_workflow_safety (org_id TEXT NOT NULL, workflow_id TEXT NOT NULL, generation TEXT NOT NULL, failure_streak INTEGER NOT NULL DEFAULT 0, paused_at TEXT, pause_reason TEXT, PRIMARY KEY(org_id,workflow_id));
ALTER TABLE hx_workflow_safety ADD COLUMN daily_run_limit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hx_workflow_safety ADD COLUMN weekly_run_limit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hx_workflow_safety ADD COLUMN monthly_run_limit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hx_workflow_safety ADD COLUMN budget_revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS hx_workflow_outcomes (org_id TEXT NOT NULL, run_id TEXT NOT NULL, workflow_id TEXT NOT NULL, generation TEXT NOT NULL, status TEXT NOT NULL, claim_id TEXT NOT NULL, PRIMARY KEY(org_id,run_id));
CREATE TABLE IF NOT EXISTS hx_workflow_safety_notices (org_id TEXT NOT NULL, workflow_id TEXT NOT NULL, generation TEXT NOT NULL, run_id TEXT NOT NULL, recipient_id TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT, PRIMARY KEY(org_id,workflow_id,generation));

ALTER TABLE hx_workflow_safety_notices ADD COLUMN read_at TEXT;

CREATE TABLE IF NOT EXISTS hx_workflow_sources (org_id TEXT NOT NULL, workflow_id TEXT NOT NULL, channel TEXT NOT NULL, thread_id TEXT NOT NULL, created_by TEXT NOT NULL, PRIMARY KEY(org_id,workflow_id));

ALTER TABLE hx_workflow_safety_notices ADD COLUMN last_attempt_at TEXT;

CREATE TABLE IF NOT EXISTS hx_workflow_generation_jobs (org_id TEXT NOT NULL, user_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, lease_token TEXT NOT NULL, lease_until INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','failed','complete')), generated TEXT, workflow_id TEXT, PRIMARY KEY(org_id,user_id,request_id), CHECK(status != 'complete' OR (workflow_id IS NOT NULL AND generated IS NOT NULL)));

CREATE TABLE IF NOT EXISTS hx_workflow_usage (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workflow_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES hx_workflow_runs(id) ON DELETE CASCADE, step_number INTEGER NOT NULL CHECK(step_number>0), provider TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER CHECK(input_tokens>=0), output_tokens INTEGER CHECK(output_tokens>=0), byok INTEGER NOT NULL CHECK(byok IN (0,1)), created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_hx_workflow_usage_run ON hx_workflow_usage(org_id,run_id,step_number);

ALTER TABLE hx_workflow_safety ADD COLUMN daily_ai_budget_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hx_workflow_safety ADD COLUMN weekly_ai_budget_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hx_workflow_safety ADD COLUMN monthly_ai_budget_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hx_workflow_safety ADD COLUMN ai_budget_action TEXT NOT NULL DEFAULT 'warn';
ALTER TABLE hx_workflow_usage ADD COLUMN estimated_micros INTEGER CHECK(estimated_micros>=0);
CREATE INDEX IF NOT EXISTS idx_hx_workflow_usage_window ON hx_workflow_usage(org_id,workflow_id,created_at);
CREATE TABLE IF NOT EXISTS hx_workflow_ai_budget_notices (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workflow_id TEXT NOT NULL, period TEXT NOT NULL CHECK(period IN ('24h','7d','30d')), budget_revision INTEGER NOT NULL, bucket_start TEXT NOT NULL, run_id TEXT NOT NULL, recipient_id TEXT NOT NULL, estimated_micros INTEGER NOT NULL, limit_micros INTEGER NOT NULL, unpriced_calls INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, delivered_at TEXT, last_attempt_at TEXT, UNIQUE(org_id,workflow_id,period,budget_revision,bucket_start));
CREATE INDEX IF NOT EXISTS idx_hx_workflow_ai_budget_notice_pending ON hx_workflow_ai_budget_notices(delivered_at,last_attempt_at,created_at);

CREATE TABLE IF NOT EXISTS hx_workflow_node_checkpoints (org_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES hx_workflow_runs(id) ON DELETE CASCADE, node_id TEXT NOT NULL, fingerprint TEXT NOT NULL, effect INTEGER NOT NULL CHECK(effect IN (0,1)), status TEXT NOT NULL CHECK(status IN ('running','unknown','done')), owner TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt>0), lease_until INTEGER NOT NULL, result TEXT, PRIMARY KEY(org_id,run_id,node_id), CHECK(status!='done' OR result IS NOT NULL));

CREATE TABLE IF NOT EXISTS hx_workflow_state_versions (org_id TEXT NOT NULL, workflow_id TEXT NOT NULL REFERENCES hx_workflows(id) ON DELETE CASCADE, revision INTEGER NOT NULL CHECK(revision>0), run_id TEXT NOT NULL, state TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', validation_status TEXT NOT NULL CHECK(validation_status IN ('pending','passed','failed')), created_at INTEGER NOT NULL, PRIMARY KEY(org_id,workflow_id,revision));

CREATE TABLE IF NOT EXISTS hx_workflow_revisions (org_id TEXT NOT NULL, workflow_id TEXT NOT NULL REFERENCES hx_workflows(id) ON DELETE CASCADE, revision INTEGER NOT NULL CHECK(revision>0), definition TEXT NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY(org_id,workflow_id,revision)); INSERT OR IGNORE INTO hx_workflow_revisions(org_id,workflow_id,revision,definition,recorded_at) SELECT org_id,id,1,json_object('name',name,'enabled',enabled,'trigger',json(trigger),'steps',json(steps),'createdBy',created_by),updated_at FROM hx_workflows WHERE NOT EXISTS(SELECT 1 FROM hx_workflow_revisions h WHERE h.org_id=hx_workflows.org_id AND h.workflow_id=hx_workflows.id);
CREATE TRIGGER IF NOT EXISTS hx_workflow_revision_insert AFTER INSERT ON hx_workflows BEGIN INSERT INTO hx_workflow_revisions(org_id,workflow_id,revision,definition,recorded_at) VALUES(NEW.org_id,NEW.id,1,json_object('name',NEW.name,'enabled',NEW.enabled,'trigger',json(NEW.trigger),'steps',json(NEW.steps),'createdBy',NEW.created_by),NEW.updated_at); END;
CREATE TRIGGER IF NOT EXISTS hx_workflow_revision_update AFTER UPDATE OF name,enabled,trigger,steps,created_by ON hx_workflows WHEN OLD.name IS NOT NEW.name OR OLD.enabled IS NOT NEW.enabled OR OLD.trigger IS NOT NEW.trigger OR OLD.steps IS NOT NEW.steps OR OLD.created_by IS NOT NEW.created_by BEGIN INSERT INTO hx_workflow_revisions(org_id,workflow_id,revision,definition,recorded_at) SELECT NEW.org_id,NEW.id,COALESCE(MAX(revision),0)+1,json_object('name',NEW.name,'enabled',NEW.enabled,'trigger',json(NEW.trigger),'steps',json(NEW.steps),'createdBy',NEW.created_by),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM hx_workflow_revisions WHERE org_id=NEW.org_id AND workflow_id=NEW.id; END;
CREATE TRIGGER IF NOT EXISTS hx_workflow_revision_immutable BEFORE UPDATE ON hx_workflow_revisions BEGIN SELECT RAISE(ABORT,'Workflow revisions are immutable'); END;

ALTER TABLE hx_workflow_state_versions ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';

ALTER TABLE hx_agent_assignments ADD COLUMN remote_stop_status TEXT;
ALTER TABLE hx_agent_assignments ADD COLUMN remote_stop_updated_at TEXT;

CREATE TRIGGER IF NOT EXISTS hx_workflow_state_immutable BEFORE UPDATE ON hx_workflow_state_versions BEGIN SELECT RAISE(ABORT,'Workflow state versions are immutable'); END;

CREATE TABLE IF NOT EXISTS hx_workflow_activations (org_id TEXT NOT NULL, job_id TEXT PRIMARY KEY REFERENCES hx_gateway_jobs(id) ON DELETE CASCADE, run_id TEXT NOT NULL REFERENCES hx_workflow_runs(id) ON DELETE CASCADE, node_id TEXT NOT NULL, node_owner TEXT NOT NULL, node_attempt INTEGER NOT NULL CHECK(node_attempt>0), UNIQUE(org_id,run_id,node_id,node_attempt));

-- Workspace file history, staged transfers and lifecycle recovery.
CREATE TABLE IF NOT EXISTS hx_workspace_files ( org_id TEXT NOT NULL, id TEXT NOT NULL, scope TEXT NOT NULL, path TEXT NOT NULL, created_by TEXT NOT NULL, created_login TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, current_version INTEGER NOT NULL DEFAULT 0 CHECK(current_version>=0), PRIMARY KEY(org_id,id), UNIQUE(org_id,scope,path) );
CREATE TABLE IF NOT EXISTS hx_workspace_file_versions ( org_id TEXT NOT NULL, file_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0), operation_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('content','deleted')), object_key TEXT, content_hash TEXT, content_type TEXT, size INTEGER, created_by TEXT NOT NULL, created_login TEXT NOT NULL, created_at TEXT NOT NULL, restored_from INTEGER, PRIMARY KEY(org_id,file_id,version), UNIQUE(org_id,operation_id), FOREIGN KEY(org_id,file_id) REFERENCES hx_workspace_files(org_id,id) ON DELETE CASCADE, CHECK((kind='deleted' AND object_key IS NULL AND content_hash IS NULL AND content_type IS NULL AND size IS NULL AND restored_from IS NULL) OR (kind='content' AND object_key IS NOT NULL AND content_hash IS NOT NULL AND content_type IS NOT NULL AND size>=0)), CHECK(restored_from IS NULL OR (restored_from>0 AND restored_from<version)) );
CREATE INDEX IF NOT EXISTS hx_workspace_files_listing ON hx_workspace_files(org_id,path,id);
CREATE TABLE IF NOT EXISTS hx_workspace_file_purges ( org_id TEXT NOT NULL, file_id TEXT NOT NULL, version INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(org_id,file_id,version), FOREIGN KEY(org_id,file_id,version) REFERENCES hx_workspace_file_versions(org_id,file_id,version) ON DELETE CASCADE );
CREATE TRIGGER IF NOT EXISTS hx_workspace_file_version_immutable BEFORE UPDATE ON hx_workspace_file_versions WHEN NOT (NEW.created_by='deleted-user' AND NEW.created_login='deleted-user' AND NOT EXISTS(SELECT 1 FROM users WHERE github_id=OLD.created_by) AND NEW.org_id IS OLD.org_id AND NEW.file_id IS OLD.file_id AND NEW.version IS OLD.version AND NEW.operation_id IS OLD.operation_id AND NEW.kind IS OLD.kind AND NEW.object_key IS OLD.object_key AND NEW.content_hash IS OLD.content_hash AND NEW.content_type IS OLD.content_type AND NEW.size IS OLD.size AND NEW.created_at IS OLD.created_at AND NEW.restored_from IS OLD.restored_from) BEGIN SELECT RAISE(ABORT,'File versions are immutable'); END;
CREATE TABLE IF NOT EXISTS hx_workspace_file_uploads ( org_id TEXT NOT NULL, id TEXT NOT NULL, file_id TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, expected_version INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('uploading','cleanup')), PRIMARY KEY(org_id,id) );
CREATE INDEX IF NOT EXISTS hx_workspace_file_uploads_due ON hx_workspace_file_uploads(expires_at);
CREATE TABLE IF NOT EXISTS hx_file_account_erasures ( user_id TEXT PRIMARY KEY, login TEXT, requested_at INTEGER NOT NULL, next_at INTEGER NOT NULL );
CREATE INDEX IF NOT EXISTS hx_file_account_erasures_due ON hx_file_account_erasures(next_at);

ALTER TABLE hx_workflow_held_events ADD COLUMN webhook_event_id TEXT;
ALTER TABLE hx_workflow_held_events ADD COLUMN payload_hash TEXT;
ALTER TABLE hx_workflows ADD COLUMN webhook_signature_required INTEGER NOT NULL DEFAULT 0 CHECK(webhook_signature_required IN (0,1));
CREATE TABLE IF NOT EXISTS hx_workflow_webhook_receipts (org_id TEXT NOT NULL, workflow_id TEXT NOT NULL REFERENCES hx_workflows(id) ON DELETE CASCADE, event_id TEXT NOT NULL, payload_hash TEXT NOT NULL, received_at TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('accepted','held','replayed')), run_id TEXT, held_event_id TEXT, PRIMARY KEY(org_id,workflow_id,event_id));
CREATE INDEX IF NOT EXISTS idx_hx_workflow_webhook_receipts_expiry ON hx_workflow_webhook_receipts(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hx_held_webhook_event ON hx_workflow_held_events(org_id,workflow_id,webhook_event_id) WHERE webhook_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS hx_workflow_row_receipts (org_id TEXT NOT NULL, workflow_id TEXT NOT NULL REFERENCES hx_workflows(id) ON DELETE CASCADE, event_hash TEXT NOT NULL, received_at TEXT NOT NULL, expires_at TEXT NOT NULL, run_id TEXT, PRIMARY KEY(org_id,workflow_id,event_hash));
CREATE INDEX IF NOT EXISTS idx_hx_workflow_row_receipts_expiry ON hx_workflow_row_receipts(expires_at);

CREATE TABLE IF NOT EXISTS hx_agent_source_grants (org_id TEXT NOT NULL, agent_id TEXT NOT NULL, user_github_id TEXT NOT NULL, membership_since TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('notion','github')), created_at TEXT NOT NULL, PRIMARY KEY(org_id,agent_id,user_github_id,source), FOREIGN KEY(org_id,agent_id) REFERENCES custom_agents(org_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS hx_agent_remote_mcp_grants (org_id TEXT NOT NULL, agent_id TEXT NOT NULL, user_github_id TEXT NOT NULL, membership_since TEXT NOT NULL, server_id TEXT NOT NULL REFERENCES hx_remote_mcp_servers(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY(org_id,agent_id,user_github_id,server_id), FOREIGN KEY(org_id,agent_id) REFERENCES custom_agents(org_id,id) ON DELETE CASCADE);

ALTER TABLE hx_remote_mcp_servers ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'headers' CHECK(auth_mode IN ('headers','oauth'));
ALTER TABLE hx_remote_mcp_servers ADD COLUMN oauth_registration TEXT NOT NULL DEFAULT 'auto' CHECK(oauth_registration IN ('auto','manual'));
ALTER TABLE hx_remote_mcp_servers ADD COLUMN oauth_client TEXT;
CREATE TABLE IF NOT EXISTS hx_remote_mcp_oauth_credentials (org_id TEXT NOT NULL, server_id TEXT NOT NULL REFERENCES hx_remote_mcp_servers(id) ON DELETE CASCADE, user_github_id TEXT NOT NULL, membership_since TEXT NOT NULL, credential TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(org_id,server_id,user_github_id));
CREATE INDEX IF NOT EXISTS hx_remote_mcp_oauth_user ON hx_remote_mcp_oauth_credentials(org_id,user_github_id,server_id);
CREATE TABLE IF NOT EXISTS hx_remote_mcp_oauth_states (state_hash TEXT PRIMARY KEY, org_id TEXT NOT NULL, server_id TEXT NOT NULL REFERENCES hx_remote_mcp_servers(id) ON DELETE CASCADE, user_github_id TEXT NOT NULL, membership_since TEXT NOT NULL, code_verifier TEXT NOT NULL, issuer TEXT NOT NULL, token_endpoint TEXT NOT NULL, client_id TEXT NOT NULL, resource TEXT NOT NULL, scope TEXT, require_issuer INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
ALTER TABLE hx_remote_mcp_oauth_states ADD COLUMN client_secret TEXT NOT NULL DEFAULT '';
ALTER TABLE hx_remote_mcp_oauth_states ADD COLUMN token_auth_method TEXT NOT NULL DEFAULT 'none';
ALTER TABLE hx_remote_mcp_oauth_states ADD COLUMN redirect_uri TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS hx_remote_mcp_oauth_states_expiry ON hx_remote_mcp_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS hx_workspace_file_origins (org_id TEXT NOT NULL, file_id TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('human','agent')), PRIMARY KEY(org_id,file_id), FOREIGN KEY(org_id,file_id) REFERENCES hx_workspace_files(org_id,id) ON DELETE CASCADE);

CREATE TABLE IF NOT EXISTS hx_app_annotations (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, table_id TEXT NOT NULL DEFAULT '', row_id TEXT NOT NULL DEFAULT '', message_source TEXT NOT NULL CHECK(message_source IN ('app','channel')), message_id TEXT NOT NULL, target TEXT NOT NULL, x REAL NOT NULL CHECK(x BETWEEN 0 AND 100), y REAL NOT NULL CHECK(y BETWEEN 0 AND 100), section TEXT NOT NULL CHECK(section IN ('overview','data')), author_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(org_id,app_id,message_source,message_id));
CREATE INDEX IF NOT EXISTS idx_hx_app_annotations_screen ON hx_app_annotations(org_id,app_id,table_id,row_id,section,created_at);

-- Durable, independent live and notification preparation for accepted sends.
CREATE TABLE IF NOT EXISTS channel_message_delivery (org_id TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('live','push')), business_created_at TEXT, allow_virtual INTEGER NOT NULL DEFAULT 0 CHECK(allow_virtual IN (0,1)), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','failed')), attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(org_id,message_id,kind));
CREATE INDEX IF NOT EXISTS idx_channel_message_delivery_due ON channel_message_delivery(kind,status,next_attempt,lease_until);

CREATE TABLE IF NOT EXISTS mcp_oauth_clients ( id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL, disabled_at INTEGER );
CREATE INDEX IF NOT EXISTS mcp_oauth_clients_owner ON mcp_oauth_clients(owner_id);
CREATE TABLE IF NOT EXISTS mcp_oauth_requests ( id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, resource TEXT NOT NULL, scopes TEXT NOT NULL, state TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER );
CREATE TABLE IF NOT EXISTS mcp_oauth_grants ( id TEXT PRIMARY KEY, client_id TEXT NOT NULL, org_id TEXT NOT NULL, user_id TEXT NOT NULL, membership_since TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT NOT NULL, sso_backed INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER );
CREATE INDEX IF NOT EXISTS mcp_oauth_grants_user ON mcp_oauth_grants(user_id, org_id);
CREATE TABLE IF NOT EXISTS mcp_oauth_codes ( code_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, resource TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER );
CREATE TABLE IF NOT EXISTS mcp_oauth_tokens ( token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('access','refresh')), expires_at INTEGER NOT NULL, consumed_at INTEGER );
CREATE INDEX IF NOT EXISTS mcp_oauth_tokens_grant ON mcp_oauth_tokens(grant_id);
CREATE TABLE IF NOT EXISTS mcp_content_mutations ( org_id TEXT NOT NULL, actor_id TEXT NOT NULL, connection_id TEXT NOT NULL, request_id TEXT NOT NULL, operation TEXT NOT NULL, payload_hash TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (org_id, actor_id, connection_id, request_id) );
CREATE TABLE IF NOT EXISTS mcp_file_uploads ( id TEXT PRIMARY KEY, org_id TEXT NOT NULL, actor_id TEXT NOT NULL, connection_id TEXT NOT NULL, conversation TEXT NOT NULL, name TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','uploading','uploaded','complete','failed')), file_id TEXT, expires_at INTEGER NOT NULL );

CREATE TABLE IF NOT EXISTS mcp_scheduled_authority ( scheduled_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, membership_since TEXT NOT NULL, token_id TEXT, grant_id TEXT, CHECK ((token_id IS NULL) != (grant_id IS NULL)) );

CREATE INDEX IF NOT EXISTS mcp_oauth_requests_expiry ON mcp_oauth_requests(expires_at);
CREATE INDEX IF NOT EXISTS mcp_oauth_codes_expiry ON mcp_oauth_codes(expires_at);
CREATE INDEX IF NOT EXISTS mcp_oauth_tokens_expiry ON mcp_oauth_tokens(expires_at);
CREATE INDEX IF NOT EXISTS mcp_oauth_grants_expiry ON mcp_oauth_grants(expires_at);

CREATE TABLE IF NOT EXISTS mcp_conversation_requests ( org_id TEXT NOT NULL, user_id TEXT NOT NULL, connection_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, membership_since TEXT NOT NULL, channel TEXT, creation_nonce TEXT, created_at TEXT NOT NULL, PRIMARY KEY (org_id, user_id, connection_id, request_id) );

CREATE TABLE IF NOT EXISTS hx_app_connection_grants (org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, connection_owner_id TEXT NOT NULL, connection_name TEXT NOT NULL, connection_version INTEGER NOT NULL, owner_membership_since TEXT NOT NULL, source_agent_id TEXT NOT NULL, endpoint TEXT NOT NULL, method TEXT NOT NULL, granted_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(org_id,app_id,connection_owner_id,connection_name));
CREATE INDEX IF NOT EXISTS idx_hx_app_connection_grants_target ON hx_app_connection_grants(org_id,app_id,connection_name);
CREATE TABLE IF NOT EXISTS hx_app_domains (org_id TEXT NOT NULL, app_id TEXT NOT NULL UNIQUE REFERENCES hx_apps(id) ON DELETE CASCADE, hostname TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('configuring','initializing','pending','active','deactivated','blocked','error')), validation_status TEXT NOT NULL DEFAULT 'pending', verification_status TEXT NOT NULL DEFAULT 'pending', error_message TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(org_id,app_id));
CREATE TABLE IF NOT EXISTS hx_app_domain_public_consents (org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, hostname TEXT NOT NULL, domain_created_at TEXT NOT NULL, confirmed_by TEXT NOT NULL, confirmed_at TEXT NOT NULL, confirmation_version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(org_id,app_id));
CREATE TABLE IF NOT EXISTS hx_app_env_vars (org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, name TEXT NOT NULL, value TEXT NOT NULL, version INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(org_id,app_id,name));
CREATE TABLE IF NOT EXISTS hx_recurring_automation_offers (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_github_id TEXT NOT NULL, login TEXT NOT NULL, channel TEXT NOT NULL, thread_id TEXT NOT NULL, source_message_id TEXT NOT NULL, source_root_hash TEXT NOT NULL, prompt TEXT NOT NULL, prompt_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('offered','declined','created')), workflow_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(org_id,channel,user_github_id,prompt_hash));
CREATE INDEX IF NOT EXISTS hx_recurring_automation_offers_member ON hx_recurring_automation_offers(org_id,user_github_id,created_at DESC);
/* Optional dimensions for admin usage reports. Old calls remain unattributed. */
ALTER TABLE ai_calls ADD COLUMN room_slug TEXT;
ALTER TABLE ai_calls ADD COLUMN agent_id TEXT;
ALTER TABLE ai_calls ADD COLUMN workflow_id TEXT;
ALTER TABLE ai_calls ADD COLUMN app_id TEXT;
ALTER TABLE hx_memory_scopes ADD COLUMN user_github_id TEXT;
ALTER TABLE hx_memory_scopes ADD COLUMN source_channel TEXT;
ALTER TABLE hx_memory_scopes ADD COLUMN source_message_id TEXT;
ALTER TABLE hx_memory_scopes ADD COLUMN source_thread_id TEXT;
/* Rebuild durable audit rows for surviving legacy review-history records. */
INSERT OR IGNORE INTO hx_memory_review_audit (id,memory_id,org_id,agent_id,channel,reviewed_version,verdict,evidence,reviewed_by,reviewed_at) SELECT h.id,h.memory_id,h.org_id,m.agent_id,COALESCE(s.channel,''),h.reviewed_version,h.verdict,h.evidence,h.reviewed_by,h.reviewed_at FROM hx_memory_review_history h JOIN hx_agent_memories m ON m.id=h.memory_id AND m.org_id=h.org_id LEFT JOIN hx_memory_scopes s ON s.memory_id=m.id AND s.org_id=m.org_id;

/* Durable review scope is backfilled only from a surviving source memory.
   Deleted legacy memories have no recoverable owner and remain undiscoverable. */
CREATE TABLE IF NOT EXISTS hx_memory_review_audit_scope (audit_id TEXT PRIMARY KEY REFERENCES hx_memory_review_audit(id) ON DELETE CASCADE, org_id TEXT NOT NULL, agent_id TEXT NOT NULL, memory_scope TEXT NOT NULL CHECK(memory_scope IN ('shared','conversation','person')), channel TEXT NOT NULL DEFAULT '', user_github_id TEXT);
CREATE INDEX IF NOT EXISTS idx_hx_memory_review_audit_scope_owner ON hx_memory_review_audit_scope(org_id,agent_id,user_github_id,channel,audit_id);
INSERT OR IGNORE INTO hx_memory_review_audit_scope (audit_id,org_id,agent_id,memory_scope,channel,user_github_id) SELECT a.id,a.org_id,a.agent_id,CASE WHEN s.user_github_id IS NOT NULL THEN 'person' WHEN COALESCE(s.channel,'')<>'' THEN 'conversation' ELSE 'shared' END,COALESCE(s.channel,''),s.user_github_id FROM hx_memory_review_audit a JOIN hx_agent_memories m ON m.id=a.memory_id AND m.org_id=a.org_id AND m.agent_id=a.agent_id LEFT JOIN hx_memory_scopes s ON s.memory_id=m.id AND s.org_id=m.org_id;
CREATE TRIGGER IF NOT EXISTS hx_memory_review_audit_scope_insert AFTER INSERT ON hx_memory_review_audit BEGIN INSERT OR IGNORE INTO hx_memory_review_audit_scope (audit_id,org_id,agent_id,memory_scope,channel,user_github_id) SELECT NEW.id,NEW.org_id,m.agent_id,CASE WHEN s.user_github_id IS NOT NULL THEN 'person' WHEN COALESCE(s.channel,'')<>'' THEN 'conversation' ELSE 'shared' END,COALESCE(s.channel,''),s.user_github_id FROM hx_agent_memories m LEFT JOIN hx_memory_scopes s ON s.memory_id=m.id AND s.org_id=m.org_id WHERE m.id=NEW.memory_id AND m.org_id=NEW.org_id; END;


CREATE TABLE IF NOT EXISTS hx_file_share_requests ( org_id TEXT NOT NULL,id TEXT NOT NULL,file_id TEXT NOT NULL,file_scope TEXT NOT NULL,file_version INTEGER NOT NULL, content_hash TEXT NOT NULL,content_type TEXT NOT NULL,size INTEGER NOT NULL,requester_id TEXT NOT NULL,requester_login TEXT NOT NULL, request_key TEXT NOT NULL,expires_at TEXT NOT NULL,allow_download INTEGER NOT NULL DEFAULT 0 CHECK(allow_download IN (0,1)), requester_membership TEXT,source_agent_id TEXT,source_message_id TEXT,source_scope TEXT,source_turn_hash TEXT,source_session_created_at TEXT, status TEXT NOT NULL CHECK(status IN ('pending','approved','declined','stale','cancelled')),approver_id TEXT,approver_login TEXT, decision_at TEXT,created_at TEXT NOT NULL,PRIMARY KEY(org_id,id),UNIQUE(org_id,requester_id,request_key), FOREIGN KEY(org_id,file_id) REFERENCES hx_workspace_files(org_id,id) ON DELETE CASCADE );
CREATE INDEX IF NOT EXISTS hx_file_share_requests_file ON hx_file_share_requests(org_id,file_id,created_at DESC);
CREATE TABLE IF NOT EXISTS hx_public_file_shares ( org_id TEXT NOT NULL,id TEXT NOT NULL,request_id TEXT NOT NULL,file_id TEXT NOT NULL,file_scope TEXT NOT NULL,file_version INTEGER NOT NULL, content_hash TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,allow_download INTEGER NOT NULL CHECK(allow_download IN (0,1)), created_by TEXT NOT NULL,created_login TEXT NOT NULL,created_at TEXT NOT NULL,revoked_at TEXT,revoked_by TEXT, PRIMARY KEY(org_id,id),UNIQUE(org_id,request_id),FOREIGN KEY(org_id,request_id) REFERENCES hx_file_share_requests(org_id,id) ON DELETE CASCADE, FOREIGN KEY(org_id,file_id,file_version) REFERENCES hx_workspace_file_versions(org_id,file_id,version) ON DELETE CASCADE );
CREATE INDEX IF NOT EXISTS hx_public_file_shares_file ON hx_public_file_shares(org_id,file_id,created_at DESC);
CREATE TABLE IF NOT EXISTS hx_file_share_audit ( org_id TEXT NOT NULL,id INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL,share_id TEXT,actor_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('proposed','approved','declined','revoked','expired','stale')),details TEXT NOT NULL,created_at TEXT NOT NULL );
CREATE INDEX IF NOT EXISTS hx_file_share_audit_request ON hx_file_share_audit(org_id,request_id,id);

CREATE INDEX IF NOT EXISTS hx_file_share_requests_source_turn ON hx_file_share_requests(org_id,source_message_id,source_agent_id);

CREATE TABLE IF NOT EXISTS hx_external_resource_grants (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, resource_type TEXT NOT NULL CHECK (resource_type IN ('workspace','room','thread','app','file')), resource_id TEXT NOT NULL CHECK (length(trim(resource_id)) BETWEEN 1 AND 200), recipient_github_id TEXT NOT NULL REFERENCES users(github_id) ON DELETE CASCADE, permission TEXT NOT NULL CHECK (permission IN ('view','edit')), granted_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, granted_at TEXT NOT NULL, expires_at TEXT CHECK (expires_at IS NULL OR expires_at > granted_at), revoked_at TEXT, revoked_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, CHECK (resource_type != 'workspace' OR resource_id = org_id));
CREATE UNIQUE INDEX IF NOT EXISTS idx_hx_external_resource_grants_active ON hx_external_resource_grants(org_id, resource_type, resource_id, recipient_github_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hx_external_resource_grants_recipient ON hx_external_resource_grants(org_id, recipient_github_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS hx_external_thread_send_requests (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, root_message_id TEXT NOT NULL, guest_github_id TEXT NOT NULL REFERENCES users(github_id) ON DELETE CASCADE, body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000), status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','cancelled')), requested_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, message_id TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hx_external_thread_send_requests_pending ON hx_external_thread_send_requests(org_id, root_message_id, guest_github_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_hx_external_thread_send_requests_owner ON hx_external_thread_send_requests(org_id, root_message_id, status, requested_at);

CREATE TABLE IF NOT EXISTS hx_external_thread_invites (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, resource_type TEXT NOT NULL CHECK(resource_type='thread'), resource_id TEXT NOT NULL CHECK(length(trim(resource_id)) BETWEEN 1 AND 200), invited_email TEXT NOT NULL CHECK(length(invited_email) BETWEEN 3 AND 254), permission TEXT NOT NULL CHECK(permission IN ('view','edit')), access_expires_at TEXT, token_hash TEXT NOT NULL UNIQUE, created_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at > created_at), redeemed_at TEXT, redeemed_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, created_grant_id TEXT REFERENCES hx_external_resource_grants(id) ON DELETE SET NULL, redemption_id TEXT UNIQUE, revoked_at TEXT, revoked_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, CHECK(access_expires_at IS NULL OR access_expires_at > created_at));
CREATE INDEX IF NOT EXISTS idx_hx_external_thread_invites_active ON hx_external_thread_invites(org_id,resource_id,expires_at) WHERE redeemed_at IS NULL AND revoked_at IS NULL;

ALTER TABLE channel_messages ADD COLUMN automation_offer_id TEXT;
CREATE TABLE IF NOT EXISTS hx_user_dictation_preferences (org_id TEXT NOT NULL, user_id TEXT NOT NULL, vocabulary TEXT NOT NULL DEFAULT '[]', corrections TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), updated_at TEXT NOT NULL, PRIMARY KEY (org_id,user_id), FOREIGN KEY (org_id,user_id) REFERENCES memberships(org_id,user_github_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS hx_user_dictation_accounts (user_id TEXT PRIMARY KEY REFERENCES users(github_id) ON DELETE CASCADE, vocabulary TEXT NOT NULL DEFAULT '[]', corrections TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), updated_at TEXT NOT NULL);
INSERT OR IGNORE INTO hx_user_dictation_accounts (user_id,vocabulary,corrections,revision,updated_at) SELECT legacy.user_id,COALESCE((SELECT json_group_array(word) FROM (SELECT MIN(j.value) AS word,MAX(o.updated_at) AS latest FROM hx_user_dictation_preferences o JOIN json_each(CASE WHEN json_valid(o.vocabulary) THEN o.vocabulary ELSE '[]' END) j WHERE o.user_id=legacy.user_id AND j.type='text' GROUP BY lower(j.value) ORDER BY latest DESC,word LIMIT 100)),'[]'),COALESCE((SELECT json_group_array(json(item)) FROM (SELECT item FROM (SELECT json_object('from',json_extract(j.value,'$.from'),'to',json_extract(j.value,'$.to')) AS item,lower(json_extract(j.value,'$.from')) AS source,o.updated_at,ROW_NUMBER() OVER (PARTITION BY lower(json_extract(j.value,'$.from')) ORDER BY o.updated_at DESC,o.rowid DESC) AS rank FROM hx_user_dictation_preferences o JOIN json_each(CASE WHEN json_valid(o.corrections) THEN o.corrections ELSE '[]' END) j WHERE o.user_id=legacy.user_id AND json_type(j.value,'$.from')='text' AND json_type(j.value,'$.to')='text') WHERE rank=1 ORDER BY updated_at DESC,item LIMIT 100)),'[]'),MAX(legacy.revision),MAX(legacy.updated_at) FROM hx_user_dictation_preferences legacy JOIN users u ON u.github_id=legacy.user_id GROUP BY legacy.user_id;
DROP TABLE IF EXISTS hx_user_dictation_preferences;


CREATE TABLE IF NOT EXISTS hx_user_draft_style_preferences (org_id TEXT NOT NULL,user_github_id TEXT NOT NULL,source_app TEXT NOT NULL DEFAULT 'general',preference_key TEXT NOT NULL,preference_text TEXT NOT NULL,source_card_id TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY (org_id,user_github_id,source_app,preference_key),FOREIGN KEY (org_id,user_github_id) REFERENCES memberships(org_id,user_github_id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_hx_user_draft_style_preferences_user ON hx_user_draft_style_preferences(org_id,user_github_id,source_app,updated_at DESC);

/* Private, short-lived reply-draft edits that an Agent sees only with the
   member's next message to that exact Agent. Draft text is never sent outside
   the workspace; the bounded changed span is deleted once attached/consumed. */
CREATE TABLE IF NOT EXISTS hx_agent_draft_edit_pending (org_id TEXT NOT NULL,user_github_id TEXT NOT NULL,agent_id TEXT NOT NULL,card_id TEXT NOT NULL,removed_text TEXT NOT NULL DEFAULT '',added_text TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,expires_at TEXT NOT NULL,PRIMARY KEY(org_id,user_github_id,agent_id,card_id),FOREIGN KEY(org_id,user_github_id) REFERENCES memberships(org_id,user_github_id) ON DELETE CASCADE,FOREIGN KEY(org_id,agent_id) REFERENCES custom_agents(org_id,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_hx_agent_draft_edit_pending_next ON hx_agent_draft_edit_pending(org_id,user_github_id,agent_id,expires_at);
CREATE TABLE IF NOT EXISTS hx_agent_draft_edit_context (org_id TEXT NOT NULL,message_id TEXT NOT NULL,user_github_id TEXT NOT NULL,agent_id TEXT NOT NULL,card_id TEXT NOT NULL,removed_text TEXT NOT NULL DEFAULT '',added_text TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,expires_at TEXT NOT NULL,PRIMARY KEY(org_id,message_id,agent_id,card_id),FOREIGN KEY(org_id,user_github_id) REFERENCES memberships(org_id,user_github_id) ON DELETE CASCADE,FOREIGN KEY(org_id,agent_id) REFERENCES custom_agents(org_id,id) ON DELETE CASCADE);



CREATE TABLE IF NOT EXISTS hx_external_app_invites (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, resource_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, invited_email TEXT NOT NULL CHECK(length(invited_email) BETWEEN 3 AND 254), permission TEXT NOT NULL CHECK(permission IN ('view','edit')), access_expires_at TEXT, token_hash TEXT NOT NULL UNIQUE, created_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at > created_at), redeemed_at TEXT, redeemed_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, created_grant_id TEXT REFERENCES hx_external_resource_grants(id) ON DELETE SET NULL, redemption_id TEXT UNIQUE, revoked_at TEXT, revoked_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, CHECK(access_expires_at IS NULL OR access_expires_at > created_at));
CREATE INDEX IF NOT EXISTS idx_hx_external_app_invites_active ON hx_external_app_invites(org_id,resource_id,expires_at) WHERE redeemed_at IS NULL AND revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS hx_external_app_send_requests (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, table_id TEXT NOT NULL DEFAULT '', row_id TEXT NOT NULL DEFAULT '', guest_github_id TEXT NOT NULL REFERENCES users(github_id) ON DELETE CASCADE, body TEXT NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 4000), status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','cancelled')), requested_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, message_id TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hx_external_app_send_requests_pending ON hx_external_app_send_requests(org_id,app_id,table_id,row_id,guest_github_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_hx_external_app_send_requests_owner ON hx_external_app_send_requests(org_id,app_id,status,requested_at);
CREATE TABLE IF NOT EXISTS hx_app_commit_approvals ( id TEXT PRIMARY KEY, org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, app_version INTEGER NOT NULL CHECK(app_version>0), repo_owner TEXT NOT NULL, repo_name TEXT NOT NULL, branch_name TEXT NOT NULL, commit_sha TEXT NOT NULL, file_path TEXT NOT NULL, source_hash TEXT NOT NULL, visibility_scope TEXT NOT NULL CHECK(visibility_scope IN ('workspace','private')), access_version INTEGER NOT NULL DEFAULT 0, domain_scope TEXT NOT NULL DEFAULT '', requested_by TEXT NOT NULL, reviewer_id TEXT, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','revoked','published')), created_at TEXT NOT NULL, reviewed_at TEXT, consumed_at TEXT );
CREATE INDEX IF NOT EXISTS hx_app_commit_approvals_current ON hx_app_commit_approvals(org_id,app_id,status,app_version);
CREATE UNIQUE INDEX IF NOT EXISTS hx_app_commit_approvals_one_open ON hx_app_commit_approvals(org_id,app_id,app_version,repo_owner,repo_name,branch_name,commit_sha,file_path,source_hash,visibility_scope,access_version,domain_scope) WHERE status IN ('pending','approved');
CREATE TRIGGER IF NOT EXISTS hx_app_commit_revoke_reviewer_demotion AFTER UPDATE OF role ON memberships WHEN OLD.role IN ('owner','admin') AND NEW.role NOT IN ('owner','admin') BEGIN UPDATE hx_app_commit_approvals SET status='revoked',reviewed_at=datetime('now') WHERE org_id=OLD.org_id AND reviewer_id=OLD.user_github_id AND status='approved' AND consumed_at IS NULL; END;
CREATE TRIGGER IF NOT EXISTS hx_app_commit_revoke_reviewer_removal AFTER DELETE ON memberships WHEN OLD.role IN ('owner','admin') BEGIN UPDATE hx_app_commit_approvals SET status='revoked',reviewed_at=datetime('now') WHERE org_id=OLD.org_id AND reviewer_id=OLD.user_github_id AND status='approved' AND consumed_at IS NULL; END;
CREATE TRIGGER IF NOT EXISTS hx_app_commit_revoke_requester_demotion AFTER UPDATE OF role ON memberships WHEN OLD.role<>'guest' AND NEW.role='guest' BEGIN UPDATE hx_app_commit_approvals SET status='revoked',reviewed_at=datetime('now') WHERE org_id=OLD.org_id AND requested_by=OLD.user_github_id AND status IN ('pending','approved') AND consumed_at IS NULL; END;
CREATE TRIGGER IF NOT EXISTS hx_app_commit_revoke_requester_removal AFTER DELETE ON memberships BEGIN UPDATE hx_app_commit_approvals SET status='revoked',reviewed_at=datetime('now') WHERE org_id=OLD.org_id AND requested_by=OLD.user_github_id AND status IN ('pending','approved') AND consumed_at IS NULL; END;
CREATE TABLE IF NOT EXISTS hx_app_record_proposals (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, table_id TEXT NOT NULL, row_id TEXT NOT NULL, request_message_id INTEGER NOT NULL REFERENCES hx_app_messages(sequence) ON DELETE CASCADE, reply_message_id INTEGER NOT NULL REFERENCES hx_app_messages(sequence) ON DELETE CASCADE, requested_by TEXT NOT NULL, changes TEXT NOT NULL, before_data TEXT NOT NULL, expected_updated_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','applying','applied','rejected','stale','undone')), expires_at TEXT NOT NULL, created_at TEXT NOT NULL, reviewed_by TEXT, reviewed_at TEXT, applied_updated_at TEXT, undone_by TEXT, undone_at TEXT);
CREATE INDEX IF NOT EXISTS idx_hx_app_record_proposals_scope ON hx_app_record_proposals(org_id,app_id,table_id,row_id,created_at);
CREATE TRIGGER IF NOT EXISTS hx_app_commit_consume_approved_publish AFTER UPDATE OF definition ON hx_apps WHEN json_extract(NEW.definition,'$.custom.publishedCommitApprovalId') IS NOT NULL AND json_extract(OLD.definition,'$.custom.publishedCommitApprovalId') IS NOT json_extract(NEW.definition,'$.custom.publishedCommitApprovalId') BEGIN UPDATE hx_app_commit_approvals SET status='published',consumed_at=json_extract(NEW.definition,'$.custom.publishedAt'),reviewed_at=COALESCE(reviewed_at,json_extract(NEW.definition,'$.custom.publishedAt')) WHERE org_id=NEW.org_id AND app_id=NEW.id AND id=json_extract(NEW.definition,'$.custom.publishedCommitApprovalId') AND app_version=OLD.version AND repo_owner=json_extract(NEW.definition,'$.custom.publishedCommit.owner') AND repo_name=json_extract(NEW.definition,'$.custom.publishedCommit.repo') AND branch_name=json_extract(NEW.definition,'$.custom.publishedCommit.branch') AND commit_sha=json_extract(NEW.definition,'$.custom.publishedCommit.sha') AND file_path=json_extract(NEW.definition,'$.custom.publishedCommit.path') AND source_hash=json_extract(NEW.definition,'$.custom.publishedCommit.sourceHash') AND status='approved' AND consumed_at IS NULL AND requested_by<>reviewer_id AND reviewer_id<>json_extract(NEW.definition,'$.custom.publishedBy') AND json_extract(NEW.definition,'$.custom.published')=json_extract(OLD.definition,'$.custom.draft') AND json_extract(NEW.definition,'$.custom.publishedCommit.sha')=json_extract(OLD.definition,'$.custom.draftCommit.sha') AND json_extract(NEW.definition,'$.custom.publishedCommit.sourceHash')=json_extract(OLD.definition,'$.custom.draftCommit.sourceHash') AND visibility_scope=COALESCE((SELECT visibility FROM hx_app_access WHERE org_id=NEW.org_id AND app_id=NEW.id),'workspace') AND access_version=COALESCE((SELECT version FROM hx_app_access WHERE org_id=NEW.org_id AND app_id=NEW.id),0) AND domain_scope=COALESCE((SELECT hostname||'#'||status FROM hx_app_domains WHERE org_id=NEW.org_id AND app_id=NEW.id),'') AND EXISTS(SELECT 1 FROM memberships r WHERE r.org_id=NEW.org_id AND r.user_github_id=reviewer_id AND r.role IN ('owner','admin')) AND EXISTS(SELECT 1 FROM memberships q WHERE q.org_id=NEW.org_id AND q.user_github_id=requested_by AND q.role<>'guest') AND EXISTS(SELECT 1 FROM memberships p WHERE p.org_id=NEW.org_id AND p.user_github_id=json_extract(NEW.definition,'$.custom.publishedBy') AND p.role<>'guest') AND (NEW.created_by=json_extract(NEW.definition,'$.custom.publishedBy') OR EXISTS(SELECT 1 FROM memberships admin WHERE admin.org_id=NEW.org_id AND admin.user_github_id=json_extract(NEW.definition,'$.custom.publishedBy') AND admin.role IN ('owner','admin'))); SELECT CASE WHEN changes()<>1 THEN RAISE(ROLLBACK,'Custom commit approval could not be consumed atomically') END; END;

CREATE TABLE IF NOT EXISTS hx_app_git_assets ( org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, app_version INTEGER NOT NULL CHECK(app_version>0), commit_sha TEXT NOT NULL, path TEXT NOT NULL, content_type TEXT NOT NULL, content_bytes BLOB NOT NULL, content_hash TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0), PRIMARY KEY(org_id,app_id,app_version,commit_sha,path) );
CREATE INDEX IF NOT EXISTS hx_app_git_assets_commit ON hx_app_git_assets(org_id,app_id,commit_sha,app_version);
CREATE TRIGGER IF NOT EXISTS hx_app_git_assets_immutable BEFORE UPDATE ON hx_app_git_assets BEGIN SELECT RAISE(ABORT,'Git commit assets are immutable'); END;
CREATE TABLE IF NOT EXISTS hx_agent_tool_traces (org_id TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE, agent_id TEXT NOT NULL, channel TEXT NOT NULL, run_by TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms BETWEEN 0 AND 86400000), steps_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(org_id, message_id));
CREATE INDEX IF NOT EXISTS idx_agent_tool_traces_access ON hx_agent_tool_traces(org_id, channel, agent_id, message_id);

CREATE TABLE IF NOT EXISTS hx_agent_workspace_source_grants (org_id TEXT NOT NULL, agent_id TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('github')), granted_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (org_id, agent_id, source), FOREIGN KEY (org_id, agent_id) REFERENCES custom_agents(org_id, id) ON DELETE CASCADE);

CREATE TABLE IF NOT EXISTS hx_external_file_invites ( id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, file_id TEXT NOT NULL, invited_email TEXT NOT NULL CHECK(length(trim(invited_email)) BETWEEN 3 AND 254), permission TEXT NOT NULL CHECK(permission='view'), access_expires_at TEXT, token_hash TEXT NOT NULL UNIQUE, created_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at>created_at), redemption_id TEXT UNIQUE, redeemed_at TEXT, redeemed_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, created_grant_id TEXT REFERENCES hx_external_resource_grants(id) ON DELETE SET NULL, revoked_at TEXT, revoked_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, FOREIGN KEY(org_id,file_id) REFERENCES hx_workspace_files(org_id,id) ON DELETE CASCADE );
CREATE INDEX IF NOT EXISTS idx_hx_external_file_invites_active ON hx_external_file_invites(org_id,file_id,revoked_at,expires_at);
CREATE INDEX IF NOT EXISTS idx_hx_external_file_invites_redeemed ON hx_external_file_invites(org_id,redeemed_by,redeemed_at);
CREATE TABLE IF NOT EXISTS hx_external_file_invites_v2 ( id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, file_id TEXT NOT NULL, invited_email TEXT NOT NULL CHECK(length(trim(invited_email)) BETWEEN 3 AND 254), permission TEXT NOT NULL CHECK(permission IN ('view','edit')), access_expires_at TEXT, token_hash TEXT NOT NULL UNIQUE, created_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at>created_at), redemption_id TEXT UNIQUE, redeemed_at TEXT, redeemed_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, created_grant_id TEXT REFERENCES hx_external_resource_grants(id) ON DELETE SET NULL, revoked_at TEXT, revoked_by TEXT REFERENCES users(github_id) ON DELETE SET NULL, FOREIGN KEY(org_id,file_id) REFERENCES hx_workspace_files(org_id,id) ON DELETE CASCADE );
INSERT OR IGNORE INTO hx_external_file_invites_v2(id,org_id,file_id,invited_email,permission,access_expires_at,token_hash,created_by,created_at,expires_at,redemption_id,redeemed_at,redeemed_by,created_grant_id,revoked_at,revoked_by) SELECT id,org_id,file_id,invited_email,'view',access_expires_at,token_hash,created_by,created_at,expires_at,redemption_id,redeemed_at,redeemed_by,created_grant_id,revoked_at,revoked_by FROM hx_external_file_invites;
CREATE INDEX IF NOT EXISTS idx_hx_external_file_invites_v2_active ON hx_external_file_invites_v2(org_id,file_id,revoked_at,expires_at);
CREATE INDEX IF NOT EXISTS idx_hx_external_file_invites_v2_redeemed ON hx_external_file_invites_v2(org_id,redeemed_by,redeemed_at);

ALTER TABLE hx_workflow_runs ADD COLUMN credential_source TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE hx_app_access ADD COLUMN room_channel TEXT;

CREATE TABLE IF NOT EXISTS hx_app_public_shares (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, org_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES hx_apps(id) ON DELETE CASCADE, app_version INTEGER NOT NULL, access_version INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);
CREATE INDEX IF NOT EXISTS idx_hx_app_public_shares_app ON hx_app_public_shares(org_id,app_id,created_at);
CREATE TABLE IF NOT EXISTS hx_app_public_share_requests (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, app_id TEXT NOT NULL, requester_id TEXT NOT NULL, requester_login TEXT NOT NULL, agent_id TEXT NOT NULL, room_channel TEXT NOT NULL, source_message_id TEXT NOT NULL, source_thread_id TEXT, source_hash TEXT NOT NULL, app_version INTEGER NOT NULL, access_version INTEGER NOT NULL, assets_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','declined','stale')), created_at TEXT NOT NULL, reviewed_by TEXT, reviewed_at TEXT);
CREATE INDEX IF NOT EXISTS idx_hx_app_public_share_requests_app ON hx_app_public_share_requests(org_id,app_id,status,created_at);
CREATE TABLE IF NOT EXISTS hx_external_thread_link_shares (id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,resource_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,permission TEXT NOT NULL CHECK(permission IN ('view','edit')),token_hash TEXT NOT NULL UNIQUE,created_by TEXT REFERENCES users(github_id) ON DELETE SET NULL,created_at TEXT NOT NULL,expires_at TEXT,revoked_at TEXT,revoked_by TEXT REFERENCES users(github_id) ON DELETE SET NULL,CHECK(expires_at IS NULL OR expires_at>created_at));
CREATE INDEX IF NOT EXISTS idx_hx_external_thread_link_shares_active ON hx_external_thread_link_shares(org_id,resource_id,created_at) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS hx_external_thread_link_redemptions (link_id TEXT NOT NULL REFERENCES hx_external_thread_link_shares(id) ON DELETE CASCADE,recipient_github_id TEXT NOT NULL REFERENCES users(github_id) ON DELETE CASCADE,grant_id TEXT REFERENCES hx_external_resource_grants(id) ON DELETE SET NULL,redeemed_at TEXT NOT NULL,PRIMARY KEY(link_id,recipient_github_id));
CREATE TABLE IF NOT EXISTS hx_agent_agent_members (org_id TEXT NOT NULL, agent_id TEXT NOT NULL, member_agent_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role='member'), updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(org_id,agent_id,member_agent_id), CHECK(agent_id != member_agent_id), FOREIGN KEY(org_id,agent_id) REFERENCES custom_agents(org_id,id) ON DELETE CASCADE, FOREIGN KEY(org_id,member_agent_id) REFERENCES custom_agents(org_id,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_hx_agent_agent_members_peer ON hx_agent_agent_members(org_id,member_agent_id,agent_id);
CREATE TABLE IF NOT EXISTS hx_agent_wake_approvals (org_id TEXT NOT NULL,id TEXT NOT NULL,assignment_id TEXT NOT NULL,source_generation INTEGER NOT NULL,source_agent_id TEXT NOT NULL,target_agent_id TEXT NOT NULL,room_channel TEXT NOT NULL,thread_id TEXT NOT NULL,source_message_id TEXT NOT NULL,source_hash TEXT NOT NULL,requester_id TEXT NOT NULL,requester_login TEXT NOT NULL,requester_membership TEXT NOT NULL,operation_id TEXT NOT NULL,brief TEXT NOT NULL,message_body TEXT NOT NULL,card_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','approved','declined','expired','cancelled','revoked','consumed')),grant_scope TEXT CHECK(grant_scope IS NULL OR grant_scope IN ('once','ten_minutes','thread','room')),request_expires_at TEXT NOT NULL,expires_at TEXT,use_limit INTEGER,use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count>=0),created_at TEXT NOT NULL,decided_at TEXT,decided_by TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(org_id,id),UNIQUE(org_id,assignment_id,source_generation),UNIQUE(org_id,card_id),UNIQUE(org_id,operation_id),CHECK(source_agent_id!=target_agent_id),CHECK((grant_scope='once' AND use_limit=1) OR (grant_scope IS NULL AND use_limit IS NULL) OR (grant_scope IN ('ten_minutes','thread','room') AND use_limit IS NULL)),CHECK(expires_at IS NULL OR expires_at>created_at));
CREATE INDEX IF NOT EXISTS idx_hx_agent_wake_approvals_pending ON hx_agent_wake_approvals(org_id,requester_id,request_expires_at) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_hx_agent_wake_approvals_pair ON hx_agent_wake_approvals(org_id,source_agent_id,target_agent_id,status,expires_at);
CREATE TABLE IF NOT EXISTS hx_agent_wake_grants (org_id TEXT NOT NULL,id TEXT NOT NULL,approval_id TEXT NOT NULL,requester_id TEXT NOT NULL,requester_membership TEXT NOT NULL,source_agent_id TEXT NOT NULL,target_agent_id TEXT NOT NULL,room_channel TEXT NOT NULL,thread_id TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('once','ten_minutes','thread','room')),expires_at TEXT,use_limit INTEGER,use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count>=0),revoked_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(org_id,id),UNIQUE(org_id,approval_id),FOREIGN KEY(org_id,approval_id) REFERENCES hx_agent_wake_approvals(org_id,id),CHECK((scope='once' AND use_limit=1) OR (scope!='once' AND use_limit IS NULL)),CHECK(expires_at IS NULL OR expires_at>created_at));
CREATE INDEX IF NOT EXISTS idx_hx_agent_wake_grants_lookup ON hx_agent_wake_grants(org_id,requester_id,source_agent_id,target_agent_id,scope,expires_at) WHERE revoked_at IS NULL;

ALTER TABLE hx_agent_assignments ADD COLUMN actor_membership TEXT;
ALTER TABLE hx_agent_handoffs ADD COLUMN wake_grant_id TEXT;
