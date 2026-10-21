import { skillSelect, skillVisible } from './skillAccess.js';
import { mayAccessAgent } from './agents.js';
// Skills (docs/kylon-gap-plan.md): how the team does a thing, written once
// as Markdown and given to any agent. An agent reads every skill it has
// when it answers (agents.js prepareAgent).

export const MAX_SKILLS = 100;
export const MAX_SKILL_CHARS = 8000;

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
const pub = (r, userId) => r && ({ id: r.id, name: r.name, description: r.description || "", body: r.body, metadata: savedMetadata(r.metadata), createdBy: r.created_by, canShare: (r.effective_owner || r.created_by) === String(userId), ...(r.created_by_name ? { createdByName: r.created_by_name } : {}), createdAt: r.created_at, updatedAt: r.updated_at, visibility: r.visibility, accessVersion: r.access_version });

export async function listSkills(db, orgId, userId = "") {
  const { results } = await db.prepare(`${skillSelect} WHERE s.org_id = ?1 AND (p.visibility IS NULL OR p.visibility = 'workspace' OR COALESCE(s.owner_id, s.created_by) = ?2) ORDER BY s.name COLLATE NOCASE`).bind(orgId, String(userId)).all();
  const skills = (results || []).map(r => pub(r, userId));
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
  return pub(await db.prepare(`${skillSelect} WHERE s.org_id = ?1 AND s.id = ?2 AND ${skillVisible}`).bind(orgId, id, String(userId)).first(), userId);
}

function clean(input) {
  const name = String(input?.name || "").trim().slice(0, 80);
  const body = String(input?.body || "").trim().slice(0, MAX_SKILL_CHARS);
  if (!name) return { error: "Give the skill a name." };
  if (!body) return { error: "Write what the skill says to do." };
  const checked = cleanSkillMetadata(input?.metadata);
  if (checked.error) return checked;
  return { name, body, description: String(input?.description || "").trim().slice(0, 200), metadata: checked.metadata };
}

export async function createSkill(db, orgId, input, by) {
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
  const insert = db.prepare("INSERT INTO hx_skills (id, org_id, name, description, body, created_by, created_at, updated_at, metadata) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)")
    .bind(id, orgId, c.name, c.description, c.body, String(by), at, JSON.stringify(c.metadata));
  await db.batch([insert, db.prepare("INSERT INTO hx_skill_access (org_id, skill_id, visibility, version) VALUES (?1, ?2, ?3, 1)").bind(orgId, id, visibility), ...skillFileInserts(db,orgId,id,assets.files)]);
  return { skill: await getSkill(db, orgId, id, by) };
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
  const visible = `SELECT s.id FROM hx_skills s LEFT JOIN hx_skill_access p ON p.org_id = s.org_id AND p.skill_id = s.id
    WHERE s.org_id = ?1 AND s.id = ?2 AND ${skillVisible}
      AND EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=?1 AND m.user_github_id=?3 AND m.role!='guest'
        AND (COALESCE(s.owner_id,s.created_by)=?3 OR m.role IN('owner','admin')))`;
  const results = await db.batch([
    db.prepare(`DELETE FROM hx_agent_skills WHERE org_id = ?1 AND skill_id IN (${visible})`).bind(orgId, id, String(userId)),
    db.prepare(`DELETE FROM hx_skills WHERE org_id = ?1 AND id IN (${visible})`).bind(orgId, id, String(userId)),
  ]);
  return results[1].meta?.changes ? { deleted: true } : { error: 'No such skill.', status: 404 };
}

export async function giveSkill(db, orgId, agentId, skillId, by) {
  if (!(await getSkill(db, orgId, skillId, by))) return { error: "No such skill.", status: 404 };
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
  return (results || []).map(r => pub(r, userId));
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
  return skillsOf(db, orgId, agentId, privateOwner);
}
