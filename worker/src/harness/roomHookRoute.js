import { drainRoomHookDispatch } from './roomHookDispatch.js';
import { enforce } from '../ratelimit.js';
import { authenticateRoomHook, receiveRoomHookEvent } from './roomHooks.js';
import { readRoomWebhookInput } from './roomWebhookInput.js';
import { broadcastRoomHookMessage } from './roomHookBroadcast.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: {'content-type':'application/json', 'cache-control':'no-store', 'x-content-type-options':'nosniff'},
});

export async function handleRoomHook(request, env, url) {
  if (!url.pathname.startsWith('/hooks/rooms/')) return null;
  if (request.method !== 'POST') return json({message:'Method not allowed.'},405);
  const limited = await enforce(env,request,'chat');
  if (limited) return limited;
  const id = url.pathname.slice('/hooks/rooms/'.length);
  const secret = /^Bearer (rh_[0-9a-f]{64})$/.exec(request.headers.get('authorization') || '')?.[1];
  if (!/^[0-9a-f-]{36}$/.test(id) || !secret) return json({message:'Invalid webhook credentials.'},401);
  const hook = await authenticateRoomHook(env.DB,id,secret);
  if (!hook) return json({message:'Invalid webhook credentials.'},401);
  const input = await readRoomWebhookInput(request);
  if (input.error) return json({message:input.error},input.status);
  const result = await receiveRoomHookEvent(env.DB,hook,input);
  // Replays can repair a missed live update; clients replace messages by ID.
  // A failed broadcast never rolls back an already committed event receipt.
  if (!result.error) await Promise.all([
    broadcastRoomHookMessage(env,hook.orgId,hook.channel,result.messageId).catch(() => {}),
    drainRoomHookDispatch(env,{orgId:hook.orgId,messageId:result.messageId,limit:1}).catch(() => {}),
  ]);
  return result.error ? json({message:result.error},result.status) : json(result,result.replay?200:201);
}
