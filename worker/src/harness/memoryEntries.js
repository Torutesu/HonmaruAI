// Structured memory is additive: old short notes remain readable and keep
// their existing prompt representation. Full bodies are fetched explicitly.
export const MEMORY_BODY_LIMIT = 16000;
export function memoryFields(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "Invalid memory entry." };
  for (const [key, limit, required] of [["title", 120, true], ["description", 500, false], ["body", MEMORY_BODY_LIMIT, true]]) {
    const value = input[key] ?? (required ? null : "");
    if (typeof value !== "string" || value.length > limit || (required && !value.trim())) return { error: `Invalid memory ${key} (maximum ${limit} characters).` };
  }
  return { title: input.title.trim(), description: (input.description || "").trim(), body: input.body.replace(/\r\n?/g, "\n").trim() };
}
export function memoryEntry(row) {
  return { id: row.id, text: row.text, source: row.source, createdBy: row.created_by, createdAt: row.created_at,
    channel: row.channel || null, kind: row.kind || "context", title: row.title ?? row.text.slice(0, 120),
    description: row.description || "", body: row.body ?? row.text, version: row.version ?? 0, updatedAt: row.updated_at || row.created_at };
}
export async function updateMemoryEntry(db, orgId, agentId, id, input, { channel = "", by = null } = {}) {
  const fields = memoryFields(input);
  if (fields.error) return fields;
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) return { error: "Expected memory version is required." };
  if (!["context", "preference", "feedback", "reference"].includes(input.kind)) return { error: "Invalid memory kind." };
  const row = await db.prepare(`SELECT m.*, s.channel, s.kind, d.version FROM hx_agent_memories m
    LEFT JOIN hx_memory_scopes s ON s.memory_id = m.id AND s.org_id = m.org_id
    LEFT JOIN hx_memory_entries d ON d.memory_id = m.id AND d.org_id = m.org_id
    WHERE m.org_id = ?1 AND m.agent_id = ?2 AND m.id = ?3 AND COALESCE(s.channel, '') = ?4`)
    .bind(orgId, agentId, id, channel).first();
  if (!row) return { error: "No such memory.", status: 404 };
  if ((row.version ?? 0) !== input.expectedVersion) return { error: "This memory changed. Reload before saving.", status: 409 };
  const stamp = new Date().toISOString();
  const results = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO hx_memory_entries (memory_id, org_id, title, description, body, version, updated_by, updated_at)
      SELECT id, org_id, substr(text,1,120), '', text, 0, created_by, created_at FROM hx_agent_memories WHERE org_id = ?1 AND agent_id = ?2 AND id = ?3`)
      .bind(orgId, agentId, id),
    db.prepare(`INSERT OR IGNORE INTO hx_memory_scopes (memory_id, org_id, channel, kind) SELECT id, org_id, '', 'context' FROM hx_agent_memories WHERE org_id = ?1 AND agent_id = ?2 AND id = ?3`)
      .bind(orgId, agentId, id),
    db.prepare(`UPDATE hx_agent_memories SET text = ?4 WHERE org_id = ?1 AND agent_id = ?2 AND id = ?3
      AND EXISTS (SELECT 1 FROM hx_memory_entries d JOIN hx_memory_scopes s ON s.memory_id = d.memory_id
        WHERE d.memory_id = ?3 AND d.org_id = ?1 AND d.version = ?5 AND s.channel = ?6)`)
      .bind(orgId, agentId, id, fields.body.replace(/\s+/g, " ").slice(0, 500), input.expectedVersion, channel),
    db.prepare(`UPDATE hx_memory_scopes SET kind = ?4 WHERE org_id = ?1 AND memory_id = ?3 AND channel = ?6
      AND EXISTS (SELECT 1 FROM hx_memory_entries d JOIN hx_agent_memories m ON m.id = d.memory_id
        WHERE d.memory_id = ?3 AND d.org_id = ?1 AND d.version = ?5 AND m.agent_id = ?2)`)
      .bind(orgId, agentId, id, input.kind, input.expectedVersion, channel),
    db.prepare(`UPDATE hx_memory_entries SET title = ?4, description = ?5, body = ?6, version = version + 1, updated_by = ?7, updated_at = ?8
      WHERE org_id = ?1 AND memory_id = ?3 AND version = ?9 AND EXISTS
      (SELECT 1 FROM hx_agent_memories m JOIN hx_memory_scopes s ON s.memory_id = m.id WHERE m.id = ?3 AND m.agent_id = ?2 AND m.org_id = ?1 AND s.channel = ?10)
      RETURNING version`).bind(orgId, agentId, id, fields.title, fields.description, fields.body, by ? String(by) : null, stamp, input.expectedVersion, channel),
  ]);
  if (!results[4].results?.length) return { error: "This memory changed. Reload before saving.", status: 409 };
  return { memory: { ...memoryEntry(row), ...fields, text: fields.body.replace(/\s+/g, " ").slice(0, 500), kind: input.kind, version: results[4].results[0].version, updatedAt: stamp } };
}

export async function memoryPage(db, orgId, agentId, { channel = '', cursor, query = '', kind = 'all' } = {}) {
  if (typeof query !== 'string' || query.length > 200 || !['all','context','preference','feedback','reference'].includes(kind)) return { error: 'Invalid memory search.', status: 400 };
  query = query.trim();
  const scope = [orgId, agentId, channel, query, kind];
  let after = null;
  if (cursor) {
    try {
      const value = JSON.parse(cursor);
      if (!Array.isArray(value) || value.length !== 7 || JSON.stringify(value.slice(0,5)) !== JSON.stringify(scope)
        || typeof value[5] !== 'string' || value[5].length > 40 || !Number.isFinite(Date.parse(value[5]))
        || typeof value[6] !== 'string' || !value[6] || value[6].length > 100) throw new Error();
      after = value.slice(5);
    } catch { return { error: 'Invalid memory cursor.', status: 400 }; }
  }
  const {results = []} = await db.prepare(`SELECT m.*, s.channel, s.kind, d.title, d.description, d.body, d.version, d.updated_at
    FROM hx_agent_memories m LEFT JOIN hx_memory_scopes s ON s.memory_id=m.id AND s.org_id=m.org_id
    LEFT JOIN hx_memory_entries d ON d.memory_id=m.id AND d.org_id=m.org_id
    WHERE m.org_id=?1 AND m.agent_id=?2 AND COALESCE(s.channel,'') IN ('',?3)
      AND (?4 IS NULL OR m.created_at < ?4 OR (m.created_at = ?4 AND m.id < ?5))
      AND (?6 = '' OR instr(lower(COALESCE(d.title,'')),lower(?6))>0
        OR instr(lower(COALESCE(d.description,'')),lower(?6))>0 OR instr(lower(COALESCE(d.body,m.text)),lower(?6))>0)
      AND (?7 = 'all' OR COALESCE(s.kind,'context')=?7)
    ORDER BY m.created_at DESC, m.id DESC LIMIT 51`)
    .bind(orgId,agentId,channel,after?.[0] || null,after?.[1] || null,query,kind).all();
  const memories = results.slice(0,50).map(memoryEntry), last = memories[memories.length-1];
  return { memories, nextCursor: results.length > 50 ? JSON.stringify([...scope,last.createdAt,last.id]) : null };
}
