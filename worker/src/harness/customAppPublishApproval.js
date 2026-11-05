import { getTable } from "./tables.js";

export const CUSTOM_PUBLISH_SCOPE = "custom-app.publish";
export async function sourceHash(source) {
  const bytes = new TextEncoder().encode(String(source || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
}
export async function customPublishState(db, orgId, app) {
  const policy = await db.prepare("SELECT enabled, updated_by AS updatedBy, updated_at AS updatedAt FROM hx_app_publish_policies WHERE org_id=?1 AND app_id=?2").bind(orgId,app.id).first();
  const draft = app.definition.custom?.draft || "";
  const hash = await sourceHash(draft);
  const approval = await db.prepare("SELECT id, draft_version AS draftVersion, source_hash AS sourceHash, scope, requested_by AS requestedBy, reviewer_id AS reviewerId, status, created_at AS createdAt, reviewed_at AS reviewedAt, consumed_at AS consumedAt FROM hx_app_publish_approvals WHERE org_id=?1 AND app_id=?2 AND draft_version=?3 AND source_hash=?4 AND scope=?5 ORDER BY created_at DESC LIMIT 1").bind(orgId,app.id,app.version,hash,CUSTOM_PUBLISH_SCOPE).first();
  return { policy: { enabled: Boolean(policy?.enabled), updatedBy: policy?.updatedBy || null, updatedAt: policy?.updatedAt || null }, approval: approval || null, draftVersion: app.version, sourceHash: hash, scope: CUSTOM_PUBLISH_SCOPE };
}
export async function setCustomPublishPolicy(db, orgId, app, enabled, by) {
  const at = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO hx_app_publish_policies(org_id,app_id,enabled,updated_by,updated_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(org_id,app_id) DO UPDATE SET enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(orgId,app.id,enabled?1:0,String(by),at),
    ...(!enabled ? [db.prepare("UPDATE hx_app_publish_approvals SET status='revoked', reviewed_at=?3 WHERE org_id=?1 AND app_id=?2 AND status IN ('pending','approved')").bind(orgId,app.id,at)] : [])
  ]);
  return { saved:true, policy:{enabled:Boolean(enabled),updatedBy:String(by),updatedAt:at} };
}
export async function requestCustomPublishApproval(db, orgId, app, by) {
  const state = await customPublishState(db,orgId,app);
  if (!state.policy.enabled) return {error:"Approval policy is disabled.",status:409};
  if (!state.sourceHash || !(app.definition.custom?.draft||"").trim()) return {error:"Save a custom app draft before requesting approval.",status:400};
  const existing=state.approval;
  if(existing?.status==="pending") return {error:"An approval request already exists for this draft.",status:409};
  const at=new Date().toISOString(), id=crypto.randomUUID();
  await db.prepare("INSERT INTO hx_app_publish_approvals(id,org_id,app_id,draft_version,source_hash,scope,requested_by,status,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'pending',?8)").bind(id,orgId,app.id,app.version,state.sourceHash,CUSTOM_PUBLISH_SCOPE,String(by),at).run();
  return {saved:true,approval:{id,draftVersion:app.version,sourceHash:state.sourceHash,scope:CUSTOM_PUBLISH_SCOPE,status:"pending",requestedBy:String(by),createdAt:at}};
}
export async function reviewCustomPublishApproval(db, orgId, app, input, reviewerId, reviewerIsAdmin) {
  if (!reviewerIsAdmin) return {error:"Only an Owner or Admin can review a custom app release.",status:403};
  const state=await customPublishState(db,orgId,app), approval=state.approval;
  if(!state.policy.enabled || !approval || approval.id!==input.approvalId || approval.status!=="pending") return {error:"This approval is missing, revoked, or already reviewed.",status:409};
  if(String(approval.requestedBy)===String(reviewerId)) return {error:"The requester cannot approve their own release.",status:403};
  if(Number(input.version)!==app.version || input.sourceHash!==state.sourceHash || approval.draftVersion!==app.version || approval.sourceHash!==state.sourceHash || approval.scope!==CUSTOM_PUBLISH_SCOPE) return {error:"The draft changed. Request a new approval for the current version.",status:409};
  const decision=input.decision;
  if(!["approve","reject"].includes(decision)) return {error:"Choose approve or reject.",status:400};
  const status=decision==="approve"?"approved":"rejected", at=new Date().toISOString();
  const result=await db.prepare("UPDATE hx_app_publish_approvals SET status=?1,reviewer_id=?2,reviewed_at=?3 WHERE id=?4 AND org_id=?5 AND app_id=?6 AND status='pending' AND draft_version=?7 AND source_hash=?8 AND scope=?9 AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id=?5 AND m.user_github_id=?2 AND m.role IN ('owner','admin'))").bind(status,String(reviewerId),at,approval.id,orgId,app.id,app.version,state.sourceHash,CUSTOM_PUBLISH_SCOPE).run();
  if(!result.meta?.changes) return {error:"This approval was already reviewed or the draft changed.",status:409};
  return {saved:true,approval:{...approval,status,reviewerId:String(reviewerId),reviewedAt:at}};
}
export async function consumeCustomPublishApproval(db, orgId, app, by, definition, version, at, table) {
  const state=await customPublishState(db,orgId,app);
  if(!state.policy.enabled) return {enabled:false};
  const approval=state.approval;
  if(!approval || approval.status!=="approved" || String(approval.requestedBy)===String(by) || Number(approval.draftVersion)!==app.version || approval.sourceHash!==state.sourceHash || approval.scope!==CUSTOM_PUBLISH_SCOPE) return {error:"An independent Owner or Admin must approve this exact saved draft before publishing.",status:409};
  const update=await db.batch([
    db.prepare("UPDATE hx_apps SET definition=?1,version=?2,updated_at=?3 WHERE id=?4 AND org_id=?5 AND version=?6 AND json_extract(definition,'$.custom.draft')=?7 AND EXISTS (SELECT 1 FROM hx_app_publish_policies p WHERE p.org_id=?5 AND p.app_id=?4 AND p.enabled=1) AND EXISTS (SELECT 1 FROM hx_app_publish_approvals a WHERE a.id=?8 AND a.org_id=?5 AND a.app_id=?4 AND a.draft_version=?6 AND a.source_hash=?9 AND a.scope=?10 AND a.status='approved' AND a.consumed_at IS NULL AND a.reviewer_id IS NOT NULL AND a.reviewer_id<>a.requested_by AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id=a.org_id AND m.user_github_id=a.reviewer_id AND m.role IN ('owner','admin')))")
      .bind(JSON.stringify(definition),version,at,app.id,orgId,app.version,app.definition.custom.draft,approval.id,state.sourceHash,CUSTOM_PUBLISH_SCOPE),
    db.prepare("UPDATE hx_app_publish_approvals SET consumed_at=?1 WHERE id=?2 AND status='approved' AND consumed_at IS NULL AND changes()=1").bind(at,approval.id),
    db.prepare("INSERT INTO hx_app_versions(app_id,org_id,version,definition,note,created_by,created_at) SELECT ?1,?2,?3,?4,'Custom app: publish',?5,?6 WHERE changes()=1").bind(app.id,orgId,version,JSON.stringify({...definition,name:app.name,columns:table.columns}),String(by),at)
  ]);
  if(!update[0]?.meta?.changes) return {error:"This app or approval changed. Reload before publishing.",status:409};
  return {enabled:true,saved:true,version};
}
