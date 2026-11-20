// Which face a workspace shows (docs/kylon-gap-plan.md).
//
// "simple" is Honmaru as it always was: the decision feed and the chat.
// "harness" adds the Kylon-style surfaces — Apps, Tables, agents as members,
// Workflows, Follow-ups, Approvals, Skills. The mode only decides what the
// clients show: the harness routes answer in either mode, so switching back
// and forth never loses an app or a row.

export const MODES = ["simple", "harness"];
export const DEFAULT_MODE = "simple";

export async function getMode(db, orgId) {
  const row = await db.prepare("SELECT mode FROM org_settings WHERE org_id = ?1").bind(orgId).first();
  return MODES.includes(row?.mode) ? row.mode : DEFAULT_MODE;
}

export async function setMode(db, orgId, mode, by) {
  if (!MODES.includes(mode)) return { error: `mode must be one of ${MODES.join(", ")}` };
  // updated_at is also the authorization generation for mode-gated in-flight
  // work. Keep it strictly increasing even when two mode changes land in the
  // same clock millisecond (e.g. Harness → Simple → Harness).
  const previous = await db.prepare("SELECT updated_at FROM org_settings WHERE org_id = ?1").bind(orgId).first();
  const now = Date.now();
  const previousTime = Date.parse(previous?.updated_at || "");
  const updatedAt = new Date(Number.isFinite(previousTime) ? Math.max(now, previousTime + 1) : now).toISOString();
  await db
    .prepare(
      `INSERT INTO org_settings (org_id, mode, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(org_id) DO UPDATE SET mode = excluded.mode, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(orgId, mode, String(by), updatedAt)
    .run();
  return { mode };
}
