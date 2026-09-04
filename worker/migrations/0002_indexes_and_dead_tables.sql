/* Indexes for the queries that were scanning, and the removal of two tables
   nothing ever read.

   Every statement is written to be safe to re-run: this file may be applied to
   a database that has already had part of it applied by hand. */

/* `loadStore` is the join snapshot — the hot path of every connection. It reads
   the cards a person is party to, `recipient_user_id = ? OR sender_user_id = ?`,
   and only the recipient half had an index. The sender half was a table scan of
   the whole organization's decision history, on every join. */
CREATE INDEX IF NOT EXISTS idx_cards_sender ON cards (org_id, sender_user_id);

/* The cron finds each candidate's org with a correlated subquery on
   `user_github_id`. The primary key leads with `org_id`, so that subquery could
   not use it. */
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships (user_github_id);

/* Sessions are read by token (the primary key) on every request, but the cron
   groups them by github_id and the sweep deletes by expiry. Both were scans of
   a table that has a row per sign-in and now, finally, gets swept. */
CREATE INDEX IF NOT EXISTS idx_sessions_github_id ON sessions (github_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

/* "Has this decision already been written to Notion?" is asked before every
   write, keyed by user and card — neither of which leads the primary key. */
CREATE INDEX IF NOT EXISTS idx_ingested_user_card ON ingested_items (user_github_id, card_id);

/* One login, one account.

   `device_tokens` is keyed by login, and a card names its recipient by login.
   Two `users` rows claiming the same one is therefore a card delivered to the
   wrong phone — the failure this makes impossible rather than unlikely.

   A duplicate can only exist where a login was freed on GitHub and taken by
   somebody else while our row for the old owner was still standing. That row is
   stale by definition, so it is renamed out of the way rather than deleted: the
   account keeps its history, and its owner's next sign-in writes the right
   login back. */
UPDATE users SET login = login || '+stale-' || github_id
 WHERE rowid NOT IN (SELECT MAX(rowid) FROM users GROUP BY login);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login ON users (login);

/* `orgs` was created on day one and never written to. `agents` was written on
   every org-graph load and deleted on every membership change, and never once
   read: the agent nodes the app renders are derived from the collaborator list
   in `org.js`, which is where they should come from — an agent is not a thing
   with its own state, it is the fact that a person has one. */
DROP TABLE IF EXISTS orgs;
DROP TABLE IF EXISTS agents;
