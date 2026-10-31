const newId = () => `annotation_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

/** A marker is accepted only with the message the user explicitly sends. */
export function normalizeAppAnnotation(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Invalid annotation.', status: 400 };
  const target = String(value.target ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  const x = Number(value.x), y = Number(value.y);
  const section = value.section;
  if (!target || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100 || !['overview', 'data'].includes(section)) return { error: 'Invalid annotation.', status: 400 };
  return { target, x, y, section };
}

/** Idempotently attach an annotation to a message in an app or inherited thread. */
export async function saveAppAnnotation(db, { orgId, appId, tableId = '', rowId = '', messageSource, messageId, authorId, annotation }) {
  if (!annotation) return { ok: true, annotationId: null };
  if (!['app', 'channel'].includes(messageSource) || (typeof messageId !== 'string' && typeof messageId !== 'number') || !String(messageId) || String(messageId).length > 100) return { error: 'Invalid annotation message.', status: 400 };
  const id = newId(), createdAt = new Date().toISOString();
  await db.prepare(`INSERT OR IGNORE INTO hx_app_annotations (id,org_id,app_id,table_id,row_id,message_source,message_id,target,x,y,section,author_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, orgId, appId, tableId, rowId, messageSource, String(messageId), annotation.target, annotation.x, annotation.y, annotation.section, String(authorId), createdAt).run();
  const saved = await db.prepare(`SELECT id,target,x,y,section FROM hx_app_annotations WHERE org_id=? AND app_id=? AND message_source=? AND message_id=?`).bind(orgId, appId, messageSource, String(messageId)).first();
  if (!saved) return { error: 'The annotation could not be saved.', status: 503 };
  if (saved.target !== annotation.target || Number(saved.x) !== annotation.x || Number(saved.y) !== annotation.y || saved.section !== annotation.section) return { error: 'This message already has a different annotation.', status: 409 };
  return { ok: true, annotationId: saved.id };
}

export async function listAppAnnotations(db, orgId, appId, { tableId = '', rowId = '' } = {}) {
  const { results } = await db.prepare(`SELECT a.id,a.table_id AS tableId,a.row_id AS rowId,a.message_source AS messageSource,a.message_id AS messageId,
      a.target,a.x,a.y,a.section,a.author_id AS authorId,
      COALESCE(m.body,c.body) AS body,COALESCE(m.created_at,c.created_at,a.created_at) AS createdAt,
      COALESCE(u.name,u.login,c.author_login,'メンバー') AS authorName
    FROM hx_app_annotations a
    LEFT JOIN hx_app_messages m ON a.message_source='app' AND m.org_id=a.org_id AND m.app_id=a.app_id AND m.table_id=a.table_id AND m.row_id=a.row_id AND CAST(m.sequence AS TEXT)=a.message_id
    LEFT JOIN channel_messages c ON a.message_source='channel' AND c.org_id=a.org_id AND c.id=a.message_id AND c.deleted_at IS NULL
    LEFT JOIN users u ON u.github_id=a.author_id
    WHERE a.org_id=? AND a.app_id=? AND a.table_id=? AND a.row_id=? AND COALESCE(m.body,c.body) IS NOT NULL
    ORDER BY a.created_at DESC,a.id DESC LIMIT 100`).bind(orgId, appId, tableId, rowId).all();
  return results || [];
}
