import { rowEventFingerprint } from './workflowRowEventFingerprint.js';

const MAX_PAYLOAD_BYTES = 200_000;
const LEASE_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const DONE_RETENTION_MS = 7 * 24 * 60 * 60_000;

// `afterRowChange` makes the event conditional on the statement placed just
// before it in the same batch having changed a row. A guarded write that is
// rejected (stale version, schema, relation or access) then commits no event,
// so no Workflow starts on values that were never stored. Callers that put
// another statement between the write and the event keep their own fence.
export async function prepareWorkflowRowEvent(db, {orgId,table,before=null,row,by,depth=0,at=Date.now()}, {afterRowChange=false}={}) {
  if (!orgId || !table?.id || !(row?.id || before?.id) || !Number.isSafeInteger(depth) || depth < 0) {
    throw new Error('Invalid Workflow row event.');
  }
  // Keep only the schema data needed to evaluate the existing trigger
  // predicates and construct event scopes after a delayed delivery.
  const payload = JSON.stringify({orgId,table:{id:table.id,columns:Array.isArray(table.columns)?table.columns:[]},before,row,by,depth});
  if (new TextEncoder().encode(payload).byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error(`Workflow row event exceeds ${MAX_PAYLOAD_BYTES} bytes.`);
  }
  const eventHash=await rowEventFingerprint(table,before,row);
  const id = `wre_${crypto.randomUUID()}`;
  return {
    id,
    eventHash,
    statement: db.prepare(`INSERT INTO hx_workflow_row_event_outbox(id,org_id,table_id,event_hash,payload,status,attempts,next_attempt,lease_until,created_at)
      SELECT ?1,?2,?3,?4,?5,'pending',0,?6,0,?6${afterRowChange?' WHERE changes()>0':''}`)
      .bind(id,orgId,table.id,eventHash,payload,at),
  };
}

// Human, API and connector writes use the same durable trigger path as
// Workflow-produced writes. Avoid filling the workspace queue for tables
// nobody watches; a matching enabled row/App-entity trigger makes the outbox
// statement part of the row mutation batch, so a full queue cannot silently
// commit the business write without its event.
export async function prepareWorkflowRowEventIfWatched(db, change, options) {
  const {orgId,table}=change||{};
  if(!orgId||!table?.id)return null;
  const watcher=await db.prepare(`SELECT 1 AS watched FROM hx_workflows w
    WHERE w.org_id=?1 AND w.enabled=1 AND (
      (json_extract(w.trigger,'$.type')='row' AND json_extract(w.trigger,'$.tableId')=?2)
      OR (json_extract(w.trigger,'$.type')='app_record_change' AND (
        EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=w.org_id AND a.id=json_extract(w.trigger,'$.appId') AND a.table_id=?2)
        OR EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=w.org_id AND e.app_id=json_extract(w.trigger,'$.appId')
          AND e.entity_key=json_extract(w.trigger,'$.entityId') AND e.table_id=?2)))) LIMIT 1`)
    .bind(orgId,table.id).first();
  return watcher?prepareWorkflowRowEvent(db,change,options):null;
}

async function deliverWorkflowRowEvent(env,payload) {
  const {onRowChange,onRowDelete}=await import('./workflows.js');
  if(payload.row==null&&payload.before)return onRowDelete(env,{orgId:payload.orgId,table:payload.table,row:payload.before,by:payload.by,depth:payload.depth,strict:true});
  return onRowChange(env,{...payload,strict:true});
}

// The same minute cron that runs scheduled Workflows also drains this queue.
// These four global maintenance/claim statements intentionally span orgs so a
// single bounded cron can drain the shared outbox; rows are inserted with
// org_id, claims are keyed by globally unique event id/lease, and payload scope
// is checked against the claimed row before any Workflow trigger is evaluated.
// Row receipts inside startRun make each per-workflow fan-out safe to retry if
// a Worker stops after starting only some of the matching Workflows.
export async function drainWorkflowRowEvents(env,{limit=25,now=Date.now(),eventId=null,deliver=deliverWorkflowRowEvent}={}) {
  const db=env?.DB;
  if(!db)return {claimed:0,delivered:0,retried:0};
  const cap=Math.max(1,Math.min(100,Math.floor(Number(limit)||25)));
  await db.prepare(`DELETE FROM hx_workflow_row_event_outbox
    WHERE status='done' AND completed_at<=?1`).bind(now-DONE_RETENTION_MS).run();
  const {results=[]}=await db.prepare(`SELECT id FROM hx_workflow_row_event_outbox
    WHERE status='pending' AND next_attempt<=?1 AND lease_until<=?1 AND (?3 IS NULL OR id=?3)
    ORDER BY next_attempt,created_at,id LIMIT ?2`).bind(now,cap,eventId).all();
  let claimed=0,delivered=0,retried=0;
  for(const candidate of results){
    const lease=crypto.randomUUID();
    const item=await db.prepare(`UPDATE hx_workflow_row_event_outbox SET lease=?2,lease_until=?3,attempts=attempts+1
      WHERE id=?1 AND status='pending' AND next_attempt<=?4 AND lease_until<=?4
      RETURNING id,org_id,payload,attempts`).bind(candidate.id,lease,now+LEASE_MS,now).first();
    if(!item)continue;
    claimed+=1;
    try{
      const payload=JSON.parse(item.payload);
      if(payload.orgId!==item.org_id)throw new Error('Workflow row event scope mismatch.');
      await deliver(env,payload);
      const saved=await db.prepare(`UPDATE hx_workflow_row_event_outbox SET status='done',completed_at=?3,lease=NULL,lease_until=0,last_error=NULL
        WHERE id=?1 AND status='pending' AND lease=?2`).bind(item.id,lease,now).run();
      if(saved.meta?.changes)delivered+=1;
    }catch(error){
      const retryMs=Math.min(MAX_BACKOFF_MS,1_000*2**Math.min(12,Math.max(0,item.attempts-1)));
      const message=String(error?.message||error).slice(0,300);
      await db.prepare(`UPDATE hx_workflow_row_event_outbox SET lease=NULL,lease_until=0,next_attempt=?3,last_error=?4
        WHERE id=?1 AND status='pending' AND lease=?2`).bind(item.id,lease,now+retryMs,message).run();
      retried+=1;
      console.error('workflow row event delivery failed',item.id,message);
    }
  }
  return {claimed,delivered,retried};
}

