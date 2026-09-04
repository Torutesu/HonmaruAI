CREATE TABLE IF NOT EXISTS users (
  github_id     TEXT PRIMARY KEY,
  login         TEXT NOT NULL,
  name          TEXT,
  avatar_url    TEXT,
  locale        TEXT DEFAULT 'en',
    created_at    TEXT NOT NULL,
  /* Email/password auth. NULL for GitHub users; set for email sign-ups.
     github_id is just the primary user id; email users get an "email:" id. */
  email         TEXT,
  password_hash TEXT,
  password_salt TEXT
);


/* login exists on every version of this table, so its index is safe here.
   The email index is not: on a database predating those columns this file is
   a no-op for them, and indexing a column that does not exist yet fails the
   whole step. It lives in migrations.sql, after the ALTER that adds it. */
/* IF NOT EXISTS skips a same-named index; it does not tolerate duplicate rows.
   schema.sql is replayed on every deploy with no error tolerance, so a single
   pre-existing duplicate would fail this statement and every deploy after it,
   until someone repaired the data by hand. Move any loser out of the way first:
   the cost of the collision is total and permanent, the insurance is one line. */
UPDATE users SET login = login || '+stale-' || github_id
 WHERE rowid NOT IN (SELECT MAX(rowid) FROM users GROUP BY login);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login ON users(login);

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

/* Team invite codes. A member creates a code for their org; anyone who
   redeems it joins that org. Kept simple: a code is reusable until deleted.
   Block comment (not --) so the test loader that flattens newlines is happy. */
CREATE TABLE IF NOT EXISTS invites (
  code           TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'member',
  created_at     TEXT NOT NULL,
  expires_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_invites_org ON invites (org_id);

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
