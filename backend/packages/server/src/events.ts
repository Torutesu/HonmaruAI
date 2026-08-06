import { OrgEvent, type EventType } from "@honmaru/protocol";
import type { Db } from "./db.js";
import { now } from "./ids.js";

interface EventRow {
  org_id: string;
  seq: number;
  type: string;
  actor_user_id: string | null;
  payload: string;
  created_at: string;
}

function toEvent(row: EventRow): OrgEvent {
  return OrgEvent.parse({
    seq: row.seq,
    orgId: row.org_id,
    type: row.type,
    actorUserId: row.actor_user_id,
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
  });
}

// Must be called inside the same transaction as the state change it records,
// so the log can never disagree with the tables it describes.
export function appendEvent(
  db: Db,
  orgId: string,
  type: EventType,
  actorUserId: string | null,
  payload: unknown
): OrgEvent {
  const seq =
    (
      db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE org_id = ?")
        .get(orgId) as { seq: number }
    ).seq + 1;
  const createdAt = now();
  db.prepare(
    `INSERT INTO events (org_id, seq, type, actor_user_id, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(orgId, seq, type, actorUserId, JSON.stringify(payload), createdAt);
  return toEvent({
    org_id: orgId,
    seq,
    type,
    actor_user_id: actorUserId,
    payload: JSON.stringify(payload),
    created_at: createdAt,
  });
}

export function listEventsSince(
  db: Db,
  orgId: string,
  sinceSeq: number,
  limit = 500
): OrgEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM events WHERE org_id = ? AND seq > ?
       ORDER BY seq ASC LIMIT ?`
    )
    .all(orgId, sinceSeq, limit) as EventRow[];
  return rows.map(toEvent);
}

export function currentSeq(db: Db, orgId: string): number {
  return (
    db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE org_id = ?")
      .get(orgId) as { seq: number }
  ).seq;
}
