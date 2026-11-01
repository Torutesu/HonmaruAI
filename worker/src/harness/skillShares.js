import { createSkill } from './skills.js';
import { skillAgentManager } from './skillAgentAuthority.js';
import { skillSessionAuthority } from './skillSessionAuthority.js';
import { skillPolicyFingerprint, skillSsoDeadline } from './skillPolicyProof.js';
import { encodeSkillBytes, listSkillFiles, readSkillFile } from './skillFiles.js';
import { skillMarkdown } from './skillMarkdown.js';
import { MAX_SKILL_PACKAGE_BYTES, MAX_SKILL_PACKAGE_FILES, validateSkillPackage } from './skillPackage.js';
import { writeSkillZip } from './skillZip.js';

const now = () => new Date().toISOString();
const newId = () => `sshare_${crypto.randomUUID().replaceAll('-', '')}`;
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
const validToken = value => typeof value === 'string' && /^skl_[a-f0-9]{64}$/.test(value);
const parse = value => { try { return JSON.parse(value); } catch { return null; } };

export async function createSkillShare(db, orgId, skill, userId, { expiresInDays = 7, confirmAnyoneWithLink, memberSince, sessionToken = null, policyFingerprint = null, ssoDeadline = null } = {}) {
  if (!skill || skill.sourceScope) return { error: 'Only workspace custom Skills can be shared by link.', status: 409 };
  if (!skill.canShare) return { error: 'Only the Skill owner can create a share link.', status: 403 };
  if (confirmAnyoneWithLink !== true) return { error: 'Confirm that anyone with the link can inspect and download this Skill.', status: 400 };
  if (!skill.description?.trim()) return { error: 'Add a description before creating a share link.', status: 400 };
  if (memberSince === undefined) memberSince = (await db.prepare('SELECT created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(orgId, String(userId)).first())?.created_at;
  if (typeof memberSince !== 'string' || !memberSince) return { error: 'Skill or sharing permissions changed. Reload before sharing.', status: 409 };
  const days = Number(expiresInDays);
  if (![1, 7, 30, 90].includes(days)) return { error: 'Choose an expiry of 1, 7, 30 or 90 days.', status: 400 };
  const active = await db.prepare(`SELECT COUNT(*) AS count FROM hx_skill_shares
    WHERE org_id=?1 AND skill_id=?2 AND revoked_at IS NULL AND expires_at>?3`).bind(orgId, skill.id, now()).first();
  if (Number(active?.count || 0) >= 50) return { error: 'This Skill already has 50 active share links.', status: 409 };

  const entries = [{ path: 'SKILL.md', bytes: new TextEncoder().encode(skillMarkdown(skill)) }];
  for (const file of await listSkillFiles(db, orgId, skill.id, userId) || []) {
    const stored = await readSkillFile(db, orgId, skill.id, file.path, userId);
    if (!stored) return { error: 'Skill files changed. Reload before sharing.', status: 409 };
    entries.push(stored);
  }
  const checked = validateSkillPackage(entries);
  if (checked.error) return { error: checked.error, status: 409 };

  const id = newId();
  const token = `skl_${Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  const createdAt = now();
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  const snapshot = { format: 1, name: skill.name, description: skill.description || '', metadata: skill.metadata || {}, fileCount: entries.length, totalBytes: checked.totalBytes };
  const writes = [db.prepare(`INSERT INTO hx_skill_shares
    (id, org_id, skill_id, token_hash, snapshot, created_by, created_at, expires_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 FROM hx_skills s
    JOIN memberships m ON m.org_id=s.org_id AND m.user_github_id=?6 AND m.created_at=?14 AND LOWER(COALESCE(m.role,'guest'))!='guest'
    WHERE s.org_id=?2 AND s.id=?3 AND COALESCE(s.owner_id,s.created_by)=?6
      AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=s.org_id)
      AND NOT EXISTS(SELECT 1 FROM workspace_tombstones d WHERE d.org_id=s.org_id)
      AND ${skillSessionAuthority('?2', '?6', '?15')}
      AND (?16 IS NULL OR ${skillPolicyFingerprint('?2', '?6', '?15')}=?16)
      AND ${skillSsoDeadline('?17')}
      AND NOT EXISTS (SELECT 1 FROM hx_skill_source_scopes ss WHERE ss.org_id=s.org_id AND ss.skill_id=s.id)
      AND s.name=?9 AND COALESCE(s.description,'')=?10 AND s.body=?11 AND s.updated_at=?12
      AND CASE WHEN json_valid(s.metadata) THEN json(s.metadata)=json(?13) ELSE 0 END
      AND (SELECT COUNT(*) FROM hx_skill_shares sh WHERE sh.org_id=?2 AND sh.skill_id=?3
           AND sh.revoked_at IS NULL AND sh.expires_at>?7)<50`)
    .bind(id, orgId, skill.id, await digest(token), JSON.stringify(snapshot), String(userId), createdAt, expiresAt,
      skill.name, skill.description || '', skill.body, skill.updatedAt, JSON.stringify(skill.metadata || {}), memberSince, sessionToken, policyFingerprint, ssoDeadline),
  ...entries.map(file => db.prepare(`INSERT INTO hx_skill_share_files (share_id, path, size, content)
    SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM hx_skill_shares WHERE id=?1)`)
    .bind(id, file.path, file.bytes.byteLength, file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength)))];
  // The share and its files are committed atomically. Recheck the live owner,
  // membership, source scope, snapshot and link limit in the inserting SQL:
  // any of these can change while the package is being assembled.
  const results = await db.batch(writes);
  if (!results[0].meta?.changes) return { error: 'Skill or sharing permissions changed. Reload before sharing.', status: 409 };
  return { token, share: { id, createdAt, expiresAt, revokedAt: null, fileCount: entries.length, totalBytes: checked.totalBytes } };
}

export async function listSkillShares(db, orgId, skillId) {
  const { results = [] } = await db.prepare(`SELECT id, created_at AS createdAt, expires_at AS expiresAt,
    revoked_at AS revokedAt, snapshot FROM hx_skill_shares
    WHERE org_id=?1 AND skill_id=?2 ORDER BY created_at DESC LIMIT 50`).bind(orgId, skillId).all();
  return { shares: results.map(row => {
    const snapshot = parse(row.snapshot) || {};
    return { id: row.id, createdAt: row.createdAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt,
      fileCount: Number(snapshot.fileCount || 0), totalBytes: Number(snapshot.totalBytes || 0) };
  }) };
}

export async function revokeSkillShare(db, orgId, skillId, shareId) {
  const at = now();
  const result = await db.prepare(`UPDATE hx_skill_shares SET revoked_at=?1
    WHERE id=?2 AND org_id=?3 AND skill_id=?4 AND revoked_at IS NULL`).bind(at, shareId, orgId, skillId).run();
  if (!result.meta?.changes) return { error: 'No active Skill share link was found.', status: 404 };
  return { revoked: true, revokedAt: at };
}

// A route may await auditing after creation. Recheck authority at the final
// database boundary before returning the bearer token. If the actor lost it,
// revoke only this newly-created link in the same transaction as the check.
export async function finalizeSkillShare(db, orgId, skillId, userId, { token, share } = {}, memberSince, sessionToken = null, policyFingerprint = null, ssoDeadline = null) {
  if (!validToken(token) || !share?.id || typeof memberSince !== 'string' || !memberSince) return false;
  let tokenHash;
  try { tokenHash = await digest(token); }
  catch (error) {
    // The random share ID and the original org, skill and actor identify the
    // undelivered row even when hashing the bearer token itself fails.
    try { await db.prepare(`UPDATE hx_skill_shares SET revoked_at=?5
      WHERE id=?1 AND org_id=?2 AND skill_id=?3 AND created_by=?4 AND revoked_at IS NULL`)
      .bind(share.id, orgId, skillId, String(userId), now()).run(); } catch { /* No token is returned. */ }
    throw error;
  }
  const at = now();
  const allowed = `sh.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND EXISTS(SELECT 1 FROM hx_skills s
    JOIN memberships m ON m.org_id=s.org_id AND m.user_github_id=?4 AND m.created_at=?7 AND LOWER(COALESCE(m.role,'guest'))!='guest'
    WHERE s.org_id=sh.org_id AND s.id=sh.skill_id AND COALESCE(s.owner_id,s.created_by)=?4
      AND NOT EXISTS(SELECT 1 FROM hx_skill_source_scopes ss WHERE ss.org_id=s.org_id AND ss.skill_id=s.id))
    AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=sh.org_id)
    AND NOT EXISTS(SELECT 1 FROM workspace_tombstones d WHERE d.org_id=sh.org_id)
    AND ${skillSessionAuthority('?2', '?4', '?8')}
    AND (?9 IS NULL OR ${skillPolicyFingerprint('?2', '?4', '?8')}=?9)
    AND ${skillSsoDeadline('?10')}`;
  const identity = `sh.id=?1 AND sh.org_id=?2 AND sh.skill_id=?3 AND sh.created_by=?4 AND sh.token_hash=?5`;
  const args = [share.id, orgId, skillId, String(userId), tokenHash, at, memberSince, sessionToken, policyFingerprint, ssoDeadline];
  try {
    const results = await db.batch([
      db.prepare(`UPDATE hx_skill_shares AS sh SET revoked_at=?6 WHERE ${identity} AND sh.revoked_at IS NULL AND NOT (${allowed})`).bind(...args),
      db.prepare(`SELECT 1 AS ok FROM hx_skill_shares sh WHERE ${identity} AND sh.revoked_at IS NULL AND ${allowed}`).bind(...args),
    ]);
    return !!results[1]?.results?.length;
  } catch (error) {
    // The caller must not receive a token after an uncertain final check. If
    // D1 is available again, also retire this exact undelivered link so it
    // does not consume the owner's active-link allowance indefinitely.
    try { await db.prepare(`UPDATE hx_skill_shares AS sh SET revoked_at=?6 WHERE ${identity} AND sh.revoked_at IS NULL`).bind(...args.slice(0, 6)).run(); } catch { /* D1 is unavailable; the token was not returned. */ }
    throw error;
  }
}

async function activeShare(db, token) {
  if (!validToken(token)) return null;
  // Public preview has no authenticated workspace context. The random,
  // one-time bearer token is reduced to its unique SHA-256 hash before lookup;
  // the row still stores its owning org_id for all member-only operations.
  const row = await db.prepare(`SELECT s.id, s.org_id AS orgId, s.snapshot, s.expires_at AS expiresAt, s.revoked_at AS revokedAt
    FROM hx_skill_shares s WHERE s.token_hash=?1
      AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=s.org_id)
      AND NOT EXISTS(SELECT 1 FROM workspace_tombstones d WHERE d.org_id=s.org_id)`)
    .bind(await digest(token)).first();
  if (!row || row.revokedAt || row.expiresAt <= now()) return null;
  const snapshot = parse(row.snapshot);
  if (!snapshot || snapshot.format !== 1 || typeof snapshot.name !== 'string') return null;
  return { ...row, snapshot };
}

export async function readSkillShare(db, token) {
  const share = await activeShare(db, token);
  if (!share) return { error: 'This Skill share link is unavailable.', status: 404 };
  return { share: { name: share.snapshot.name, description: share.snapshot.description, metadata: share.snapshot.metadata,
    fileCount: share.snapshot.fileCount, totalBytes: share.snapshot.totalBytes, expiresAt: share.expiresAt } };
}

async function shareFiles(db, share) {
  const { results = [] } = await db.prepare('SELECT path, size FROM hx_skill_share_files WHERE share_id=?1 ORDER BY path LIMIT ?2').bind(share.id, MAX_SKILL_PACKAGE_FILES + 1).all();
  const total = results.reduce((sum, row) => sum + Number(row.size || 0), 0);
  if (!results.length || results.length > MAX_SKILL_PACKAGE_FILES || total > MAX_SKILL_PACKAGE_BYTES) return { error: 'This Skill package is unavailable.', status: 404 };
  const entries = [];
  for (const row of results) {
    const file = await db.prepare('SELECT content FROM hx_skill_share_files WHERE share_id=?1 AND path=?2').bind(share.id, row.path).first();
    if (!file?.content) return { error: 'This Skill package is unavailable.', status: 404 };
    const bytes = file.content instanceof ArrayBuffer ? new Uint8Array(file.content)
      : file.content instanceof Uint8Array ? file.content
        : Array.isArray(file.content) ? Uint8Array.from(file.content) : null;
    if (!bytes || Number(row.size) !== bytes.byteLength) return { error: 'This Skill package is unavailable.', status: 404 };
    entries.push({ path: row.path, size: Number(row.size), bytes });
  }
  const checked = validateSkillPackage(entries);
  return checked.error ? { error: 'This Skill package is unavailable.', status: 404 } : { entries };
}

export async function downloadSkillShare(db, token) {
  const share = await activeShare(db, token);
  if (!share) return { error: 'This Skill share link is unavailable.', status: 404 };
  const result = await shareFiles(db, share);
  if (result.error) return result;
  const zip = writeSkillZip(result.entries);
  if (zip.error) return zip;
  // File reads can span many database calls. Treat the final check as the
  // authorization point so a revocation committed during those reads wins.
  const current = await activeShare(db, token);
  if (!current || current.id !== share.id) return { error: 'This Skill share link is unavailable.', status: 404 };
  return zip;
}

export async function importSkillShare(db, token, { orgId, userId, name, agentId, memberSince, sessionToken = null, policyFingerprint = null, ssoDeadline = null } = {}) {
  if (memberSince === undefined) memberSince = (await db.prepare('SELECT created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(orgId, String(userId)).first())?.created_at;
  if (typeof memberSince !== 'string' || !memberSince) return { error: 'This Skill share link is unavailable.', status: 404 };
  const share = await activeShare(db, token);
  if (!share) return { error: 'This Skill share link is unavailable.', status: 404 };
  const result = await shareFiles(db, share);
  if (result.error) return result;
  const checked = validateSkillPackage(result.entries);
  if (checked.error) return { error: 'This Skill package is unavailable.', status: 404 };
  const overrideName = typeof name === 'string' ? name.trim() : '';
  const made = await createSkill(db, orgId, { ...checked.draft, ...(overrideName ? { name: overrideName } : {}), visibility: 'private', files: checked.files.map(file => ({ path: file.path, base64: encodeSkillBytes(file.bytes) })) }, userId, { activeShareId: share.id, installAgentId: agentId, memberSince, sessionToken, policyFingerprint, ssoDeadline });
  if (made.error) return made;
  return { skill: made.skill, source: { name: share.snapshot.name, expiresAt: share.expiresAt } };
}

// A private copy is durable after import, even when its source link is later
// revoked. Check the recipient's current access again after auditing before
// sending the copied contents; never delete the successfully imported copy.
export async function mayDeliverImportedSkill(db, orgId, skill, userId, memberSince, agentId, sessionToken = null, policyFingerprint = null, ssoDeadline = null) {
  if (!skill?.id || typeof memberSince !== 'string' || !memberSince) return false;
  const sql = `SELECT 1 AS ok FROM hx_skills s
    JOIN memberships m ON m.org_id=s.org_id AND m.user_github_id=?3 AND m.created_at=?4 AND LOWER(COALESCE(m.role,'guest'))!='guest'
    LEFT JOIN hx_skill_access p ON p.org_id=s.org_id AND p.skill_id=s.id
    WHERE s.org_id=?1 AND s.id=?2 AND (COALESCE(p.visibility,'workspace')='workspace' OR COALESCE(s.owner_id,s.created_by)=?3)
      AND s.name=?5 AND COALESCE(s.description,'')=?6 AND s.body=?7 AND s.updated_at=?8
      AND CASE WHEN json_valid(s.metadata) THEN json(s.metadata)=json(?9) ELSE 0 END
      AND NOT EXISTS(SELECT 1 FROM hx_skill_source_scopes ss WHERE ss.org_id=s.org_id AND ss.skill_id=s.id)
      AND NOT EXISTS(SELECT 1 FROM workspace_tombstones d WHERE d.org_id=s.org_id)
      AND ${skillSessionAuthority('?1', '?3', '?10')}
      AND (?11 IS NULL OR ${skillPolicyFingerprint('?1', '?3', '?10')}=?11)
      AND ${skillSsoDeadline('?12')}
      AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=s.org_id AND
        (d.purge_started_at IS NOT NULL OR NOT (LOWER(m.role)='owner' OR (INSTR(m.org_id,'/')>0 AND LOWER(m.role)='admin'))))
      ${agentId ? `AND ${skillAgentManager('?1', '?13', '?3')}
        AND EXISTS(SELECT 1 FROM hx_agent_skills l WHERE l.org_id=s.org_id AND l.skill_id=s.id AND l.agent_id=?13)` : ''}`;
  return !!await db.prepare(sql).bind(orgId, skill.id, String(userId), memberSince, skill.name, skill.description || '', skill.body, skill.updatedAt, JSON.stringify(skill.metadata || {}), sessionToken, policyFingerprint, ssoDeadline, ...(agentId ? [agentId] : [])).first();
}
