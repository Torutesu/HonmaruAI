// Durable card deliveries, drained by the existing one-minute cron. Claims
// expire after a crashed invocation; successful destinations are not resent.
// Provider acceptance is not proof of display on the recipient's device.
import { getCard, getUserByLogin } from './db.js';
import { accessFor, mayReadCard } from './access.js';

export const MAX_ATTEMPTS = 5;
export const retryDelay = (attempt) => [60, 300, 900, 3600][Math.min(Math.max(attempt - 1, 0), 3)] * 1000;
export const retryable = (result) => !result.ok && !result.skipped && (!result.status || result.status === 408 || result.status === 429 || result.status >= 500);
export async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((n) => n.toString(16).padStart(2, '0')).join('');
}

export async function deliverOnce(db, jobId, channel, target, send) {
  if (!jobId) return send();
  const id = await digest(`${jobId}|${channel}|${target}`);
  const prior = await db.prepare('SELECT accepted FROM notification_deliveries WHERE id = ?1').bind(id).first();
  if (prior?.accepted) return { ok: true, status: 200, cached: true };
  const result = await send();
  // Sent is sent: failing to note it down (D1 refusing writes) must not turn
  // a delivery into an exception, which the job would retry as a failure.
  await db.prepare(`INSERT INTO notification_deliveries (id, job_id, channel, accepted, status_code, attempts, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
    ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted, status_code = excluded.status_code,
      attempts = notification_deliveries.attempts + 1, updated_at = excluded.updated_at`)
    .bind(id, jobId, channel, result.ok ? 1 : 0, result.status || 0, new Date().toISOString()).run()
    .catch((err) => console.error("delivery record failed", err?.message || err));
  return result;
}

export async function enqueueCardNotification(env, input) {
  const {card, kind = 'created', toLogin, orgId = null} = input;
  const login = toLogin || (kind === 'decided' ? card?.senderUserID : card?.recipientUserID);
  // A deliberate nudge is a new event; a created/decided event is stable
  // across duplicate broadcasts. Comments have their own identity.
  const event = kind === 'created' ? card.createdAt || '' : kind === 'decided' ? card.decision?.decidedAt || '' : input.comment?.id || crypto.randomUUID();
  const id = await digest(JSON.stringify([orgId, card.id, kind, login, event]));
  const at = new Date().toISOString();
  await env.DB.prepare(`INSERT OR IGNORE INTO notification_jobs
    (id, org_id, login, card_id, kind, payload, state, attempts, due_at, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 0, ?7, ?7, ?7)`)
    .bind(id, orgId, login, card.id, kind, JSON.stringify(input), at).run();
  return id;
}

export async function runCardNotification(env, id, send, now = Date.now()) {
  const at = new Date(now).toISOString();
  const lease = new Date(now + 5 * 60_000).toISOString();
  const claim = await env.DB.prepare(`UPDATE notification_jobs SET lease_until = ?2, attempts = attempts + 1, updated_at = ?3
    WHERE id = ?1 AND state = 'pending' AND due_at <= ?3 AND (lease_until IS NULL OR lease_until <= ?3) AND attempts < ?4`)
    .bind(id, lease, at, MAX_ATTEMPTS).run();
  if (!claim.meta?.changes) return {sent:0, skipped:'already claimed or complete'};
  const job = await env.DB.prepare('SELECT * FROM notification_jobs WHERE id = ?1').bind(id).first();
  let result;
  try {
    const input = JSON.parse(job.payload);
    if (job.attempts > 1) {
      const user = await getUserByLogin(env.DB, job.login);
      if (!user) result = {sent:0, skipped:'recipient removed'};
      if (!result && job.org_id) {
        const member = await env.DB.prepare('SELECT 1 FROM memberships WHERE org_id = ?1 AND user_github_id = ?2').bind(job.org_id, user.github_id).first();
        const card = await getCard(env.DB, job.org_id, job.card_id);
        if (!member || !card || !mayReadCard(card, await accessFor(env.DB, job.org_id, job.login))) result = {sent:0, skipped:'no longer accessible'};
        else if ((job.kind === 'created' || job.kind === 'nudged') && (card.status !== 'pending' || card.recipientUserID !== job.login)) result = {sent:0, skipped:'request changed'};
        else if (job.kind === 'decided' && (card.status === 'pending' || card.decision?.decidedAt !== input.card.decision?.decidedAt)) result = {sent:0, skipped:'response changed'};
        else input.card = card;
      }
    }
    result ||= await send(env, {...input, deliveryJobId:id});
  } catch { result = {sent:0, retry:true, failure:'delivery exception'}; }
  const retry = result.retry && job.attempts < MAX_ATTEMPTS;
  const state = retry ? 'pending' : result.retry ? 'failed' : result.skipped ? 'skipped' : result.sent ? 'sent' : 'failed';
  await env.DB.prepare(`UPDATE notification_jobs SET state = ?2, due_at = ?3, lease_until = NULL,
    last_error = ?4, payload = CASE WHEN ?2 = 'pending' THEN payload ELSE '{}' END, updated_at = ?5 WHERE id = ?1 AND lease_until = ?6`)
    .bind(id, state, new Date(now + retryDelay(job.attempts)).toISOString(), result.retry ? 'transient delivery failure' : result.skipped || (result.sent ? null : 'no accepted delivery'), at, lease).run();
  return result;
}

export async function drainCardNotifications(env, send, now = Date.now()) {
  const at = new Date(now).toISOString();
  await env.DB.prepare("UPDATE notification_jobs SET state = 'failed', payload = '{}', lease_until = NULL, last_error = 'retry limit or expiry' WHERE state = 'pending' AND (created_at < ?1 OR (attempts >= ?2 AND lease_until <= ?3))")
    .bind(new Date(now - 86400000).toISOString(), MAX_ATTEMPTS, at).run();
  const {results} = await env.DB.prepare("SELECT id FROM notification_jobs WHERE state = 'pending' AND due_at <= ?1 AND (lease_until IS NULL OR lease_until <= ?1) ORDER BY due_at LIMIT 25").bind(at).all();
  for (const job of results || []) await runCardNotification(env, job.id, send, now);
  // Finished jobs and their deliveries past a week are trimmed by the daily
  // pruneGrowth (retention.js). Here, every minute, the same two deletes
  // read both tables end to end 1,440 times a day, against D1's daily row
  // reads.
  return {processed:results?.length || 0};
}
