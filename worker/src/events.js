// Append-only history of what happened to a decision card.
//
// Rows are never updated or deleted: a decision, a rollback, and a deletion are
// all just events, each carrying a snapshot of the card at that moment. That is
// what makes "what did this look like before the rollback?" answerable, and why
// deleting a card does not erase its past.

export async function appendCardEvent(db, orgId, { cardId, type, action, actorUserId, note, snapshot }) {
  await db
    .prepare(
      `INSERT INTO card_events (id, org_id, card_id, type, action, actor_user_id, note, snapshot, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(
      crypto.randomUUID(),
      orgId,
      cardId,
      type,
      action || null,
      actorUserId || null,
      note || null,
      JSON.stringify(snapshot ?? null),
      new Date().toISOString()
    )
    .run();
}

function toEvent(row) {
  return {
    id: row.id,
    cardId: row.card_id,
    type: row.type,
    action: row.action,
    actorUserId: row.actor_user_id,
    note: row.note,
    snapshot: JSON.parse(row.snapshot),
    createdAt: row.created_at,
  };
}

// Ordering ties on created_at are broken by rowid: several events can land in
// the same millisecond, and a scrambled timeline is worse than a slow one.
export async function listCardEvents(db, orgId, cardId) {
  const { results } = await db
    .prepare(
      `SELECT id, card_id, type, action, actor_user_id, note, snapshot, created_at
       FROM card_events WHERE org_id = ?1 AND card_id = ?2
       ORDER BY created_at ASC, rowid ASC`
    )
    .bind(orgId, cardId)
    .all();
  return results.map(toEvent);
}

export async function listOrgEvents(db, orgId, limit = 50) {
  const { results } = await db
    .prepare(
      `SELECT id, card_id, type, action, actor_user_id, note, snapshot, created_at
       FROM card_events WHERE org_id = ?1
       ORDER BY created_at DESC, rowid DESC LIMIT ?2`
    )
    .bind(orgId, limit)
    .all();
  return results.map(toEvent);
}
