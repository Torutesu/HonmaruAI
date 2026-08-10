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
