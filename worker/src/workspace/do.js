// One workspace's conversations in a SQLite database of its own — PoC-A of
// docs/architecture/discord-model-platform-plan.md (§4, §12).
//
// Everything here is keyed by channel, so a busy channel can later move to a
// Durable Object of its own by copying its rows (§6.1). Every channel has its
// own sequence: a client that knows the last `seq` it saw asks for what came
// after, which is what makes reconnecting after a deploy cheap (§9.3).
//
// The Worker decides who may do what, exactly as for the D1 routes
// (channelRoutes.js `inChannel`); this object is only reached with a checked
// member and a resolved channel. It never reads D1.
//
// Read positions are held in memory and written a few seconds later in one
// go: marking a channel read is the most frequent write a chat app makes, and
// rows written are what this storage is billed on (§5.3).

import { DurableObject } from "cloudflare:workers";

const SCHEMA = [
  // v1
  [
    `CREATE TABLE messages (
       id         TEXT PRIMARY KEY,
       channel_id TEXT NOT NULL,
       seq        INTEGER NOT NULL,
       author     TEXT,
       kind       TEXT NOT NULL DEFAULT 'message',
       body       TEXT NOT NULL,
       parent_id  TEXT,
       created_at TEXT NOT NULL,
       edited_at  TEXT,
       deleted_at TEXT
     )`,
    "CREATE UNIQUE INDEX messages_by_seq ON messages (channel_id, seq)",
    "CREATE TABLE channel_seq (channel_id TEXT PRIMARY KEY, seq INTEGER NOT NULL)",
    `CREATE TABLE reads (
       login      TEXT NOT NULL,
       channel_id TEXT NOT NULL,
       seq        INTEGER NOT NULL,
       PRIMARY KEY (login, channel_id)
     ) WITHOUT ROWID`,
    // Trigram, so words in Japanese (no spaces) are found as well as English.
    `CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='messages', content_rowid='rowid', tokenize='trigram')`,
    `CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
       INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body);
     END`,
    `CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
       INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
     END`,
    `CREATE TRIGGER messages_au AFTER UPDATE OF body ON messages BEGIN
       INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
       INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body);
     END`,
  ],
];

const READ_FLUSH_MS = 3000;
const PAGE_MAX = 200;

/// A time-ordered id (UUIDv7): made here, sortable, no counter shared with
/// anything else.
export function uuidv7(now = Date.now()) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let ms = BigInt(now);
  for (let i = 5; i >= 0; i -= 1) { bytes[i] = Number(ms & 0xffn); ms >>= 8n; }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const toMessage = (r) => ({
  id: r.id, channel: r.channel_id, seq: r.seq, author: r.author, kind: r.kind,
  body: r.deleted_at ? "" : r.body, parentId: r.parent_id || null,
  createdAt: r.created_at, editedAt: r.edited_at || null, deletedAt: r.deleted_at || null,
});

export class WorkspaceDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.pendingReads = new Map(); // `${login}\n${channel}` -> seq
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  // The schema's version is kept in a row of its own (PRAGMA user_version is
  // not open to Durable Objects). Every change is a new entry in SCHEMA and
  // only ever adds: a deploy updates every object at once, so a column the
  // old code still reads is never dropped in the same deploy (§4.2).
  migrate() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS _schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)");
    const version = this.sql.exec("SELECT version FROM _schema WHERE id = 1").toArray()[0]?.version || 0;
    for (let v = version; v < SCHEMA.length; v += 1) {
      this.ctx.storage.transactionSync(() => {
        for (const stmt of SCHEMA[v]) this.sql.exec(stmt);
        this.sql.exec("INSERT INTO _schema (id, version) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version", v + 1);
      });
    }
  }

  // Rows read and written by one call, for the cost model's numbers.
  measure(fn) {
    const cursors = [];
    const exec = (...args) => { const c = this.sql.exec(...args); cursors.push(c); return c; };
    const result = fn(exec);
    const usage = cursors.reduce((u, c) => ({ rowsRead: u.rowsRead + c.rowsRead, rowsWritten: u.rowsWritten + c.rowsWritten }), { rowsRead: 0, rowsWritten: 0 });
    return { ...result, usage };
  }

  nextSeq(exec, channel) {
    return exec(
      `INSERT INTO channel_seq (channel_id, seq) VALUES (?, 1)
       ON CONFLICT (channel_id) DO UPDATE SET seq = seq + 1 RETURNING seq`, channel
    ).one().seq;
  }

  /// A new message in a channel. The caller has already been let in.
  post({ channel, author, body, parentId = null, now = Date.now() }) {
    return this.ctx.storage.transactionSync(() => this.measure((exec) => {
      const seq = this.nextSeq(exec, channel);
      const row = {
        id: uuidv7(now), channel_id: channel, seq, author, kind: "message", body: String(body),
        parent_id: parentId, created_at: new Date(now).toISOString(), edited_at: null, deleted_at: null,
      };
      exec(
        `INSERT INTO messages (id, channel_id, seq, author, kind, body, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.channel_id, row.seq, row.author, row.kind, row.body, row.parent_id, row.created_at
      );
      return { message: toMessage(row) };
    }));
  }

  /// A page of a channel: newest first before `before`, or oldest first
  /// after `after` (what a client catching up asks for).
  history({ channel, before = null, after = null, limit = 50 }) {
    const n = Math.max(1, Math.min(Number(limit) || 50, PAGE_MAX));
    return this.measure((exec) => {
      let rows;
      if (after !== null && after !== undefined) {
        rows = exec("SELECT * FROM messages WHERE channel_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?", channel, Number(after), n).toArray();
      } else if (before !== null && before !== undefined) {
        rows = exec("SELECT * FROM messages WHERE channel_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?", channel, Number(before), n).toArray().reverse();
      } else {
        rows = exec("SELECT * FROM messages WHERE channel_id = ? ORDER BY seq DESC LIMIT ?", channel, n).toArray().reverse();
      }
      const last = exec("SELECT seq FROM channel_seq WHERE channel_id = ?", channel).toArray()[0]?.seq || 0;
      return { messages: rows.map(toMessage), lastSeq: last };
    });
  }

  /// Apply the account-deletion policy to messages and read positions.
  forgetAccount({ login }) {
    if (typeof login !== "string" || !login) throw new Error("login required");
    this.ctx.storage.transactionSync(() => {
      // Match DM participants literally; usernames may contain SQL wildcards.
      const ownDM = "substr(channel_id, 1, 3) = 'dm:' AND (substr(channel_id, 4, length(?) + 1) = ? || '|' OR substr(channel_id, -(length(?) + 1)) = '|' || ?)";
      this.sql.exec(`DELETE FROM messages WHERE ${ownDM}`, login, login, login, login);
      this.sql.exec(`DELETE FROM reads WHERE login = ? OR (${ownDM})`, login, login, login, login, login);
      this.sql.exec(`DELETE FROM channel_seq WHERE ${ownDM}`, login, login, login, login);
      this.sql.exec("UPDATE messages SET author = NULL WHERE author = ?", login);
    });
    // An already scheduled alarm must not recreate the deleted read positions.
    for (const key of this.pendingReads.keys()) {
      const [reader, channel] = key.split("\n");
      if (reader === login || (channel.startsWith("dm:") && channel.slice(3).split("|").includes(login))) {
        this.pendingReads.delete(key);
      }
    }
    return { ok: true };
  }

  /// How far someone has read, noted now and written shortly.
  async markRead({ login, channel, seq }) {
    const k = `${login}\n${channel}`;
    const at = Number(seq) || 0;
    if ((this.pendingReads.get(k) || 0) >= at) return { ok: true };
    this.pendingReads.set(k, at);
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + READ_FLUSH_MS);
    return { ok: true };
  }

  flushReads() {
    if (!this.pendingReads.size) return { usage: { rowsRead: 0, rowsWritten: 0 } };
    const pending = [...this.pendingReads];
    this.pendingReads.clear();
    return this.ctx.storage.transactionSync(() => this.measure((exec) => {
      for (const [k, seq] of pending) {
        const [login, channel] = k.split("\n");
        exec(
          `INSERT INTO reads (login, channel_id, seq) VALUES (?, ?, ?)
           ON CONFLICT (login, channel_id) DO UPDATE SET seq = MAX(seq, excluded.seq)`, login, channel, seq
        );
      }
      return {};
    }));
  }

  async alarm() {
    this.flushReads();
  }

  /// Unread counts for one person across the channels given (the ones the
  /// Worker says they can see).
  unread({ login, channels }) {
    const wanted = [...new Set(channels || [])].slice(0, 500);
    if (!wanted.length) return { channels: [] };
    return this.measure((exec) => {
      const marks = wanted.map(() => "?").join(", ");
      const last = new Map(exec(`SELECT channel_id, seq FROM channel_seq WHERE channel_id IN (${marks})`, ...wanted).toArray().map((r) => [r.channel_id, r.seq]));
      const read = new Map(exec(`SELECT channel_id, seq FROM reads WHERE login = ? AND channel_id IN (${marks})`, login, ...wanted).toArray().map((r) => [r.channel_id, r.seq]));
      for (const [k, seq] of this.pendingReads) {
        const [l, c] = k.split("\n");
        if (l === login && seq > (read.get(c) || 0)) read.set(c, seq);
      }
      return {
        channels: wanted.filter((c) => last.has(c)).map((c) => ({
          channel: c, lastSeq: last.get(c), readSeq: read.get(c) || 0, unread: Math.max(0, last.get(c) - (read.get(c) || 0)),
        })),
      };
    });
  }

  /// Messages with the words asked, newest first, in the channels given.
  search({ q, channels, limit = 20 }) {
    const text = String(q || "").trim();
    const wanted = [...new Set(channels || [])].slice(0, 500);
    if (text.length < 3 || !wanted.length) return { hits: [] };
    const n = Math.max(1, Math.min(Number(limit) || 20, 50));
    return this.measure((exec) => {
      const marks = wanted.map(() => "?").join(", ");
      const phrase = `"${text.replace(/"/g, '""')}"`;
      const rows = exec(
        `SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
          WHERE messages_fts MATCH ? AND m.deleted_at IS NULL AND m.channel_id IN (${marks})
          ORDER BY m.created_at DESC LIMIT ?`, phrase, ...wanted, n
      ).toArray();
      return { hits: rows.map(toMessage) };
    });
  }

  /// Messages copied from D1, as they were: same ids, same times, a seq per
  /// channel in the order they were said. Safe to run twice.
  backfill({ rows }) {
    return this.ctx.storage.transactionSync(() => this.measure((exec) => {
      let copied = 0;
      for (const r of rows || []) {
        const exists = exec("SELECT 1 FROM messages WHERE id = ?", r.id).toArray().length;
        if (exists) continue;
        const seq = this.nextSeq(exec, r.channel);
        exec(
          `INSERT INTO messages (id, channel_id, seq, author, kind, body, parent_id, created_at, edited_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          r.id, r.channel, seq, r.author_login ?? null, r.kind || "message", r.body ?? "", r.parent_id ?? null,
          r.created_at, r.edited_at ?? null, r.deleted_at ?? null
        );
        copied += 1;
      }
      return { copied };
    }));
  }

  /// Rows as D1 now has them, from dual writing (store/mirror.js): new ones
  /// get the next seq in their channel, known ones take D1's words and state.
  /// `deletes` are rows D1 no longer has. Safe to repeat.
  mirror({ upserts = [], deletes = [] }) {
    return this.ctx.storage.transactionSync(() => this.measure((exec) => {
      let written = 0;
      for (const r of upserts) {
        const known = exec("SELECT body, edited_at, deleted_at, parent_id, author, kind FROM messages WHERE id = ?", r.id).toArray()[0];
        if (!known) {
          const seq = this.nextSeq(exec, r.channel);
          exec(
            `INSERT INTO messages (id, channel_id, seq, author, kind, body, parent_id, created_at, edited_at, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            r.id, r.channel, seq, r.author_login ?? null, r.kind || "message", r.body ?? "", r.parent_id ?? null,
            r.created_at, r.edited_at ?? null, r.deleted_at ?? null
          );
          written += 1;
          continue;
        }
        const same = known.body === (r.body ?? "") && (known.edited_at ?? null) === (r.edited_at ?? null)
          && (known.deleted_at ?? null) === (r.deleted_at ?? null) && (known.parent_id ?? null) === (r.parent_id ?? null)
          && (known.author ?? null) === (r.author_login ?? null) && known.kind === (r.kind || "message");
        if (same) continue;
        exec(
          "UPDATE messages SET body = ?, edited_at = ?, deleted_at = ?, parent_id = ?, author = ?, kind = ? WHERE id = ?",
          r.body ?? "", r.edited_at ?? null, r.deleted_at ?? null, r.parent_id ?? null, r.author_login ?? null, r.kind || "message", r.id
        );
        written += 1;
      }
      for (const id of deletes) {
        written += exec("DELETE FROM messages WHERE id = ?", id).rowsWritten ? 1 : 0;
      }
      return { written };
    }));
  }

  /// The rows with ids in (after, until], for comparing a range with D1.
  rows({ after = "", through, until }) {
    return this.sql.exec(
      "SELECT id, channel_id, body, created_at, edited_at, deleted_at FROM messages WHERE id > ? AND id <= ? AND created_at < ? ORDER BY id",
      after, through, until
    ).toArray();
  }

  /// One page of the count and digest of messages said before `until`, by id
  /// after `after` — the same page the Worker reads from D1 (v2.js).
  async checksum({ until, after = "", limit = 1000 }) {
    const rows = this.sql.exec(
      "SELECT id, channel_id, body, created_at, edited_at, deleted_at FROM messages WHERE created_at < ? AND id > ? ORDER BY id LIMIT ?",
      until, after, limit
    ).toArray();
    return { ...(await digest(rows.map(digestFields))), last: rows.length ? rows[rows.length - 1].id : null };
  }

  stats() {
    return {
      messages: this.sql.exec("SELECT COUNT(*) AS n FROM messages").one().n,
      channels: this.sql.exec("SELECT COUNT(*) AS n FROM channel_seq").one().n,
      bytes: this.ctx.storage.sql.databaseSize,
    };
  }
}

export const digestFields = (r) => [r.id, r.channel_id ?? r.channel, r.body, r.created_at, r.edited_at || "", r.deleted_at || ""];

/// SHA-256 over the rows, one line each, fields separated by a unit
/// separator. Both sides sort by id before calling.
export async function digest(rows) {
  const text = rows.map((f) => f.map((x) => String(x ?? "")).join("\u001f")).join("\n");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return { count: rows.length, hash: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("") };
}
