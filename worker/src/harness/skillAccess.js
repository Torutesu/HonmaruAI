// Legacy skills have no policy row and retain workspace visibility.
export const skillSelect = `SELECT s.*, COALESCE(p.visibility, 'workspace') AS visibility,
  COALESCE(p.version, 0) AS access_version,
  COALESCE(NULLIF(TRIM(u.name), ''), u.login, '') AS created_by_name FROM hx_skills s
  LEFT JOIN hx_skill_access p ON p.org_id = s.org_id AND p.skill_id = s.id
  LEFT JOIN users u ON u.github_id = s.created_by`;
export const skillVisible = `(COALESCE(p.visibility, 'workspace') = 'workspace' OR s.created_by = ?3)`;

export async function setSkillAccess(db, orgId, id, userId, input) {
  const row = await db.prepare(`${skillSelect} WHERE s.org_id = ?1 AND s.id = ?2`).bind(orgId, id).first();
  if (!row || (row.visibility === 'private' && row.created_by !== String(userId))) return { error: 'No such skill.', status: 404 };
  if (row.created_by !== String(userId)) return { error: 'Only the skill owner can change sharing.', status: 403 };
  if (!['private', 'workspace'].includes(input.visibility)) return { error: 'Invalid visibility.' };
  if (!Number.isSafeInteger(input.version) || input.version < 0) return { error: 'A current access version is required.' };
  const r = input.version === 0
    ? await db.prepare('INSERT OR IGNORE INTO hx_skill_access (org_id, skill_id, visibility, version) VALUES (?1, ?2, ?3, 1)').bind(orgId, id, input.visibility).run()
    : await db.prepare('UPDATE hx_skill_access SET visibility = ?3, version = version + 1 WHERE org_id = ?1 AND skill_id = ?2 AND version = ?4').bind(orgId, id, input.visibility, input.version).run();
  if (!r.meta?.changes) return { error: 'Sharing changed. Reload before saving.', status: 409 };
  return { access: { visibility: input.visibility, version: input.version + 1 } };
}
