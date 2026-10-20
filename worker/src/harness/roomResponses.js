export async function roomResponses(db, orgId, channel) {
  const row = await db.prepare('SELECT mentioned_only, version FROM hx_room_responses WHERE org_id = ?1 AND channel = ?2').bind(orgId, channel).first();
  return { mentionedOnly: Boolean(row?.mentioned_only), version: row?.version || 0 };
}
export async function saveRoomResponses(db, orgId, channel, input, by) {
  if (typeof input.mentionedOnly !== 'boolean' || !Number.isSafeInteger(input.version) || input.version < 0) return { error: 'A response setting and its current version are required.', status: 400 };
  const at = new Date().toISOString();
  const result = input.version === 0
    ? await db.prepare('INSERT OR IGNORE INTO hx_room_responses (org_id, channel, mentioned_only, version, updated_by, updated_at) VALUES (?1, ?2, ?3, 1, ?4, ?5)').bind(orgId, channel, input.mentionedOnly ? 1 : 0, String(by), at).run()
    : await db.prepare('UPDATE hx_room_responses SET mentioned_only = ?3, version = version + 1, updated_by = ?4, updated_at = ?5 WHERE org_id = ?1 AND channel = ?2 AND version = ?6').bind(orgId, channel, input.mentionedOnly ? 1 : 0, String(by), at, input.version).run();
  if (!result.meta?.changes) return { error: 'The response setting changed. Reload before saving.', status: 409 };
  return { responses: await roomResponses(db, orgId, channel) };
}
