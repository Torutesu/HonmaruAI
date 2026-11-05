// Display preferences are personal: one person's choice to keep the original
// Simple face must never change the workspace mode for anybody else.
export async function getDisplayPreference(db, orgId, userId) {
  const row = await db.prepare(`SELECT simple_only AS simpleOnly,revision
    FROM hx_user_display_preferences WHERE org_id=?1 AND user_id=?2`)
    .bind(orgId,String(userId)).first();
  return { simpleOnly: row?.simpleOnly === 1, revision: Number(row?.revision || 0) };
}

export async function setDisplayPreference(db, orgId, userId, simpleOnly, expectedRevision, now = new Date().toISOString()) {
  if (typeof simpleOnly !== 'boolean') return { error: 'simpleOnly must be true or false.', status: 400 };
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return { error: 'expectedRevision must be a non-negative integer.', status: 400 };

  // D1 batches are atomic. A missing preference is revision 0; seed it only
  // for that expected revision, then update existing rows only on an exact
  // revision match. Concurrent device writes cannot both win the same base.
  const [inserted, updated] = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO hx_user_display_preferences
        (org_id,user_id,simple_only,revision,updated_at)
      SELECT ?1,?2,?3,1,?4 WHERE ?5=0
      RETURNING simple_only AS simpleOnly,revision`)
      .bind(orgId,String(userId),simpleOnly ? 1 : 0,now,expectedRevision),
    db.prepare(`UPDATE hx_user_display_preferences SET
        simple_only=?3,revision=revision+1,updated_at=?4
      WHERE org_id=?1 AND user_id=?2 AND revision=?5
      RETURNING simple_only AS simpleOnly,revision`)
      .bind(orgId,String(userId),simpleOnly ? 1 : 0,now,expectedRevision),
  ]);
  const row = updated?.results?.[0] || inserted?.results?.[0];
  if (row) return { simpleOnly: row.simpleOnly === 1, revision: Number(row.revision || 0) };
  return {
    error: 'The display preference changed on another device.',
    code: 'stale_revision',
    status: 409,
    current: await getDisplayPreference(db, orgId, userId),
  };
}
