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
