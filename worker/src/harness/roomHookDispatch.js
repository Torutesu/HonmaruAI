import { roomHookExecutionGrant } from './roomHookExecutionGrant.js';

// Retry handoff, not model execution. Runner acceptance must be idempotent by
// org/message ID because a lost response can leave an accepted job pending here.
export async function drainRoomHookDispatch(env, { now = Date.now(), limit = 20, orgId = null, messageId = null } = {}) {
  if (!env.AGENT_RUNNER) return { accepted: 0, cancelled: 0, retried: 0 };
  const cap = Number.isSafeInteger(limit) ? Math.max(1, Math.min(50, limit)) : 20;
  const { results } = await env.DB.prepare("SELECT message_id,org_id,attempts FROM hx_room_hook_dispatch WHERE status='pending' AND next_attempt<=?1 AND lease_until<=?1 AND (?3 IS NULL OR org_id=?3) AND (?4 IS NULL OR message_id=?4) ORDER BY next_attempt,message_id LIMIT ?2").bind(now,cap,orgId,messageId).all();
  const counts = { accepted: 0, cancelled: 0, retried: 0 };
  await Promise.all((results || []).map(async row => {
    const lease = crypto.randomUUID();
    const claimed = await env.DB.prepare("UPDATE hx_room_hook_dispatch SET lease=?3,lease_until=?4,attempts=attempts+1 WHERE message_id=?1 AND org_id=?2 AND status='pending' AND next_attempt<=?5 AND lease_until<=?5")
      .bind(row.message_id,row.org_id,lease,now+60000,now).run();
    if (!claimed.meta?.changes) return;
    let status = 'pending';
    try {
      const grant = await roomHookExecutionGrant(env.DB,row.org_id,row.message_id);
      if (!grant) status = 'cancelled';
      else {
        const stub = env.AGENT_RUNNER.get(env.AGENT_RUNNER.idFromName(row.org_id));
        const response = await stub.fetch('https://agents/enqueue', {
          method: 'POST', headers: {'content-type':'application/json'},
          body: JSON.stringify({kind:'room_hook',orgId:row.org_id,rowId:row.message_id}),
          signal: AbortSignal.timeout(10000),
        });
        if (response.status === 202) status = 'accepted';
      }
    } catch { /* No secrets or external response text enter logs or durable state. */ }
    const next = now + Math.min(3600000, 15000 * 2 ** Math.min(row.attempts, 8));
    const finished = await env.DB.prepare('UPDATE hx_room_hook_dispatch SET status=?4,next_attempt=?5,lease=NULL,lease_until=0,updated_at=?6 WHERE message_id=?1 AND org_id=?2 AND lease=?3')
      .bind(row.message_id,row.org_id,lease,status,next,new Date(now).toISOString()).run();
    if (finished.meta?.changes) counts[status === 'pending' ? 'retried' : status]++;
  }));
  return counts;
}
