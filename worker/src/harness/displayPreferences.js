// Display preferences are personal: one person's choice to keep the original
// Simple face must never change the workspace mode for anybody else.
export async function getDisplayPreference(db, orgId, userId) {
  const row = await db.prepare(`SELECT simple_only AS simpleOnly,revision
    FROM hx_user_display_preferences WHERE org_id=?1 AND user_id=?2`)
    .bind(orgId,String(userId)).first();
  return { simpleOnly: row?.simpleOnly === 1, revision: Number(row?.revision || 0) };
}

export async function setDisplayPreference(db, orgId, userId, simpleOnly, now = new Date().toISOString()) {
  if (typeof simpleOnly !== 'boolean') return { error: 'simpleOnly must be true or false.', status: 400 };
  const row = await db.prepare(`INSERT INTO hx_user_display_preferences
      (org_id,user_id,simple_only,revision,updated_at)
    VALUES (?1,?2,?3,1,?4)
    ON CONFLICT(org_id,user_id) DO UPDATE SET
      simple_only=excluded.simple_only,
      revision=hx_user_display_preferences.revision+1,
      updated_at=excluded.updated_at
    RETURNING simple_only AS simpleOnly,revision`)
    .bind(orgId,String(userId),simpleOnly ? 1 : 0,now).first();
  return { simpleOnly: row?.simpleOnly === 1, revision: Number(row?.revision || 0) };
}
