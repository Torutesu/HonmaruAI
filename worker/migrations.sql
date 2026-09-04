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

/* After the ALTER above, and never in schema.sql: that file runs first, so on a
   database predating the column this index would be created against a column
   that does not exist yet and fail the deploy. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
