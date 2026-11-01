import { currentIp } from './requestContext.js';
import { skillSessionAuthority } from './harness/skillSessionAuthority.js';
import { skillPolicyFingerprint, skillSsoDeadline, evaluateSnapshot } from './harness/skillPolicyProof.js';

// This is the last authorization point before a deletion-recovery promotion.
// It evaluates one complete policy snapshot, then uses that snapshot, the
// session generation, and membership generation in the same D1 batch as both
// the guarded promotion and the final permission result.
export async function deletionOwnerGate(env, session, orgId, initialDue) {
  const denied = { status: 410, body: { message: 'This workspace is being deleted.', code: 'workspace-deleting', orgId, dueAt: initialDue } };
  const ipDenied = { status: 403, body: { message: "This workspace can only be used from your company's network.", code: 'ip-not-allowed', orgId } };
  if (typeof session.token !== 'string' || !session.token.startsWith('h1:') || !session.created_at) return denied;
  const db=env.DB,user=String(session.github_id),key=session.token;
  const snapshot=await db.prepare(`SELECT m.created_at AS memberSince,m.role AS memberRole,EXISTS(SELECT 1 FROM memberships own WHERE own.org_id=m.org_id AND own.role='owner') AS hasOwner,d.due_at AS dueAt,d.requested_at AS requestedAt,d.requested_by AS requestedBy,
    ${skillPolicyFingerprint('?1','?2','?3')} AS fingerprint
    FROM memberships m JOIN workspace_deletions d ON d.org_id=m.org_id WHERE m.org_id=?1 AND m.user_github_id=?2`)
    .bind(orgId,user,key).first();
  if(!snapshot) return denied;
  let checked,mayPromote;
  try {
    const state=JSON.parse(snapshot.fingerprint);
    const network=typeof state.network==='string'?JSON.parse(state.network):state.network;
    mayPromote=Boolean(currentIp() || !network?.enforce);
    if(!mayPromote && !String(orgId).includes('/') && String(snapshot.memberRole).toLowerCase()==='admin' && !snapshot.hasOwner)return ipDenied;
    checked=evaluateSnapshot(snapshot.fingerprint,orgId);
  } catch { return denied; }
  if(!checked.allowed) return denied;
  const proof=`member.created_at IS ?4 AND sess.created_at IS ?5
    AND ${skillSessionAuthority('?1','?2','?3')}
    AND (${skillPolicyFingerprint('?1','?2','?3')})=?6 AND ${skillSsoDeadline('?7')}
    AND d.due_at IS ?8 AND COALESCE(d.due_at,'')!='' AND d.requested_at IS ?9 AND d.requested_by IS ?10
    AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=?1)`;
  const args=[orgId,user,key,snapshot.memberSince,session.created_at,snapshot.fingerprint,checked.ssoDeadline??null,snapshot.dueAt,snapshot.requestedAt,snapshot.requestedBy,mayPromote?1:0];
  const exists=`EXISTS(SELECT 1 FROM memberships member JOIN sessions sess ON sess.token=?3 AND sess.github_id=?2
    JOIN workspace_deletions d ON d.org_id=member.org_id WHERE member.org_id=?1 AND member.user_github_id=?2 AND d.purge_started_at IS NULL AND ${proof})`;
  const promote=db.prepare(`UPDATE memberships SET role='owner' WHERE org_id=?1 AND role='admin'
    AND ?11=1 AND instr(?1,'/')=0 AND user_github_id=(SELECT user_github_id FROM memberships WHERE org_id=?1 AND role='admin' ORDER BY created_at ASC,user_github_id ASC LIMIT 1)
    AND NOT EXISTS(SELECT 1 FROM memberships WHERE org_id=?1 AND role='owner')
    AND EXISTS(SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2 AND LOWER(COALESCE(role,'member'))='admin')
    AND ${exists}`).bind(...args);
  const gate=db.prepare(`SELECT 1 AS allowed FROM memberships member JOIN sessions sess ON sess.token=?3 AND sess.github_id=?2
    JOIN workspace_deletions d ON d.org_id=member.org_id WHERE member.org_id=?1 AND member.user_github_id=?2 AND ${proof}
    AND (?11 IN (0,1)) AND (LOWER(member.role)='owner' OR (instr(?1,'/')>0 AND LOWER(member.role)='admin'))`).bind(...args);
  const result=await db.batch([promote,gate]);
  return result[1]?.results?.length ? null : denied;
}
