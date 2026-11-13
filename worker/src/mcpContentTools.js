import { McpInputError, requireMcpScope, mcpResult, validateMcpInput } from './mcpSupport.js';
import { resolveMcpConversation, mcpConversationContext, mcpAudienceSql } from './mcpConversation.js';
import { listMembers } from './team.js';
import { listEmoji } from './emoji.js';
import { getCanvas, saveCanvas, toClientCanvas, MAX_CANVAS_CHARS } from './canvas.js';
import { viewOf } from './channels.js';
import { accessFor } from './access.js';
import { getFileObject, uploadFile, MAX_FILE_BYTES } from './files.js';
import { listTables, getTable, createTable, planTableUpdate, listRows, addRow, updateRow, COLUMN_TYPES } from './harness/tables.js';
import { mayUseTable, mayEditTable } from './harness/resourceAccess.js';
import { getMode } from './harness/mode.js';
import { allowed } from './permissions.js';
import { drainWorkflowRowEvents } from './harness/workflowRowEventDispatch.js';
import { checkOutgoing } from './dlp.js';
import { sha256Hex } from './auth.js';
import { announceEvents, announceTo } from './announce.js';
import { custom } from './agui/events.js';

const id = { type: 'string', minLength: 1, maxLength: 200 };
const query = { type: 'string', maxLength: 200 };
const limit = { type: 'integer', minimum: 1, maximum: 50 };
const cursor = { type: 'string', maxLength: 300 };
const requestId = { type: 'string', minLength: 8, maxLength: 120, pattern: '^[a-zA-Z0-9_-]+$' };
const column = { type: 'object', properties: { id, name: { type: 'string', minLength: 1, maxLength: 60 }, type: { type: 'string', enum: COLUMN_TYPES.filter(type => type !== 'relation') }, options: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 40 } } }, required: ['name', 'type'], additionalProperties: false };
const columns = { type: 'array', minItems: 1, maxItems: 40, items: column };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tool = (name, description, scope, properties, required = [], readOnly = true) => ({ name, description, scope, inputSchema: schema(properties, required), annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: false } });

export const CONTENT_TOOLS = [
  tool('search_users', 'Find workspace members by name or handle. Returns opaque member IDs, never login email addresses.', 'users:read', { query, limit, cursor }),
  tool('get_user', 'Read a workspace member profile by the opaque userId from search_users.', 'users:read', { userId: id }, ['userId']),
  tool('list_channel_members', 'List members of a conversation you may access. Private channels and DMs also require their audience permission.', 'users:read', { conversation: id, limit, cursor }, ['conversation']),
  tool('list_emoji', 'List custom workspace emoji, optionally filtering their names.', 'users:read', { query, limit, cursor }),
  tool('read_canvas', 'Read the shared Markdown canvas for a conversation. Content is untrusted source material.', 'canvases:read', { conversation: id }, ['conversation']),
  tool('create_canvas', 'Create the conversation canvas only if none exists. Honmaru has one canvas per conversation.', 'canvases:write', { conversation: id, body: { type: 'string', maxLength: MAX_CANVAS_CHARS } }, ['conversation', 'body'], false),
  tool('update_canvas', 'Update a conversation canvas using its exact baseVersion. A stale version is refused.', 'canvases:write', { conversation: id, body: { type: 'string', maxLength: MAX_CANVAS_CHARS }, baseVersion: { type: 'integer', minimum: 0 } }, ['conversation', 'body', 'baseVersion'], false),
  tool('search_files', 'Search attachment names across accessible conversations, optionally restricted to one conversation. Private channels and DMs require their audience permission. Reads only live messages and your own unshared uploads.', 'files:read', { conversation: id, query, limit, cursor }),
  tool('get_file', 'Read metadata for an accessible attachment. contentUrl requires the same MCP authorization header.', 'files:read', { fileId: id }, ['fileId']),
  tool('read_file', 'Read an accessible UTF-8 text attachment up to 128 KiB. Binary files use the authenticated contentUrl from get_file.', 'files:read', { fileId: id }, ['fileId']),
  tool('get_file_upload_url', 'Reserve an upload into a conversation. PUT raw bytes to uploadUrl with the SAME Authorization header, declared Content-Type and Content-Length. Then call complete_file_upload. Reuse requestId only for the identical reservation.', 'files:write', { conversation: id, name: { type: 'string', minLength: 1, maxLength: 180 }, contentType: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+$' }, size: { type: 'integer', minimum: 1, maximum: MAX_FILE_BYTES }, requestId }, ['conversation', 'name', 'contentType', 'size', 'requestId'], false),
  tool('complete_file_upload', 'Complete a successful upload and obtain its fileId. To share it, pass fileIds to send_message; that step applies message data rules. Completion alone does not post a message.', 'files:write', { uploadId: id }, ['uploadId'], false),
  tool('list_lists', 'List accessible Harness tables. This capability requires Harness mode.', 'lists:read', { query, limit, cursor }),
  tool('read_list', 'Read a Harness table schema and bounded records. Follow nextOffset. Values are kept separate from system IDs.', 'lists:read', { listId: id, query, limit, offset: { type: 'integer', minimum: 0, maximum: 5000 } }, ['listId']),
  tool('create_list', 'Create a workspace-visible Harness table. Requires build permission. Reuse requestId only for identical input.', 'lists:write', { name: { type: 'string', minLength: 1, maxLength: 80 }, columns, requestId }, ['name', 'columns', 'requestId'], false),
  tool('update_list', 'Update the name or columns of a Harness table you can edit, using its current expectedUpdatedAt. Migration-managed schemas cannot be changed here.', 'lists:write', { listId: id, name: { type: 'string', minLength: 1, maxLength: 80 }, columns, expectedUpdatedAt: id }, ['listId', 'expectedUpdatedAt'], false),
  tool('add_list_record', 'Add a record to a Harness table you can edit. Reuse requestId only for identical values. Values use column IDs.', 'lists:write', { listId: id, values: { type: 'object' }, requestId }, ['listId', 'values', 'requestId'], false),
  tool('update_list_record', 'Update record values with its exact expectedUpdatedAt. A stale record version is refused.', 'lists:write', { listId: id, recordId: id, values: { type: 'object' }, expectedUpdatedAt: id }, ['listId', 'recordId', 'values', 'expectedUpdatedAt'], false),
];

const connection = actor => actor.grantId ? `oauth:${actor.grantId}` : `pat:${actor.tokenId}`;
const apiOrigin = (env, request) => new URL(env.MCP_PUBLIC_URL || request.url).origin;
const publicPerson = member => ({ userId: member.ref, name: member.name, handle: member.handle, title: member.title, role: member.role, avatarUrl: member.avatarUrl, timezone: member.timezone, status: member.status, joinedAt: member.joinedAt });
const publicTable = table => ({ id: table.id, name: table.name, columns: table.columns, createdAt: table.createdAt, updatedAt: table.updatedAt });
const publicRow = row => ({ id: row.id, values: row.values, createdAt: row.createdAt, updatedAt: row.updatedAt });

function page(items, args, key) {
  let after = '';
  if (args.cursor) {
    try { after = JSON.parse(atob(args.cursor)); } catch { throw new McpInputError('Invalid continuation cursor.'); }
    if (typeof after !== 'string') throw new McpInputError('Invalid continuation cursor.');
  }
  const selected = items.sort((a, b) => String(a[key]).localeCompare(String(b[key]))).filter(item => !after || String(item[key]).localeCompare(after) > 0);
  const count = args.limit || 30;
  const visible = selected.slice(0, count);
  return { items: visible, nextCursor: selected.length > count ? btoa(JSON.stringify(String(visible.at(-1)[key]))) : null };
}

async function once(env, actor, operation, args, run) {
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const payloadHash = await sha256Hex(JSON.stringify(stable(args)));
  const key = [actor.orgId, actor.githubId, connection(actor), args.requestId];
  const inserted = await env.DB.prepare('INSERT OR IGNORE INTO mcp_content_mutations (org_id,actor_id,connection_id,request_id,operation,payload_hash,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)').bind(...key, operation, payloadHash, Date.now()).run();
  if (!inserted.meta?.changes) {
    const row = await env.DB.prepare('SELECT operation,payload_hash,result FROM mcp_content_mutations WHERE org_id=?1 AND actor_id=?2 AND connection_id=?3 AND request_id=?4').bind(...key).first();
    if (row?.operation !== operation || row.payload_hash !== payloadHash) throw new McpInputError('This requestId was already used with different input.');
    if (!row.result) throw new McpInputError('This operation is in progress or its outcome is uncertain. Read the resource before starting another operation.');
    return JSON.parse(row.result);
  }
  const value = await run();
  await env.DB.prepare('UPDATE mcp_content_mutations SET result=?5 WHERE org_id=?1 AND actor_id=?2 AND connection_id=?3 AND request_id=?4').bind(...key, JSON.stringify(value)).run();
  return value;
}

async function allowList(env, actor, listId, writing) {
  if (await getMode(env.DB, actor.orgId) !== 'harness') throw new McpInputError('Lists require Harness mode.');
  if (writing && !await allowed(env.DB, actor.orgId, actor.githubId, 'harness.build')) throw new McpInputError('You do not have permission to change lists.');
  if (listId && !await mayUseTable(env.DB, actor.orgId, listId, actor.githubId)) throw new McpInputError('No such list.');
  // Build permission belongs to every ordinary member and seeing an app's table
  // is often only a view grant, so writes need edit access to every app that
  // exposes the table, the same rule as the web table route and Harness MCP.
  if (listId && writing && !await mayEditTable(env.DB, actor.orgId, listId, actor.githubId)) throw new McpInputError('You do not have permission to change this list.');
}

async function checkContent(env, actor, request, text, where) {
  const denied = await checkOutgoing(env, request, { orgId: actor.orgId, login: actor.login, text, where });
  if (denied) {
    const body = await denied.json();
    throw new McpInputError(body.message || 'Workspace data rules prevent this operation.');
  }
}

function checked(result) {
  if (result.error) throw new McpInputError(result.error);
  return result;
}

async function readableFile(env, actor, fileId) {
  const row = await env.DB.prepare(`SELECT f.* FROM message_files f WHERE f.org_id=?1 AND f.id=?2 AND (
    (f.message_id IS NULL AND f.uploader=?3) OR EXISTS (SELECT 1 FROM channel_messages m WHERE m.org_id=f.org_id AND m.id=f.message_id AND m.channel=f.channel AND m.deleted_at IS NULL AND (m.parent_id IS NULL OR EXISTS (SELECT 1 FROM channel_messages p WHERE p.org_id=m.org_id AND p.id=m.parent_id AND p.channel=m.channel AND p.deleted_at IS NULL))))`).bind(actor.orgId, fileId, actor.login).first();
  if (!row) throw new McpInputError('No such file.');
  const members = await listMembers(env.DB, actor.orgId, actor.githubId);
  const view = viewOf(row.channel, actor.login, members, await accessFor(env.DB, actor.orgId, actor.login));
  if (!view) throw new McpInputError('No such file.');
  await resolveMcpConversation(env, actor, view);
  return row;
}

function fileInfo(row, env, request) {
  return { id: row.id, name: row.name, contentType: row.type, size: row.size, messageId: row.message_id, createdAt: row.created_at, contentUrl: `${apiOrigin(env, request)}/mcp/files/${encodeURIComponent(row.id)}/content`, requiresAuthorization: true };
}

export async function callContentTool(env, actor, name, args = {}, request, ctx) {
  const definition = CONTENT_TOOLS.find(item => item.name === name);
  if (!definition) return null;
  requireMcpScope(actor, definition.scope);
  validateMcpInput(args, definition.inputSchema);
  if (name === 'search_users' || name === 'get_user' || name === 'list_channel_members') {
    let members = await listMembers(env.DB, actor.orgId, actor.githubId);
    if (name === 'get_user') {
      const found = members.find(member => member.ref === args.userId);
      if (!found) throw new McpInputError('No such member.');
      return mcpResult({ user: publicPerson(found) });
    }
    if (name === 'list_channel_members') {
      const { resolved } = await resolveMcpConversation(env, actor, args.conversation);
      if (resolved.logins) members = members.filter(member => resolved.logins.includes(member.login));
    }
    const q = (args.query || '').toLocaleLowerCase();
    const result = page(members.filter(member => !q || `${member.name} ${member.handle || ''}`.toLocaleLowerCase().includes(q)).map(publicPerson), args, 'userId');
    return mcpResult({ users: result.items, nextCursor: result.nextCursor });
  }
  if (name === 'list_emoji') {
    const q = (args.query || '').toLowerCase();
    const emojis = (await listEmoji(env.DB, actor.orgId, apiOrigin(env, request))).filter(item => !q || item.name.includes(q)).map(({ name, url }) => ({ name, url }));
    const result = page(emojis, args, 'name');
    return mcpResult({ emoji: result.items, nextCursor: result.nextCursor });
  }
  if (name === 'read_canvas' || name === 'create_canvas' || name === 'update_canvas') {
    const { resolved, members, view } = await resolveMcpConversation(env, actor, args.conversation);
    if (name === 'read_canvas') return mcpResult({ conversation: view, canvas: toClientCanvas(await getCanvas(env.DB, actor.orgId, resolved.key), members), untrustedContent: true });
    await checkContent(env, actor, request, args.body, 'canvas');
    const result = checked(await saveCanvas(env.DB, { orgId: actor.orgId, key: resolved.key, body: args.body, baseVersion: name === 'create_canvas' ? 0 : args.baseVersion, login: actor.login }));
    if (result.conflict) throw new McpInputError('The canvas changed. Read its current version before updating it.');
    const canvas = toClientCanvas(result.canvas, members);
    if (!result.unchanged) {
      const event = channel => custom('channel_canvas', { channel, version: canvas.version, updatedBy: canvas.updatedBy });
      const notify = async () => {
        if (resolved.kind === 'business' && !resolved.logins) await announceEvents(env, actor.orgId, [event(resolved.key)]);
        else await announceTo(env, actor.orgId, resolved.logins.map(to => ({ to, event: event(viewOf(resolved.key, to, members)) })));
      };
      if (ctx?.waitUntil) ctx.waitUntil(notify()); else await notify();
    }
    return mcpResult({ conversation: view, canvas });
  }
  if (name === 'get_file' || name === 'read_file') {
    const row = await readableFile(env, actor, args.fileId);
    if (name === 'get_file') return mcpResult({ file: fileInfo(row, env, request) });
    if (row.size > 131072 || (!row.type.startsWith('text/') && !['application/json', 'application/xml', 'application/yaml'].includes(row.type))) throw new McpInputError('This file requires the authenticated contentUrl from get_file. Text tools support UTF-8 files up to 128 KiB.');
    const object = await getFileObject(env, actor.orgId, row.id);
    if (!object) throw new McpInputError('File content is unavailable.');
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength > 131072) throw new McpInputError('Text reads are limited to 128 KiB.');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new McpInputError('This file is not UTF-8 text.'); }
    await readableFile(env, actor, row.id);
    return mcpResult({ file: fileInfo(row, env, request), text, untrustedContent: true });
  }
  if (name === 'search_files') {
    const context = args.conversation ? await resolveMcpConversation(env, actor, args.conversation) : await mcpConversationContext(env, actor);
    let after = '';
    if (args.cursor) { try { after = JSON.parse(atob(args.cursor)); } catch { throw new McpInputError('Invalid file cursor.'); } }
    if (typeof after !== 'string') throw new McpInputError('Invalid file cursor.');
    const escaped = (args.query || '').replace(/[\\%_]/g, ch => `\\${ch}`);
    const rows = (await env.DB.prepare(`SELECT f.* FROM message_files f
      WHERE f.org_id=?1 AND f.id>?3 AND f.name LIKE ?4 ESCAPE '\\' AND (?5 IS NULL OR f.channel=?5)
        AND ${mcpAudienceSql(actor.scopes, 'f')}
        AND (
          (f.channel LIKE 'b:%' AND EXISTS (
            SELECT 1 FROM businesses b WHERE b.org_id=?1 AND 'b:' || b.slug=f.channel AND b.archived_at IS NULL
              AND (b.private=0 OR EXISTS (SELECT 1 FROM conversation_members c WHERE c.org_id=?1 AND c.channel=f.channel AND c.login=?2))))
          OR (f.channel LIKE 'g:%' AND EXISTS (SELECT 1 FROM conversation_members c WHERE c.org_id=?1 AND c.channel=f.channel AND c.login=?2))
          OR (f.channel LIKE 'dm:%' AND EXISTS (
            SELECT 1 FROM memberships ms JOIN users u ON u.github_id=ms.user_github_id
            WHERE ms.org_id=?1 AND u.login!=?2
              AND (f.channel='dm:' || ?2 || '|' || u.login OR f.channel='dm:' || u.login || '|' || ?2))))
        AND ((f.message_id IS NULL AND f.uploader=?2) OR EXISTS (
          SELECT 1 FROM channel_messages m WHERE m.org_id=f.org_id AND m.id=f.message_id AND m.channel=f.channel
            AND m.deleted_at IS NULL AND (m.parent_id IS NULL OR EXISTS (
              SELECT 1 FROM channel_messages p WHERE p.org_id=m.org_id AND p.id=m.parent_id AND p.channel=m.channel AND p.deleted_at IS NULL))))
      ORDER BY f.id LIMIT ?6`).bind(actor.orgId, actor.login, after, `%${escaped}%`, context.resolved?.key || null, (args.limit || 30) + 1).all()).results || [];
    const selected = rows.slice(0, args.limit || 30);
    return mcpResult({ files: selected.map(row => fileInfo(row, env, request)), nextCursor: rows.length > selected.length ? btoa(JSON.stringify(selected.at(-1).id)) : null });
  }
  if (name === 'get_file_upload_url') {
    await resolveMcpConversation(env, actor, args.conversation);
    const reservation = await once(env, actor, name, args, async () => {
      const uploadId = crypto.randomUUID();
      const expiresAt = Date.now() + 15 * 60 * 1000;
      await env.DB.prepare('INSERT INTO mcp_file_uploads (id,org_id,actor_id,connection_id,conversation,name,content_type,size,state,expires_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,\'pending\',?9)').bind(uploadId, actor.orgId, actor.githubId, connection(actor), args.conversation, args.name, args.contentType, args.size, expiresAt).run();
      return { uploadId, uploadUrl: `${apiOrigin(env, request)}/mcp/uploads/${uploadId}`, method: 'PUT', requiresAuthorization: true, expiresAt };
    });
    await ownUpload(env, actor, reservation.uploadId);
    return mcpResult(reservation);
  }
  if (name === 'complete_file_upload') {
    const upload = await ownUpload(env, actor, args.uploadId);
    if (!['uploaded', 'complete'].includes(upload.state)) throw new McpInputError('Upload bytes have not completed.');
    const file = await readableFile(env, actor, upload.file_id);
    await env.DB.prepare("UPDATE mcp_file_uploads SET state='complete' WHERE id=?1 AND org_id=?2 AND state='uploaded'").bind(upload.id, actor.orgId).run();
    return mcpResult({ file: fileInfo(file, env, request), fileId: file.id, shared: Boolean(file.message_id) });
  }
  const writing = definition.scope === 'lists:write';
  await allowList(env, actor, args.listId, writing);
  if (name === 'list_lists') {
    const q = (args.query || '').toLocaleLowerCase();
    const visible = [];
    for (const table of await listTables(env.DB, actor.orgId)) if ((!q || table.name.toLocaleLowerCase().includes(q)) && await mayUseTable(env.DB, actor.orgId, table.id, actor.githubId)) visible.push(publicTable(table));
    const result = page(visible, args, 'id');
    return mcpResult({ lists: result.items, nextCursor: result.nextCursor });
  }
  if (name === 'read_list') {
    const result = checked(await listRows(env.DB, actor.orgId, args.listId, { q: args.query, limit: args.limit || 30, offset: args.offset || 0 }));
    await allowList(env, actor, args.listId, false);
    return mcpResult({ list: publicTable(result.table), records: result.rows.map(publicRow), nextOffset: result.nextOffset, total: result.total });
  }
  await checkContent(env, actor, request, JSON.stringify(args), 'list');
  if (name === 'create_list') {
    const result = await once(env, actor, name, args, async () => ({ list: publicTable(checked(await createTable(env.DB, { orgId: actor.orgId, name: args.name, columns: args.columns, by: actor.githubId })).table), visibility: 'workspace' }));
    await allowList(env, actor, result.list.id, true);
    return mcpResult(result);
  }
  if (name === 'update_list') {
    const current = await getTable(env.DB, actor.orgId, args.listId);
    if (current.updatedAt !== args.expectedUpdatedAt) throw new McpInputError('The list changed. Read its current version before updating it.');
    const plan = checked(await planTableUpdate(env.DB, actor.orgId, args.listId, { name: args.name, columns: args.columns }, { sql: 'updated_at=?9', binds: [args.expectedUpdatedAt] }));
    if (!(await plan.statement.run()).meta?.changes) throw new McpInputError('The list changed. Read its current version before updating it.');
    return mcpResult({ list: publicTable(await getTable(env.DB, actor.orgId, args.listId)) });
  }
  if (name === 'add_list_record') return mcpResult(await once(env, actor, name, args, async () => {
    const result = checked(await addRow(env.DB, actor.orgId, args.listId, args.values, actor.githubId, 'strict', actor.githubId));
    if(result.rowEventId)await drainWorkflowRowEvents(env,{eventId:result.rowEventId,limit:1});
    return { record: publicRow(result.row) };
  }));
  if (name === 'update_list_record') {
    const result = checked(await updateRow(env.DB, actor.orgId, args.listId, args.recordId, args.values, actor.githubId, args.expectedUpdatedAt, 'strict', actor.githubId));
    if(result.rowEventId)await drainWorkflowRowEvents(env,{eventId:result.rowEventId,limit:1});
    return mcpResult({ record: publicRow(result.row) });
  }
  return null;
}

async function ownUpload(env, actor, uploadId) {
  const upload = await env.DB.prepare('SELECT * FROM mcp_file_uploads WHERE id=?1 AND org_id=?2 AND actor_id=?3 AND connection_id=?4').bind(uploadId, actor.orgId, actor.githubId, connection(actor)).first();
  if (!upload || upload.expires_at < Date.now()) throw new McpInputError('No current upload reservation.');
  await resolveMcpConversation(env, actor, upload.conversation);
  return upload;
}

export async function handleMcpContentUpload(request, env, url, actor) {
  const match = /^\/mcp\/uploads\/([a-f0-9-]{36})$/.exec(url.pathname);
  const download = /^\/mcp\/files\/(f_[a-f0-9]{24})\/content$/.exec(url.pathname);
  if (!match && !download) return null;
  const headers = { 'cache-control': 'no-store', 'content-type': 'application/json' };
  const method = download ? 'GET' : 'PUT';
  if (request.method !== method) return new Response(null, { status: 405, headers: { allow: method } });
  const scope = download ? 'files:read' : 'files:write';
  if (!actor.scopes?.includes(scope)) return new Response(JSON.stringify({ message: `This connection requires the ${scope} permission.` }), { status: 403, headers });
  try {
    if (download) {
      const row = await readableFile(env, actor, download[1]);
      const object = await getFileObject(env, actor.orgId, row.id);
      if (!object) throw new McpInputError('File content is unavailable.');
      await readableFile(env, actor, row.id);
      return new Response(object.body, { headers: { 'content-type': row.type, 'content-length': String(row.size), 'content-disposition': 'attachment', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'no-store' } });
    }
    const upload = await ownUpload(env, actor, match[1]);
    if (['uploaded', 'complete'].includes(upload.state)) return new Response(JSON.stringify({ uploadId: upload.id, uploaded: true }), { headers });
    if (upload.state !== 'pending') throw new McpInputError('Upload already started. Check completion before reserving a replacement.');
    if (Number(request.headers.get('content-length')) !== upload.size || request.headers.get('content-type') !== upload.content_type) throw new McpInputError('Upload headers must match the reservation.');
    const claimed = await env.DB.prepare("UPDATE mcp_file_uploads SET state='uploading' WHERE id=?1 AND org_id=?3 AND state='pending' AND expires_at>?2").bind(upload.id, Date.now(), actor.orgId).run();
    if (!claimed.meta?.changes) throw new McpInputError('Upload already started.');
    const { resolved } = await resolveMcpConversation(env, actor, upload.conversation);
    const target = new URL(request.url);
    target.searchParams.set('name', upload.name);
    const response = await uploadFile(request, env, target, { orgId: actor.orgId, resolved, login: actor.login });
    const result = await response.json();
    if (!response.ok) {
      await env.DB.prepare("UPDATE mcp_file_uploads SET state='failed' WHERE id=?1 AND org_id=?2").bind(upload.id, actor.orgId).run();
      return new Response(JSON.stringify({ message: result.message }), { status: response.status, headers });
    }
    await env.DB.prepare("UPDATE mcp_file_uploads SET state='uploaded',file_id=?2 WHERE id=?1 AND org_id=?3 AND state='uploading'").bind(upload.id, result.file.id, actor.orgId).run();
    return new Response(JSON.stringify({ uploadId: upload.id, uploaded: true }), { status: 201, headers });
  } catch (error) {
    if (error instanceof McpInputError) return new Response(JSON.stringify({ message: error.message }), { status: 400, headers });
    throw error;
  }
}
