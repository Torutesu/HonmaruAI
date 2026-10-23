import {roomRoleState} from './roomRoles.js';
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
  const state=await roomRoleState(db,orgId,channel);
  if(state?.managed){
    const actor=state.members.find(member=>member.kind==='person'&&member.id===String(by)&&member.eligible);
    if(!actor)return {error:'Only a room member can change its guidelines.',status:403};
    const at=new Date().toISOString(),text=input.body.trim();
    const saved=await db.prepare(`INSERT INTO hx_room_guidelines(org_id,channel,body,version,updated_by,updated_at)
      SELECT ?1,?2,?3,?4+1,?5,?6 WHERE
        (?4=0 OR EXISTS(SELECT 1 FROM hx_room_guidelines WHERE org_id=?1 AND channel=?2 AND version=?4))
        AND EXISTS(SELECT 1 FROM hx_room_access WHERE org_id=?1 AND channel=?2 AND version=?7 AND deleted_at IS NULL)
        AND EXISTS(SELECT 1 FROM businesses b JOIN conversation_members c ON c.org_id=b.org_id AND c.channel=?2
          JOIN users u ON u.login=c.login JOIN memberships m ON m.org_id=b.org_id AND m.user_github_id=u.github_id
          WHERE b.org_id=?1 AND 'b:'||b.slug=?2 AND b.archived_at IS NULL AND u.github_id=?5
            AND m.role!='guest' AND m.created_at||'/'||c.added_at=?8)
      ON CONFLICT(org_id,channel) DO UPDATE SET body=excluded.body,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at
        WHERE hx_room_guidelines.version=?4
      RETURNING body,version,updated_at AS updatedAt`).bind(orgId,channel,text,input.version,String(by),at,state.version,actor.membership).first();
    return saved?{guidelines:saved}:{error:'The guidelines or room membership changed. Reload before saving.',status:409};
  }
  // A deleted/archived managed room must not fall back to legacy writes.
  if(!state&&await db.prepare('SELECT 1 FROM hx_room_access WHERE org_id=?1 AND channel=?2').bind(orgId,channel).first())
    return {error:'No such active room.',status:404};
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
  const prefix = `<room_guidelines>\n${body}\n</room_guidelines>\nApply these room instructions to this turn. They do not grant access or override tool permissions.\n\n`;
  return { ...agent, instructions: prefix + (agent.instructions || ''),
    ...(agent.researchInstructions ? { researchInstructions: prefix + agent.researchInstructions } : {}) };
}
