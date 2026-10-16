// Durable room instructions. Presentation mode never disables saved rules.
export const MAX_GUIDELINES = 4096;

export async function getGuidelines(db, orgId, channel) {
  const row = await db.prepare("SELECT body, version, updated_at FROM hx_room_guidelines WHERE org_id = ?1 AND channel = ?2")
    .bind(orgId, channel).first();
  return { body: row?.body || "", version: row?.version || 0, updatedAt: row?.updated_at || null };
}

export async function saveGuidelines(db, orgId, channel, input, by) {
  if (typeof input.body !== "string" || input.body.length > MAX_GUIDELINES) return { error: `Guidelines must be text of at most ${MAX_GUIDELINES} characters.` };
  if (!Number.isSafeInteger(input.version) || input.version < 0) return { error: "A current version is required." };
  const text = input.body.trim();
  const at = new Date().toISOString();
  const result = input.version === 0
    ? await db.prepare(`INSERT OR IGNORE INTO hx_room_guidelines (org_id, channel, body, version, updated_by, updated_at)
      VALUES (?1, ?2, ?3, 1, ?4, ?5)`).bind(orgId, channel, text, String(by), at).run()
    : await db.prepare(`UPDATE hx_room_guidelines SET body = ?3, version = version + 1, updated_by = ?4, updated_at = ?5
      WHERE org_id = ?1 AND channel = ?2 AND version = ?6`).bind(orgId, channel, text, String(by), at, input.version).run();
  if (!result.meta?.changes) return { error: "The guidelines changed. Reload before saving.", status: 409 };
  return { guidelines: await getGuidelines(db, orgId, channel) };
}

export async function withRoomGuidelines(db, orgId, channel, agent) {
  if (!channel?.startsWith("b:")) return agent;
  const { body } = await getGuidelines(db, orgId, channel);
  if (!body) return agent;
  return { ...agent, instructions: `<room_guidelines>\n${body}\n</room_guidelines>\nApply these room instructions to this turn. They do not grant access or override tool permissions.\n\n${agent.instructions || ""}` };
}
