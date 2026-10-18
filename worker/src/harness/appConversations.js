import { mayUseApp, mayUseTable } from './resourceAccess.js';

// Object conversations inherit the current app ACL; room navigation never grants access.
// Reading an empty conversation does not create records or trigger agents.
export async function appConversation(db, orgId, userId, appId, input = {}, write = false) {
  if (!(await mayUseApp(db, orgId, appId, userId))) return { error: 'No such app.', status: 404 };
  const app = await db.prepare('SELECT table_id FROM hx_apps WHERE org_id=? AND id=?').bind(orgId, appId).first();
  if (!app) return { error: 'No such app.', status: 404 };
  const tableId = input.tableId ?? '', rowId = input.rowId ?? '';
  if (typeof tableId !== 'string' || typeof rowId !== 'string' || Boolean(tableId) !== Boolean(rowId) || tableId.length > 100 || rowId.length > 100) return { error: 'Invalid record scope.', status: 400 };
  if (rowId) {
    const linked = tableId === app.table_id || await db.prepare('SELECT 1 FROM hx_app_entities WHERE org_id=? AND app_id=? AND table_id=?').bind(orgId, appId, tableId).first();
    if (!linked || !(await mayUseTable(db, orgId, tableId, userId)) || !(await db.prepare('SELECT 1 FROM hx_rows WHERE org_id=? AND table_id=? AND id=?').bind(orgId, tableId, rowId).first())) return { error: 'No such record.', status: 404 };
  }
  const scope = JSON.stringify([orgId, appId, tableId, rowId]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope));
  const threadId = 'object_' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  const params = [orgId, appId, tableId, rowId];
  if (write) {
    if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 4000 || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestId)) return { error: 'Message and request ID are required (maximum 4000 characters).', status: 400 };
    const body = input.body.trim();
    await db.prepare(`INSERT OR IGNORE INTO hx_app_messages (org_id,app_id,table_id,row_id,author_id,request_id,body,created_at) VALUES (?,?,?,?,?,?,?,?)`).bind(...params, String(userId), input.requestId, body, new Date().toISOString()).run();
    const message = await db.prepare('SELECT sequence AS id,body FROM hx_app_messages WHERE org_id=? AND app_id=? AND table_id=? AND row_id=? AND author_id=? AND request_id=?').bind(...params, String(userId), input.requestId).first();
    if (message.body !== body) return { error: 'Request ID was already used for a different message.', status: 409 };
    return { threadId, messageId: message.id };
  }
  const before = input.before === undefined || input.before === '' ? null : Number(input.before);
  if (before !== null && (!Number.isSafeInteger(before) || before < 1)) return { error: 'Invalid cursor.', status: 400 };
  const { results } = await db.prepare(`SELECT m.sequence AS id,m.author_id AS authorId,COALESCE(u.name,u.login,'メンバー') AS authorName,m.body,m.created_at AS createdAt
    FROM hx_app_messages m LEFT JOIN users u ON u.github_id=m.author_id
    WHERE m.org_id=? AND m.app_id=? AND m.table_id=? AND m.row_id=? AND (? IS NULL OR m.sequence<?)
    ORDER BY m.sequence DESC LIMIT 51`).bind(...params, before, before).all();
  const messages = (results || []).slice(0, 50).reverse();
  return { threadId, messages, hasMore: results.length > 50 };
}
