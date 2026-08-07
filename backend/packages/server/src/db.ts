import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  github_user_id INTEGER UNIQUE,
  github_username TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  team_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS org_edges (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  sender_user_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  context TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  labels TEXT NOT NULL DEFAULT '[]',
  agent_route TEXT,
  routing_reason TEXT,
  source_instruction TEXT,
  revision_note TEXT,
  parent_card_id TEXT,
  due_at TEXT,
  escalated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_org_recipient
  ON cards(org_id, recipient_user_id);
CREATE INDEX IF NOT EXISTS idx_cards_org_sender
  ON cards(org_id, sender_user_id);

CREATE TABLE IF NOT EXISTS card_watchers (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (card_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_watchers_user ON card_watchers(user_id);

CREATE TABLE IF NOT EXISTS external_refs (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  integration TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT,
  state TEXT,
  PRIMARY KEY (card_id, integration)
);

CREATE TABLE IF NOT EXISTS events (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_user_id TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, seq)
);

CREATE TABLE IF NOT EXISTS card_messages (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  author_user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_card
  ON card_messages(card_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  card_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user
  ON notifications(user_id, org_id, read_at);

CREATE TABLE IF NOT EXISTS device_tokens (
  user_id TEXT NOT NULL REFERENCES users(id),
  platform TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, token)
);

CREATE TABLE IF NOT EXISTS agent_memories (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,           -- observation | preference
  content TEXT NOT NULL,
  source_card_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_user
  ON agent_memories(org_id, user_id, kind, created_at);

CREATE TABLE IF NOT EXISTS integration_configs (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (org_id, kind)
);
`;

export function openDb(path: string): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  // Additive migrations for databases created before a column existed.
  ensureColumn(db, "cards", "due_at", "TEXT");
  ensureColumn(db, "cards", "escalated_at", "TEXT");
  return db;
}

function ensureColumn(db: Db, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
