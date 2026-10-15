// Skills (docs/kylon-gap-plan.md): how the team does a thing, written once
// as Markdown and given to any agent. An agent reads every skill it has
// when it answers (agents.js prepareAgent).

export const MAX_SKILLS = 100;
export const MAX_SKILL_CHARS = 8000;

const now = () => new Date().toISOString();
const newId = (p) => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
const pub = (r) => r && ({ id: r.id, name: r.name, description: r.description || "", body: r.body, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at });

export async function listSkills(db, orgId) {
  const { results } = await db.prepare("SELECT * FROM hx_skills WHERE org_id = ?1 ORDER BY name COLLATE NOCASE").bind(orgId).all();
  const skills = (results || []).map(pub);
  const { results: links } = await db.prepare("SELECT skill_id, agent_id FROM hx_agent_skills WHERE org_id = ?1").bind(orgId).all();
  for (const s of skills) s.agents = (links || []).filter((l) => l.skill_id === s.id).map((l) => l.agent_id);
  return skills;
}

export async function getSkill(db, orgId, id) {
  return pub(await db.prepare("SELECT * FROM hx_skills WHERE id = ?1 AND org_id = ?2").bind(id, orgId).first());
}

function clean(input) {
  const name = String(input?.name || "").trim().slice(0, 80);
  const body = String(input?.body || "").trim().slice(0, MAX_SKILL_CHARS);
  if (!name) return { error: "Give the skill a name." };
  if (!body) return { error: "Write what the skill says to do." };
  return { name, body, description: String(input?.description || "").trim().slice(0, 200) };
}

export async function createSkill(db, orgId, input, by) {
  const c = clean(input);
  if (c.error) return c;
  const n = await db.prepare("SELECT COUNT(*) AS n FROM hx_skills WHERE org_id = ?1").bind(orgId).first();
  if (Number(n?.n || 0) >= MAX_SKILLS) return { error: "This workspace has as many skills as it can hold." };
  const id = newId("skill");
  const at = now();
  await db.prepare("INSERT INTO hx_skills (id, org_id, name, description, body, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)")
    .bind(id, orgId, c.name, c.description, c.body, String(by), at).run();
  return { skill: await getSkill(db, orgId, id) };
}

export async function updateSkill(db, orgId, id, input) {
  const existing = await getSkill(db, orgId, id);
  if (!existing) return { error: "No such skill.", status: 404 };
  const c = clean({ ...existing, ...input });
  if (c.error) return c;
  await db.prepare("UPDATE hx_skills SET name = ?1, description = ?2, body = ?3, updated_at = ?4 WHERE id = ?5 AND org_id = ?6")
    .bind(c.name, c.description, c.body, now(), id, orgId).run();
  return { skill: await getSkill(db, orgId, id) };
}

export async function deleteSkill(db, orgId, id) {
  await db.batch([
    db.prepare("DELETE FROM hx_agent_skills WHERE org_id = ?1 AND skill_id = ?2").bind(orgId, id),
    db.prepare("DELETE FROM hx_skills WHERE org_id = ?1 AND id = ?2").bind(orgId, id),
  ]);
  return { deleted: true };
}

export async function giveSkill(db, orgId, agentId, skillId, by) {
  if (!(await getSkill(db, orgId, skillId))) return { error: "No such skill.", status: 404 };
  await db.prepare("INSERT OR IGNORE INTO hx_agent_skills (org_id, agent_id, skill_id, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(orgId, agentId, skillId, String(by), now()).run();
  return { given: true };
}

export async function takeSkill(db, orgId, agentId, skillId) {
  await db.prepare("DELETE FROM hx_agent_skills WHERE org_id = ?1 AND agent_id = ?2 AND skill_id = ?3").bind(orgId, agentId, skillId).run();
  return { taken: true };
}

export async function skillsOf(db, orgId, agentId) {
  const { results } = await db
    .prepare("SELECT s.* FROM hx_agent_skills l JOIN hx_skills s ON s.id = l.skill_id WHERE l.org_id = ?1 AND l.agent_id = ?2 ORDER BY s.name COLLATE NOCASE")
    .bind(orgId, agentId)
    .all()
    .catch(() => ({ results: [] }));
  return (results || []).map(pub);
}
