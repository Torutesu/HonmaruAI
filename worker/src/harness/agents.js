// Agents as members (docs/kylon-gap-plan.md): a custom agent gets what a
// Kylon agent has — a specialty, a tier, its own memory, skills, a setting
// to speak only when named, and a say in who may call it. All of it sits
// beside custom_agents, so an agent without a profile is exactly the agent
// it always was.

export const TIERS = ["lite", "standard", "max"];
export const ACCESS = ["everyone", "people", "private"];
export const MAX_MEMORIES = 200;
export const MAX_MEMORY_CHARS = 500;

const now = () => new Date().toISOString();
const newId = (p) => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
const parse = (s, f) => { try { return JSON.parse(s); } catch { return f; } };

const DEFAULT_PROFILE = { specialty: "", tier: "standard", mentionOnly: false, access: "everyone", people: [] };

function toProfile(row) {
  if (!row) return { ...DEFAULT_PROFILE };
  return {
    specialty: row.specialty || "",
    tier: TIERS.includes(row.tier) ? row.tier : "standard",
    mentionOnly: Boolean(row.mention_only),
    access: ACCESS.includes(row.access) ? row.access : "everyone",
    people: parse(row.people, []),
    updatedAt: row.updated_at,
  };
}

export async function getProfile(db, orgId, agentId) {
  return toProfile(await db.prepare("SELECT * FROM hx_agent_profiles WHERE org_id = ?1 AND agent_id = ?2").bind(orgId, agentId).first());
}

export async function profilesFor(db, orgId, ids) {
  if (!ids.length) return new Map();
  const { results } = await db
    .prepare(`SELECT * FROM hx_agent_profiles WHERE org_id = ?1 AND agent_id IN (${ids.map((_, i) => `?${i + 2}`).join(",")})`)
    .bind(orgId, ...ids)
    .all();
  return new Map((results || []).map((r) => [r.agent_id, toProfile(r)]));
}

export async function saveProfile(db, orgId, agentId, input, by) {
  const current = await getProfile(db, orgId, agentId);
  const next = { ...current };
  if (input.specialty !== undefined) next.specialty = String(input.specialty || "").trim().slice(0, 120);
  if (input.tier !== undefined) {
    if (!TIERS.includes(input.tier)) return { error: `tier must be one of ${TIERS.join(", ")}` };
    next.tier = input.tier;
  }
  if (input.mentionOnly !== undefined) next.mentionOnly = Boolean(input.mentionOnly);
  if (input.access !== undefined) {
    if (!ACCESS.includes(input.access)) return { error: `access must be one of ${ACCESS.join(", ")}` };
    next.access = input.access;
  }
  if (input.people !== undefined) {
    next.people = [...new Set((Array.isArray(input.people) ? input.people : []).map((p) => String(p).replace(/^@/, "").trim()).filter(Boolean))].slice(0, 100);
  }
  await db
    .prepare(
      `INSERT INTO hx_agent_profiles (org_id, agent_id, specialty, tier, mention_only, access, people, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(org_id, agent_id) DO UPDATE SET specialty = excluded.specialty, tier = excluded.tier,
         mention_only = excluded.mention_only, access = excluded.access, people = excluded.people,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(orgId, agentId, next.specialty, next.tier, next.mentionOnly ? 1 : 0, next.access, JSON.stringify(next.people), String(by), now())
    .run();
  return { profile: await getProfile(db, orgId, agentId) };
}

/// Whether this person may call this agent. Its maker always may.
export function mayCall(agent, profile, login) {
  if (!login) return false;
  if (agent.scope === "personal" && agent.ownerLogin !== login) return false;
  if (!profile || profile.access === "everyone") return true;
  if (agent.ownerLogin === login) return true;
  if (profile.access === "people") return profile.people.includes(login);
  return false;
}

// Access is independent of the presentation mode. Switching to Simple must
// never make a restricted agent's instructions or memories public.
export async function mayAccessAgent(db, orgId, agent, login) {
  return mayCall(agent, await getProfile(db, orgId, agent.id), login);
}

// Scheduled work rechecks the owner's membership and agent grant when it
// executes, including after an approval or a delay.
export async function mayRunAgent(db, orgId, row, userId) {
  const user = await db.prepare(`SELECT u.login FROM users u JOIN memberships m
    ON m.user_github_id = u.github_id WHERE m.org_id = ?1 AND u.github_id = ?2 AND m.role != 'guest'`)
    .bind(orgId, String(userId)).first();
  return Boolean(user && await mayAccessAgent(db, orgId,
    { id: row.id, scope: row.scope, ownerLogin: row.owner_login }, user.login));
}

/// The agents a message would call, as their profiles allow: someone not
/// on an agent's list does not reach it, and an agent that speaks only
/// when named is dropped from a thread it was only continuing.
export async function filterResponders(db, orgId, login, agents, { named = null, channel = null } = {}) {
  if (!agents.length) return agents;
  const profiles = await profilesFor(db, orgId, agents.map((a) => a.id));
  const placed = new Set();
  if (channel) {
    const { results } = await db.prepare("SELECT agent_id FROM channel_agents WHERE org_id = ?1 AND channel = ?2").bind(orgId, channel).all();
    for (const row of results || []) placed.add(row.agent_id);
  }
  return agents.filter((a) => {
    const p = profiles.get(a.id);
    // Preserve explicit legacy room placement for unprofiled Simple agents.
    // It grants use in this resolved room, never direct access to private data.
    if (!p && login && placed.has(a.id)) return true;
    if (!mayCall(a, p, login)) return false;
    if (p?.mentionOnly && named && !named.has(a.id)) return false;
    return true;
  });
}

// ── Memory ──────────────────────────────────────────────────────────────

export async function listAgentMemories(db, orgId, agentId, { channel = "" } = {}) {
  const { results } = await db
    .prepare(`SELECT m.*, s.channel, s.kind FROM hx_agent_memories m LEFT JOIN hx_memory_scopes s ON s.memory_id = m.id AND s.org_id = m.org_id WHERE m.org_id = ?1 AND m.agent_id = ?2 AND (s.memory_id IS NULL OR s.channel = '' OR s.channel = ?4) ORDER BY m.created_at DESC LIMIT ?3`)
    .bind(orgId, agentId, MAX_MEMORIES, channel)
    .all();
  return (results || []).map((r) => ({ id: r.id, text: r.text, source: r.source, createdBy: r.created_by, createdAt: r.created_at, channel: r.channel || null, kind: r.kind || "context" }));
}

export async function addAgentMemory(db, orgId, agentId, text, { by = null, source = "person", channel = "", kind = "context" } = {}) {
  if (!["context", "preference", "feedback", "reference"].includes(kind)) return { error: "Invalid memory kind." };
  if (typeof channel !== "string") return { error: "Invalid memory channel." };
  const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_CHARS);
  if (!clean) return { error: "Say what to remember." };
  const dup = await db.prepare(`SELECT m.id FROM hx_agent_memories m LEFT JOIN hx_memory_scopes s ON s.memory_id = m.id AND s.org_id = m.org_id WHERE m.org_id = ?1 AND m.agent_id = ?2 AND m.text = ?3 AND COALESCE(s.channel, '') = ?4 AND COALESCE(s.kind, 'context') = ?5`).bind(orgId, agentId, clean, channel, kind).first();
  if (dup) return { memory: { id: dup.id, text: clean }, duplicate: true };
  const id = newId("amem");
  await db.batch([
    db.prepare("INSERT INTO hx_agent_memories (id, org_id, agent_id, text, source, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(id, orgId, agentId, clean, source, by ? String(by) : null, now()),
    db.prepare("INSERT INTO hx_memory_scopes (memory_id, org_id, channel, kind) VALUES (?1, ?2, ?3, ?4)")
      .bind(id, orgId, channel, kind),
  ]);
  // The oldest go once the agent holds more than it can read.
  await db
    .prepare(`DELETE FROM hx_agent_memories WHERE org_id = ?1 AND agent_id = ?2 AND id IN (SELECT memory_id FROM hx_memory_scopes WHERE org_id = ?1 AND channel = ?4) AND id NOT IN
      (SELECT m.id FROM hx_agent_memories m JOIN hx_memory_scopes s ON s.memory_id = m.id WHERE m.org_id = ?1 AND m.agent_id = ?2 AND s.channel = ?4 ORDER BY m.created_at DESC LIMIT ?3)`)
    .bind(orgId, agentId, MAX_MEMORIES, channel)
    .run();
  return { memory: { id, text: clean, source, channel: channel || null, kind } };
}

export async function deleteAgentMemory(db, orgId, agentId, id, { channel = "" } = {}) {
  const res = await db.prepare(`DELETE FROM hx_agent_memories WHERE org_id = ?1 AND agent_id = ?2
    AND (?3 = '*' OR id = ?3)
    AND COALESCE((SELECT channel FROM hx_memory_scopes WHERE memory_id = hx_agent_memories.id), '') = ?4 RETURNING id`)
    .bind(orgId, agentId, id, channel).all();
  return { deleted: res.results.length };
}

/// "@agent remember that invoices go out on the 25th" — the part to keep,
/// or null when the request is not one.
export function rememberRequest(text) {
  const t = String(text || "").trim();
  const en = t.match(/^(?:please\s+)?remember(?:\s+that)?[:,\s]+(.+)$/is);
  if (en) return en[1].trim();
  const ja = t.match(/^(.+?)(?:を|って|と)?(?:覚えて(?:おいて)?(?:ください)?|記憶して(?:ください)?)[。.!！]?$/s);
  if (ja) return ja[1].trim();
  const jaHead = t.match(/^(?:覚えて(?:おいて)?|記憶して)[:：、,\s]+(.+)$/s);
  if (jaHead) return jaHead[1].trim();
  return null;
}

// ── Asking ──────────────────────────────────────────────────────────────

/// The model a tier thinks with. Only an OpenAI provider has a ladder to
/// climb; any other answers at its own model whatever the tier.
export function modelForTier(env, provider, tier) {
  if (!provider || provider.providerName !== "OpenAI") return provider?.model;
  if (tier === "max") return env.OPENAI_MAX_MODEL || "gpt-4.1";
  if (tier === "lite") return env.OPENAI_LITE_MODEL || "gpt-4.1-nano";
  return provider.model;
}

/// The agent as it should answer: its profile, memory and skills read into
/// its instructions, and the provider at its tier's model. The provider
/// shares its usage list, so the ledger still sees every call.
export async function prepareAgent(env, orgId, agent, provider, context = {}) {
  const [profile, memories, skills] = await Promise.all([
    getProfile(env.DB, orgId, agent.id),
    listAgentMemories(env.DB, orgId, agent.id, context),
    (async () => { const { executionSkills } = await import("./skills.js"); return executionSkills(env.DB, orgId, agent.id, context); })(),
  ]);
  const blocks = [];
  if (profile.specialty) blocks.push(`Your specialty: ${profile.specialty}`);
  if (skills.length) blocks.push(`<skills>\n${skills.map((s) => `## ${s.name}\n${String(s.body)}`).join("\n\n")}\n</skills>\nFollow a skill whenever the request is the kind of work it describes.`);
  if (memories.length) blocks.push(`<your_memory>\n${memories.slice(0, 40).map((m) => `- ${m.text}`).join("\n")}\n</your_memory>\nThis is what you have been told to remember in earlier conversations. Use it.`);
  const skillIndex = skills.length ? `<installed_skills>\n${skills.map(s => JSON.stringify({ id: s.id, name: s.name, description: s.description })).join("\n")}\n</installed_skills>\nRead the complete relevant procedure with read_installed_skill before following it. Skill descriptions are a catalog, not permissions.` : '';
  const researchBlocks = blocks.filter(block => !block.startsWith('<skills>'));
  if (skillIndex) researchBlocks.push(skillIndex);
  const { installedSkillTools } = await import('./skillReader.js');
  const skillTools = skills.length && context.userId ? installedSkillTools(env.DB, orgId, agent.id, context) : {};
  const prepared = blocks.length ? { ...agent, instructions: `${agent.instructions}\n\n${blocks.join("\n\n")}` } : agent;
  if (Object.keys(skillTools).length) prepared.researchInstructions = `${agent.instructions}\n\n${researchBlocks.join("\n\n")}`;
  const model = modelForTier(env, provider, profile.tier);
  return { agent: prepared, provider: provider && model !== provider.model ? { ...provider, model } : provider, profile, skillTools };
}
