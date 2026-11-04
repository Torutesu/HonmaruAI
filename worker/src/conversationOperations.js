import { attachedTexts } from './dlpFiles.js';
import { checkOutgoing } from './dlp.js';
import { sendable, MAX_FILES_PER_MESSAGE } from './files.js';
import { clientIdOk, postMessage } from './channels.js';

export async function prepareConversationMessage(env, request, { orgId, user, resolved, body }) {
  const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : null;
  const replyTo = typeof body.replyTo === 'string' && body.replyTo ? body.replyTo : null;
  const fail = (message, status = 400, code) => ({ denied: Response.json({ message, ...(code ? { code } : {}) }, { status }) });
  if (replyTo && body.sendAt) return fail('A scheduled message cannot be a reply yet.');
  const alsoChannel = Boolean(parentId) && body.alsoChannel === true;
  const attached = Array.isArray(body.files) && body.files.length
    ? await attachedTexts(env, { orgId, key: resolved.key, login: user.login, ids: body.files, githubId: user.github_id }).catch(() => []) : [];
  const stopped = await checkOutgoing(env, request, { orgId, login: user.login, text: typeof body.body === 'string' ? body.body : '', files: attached, ack: body.dlpAck === true, where: body.sendAt ? 'scheduled' : parentId ? 'reply' : 'message' });
  if (stopped) return { denied: stopped };
  const uploads = body.sendAt ? { ids: [] } : await sendable(env.DB, { orgId, key: resolved.key, login: user.login, ids: body.files });
  if (uploads.over) return fail(`A message can carry at most ${MAX_FILES_PER_MESSAGE} files.`, 400, 'too_many_files');
  if (body.clientId != null && body.clientId !== '' && !clientIdOk(body.clientId)) return fail('That send cannot be tried again.');
  return { parentId, replyTo, alsoChannel, uploads, withFiles: uploads.ids.length > 0, clientId: typeof body.clientId === 'string' && body.clientId ? body.clientId : null };
}

export async function acceptConversationMessage(env, { orgId, user, resolved, body, prepared, agentRequest = null, conversationActorId = null, mcpAuthority = null }) {
  return postMessage(env.DB, { orgId, key: resolved.key, authorLogin: user.login,
    body: typeof body.body === 'string' ? body.body : '', parentId: prepared.parentId, replyTo: prepared.replyTo,
    withFiles: prepared.withFiles, files: { login: user.login, ...prepared.uploads }, clientId: prepared.clientId,
    alsoChannel: prepared.alsoChannel, agentRequest, deliveryTasks: true, deliveryBoundary: resolved.deliveryBoundary, conversationActorId, mcpAuthority });
}
