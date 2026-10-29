// Delivery intent commits with its message. Each path owns a lease and retry
// clock, so notification lookups never hold up connected readers.
export function messageDeliveryStatements(db, orgId, messageId) {
  return ['live', 'push'].map(kind => db.prepare(`INSERT INTO channel_message_delivery (org_id,message_id,kind)
    SELECT org_id,id,?3 FROM channel_messages WHERE org_id=?1 AND id=?2 AND deleted_at IS NULL
    ON CONFLICT DO NOTHING`).bind(orgId,messageId,kind));
}

export async function drainMessageDelivery(db, deliver, {kind, orgId=null, messageId=null, now=Date.now(), limit=20}={}) {
  if (!['live','push'].includes(kind)) throw new Error('Invalid message delivery kind');
  const sweepStarted = Date.now();
  await db.prepare(`UPDATE channel_message_delivery SET status='failed',lease=NULL,lease_until=0
    WHERE kind=?1 AND status='pending' AND attempts>=10 AND lease_until<=?2
      AND (?3 IS NULL OR org_id=?3) AND (?4 IS NULL OR message_id=?4)`)
    .bind(kind,now,orgId,messageId).run();
  const {results=[]}=await db.prepare(`SELECT org_id,message_id,attempts FROM channel_message_delivery
    WHERE kind=?1 AND status='pending' AND attempts<10 AND next_attempt<=?2 AND lease_until<=?2
      AND (?3 IS NULL OR org_id=?3) AND (?4 IS NULL OR message_id=?4)
    ORDER BY next_attempt,message_id LIMIT ?5`).bind(kind,now,orgId,messageId,Math.min(50,Math.max(1,limit))).all();
  // Advance each lease when it is acquired, even if earlier jobs were slow.
  // Bounded work per sweep; separate kind sweeps run independently.
  for (const row of results) {
    const current = now + Date.now() - sweepStarted;
    const lease=crypto.randomUUID();
    const claim=await db.prepare(`UPDATE channel_message_delivery SET lease=?4,lease_until=?5,attempts=attempts+1
      WHERE org_id=?1 AND message_id=?2 AND kind=?3 AND status='pending' AND attempts<10 AND next_attempt<=?6 AND lease_until<=?6`)
      .bind(row.org_id,row.message_id,kind,lease,current+60000,current).run();
    if (!claim.meta?.changes) continue;
    let status='done';
    try { await deliver(row.org_id,row.message_id); }
    catch { status=row.attempts>=9?'failed':'pending'; }
    const finished = now + Date.now() - sweepStarted;
    await db.prepare(`UPDATE channel_message_delivery SET status=?5,lease=NULL,lease_until=0,next_attempt=?6
      WHERE org_id=?1 AND message_id=?2 AND kind=?3 AND lease=?4`)
      .bind(row.org_id,row.message_id,kind,lease,status,finished+Math.min(3600000,15000*2**Math.min(row.attempts,8))).run();
  }
}
