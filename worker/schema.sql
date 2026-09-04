/* GENERATED FILE — do not edit.
   Built from migrations/ by `npm run schema:build`. Add a change as a new
   numbered migration and regenerate; editing here is a change production
   will never see. */

CREATE TABLE IF NOT EXISTS users (
  github_id     TEXT PRIMARY KEY,
  login         TEXT NOT NULL,
  name          TEXT,
  avatar_url    TEXT,
  locale        TEXT DEFAULT 'en',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orgs (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  org_id            TEXT NOT NULL,
  user_github_id    TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'member',
  created_at        TEXT NOT NULL,
  PRIMARY KEY (org_id, user_github_id)
);

CREATE TABLE IF NOT EXISTS agents (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  user_github_id    TEXT NOT NULL,
  display_name      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  org_id            TEXT NOT NULL,
  card_id           TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  sender_user_id    TEXT,
  created_at        TEXT NOT NULL,
  data              TEXT NOT NULL,
  status            TEXT,
  priority          TEXT,
  decided_at        TEXT,
  updated_at        TEXT,
  PRIMARY KEY (org_id, card_id)
);
CREATE INDEX IF NOT EXISTS idx_cards_recipient ON cards (org_id, recipient_user_id);
CREATE INDEX IF NOT EXISTS idx_cards_status ON cards (org_id, status);

CREATE TABLE IF NOT EXISTS contexts (
  org_id  TEXT NOT NULL,
  user_id TEXT NOT NULL,
  data    TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token               TEXT PRIMARY KEY,
  github_id           TEXT NOT NULL,
  github_access_token TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  expires_at          TEXT
);

/* One row per authorization attempt, deleted the moment it is redeemed. The
   redirect is a custom URL scheme, which iOS hands to any app that claims it,
   so an unguarded callback lets another app feed us a code and bind the session
   to its own account. The nonce is what makes the code ours.

   Block comments, not `--`: the tests load this file with newlines flattened to
   spaces, and a line comment would swallow the rest of the schema. */
CREATE TABLE IF NOT EXISTS oauth_states (
  state       TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

/* Fixed-window counters. Keyed by session token where there is one and by IP
   where there is not, so a signed-in user's budget follows them across networks
   and an anonymous one cannot be reset by reconnecting. */
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket      TEXT NOT NULL,
  subject     TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, subject, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);

CREATE TABLE IF NOT EXISTS card_events (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  card_id        TEXT NOT NULL,
  type           TEXT NOT NULL,
  action         TEXT,
  actor_user_id  TEXT,
  note           TEXT,
  snapshot       TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_card ON card_events (org_id, card_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_org ON card_events (org_id, created_at);

CREATE TABLE IF NOT EXISTS ingested_items (
  connector      TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  user_github_id TEXT NOT NULL,
  org_id         TEXT NOT NULL,
  card_id        TEXT,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (connector, external_id, user_github_id)
);

/* One row per device per user. Keyed by the token because that is what Apple
   makes unique, and because the same person on two phones must get both. The
   login is denormalized alongside the numeric id: the relay knows a recipient
   by their login and would otherwise need a join on the hot path of every
   card. */
CREATE TABLE IF NOT EXISTS device_tokens (
  device_token   TEXT PRIMARY KEY,
  user_github_id TEXT NOT NULL,
  login          TEXT NOT NULL,
  environment    TEXT NOT NULL DEFAULT 'production',
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_login ON device_tokens (login);

CREATE TABLE IF NOT EXISTS ai_usage (
  user_github_id TEXT NOT NULL,
  day            TEXT NOT NULL,
  used           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_github_id, day)
);

CREATE TABLE IF NOT EXISTS entitlements (
  user_github_id TEXT PRIMARY KEY,
  is_pro         INTEGER NOT NULL,
  checked_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_config (
  user_github_id TEXT NOT NULL,
  connector      TEXT NOT NULL,
  config         TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (user_github_id, connector)
);

/* Mailgun signs `timestamp + token`, never the body, so a signature that was
   valid once stays valid for anything you care to attach to it. Spending the
   token is what stops that. Rows are swept with the rate-limit windows. */
CREATE TABLE IF NOT EXISTS webhook_nonces (
  token      TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

/* What a person actually does here, as opposed to what GitHub lets them push.

   The org graph was the repository's permission list with the words changed:
   Admin, Maintainer, Engineer, Member. Nobody's responsibility — design,
   billing, the client relationship — was represented anywhere, so "route this
   to whoever it belongs to" had nothing to route by, and the manager edge the
   router looks for was never once emitted.

   Written by the person it describes. You know your own job, and a claim about
   who your manager is only makes sense in that direction. */
CREATE TABLE IF NOT EXISTS org_profiles (
  org_id            TEXT NOT NULL,
  user_github_id    TEXT NOT NULL,
  title             TEXT,
  responsibilities  TEXT,
  manager_login     TEXT,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (org_id, user_github_id)
);

/* Which connectors a person has actually linked.

   The scheduled sync used to look for a `connector_config` row, and the only
   thing that writes one is Notion's database picker — so anyone who connected
   Gmail or Slack and nothing else was never synced at all, by the loop whose
   whole reason for existing is that "your AI triaged three decisions overnight"
   cannot be true if the AI only runs while you are looking at it.

   `last_synced_at` is what stops the same fifty people being served every run
   while the fifty-first waits forever. */
CREATE TABLE IF NOT EXISTS connector_links (
  user_github_id TEXT NOT NULL,
  connector      TEXT NOT NULL,
  linked_at      TEXT NOT NULL,
  last_synced_at TEXT,
  PRIMARY KEY (user_github_id, connector)
);
CREATE INDEX IF NOT EXISTS idx_connector_links_user ON connector_links (user_github_id);

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

/* A decision could be overwritten by a stale copy of itself.

   Every write to a card is a read, a merge in JavaScript, and a write back,
   with two awaits on D1 in between — and a Durable Object releases its input
   gate across an external storage await. So two sockets belonging to the same
   person (a phone and an iPad, or the same phone reconnecting mid-decision)
   could both read the pending card, both merge their own change onto it, and
   both write. The second write won, silently, and the first decision was gone
   with no error anywhere.

   The worst case was not two devices. The recipient's AI rewrites an incoming
   card in the background: it re-reads the card to check nobody has answered
   yet, and then writes. A decision made in that window was overwritten by a
   rewrite of the question.

   `version` makes the write conditional on the read still being current. */
ALTER TABLE cards ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
