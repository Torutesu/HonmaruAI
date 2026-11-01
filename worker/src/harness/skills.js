import { mayReadSkillSource, visibleSkillRows } from './skillSourceScope.js';
import { skillAgentManager } from './skillAgentAuthority.js';
import { skillSessionAuthority } from './skillSessionAuthority.js';
import { skillPolicyFingerprint, skillSsoDeadline } from './skillPolicyProof.js';
import { skillMarkdown, MAX_SKILL_FILE_BYTES } from './skillMarkdown.js';
import { skillSelect, skillVisible } from './skillAccess.js';
import { mayAccessAgent } from './agents.js';
// Skills (docs/kylon-gap-plan.md): how the team does a thing, written once
// as Markdown and given to any agent. An agent reads every skill it has
// when it answers (agents.js prepareAgent).

export const MAX_SKILLS = 100;
export const MAX_SKILL_CHARS = 16000;
export const MAX_SKILL_NAME_CHARS = 120;
export const MAX_SKILL_DESCRIPTION_CHARS = 500;

const now = () => new Date().toISOString();
const newId = (p) => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
export function cleanSkillMetadata(value = {}) {
  const safe = (v, depth = 0) => depth <= 12 && (v === null || typeof v === 'string' || typeof v === 'boolean'
    || typeof v === 'number' && Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v))
    || typeof v === 'object' && v !== null && Object.values(v).every(child => safe(child, depth + 1)));
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !safe(value)
      || Object.hasOwn(value, 'name') || Object.hasOwn(value, 'description') || JSON.stringify(value).length > 8000) throw new Error();
    return { metadata: value };
  } catch { return { error: 'Skill metadata must be a JSON-compatible mapping of at most 8000 characters and 12 levels.' }; }
}
function savedMetadata(value) { try { return cleanSkillMetadata(JSON.parse(value || '{}')).metadata || {}; } catch { return {}; } }
const pub = (r, userId) => r && ({ id: r.id, name: r.name, description: r.description || "", body: r.body, metadata: savedMetadata(r.metadata), createdBy: r.created_by, sourceScope: r.source_agent_id ? { agentId: r.source_agent_id, channel: r.source_channel || null } : null, canShare: !r.source_agent_id && (r.effective_owner || r.created_by) === String(userId), ...(r.created_by_name ? { createdByName: r.created_by_name } : {}), createdAt: r.created_at, updatedAt: r.updated_at, visibility: r.visibility, accessVersion: r.access_version });

export async function listSkills(db, orgId, userId = "") {
  const { results } = await db.prepare(`${skillSelect} WHERE s.org_id = ?1 AND (ss.skill_id IS NOT NULL OR p.visibility IS NULL OR p.visibility = 'workspace' OR COALESCE(s.owner_id, s.created_by) = ?2) ORDER BY s.name COLLATE NOCASE`).bind(orgId, String(userId)).all();
  const skills = (await visibleSkillRows(db,orgId,results,userId)).map(r => pub(r,userId));
  const { results: links } = await db.prepare("SELECT skill_id, agent_id FROM hx_agent_skills WHERE org_id = ?1").bind(orgId).all();
  const user = userId ? await db.prepare("SELECT login FROM users WHERE github_id = ?1").bind(String(userId)).first() : null;
  const visible = new Set();
  for (const id of new Set((links || []).map(l => l.agent_id))) {
    const a = await db.prepare("SELECT id, scope, owner_login FROM custom_agents WHERE org_id = ?1 AND id = ?2 AND deleted_at IS NULL").bind(orgId, id).first();
    if (a && user && await mayAccessAgent(db, orgId, { ...a, ownerLogin: a.owner_login }, user.login)) visible.add(id);
  }
  for (const s of skills) { s.agents = (links || []).filter(l => l.skill_id === s.id && visible.has(l.agent_id)).map(l => l.agent_id); }
  return skills;
}

export async function getSkill(db, orgId, id, userId = "") {
  const row = await db.prepare(`${skillSelect} WHERE s.org_id = ?1 AND s.id = ?2 AND ${skillVisible}`).bind(orgId,id,String(userId)).first();
  return row && await mayReadSkillSource(db,orgId,row,userId) ? pub(row,userId) : null;
}

function clean(input) {
  const name = String(input?.name || "").trim();
  const body = String(input?.body || "").trim();
  const description = String(input?.description || "").trim();
  if (name.length > MAX_SKILL_NAME_CHARS) return {error:`The skill name must contain at most ${MAX_SKILL_NAME_CHARS} characters.`};
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) return {error:`The skill description must contain at most ${MAX_SKILL_DESCRIPTION_CHARS} characters.`};
  if (body.length > MAX_SKILL_CHARS) return {error:`The skill instructions must contain at most ${MAX_SKILL_CHARS} characters.`};
  if (!name) return { error: "Give the skill a name." };
  if (!body) return { error: "Write what the skill says to do." };
  const checked = cleanSkillMetadata(input?.metadata);
  if (checked.error) return checked;
  const fields = { name, body, description, metadata: checked.metadata };
  if (new TextEncoder().encode(skillMarkdown(fields)).length > MAX_SKILL_FILE_BYTES) return { error: "SKILL.md must be at most 64 KiB including metadata." };
  return fields;
}

export async function createSkill(db, orgId, input, by, { activeShareId, installAgentId, memberSince, sessionToken = null, policyFingerprint = null, ssoDeadline = null } = {}) {
  if (installAgentId && !activeShareId) return { error: 'This Skill share link is unavailable.', status: 404 };
  if (activeShareId && (typeof memberSince !== 'string' || !memberSince)) return { error: 'This Skill share link is unavailable.', status: 404 };
  const visibility = input.visibility ?? 'workspace';
  if (!['workspace', 'private'].includes(visibility)) return { error: 'Invalid visibility.' };
  const c = clean(input);
  if (c.error) return c;
  const { prepareSkillFiles, skillFileInserts } = await import('./skillFiles.js');
  const assets = input.files === undefined ? {files:[]} : prepareSkillFiles(c,input.files);
  if(assets.error)return assets;
  const n = await db.prepare("SELECT COUNT(*) AS n FROM hx_skills WHERE org_id = ?1").bind(orgId).first();
  if (Number(n?.n || 0) >= MAX_SKILLS) return { error: "This workspace has as many skills as it can hold." };
  const id = newId("skill");
  const at = now();
  const values = [id, orgId, c.name, c.description, c.body, String(by), at, JSON.stringify(c.metadata)];
  // Import authorization must be checked in the same transaction that creates
  // the copy: a link can be revoked (or the recipient removed) after the files
  // have already been read. Keep ordinary Skill creation unchanged.
  const insert = activeShareId
    ? db.prepare(`INSERT INTO hx_skills (id, org_id, name, description, body, created_by, created_at, updated_at, metadata)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8
        WHERE EXISTS (SELECT 1 FROM hx_skill_shares sh WHERE sh.id=?9 AND sh.revoked_at IS NULL AND sh.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=sh.org_id)
          AND NOT EXISTS(SELECT 1 FROM workspace_tombstones d WHERE d.org_id=sh.org_id))
          AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id=?2 AND m.user_github_id=?6 AND m.created_at=?10 AND LOWER(COALESCE(m.role,'guest'))!='guest'
            AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=m.org_id AND
              (d.purge_started_at IS NOT NULL OR NOT (LOWER(m.role)='owner' OR (INSTR(m.org_id,'/')>0 AND LOWER(m.role)='admin')))))
          AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=?2 AND d.purge_started_at IS NOT NULL)
          AND NOT EXISTS(SELECT 1 FROM workspace_tombstones d WHERE d.org_id=?2)
          AND ${skillSessionAuthority('?2', '?6', '?11')}
          AND (?12 IS NULL OR ${skillPolicyFingerprint('?2', '?6', '?11')}=?12)
          AND ${skillSsoDeadline('?13')}
          AND (SELECT COUNT(*) FROM hx_skills WHERE org_id=?2)<${MAX_SKILLS}
          ${installAgentId ? `AND ${skillAgentManager('?2', '?14', '?6')}` : ''}`).bind(...values, activeShareId, memberSince, sessionToken, policyFingerprint, ssoDeadline, ...(installAgentId ? [installAgentId] : []))
    : db.prepare("INSERT INTO hx_skills (id, org_id, name, description, body, created_by, created_at, updated_at, metadata) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)").bind(...values);
  const accessSql = activeShareId
    ? 'INSERT INTO hx_skill_access (org_id, skill_id, visibility, version) SELECT ?1, ?2, ?3, 1 WHERE EXISTS (SELECT 1 FROM hx_skills WHERE org_id=?1 AND id=?2)'
    : 'INSERT INTO hx_skill_access (org_id, skill_id, visibility, version) VALUES (?1, ?2, ?3, 1)';
  const install = installAgentId ? [db.prepare(`INSERT INTO hx_agent_skills (org_id,agent_id,skill_id,added_by,added_at)
    SELECT ?1,?2,?3,?4,?5 WHERE EXISTS(SELECT 1 FROM hx_skills WHERE org_id=?1 AND id=?3)`)
    .bind(orgId, installAgentId, id, String(by), at)] : [];
  const writes = await db.batch([insert, db.prepare(accessSql).bind(orgId, id, visibility), ...skillFileInserts(db,orgId,id,assets.files,{onlyIfSkillExists: Boolean(activeShareId)}), ...install]);
  if (activeShareId && !writes[0]?.meta?.changes) return { error: 'This Skill share link is unavailable.', status: 404 };
  let skill;
  try { skill = await getSkill(db, orgId, id, by); }
  catch (error) {
    if (activeShareId) return { error: 'The import was saved but could not be shown. Check with a workspace admin before retrying.', status: 503, committedSkillId: id };
    throw error;
  }
  if (activeShareId && !skill) return { error: 'The import was saved but your access changed. Check with a workspace admin before retrying.', status: 409, committedSkillId: id };
  return { skill };
}

export async function updateSkill(db, orgId, id, input, userId = "") {
  if (input.files !== undefined) return {error:"Replace support files by importing a new skill package."};
  const existing = await getSkill(db, orgId, id, userId);
  if (!existing) return { error: "No such skill.", status: 404 };
  const c = clean({ ...existing, ...input });
  if (c.error) return c;
  const result = await db.prepare(`UPDATE hx_skills SET name = ?1, description = ?2, body = ?3, updated_at = ?4, metadata = ?8
    WHERE id = ?5 AND org_id = ?6 AND (COALESCE(owner_id, created_by) = ?7 OR NOT EXISTS
      (SELECT 1 FROM hx_skill_access p WHERE p.org_id = ?6 AND p.skill_id = ?5 AND p.visibility = 'private'))
      AND EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=?6 AND m.user_github_id=?7 AND m.role!='guest'
        AND (COALESCE(owner_id,created_by)=?7 OR m.role IN('owner','admin')))`)
    .bind(c.name, c.description, c.body, now(), id, orgId, String(userId), JSON.stringify(c.metadata)).run();
  if (!result.meta?.changes) return { error: 'No such skill.', status: 404 };
  return { skill: await getSkill(db, orgId, id, userId) };
}

export async function deleteSkill(db, orgId, id, userId = '') {
  if (!await getSkill(db,orgId,id,userId)) return {error:'No such skill.',status:404};
  const visible = `SELECT s.id FROM hx_skills s LEFT JOIN hx_skill_access p ON p.org_id = s.org_id AND p.skill_id = s.id
    WHERE s.org_id = ?1 AND s.id = ?2 AND (COALESCE(p.visibility,'workspace')='workspace' OR COALESCE(s.owner_id,s.created_by)=?3)
      AND EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=?1 AND m.user_github_id=?3 AND m.role!='guest'
        AND (COALESCE(s.owner_id,s.created_by)=?3 OR m.role IN('owner','admin')))`;
  const results = await db.batch([
    db.prepare(`DELETE FROM hx_agent_skills WHERE org_id = ?1 AND skill_id IN (${visible})`).bind(orgId, id, String(userId)),
    db.prepare(`DELETE FROM hx_skills WHERE org_id = ?1 AND id IN (${visible})`).bind(orgId, id, String(userId)),
  ]);
  return results[1].meta?.changes ? { deleted: true } : { error: 'No such skill.', status: 404 };
}

export async function giveSkill(db, orgId, agentId, skillId, by) {
  const skill = await getSkill(db,orgId,skillId,by);
  if (!skill) return {error:"No such skill.",status:404};
  if (skill.sourceScope && skill.sourceScope.agentId !== agentId) return {error:"This skill is restricted to its source agent.",status:409};
  await db.prepare("INSERT OR IGNORE INTO hx_agent_skills (org_id, agent_id, skill_id, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(orgId, agentId, skillId, String(by), now()).run();
  return { given: true };
}

export async function takeSkill(db, orgId, agentId, skillId) {
  await db.prepare("DELETE FROM hx_agent_skills WHERE org_id = ?1 AND agent_id = ?2 AND skill_id = ?3").bind(orgId, agentId, skillId).run();
  return { taken: true };
}

export async function skillsOf(db, orgId, agentId, userId = "") {
  const { results } = await db
    .prepare(`${skillSelect} JOIN hx_agent_skills l ON l.skill_id = s.id AND l.org_id = s.org_id WHERE s.org_id = ?1 AND l.agent_id = ?2 AND ${skillVisible} ORDER BY s.name COLLATE NOCASE`)
    .bind(orgId, agentId, String(userId))
    .all();
  return (await visibleSkillRows(db,orgId,results,userId)).map(r => pub(r,userId));
}

// Private bodies are allowed only in their owner's direct agent conversation.
// Shared rooms and workflow logs must never inherit a private skill.
export async function executionSkills(db, orgId, agentId, context = {}) {
  let privateOwner = '';
  if (context.userId && context.allowPrivate !== false) {
    const u = await db.prepare(`SELECT u.login FROM users u JOIN memberships m ON m.user_github_id = u.github_id
      WHERE m.org_id = ?1 AND u.github_id = ?2 AND m.role != 'guest'`).bind(orgId, String(context.userId)).first();
    if (u && context.channel === `ag:${agentId}|${u.login}`) privateOwner = String(context.userId);
  }
  const skills = await skillsOf(db,orgId,agentId,context.userId || privateOwner);
  return skills.filter(skill => {
    if (skill.sourceScope) return skill.sourceScope.agentId === agentId
      && (!skill.sourceScope.channel || context.allowPrivate !== false && skill.sourceScope.channel === context.channel);
    return skill.visibility !== 'private' || Boolean(privateOwner);
  });
}
