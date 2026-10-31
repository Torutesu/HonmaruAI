import { createSkill } from './skills.js';
import { encodeSkillBytes, listSkillFiles, readSkillFile } from './skillFiles.js';
import { skillMarkdown } from './skillMarkdown.js';
import { MAX_SKILL_PACKAGE_BYTES, MAX_SKILL_PACKAGE_FILES, validateSkillPackage } from './skillPackage.js';
import { writeSkillZip } from './skillZip.js';

const now = () => new Date().toISOString();
const newId = () => `sshare_${crypto.randomUUID().replaceAll('-', '')}`;
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
const validToken = value => typeof value === 'string' && /^skl_[a-f0-9]{64}$/.test(value);
const parse = value => { try { return JSON.parse(value); } catch { return null; } };

export async function createSkillShare(db, orgId, skill, userId, { expiresInDays = 7, confirmAnyoneWithLink } = {}) {
  if (!skill || skill.sourceScope) return { error: 'Only workspace custom Skills can be shared by link.', status: 409 };
  if (!skill.canShare) return { error: 'Only the Skill owner can create a share link.', status: 403 };
  if (confirmAnyoneWithLink !== true) return { error: 'Confirm that anyone with the link can inspect and download this Skill.', status: 400 };
  if (!skill.description?.trim()) return { error: 'Add a description before creating a share link.', status: 400 };
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
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
    .bind(id, orgId, skill.id, await digest(token), JSON.stringify(snapshot), String(userId), createdAt, expiresAt),
  ...entries.map(file => db.prepare(`INSERT INTO hx_skill_share_files (share_id, path, size, content) VALUES (?1, ?2, ?3, ?4)`)
    .bind(id, file.path, file.bytes.byteLength, file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength)))];
  await db.batch(writes);
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

async function activeShare(db, token) {
  if (!validToken(token)) return null;
  const row = await db.prepare(`SELECT id, org_id AS orgId, snapshot, expires_at AS expiresAt, revoked_at AS revokedAt
    FROM hx_skill_shares WHERE token_hash=?1`).bind(await digest(token)).first();
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
  return writeSkillZip(result.entries);
}

export async function importSkillShare(db, token, { orgId, userId, name } = {}) {
  const share = await activeShare(db, token);
  if (!share) return { error: 'This Skill share link is unavailable.', status: 404 };
  const result = await shareFiles(db, share);
  if (result.error) return result;
  const checked = validateSkillPackage(result.entries);
  if (checked.error) return { error: 'This Skill package is unavailable.', status: 404 };
  const overrideName = typeof name === 'string' ? name.trim() : '';
  const made = await createSkill(db, orgId, { ...checked.draft, ...(overrideName ? { name: overrideName } : {}), visibility: 'private', files: checked.files.map(file => ({ path: file.path, base64: encodeSkillBytes(file.bytes) })) }, userId);
  if (made.error) return made;
  return { skill: made.skill, source: { name: share.snapshot.name, expiresAt: share.expiresAt } };
}

