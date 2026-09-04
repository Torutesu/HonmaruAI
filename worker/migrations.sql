/* Schema changes that CREATE ... IF NOT EXISTS cannot express.

   schema.sql is replayed on every deploy and is safe because every statement
   there is idempotent. Adding a column to a table that already exists is not:
   CREATE TABLE IF NOT EXISTS is a no-op on a live table, so the column never
   appears, and anything depending on it — an index, a query — then fails.

   Only tables that already exist in production belong here. A brand new table
   (invites) is defined complete in schema.sql instead, so it needs no ALTER.

   D1 has no IF NOT EXISTS for ADD COLUMN, so replaying this on an already
   migrated database errors with "duplicate column name". That is the expected
   signal that there is nothing to do, not a failure. */

ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN password_salt TEXT;

/* Must come after the ALTER above: indexing a column that does not exist is
   the exact failure this file is here to prevent. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
