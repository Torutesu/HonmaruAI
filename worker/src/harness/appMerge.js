import { databaseView, readFork, digest, relationStateError } from './appDatabase.js';
import { validateValues } from './tableContract.js';
import { getTable } from './tables.js';
import { prepareWorkflowRowEventIfWatched } from './workflowRowEventDispatch.js';
const err=(error,status=409)=>({error,status});
const canonical=value=>JSON.stringify(value, Object.keys(value).sort());
// Leave headroom below D1's documented 2,000-statement batch example and
// Workers' approximate 5,000 bindings-per-script limit. A watched row adds
// one outbox statement and each row change adds one write statement.
export const MAX_FORK_MERGE_RECORDS=250;

// Match the app-management and table access checks at the point where a
// preview is returned and where the reviewed merge is committed. A table can
// also be linked from another app, whose private policy must be respected.
const mergeAuthority=ids=>`EXISTS(SELECT 1 FROM memberships m JOIN hx_apps target ON target.org_id=m.org_id AND target.id=?2
  LEFT JOIN hx_app_access target_policy ON target_policy.org_id=target.org_id AND target_policy.app_id=target.id
  WHERE m.org_id=?1 AND m.user_github_id=?3 AND lower(trim(coalesce(m.role,'member')))!='guest'
    AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=m.org_id AND d.purge_started_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM workspace_tombstones d WHERE d.org_id=m.org_id)
    AND (target.created_by=?3 OR lower(trim(coalesce(m.role,'member'))) IN ('admin','owner'))
    AND (coalesce(target_policy.visibility,'workspace')='workspace' OR target.created_by=?3)
    AND NOT EXISTS(SELECT 1 FROM json_each(${ids}) selected WHERE
      NOT EXISTS(SELECT 1 FROM hx_tables t WHERE t.org_id=?1 AND t.id=selected.value)
      OR EXISTS(SELECT 1 FROM (
        SELECT a.id FROM hx_apps a WHERE a.org_id=?1 AND a.table_id=selected.value
        UNION SELECT e.app_id AS id FROM hx_app_entities e WHERE e.org_id=?1 AND e.table_id=selected.value
      ) linked LEFT JOIN hx_apps a ON a.org_id=?1 AND a.id=linked.id
        LEFT JOIN hx_app_access p ON p.org_id=a.org_id AND p.app_id=a.id
        WHERE a.id IS NULL OR (coalesce(p.visibility,'workspace')!='workspace' AND a.created_by IS NOT ?3))))`;
const mayMerge=async(db,orgId,appId,by,tableIds)=>Boolean(await db.prepare(`SELECT 1 AS ok WHERE ${mergeAuthority('?4')}`)
  .bind(orgId,appId,String(by),JSON.stringify(tableIds)).first());

function columnInput(column){const {id,...input}=column;return input;}
function schemaJournalOperations(before,after){
  const operations=[];
  const oldById=new Map((before||[]).map(column=>[column.id,column]));
  const nextById=new Map((after||[]).map(column=>[column.id,column]));
  const additions=(after||[]).filter(column=>!oldById.has(column.id));
  if(additions.length)operations.push({op:'add_columns',columns:additions.map(columnInput)});
  for(const old of before||[]){
    const next=nextById.get(old.id);
    if(!next){operations.push({op:'drop_empty_column',column:old.id});continue;}
    const shape=column=>JSON.stringify({type:column.type,options:column.options,targetEntity:column.targetEntity,multiple:column.multiple});
    if(shape(old)!==shape(next))operations.push({op:'convert_column',column:old.id,type:next.type,...(next.options?{options:next.options}:{}),...(next.type==='relation'?{targetEntity:next.targetEntity,multiple:Boolean(next.multiple)}:{})});
    if(old.name!==next.name)operations.push({op:'rename_column',column:old.id,name:next.name});
  }
  return operations;
}

// Compute a bounded three-way diff. Existing forks without a base cannot merge.
export async function previewMerge(db,orgId,app,by,input) {
  const {fork}=await readFork(db,orgId,app.id,by);
  if(!fork||fork.id!==input.forkId||fork.revision!==input.revision)return err('Preview changed. Reload before reviewing.');
  if(fork.mergedAt)return err('This preview was already merged. Create a fresh preview before editing.');
  const base=await db.prepare('SELECT data FROM hx_app_fork_bases WHERE fork_id=?1 AND org_id=?2 AND app_id=?3 AND created_by=?4').bind(fork.id,orgId,app.id,String(by)).first();
  if(!base)return err('This older preview has no merge baseline. Create a new preview from production.');
  if(input.resolutions!==undefined&&(!input.resolutions||typeof input.resolutions!=='object'||Array.isArray(input.resolutions)))return err('Conflict resolutions must be a record choice map.',400);
  const original=JSON.parse(base.data),tableIds=original.map(entity=>entity.table.id);
  if(!await mayMerge(db,orgId,app.id,by,tableIds))return err('No such app.',404);
  const schema=await databaseView(db,orgId,app),changes=[],conflicts=[],snapshots=[],schemaChanges=[];
  const suppliedResolutions=input.resolutions||{};
  if(schema.entities.length!==original.length)return err('The production schema changed. Create a fresh preview.');
  const originalByKey=new Map(original.map(entity=>[entity.key,entity])),currentByKey=new Map(schema.entities.map(entity=>[entity.key,entity])),forkByKey=new Map(fork.entities.map(entity=>[entity.key,entity]));
  if(forkByKey.size!==fork.entities.length||new Set(fork.entities.map(entity=>entity.table.id)).size!==fork.entities.length)return err('Preview entity keys and table IDs must be unique.',409);
  const deletedEntities=original.filter(entity=>!forkByKey.has(entity.key));
  if(deletedEntities.some(entity=>entity.key==='primary'))return err('The primary entity cannot be deleted.',409);
  for(const entity of original){
    const current=currentByKey.get(entity.key),edited=forkByKey.get(entity.key);
    if(!current||current.table.id!==entity.table.id||JSON.stringify(current.table.columns)!==JSON.stringify(entity.table.columns))return err('The production schema changed. Create a fresh preview.');
    if(edited&&edited.table.id!==entity.table.id)return err('The production schema changed. Create a fresh preview.');
  }
  const newEntities=fork.entities.filter(entity=>!originalByKey.has(entity.key));
  if(newEntities.some(entity=>currentByKey.has(entity.key)||!/^tbl_[a-f0-9]{32}$/.test(entity.table.id)))return err('A preview entity conflicts with the production schema. Create a fresh preview.',409);
  for(const entity of deletedEntities){
    const reference=await db.prepare(`SELECT 1 AS referenced FROM hx_workflows w WHERE w.org_id=?1 AND (
      (json_extract(w.trigger,'$.type')='row' AND json_extract(w.trigger,'$.tableId')=?2)
      OR (json_extract(w.trigger,'$.type')='app_record_change' AND json_extract(w.trigger,'$.appId')=?3 AND json_extract(w.trigger,'$.entityId')=?4)
    ) LIMIT 1`).bind(orgId,entity.table.id,app.id,entity.key).first();
    if(reference)return err('Remove Workflow references before deleting this entity.',409);
  }
  for(const entity of original){
    const current=currentByKey.get(entity.key),edited=forkByKey.get(entity.key);
    const beforeColumns=entity.table.columns||[],previewColumns=edited?.table.columns||[];
    if(!edited)schemaChanges.push({entity:entity.key,tableId:current.table.id,tableName:current.table.name,before:beforeColumns,after:[],newEntity:false,deletedEntity:true,operations:[{op:'drop_entity',entity:entity.key}]});
    else if(JSON.stringify(beforeColumns)!==JSON.stringify(previewColumns))schemaChanges.push({entity:entity.key,tableId:current.table.id,tableName:current.table.name,before:beforeColumns,after:previewColumns,newEntity:false,operations:schemaJournalOperations(beforeColumns,previewColumns)});
    const {results=[]}=await db.prepare('SELECT id,data,updated_at AS updatedAt FROM hx_rows WHERE org_id=?1 AND table_id=?2 ORDER BY id').bind(orgId,current.table.id).all();
    snapshots.push({key:entity.key,tableId:current.table.id,columns:JSON.stringify(current.table.columns),rows:results,...(!edited?{deletedEntity:true}:{})});
    const live=new Map(results.map(r=>[r.id,r])),before=new Map(entity.rows.map(r=>[r.id,r])),after=new Map((edited?.rows||[]).map(r=>[r.id,r]));
    for(const id of new Set([...before.keys(),...after.keys()])) {
      const a=before.get(id),b=after.get(id);
      if(a&&b&&canonical(a.values)===canonical(b.values))continue;
      const row=live.get(id),operation=!a?'create':!b?'remove':'update';
      const changeId=`${entity.key}:${id}`;
      if(a?(!row||row.updatedAt!==a.updatedAt||canonical(JSON.parse(row.data))!==canonical(a.values)):!!row)conflicts.push({changeId,entity:entity.key,id,reason:'Production changed after this preview was created.',production:row?JSON.parse(row.data):null,preview:b?.values??null});
      if(b&&validateValues(previewColumns,b.values).length)return err('Preview contains invalid values.',400);
      changes.push({entity:entity.key,tableId:current.table.id,tableName:current.table.name,id,operation,before:a?.values??null,after:b?.values??null});
    }
  }
  for(const entity of newEntities){
    const columns=entity.table.columns||[];
    schemaChanges.push({entity:entity.key,tableId:entity.table.id,tableName:entity.table.name,before:[],after:columns,newEntity:true,operations:[{op:'create_entity',entity:entity.key,name:entity.table.name,columns:columns.map(columnInput)}]});
    snapshots.push({key:entity.key,tableId:entity.table.id,columns:JSON.stringify(columns),rows:[],newEntity:true,name:entity.table.name});
    for(const row of entity.rows){
      if(validateValues(columns,row.values).length)return err('Preview contains invalid values.',400);
      changes.push({entity:entity.key,tableId:entity.table.id,tableName:entity.table.name,id:row.id,operation:'create',before:null,after:row.values});
    }
  }
  const conflictIds=new Set(conflicts.map(conflict=>conflict.changeId));
  if(Object.keys(suppliedResolutions).some(id=>!conflictIds.has(id)||!['preview','production'].includes(suppliedResolutions[id])))return err('Choose whether to keep production or use the preview for each conflicting record.',400);
  const unresolved=conflicts.filter(conflict=>!['preview','production'].includes(suppliedResolutions[conflict.changeId]));
  const conflictsById=new Map(conflicts.map(conflict=>[conflict.changeId,conflict]));
  const appliedChanges=changes.flatMap(change=>{
    const changeId=`${change.entity}:${change.id}`;
    if(!conflictIds.has(changeId))return [change];
    if(suppliedResolutions[changeId]!=='preview')return [];
    const conflict=conflictsById.get(changeId);
    // A preview-created row can collide with an independently-created live ID.
    // Explicitly choosing the preview means replacing that live row, not issuing
    // an INSERT that fails after the human has reviewed the collision.
    return change.operation==='create'&&conflict?.production!==null
      ? [{...change,operation:'update',before:conflict?.production??null}]
      : [change];
  });
  for(const snapshot of snapshots){
    const net=appliedChanges.filter(change=>change.tableId===snapshot.tableId).reduce((total,change)=>total+(change.operation==='create'?1:change.operation==='remove'?-1:0),0);
    if(snapshot.rows.length+net>5000)return err('Production row limit would be exceeded.',400);
  }
  if(appliedChanges.length>MAX_FORK_MERGE_RECORDS)return err(`Merge at most ${MAX_FORK_MERGE_RECORDS} changed records at once. Use a smaller preview.`,400);
  // Validate the exact merged production state after the user's conflict choices.
  // This allows a preview to add related rows together, but never leaves a dangling relation.
  const mergeEntities=snapshots.map(snapshot=>{
    if(snapshot.deletedEntity)return null;
    const source=schema.entities.find(entity=>entity.key===snapshot.key);
    const previewEntity=fork.entities.find(entity=>entity.key===snapshot.key);
    return {key:snapshot.key,table:{id:snapshot.tableId,name:source?.table.name||'',columns:previewEntity?.table.columns||source?.table.columns||[]},rows:snapshot.rows.map(row=>({id:row.id,values:JSON.parse(row.data||'{}'),updatedAt:row.updatedAt}))};
  });
  const survivingMergeEntities=mergeEntities.filter(Boolean);
  for(const change of appliedChanges){
    if(deletedEntities.some(entity=>entity.key===change.entity)){
      if(change.operation!=='remove')return err('A deleted entity cannot contain preview records.',409);
      continue;
    }
    const entity=survivingMergeEntities.find(item=>item.key===change.entity);
    if(!entity)return err('The production schema changed. Create a fresh preview.',409);
    const index=entity.rows.findIndex(row=>row.id===change.id);
    if(change.operation==='remove'){if(index>=0)entity.rows.splice(index,1);}
    else if(index>=0)entity.rows[index]={...entity.rows[index],values:change.after};
    else entity.rows.push({id:change.id,values:change.after,updatedAt:null});
  }
  const relationError=relationStateError(survivingMergeEntities);
  if(relationError)return err(relationError,409);
  const resolutions=Object.fromEntries(Object.keys(suppliedResolutions).sort().map(id=>[id,suppliedResolutions[id]]));
  const review={forkId:fork.id,revision:fork.revision,schemaVersion:schema.version,changes,conflicts,schemaChanges,resolved:unresolved.length===0};
  const checksum=await digest(JSON.stringify({review,snapshots,resolutions,appliedChanges}));
  if(!await mayMerge(db,orgId,app.id,by,tableIds))return err('No such app.',404);
  return {...review,checksum,snapshots,resolutions,appliedChanges};
}

export async function mergeFork(db,orgId,app,by,input) {
  const previous=await db.prepare('SELECT checksum,created_at AS mergedAt,plan FROM hx_app_fork_merges WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND fork_id=?4').bind(orgId,app.id,String(by),String(input.forkId||'')).first();
  if(previous){
    const {results}=await db.prepare('SELECT table_id FROM hx_apps WHERE org_id=?1 AND id=?2 UNION SELECT table_id FROM hx_app_entities WHERE org_id=?1 AND app_id=?2').bind(orgId,app.id).all();
    if(!await mayMerge(db,orgId,app.id,by,(results||[]).map(row=>row.table_id)))return err('No such app.',404);
    if(previous.checksum!==input.checksum)return err('This preview was already merged.');
    let replayPlan;
    try{replayPlan=JSON.parse(previous.plan)}catch{replayPlan=null}
    return {merged:true,replay:true,mergedAt:previous.mergedAt,forkId:input.forkId,checksum:input.checksum,changed:Array.isArray(replayPlan?.changes)?replayPlan.changes.length:Array.isArray(replayPlan)?replayPlan.length:0,schemaChanged:Array.isArray(replayPlan?.schemaChanges)?replayPlan.schemaChanges.length:0};
  }
  const plan=await previewMerge(db,orgId,app,by,input);
  if(plan.error)return plan;
  if(!plan.resolved)return err('Choose whether to keep production or use the preview for every conflicting record.');
  if(!plan.changes.length&&!plan.schemaChanges.length)return err('There are no changes to merge.',400);
  if(!plan.appliedChanges.length&&!plan.conflicts.length&&!plan.schemaChanges.length)return err('There are no changes to merge.',400);
  if(plan.checksum!==input.checksum)return err('Production or preview changed. Review the differences again.');
  const latest=plan.snapshots.reduce((n,e)=>e.rows.reduce((m,r)=>Math.max(m,Date.parse(r.updatedAt)||0),n),Date.now());
  const nonce=crypto.randomUUID(),at=new Date(latest+1).toISOString();
  const originalRows=new Map(plan.snapshots.flatMap(entity=>entity.rows.map(row=>[`${entity.tableId}:${row.id}`,row])));
  // The receipt and every mutation commit in one D1 transaction. Recheck the
  // entire reviewed schema/data snapshot at transaction time, including deletes.
  const receipt=db.prepare(`INSERT OR IGNORE INTO hx_app_fork_merges (org_id,app_id,created_by,fork_id,revision,checksum,nonce,plan,created_at)
    SELECT ?1,?2,?3,?4,?5,?7,?8,?9,?10 WHERE
    EXISTS (SELECT 1 FROM hx_app_forks WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND id=?4 AND revision=?5)
    AND ${mergeAuthority('?11')}
    AND coalesce((SELECT version FROM hx_app_database_state WHERE org_id=?1 AND app_id=?2),0)=?12
    AND (SELECT COUNT(*)+1 FROM hx_app_entities WHERE org_id=?1 AND app_id=?2)=json_array_length(?6)-(SELECT COUNT(*) FROM json_each(?6) WHERE json_extract(value,'$.newEntity')=1)
    AND NOT EXISTS (SELECT 1 FROM json_each(?6) e WHERE
      (json_extract(e.value,'$.newEntity')=1 AND (EXISTS (SELECT 1 FROM hx_tables t WHERE t.org_id=?1 AND t.id=json_extract(e.value,'$.tableId')) OR EXISTS (SELECT 1 FROM hx_app_entities l WHERE l.org_id=?1 AND l.app_id=?2 AND l.entity_key=json_extract(e.value,'$.key'))))
      OR (coalesce(json_extract(e.value,'$.newEntity'),0)=0 AND (
        NOT EXISTS (SELECT 1 FROM hx_tables t WHERE t.org_id=?1 AND t.id=json_extract(e.value,'$.tableId') AND t.columns=json_extract(e.value,'$.columns'))
        OR NOT EXISTS (SELECT 1 FROM hx_apps a WHERE a.org_id=?1 AND a.id=?2 AND ((json_extract(e.value,'$.key')='primary' AND a.table_id=json_extract(e.value,'$.tableId')) OR EXISTS (SELECT 1 FROM hx_app_entities l WHERE l.org_id=?1 AND l.app_id=?2 AND l.entity_key=json_extract(e.value,'$.key') AND l.table_id=json_extract(e.value,'$.tableId'))))
        OR (SELECT COUNT(*) FROM hx_rows r WHERE r.org_id=?1 AND r.table_id=json_extract(e.value,'$.tableId'))!=json_array_length(e.value,'$.rows')
        OR EXISTS (SELECT 1 FROM json_each(e.value,'$.rows') expected WHERE NOT EXISTS
          (SELECT 1 FROM hx_rows r WHERE r.org_id=?1 AND r.table_id=json_extract(e.value,'$.tableId') AND r.id=json_extract(expected.value,'$.id') AND r.data=json_extract(expected.value,'$.data') AND r.updated_at=json_extract(expected.value,'$.updatedAt')))
        OR (json_extract(e.value,'$.deletedEntity')=1 AND EXISTS (SELECT 1 FROM hx_workflows w WHERE w.org_id=?1 AND (
          (json_extract(w.trigger,'$.type')='row' AND json_extract(w.trigger,'$.tableId')=json_extract(e.value,'$.tableId'))
          OR (json_extract(w.trigger,'$.type')='app_record_change' AND json_extract(w.trigger,'$.appId')=?2 AND json_extract(w.trigger,'$.entityId')=json_extract(e.value,'$.key')))))))
    )`).bind(orgId,app.id,String(by),plan.forkId,plan.revision,JSON.stringify(plan.snapshots),plan.checksum,nonce,JSON.stringify({schemaChanges:plan.schemaChanges,changes:plan.changes}),at,JSON.stringify(plan.snapshots.filter(snapshot=>!snapshot.newEntity).map(snapshot=>snapshot.tableId)),plan.schemaVersion);
  const guard='EXISTS (SELECT 1 FROM hx_app_fork_merges WHERE org_id=?1 AND app_id=?2 AND nonce=?3)';
  const statements=[receipt],queuedEvents=new Map();
  for(const change of plan.schemaChanges) {
    if(change.newEntity){
      statements.push(db.prepare(`INSERT INTO hx_tables (id,org_id,name,columns,created_by,created_at,updated_at) SELECT ?4,?1,?5,?6,?7,?8,?8 WHERE ${guard}`).bind(orgId,app.id,nonce,change.tableId,change.tableName,JSON.stringify(change.after),String(by),at));
      statements.push(db.prepare(`INSERT INTO hx_app_entities (org_id,app_id,entity_key,table_id) SELECT ?1,?2,?4,?5 WHERE ${guard}`).bind(orgId,app.id,nonce,change.entity,change.tableId));
    }else if(!change.deletedEntity)statements.push(db.prepare(`UPDATE hx_tables SET columns=?4,updated_at=?5 WHERE org_id=?1 AND id=?6 AND columns=?7 AND ${guard}`).bind(orgId,app.id,nonce,JSON.stringify(change.after),at,change.tableId,JSON.stringify(change.before)));
  }
  if(plan.schemaChanges.length) {
    statements.push(db.prepare(`INSERT INTO hx_app_database_state (org_id,app_id,version) SELECT ?1,?2,1 WHERE ${guard} ON CONFLICT(org_id,app_id) DO UPDATE SET version=version+1 WHERE ${guard}`).bind(orgId,app.id,nonce));
    const operations=plan.schemaChanges.flatMap(change=>(change.operations||[]).map(operation=>({...operation,entity:change.entity})));
    const inverseOperations=operations.every(operation=>['add_columns','rename_column'].includes(operation.op))
      ? [...operations].reverse().flatMap(operation=>operation.op==='add_columns'
        ? operation.columns.map(column=>({op:'drop_empty_column',entity:operation.entity,column:plan.schemaChanges.find(change=>change.entity===operation.entity)?.after.find(item=>item.name===column.name)?.id})).filter(item=>item.column)
        : [{op:'rename_column',entity:operation.entity,column:operation.column,name:plan.schemaChanges.find(change=>change.entity===operation.entity)?.before.find(item=>item.id===operation.column)?.name}])
      : null;
    const journalPlan=JSON.stringify({format:2,operations,inverseOperations});
    const journalChecksum=await digest(journalPlan),migrationId=`preview_${nonce.replaceAll('-','').slice(0,16)}`;
    statements.push(db.prepare(`INSERT INTO hx_app_migrations (org_id,app_id,migration_id,version,checksum,plan,nonce,created_by,created_at) SELECT ?1,?2,?4,?5,?6,?7,?3,?8,?9 WHERE ${guard}`).bind(orgId,app.id,nonce,migrationId,plan.schemaVersion+1,journalChecksum,journalPlan,String(by),at));
  }
  for(const c of plan.appliedChanges) {
    if(c.operation==='create')statements.push(db.prepare(`INSERT INTO hx_rows (id,table_id,org_id,data,position,created_by,updated_by,created_at,updated_at) SELECT ?4,?5,?1,?6,COALESCE((SELECT MAX(position)+1 FROM hx_rows WHERE org_id=?1 AND table_id=?5),0),?7,?7,?8,?8 WHERE ${guard}`).bind(orgId,app.id,nonce,c.id,c.tableId,JSON.stringify(c.after),String(by),at));
    else if(c.operation==='update')statements.push(db.prepare(`UPDATE hx_rows SET data=?6,updated_by=?7,updated_at=?8 WHERE org_id=?1 AND table_id=?5 AND id=?4 AND ${guard}`).bind(orgId,app.id,nonce,c.id,c.tableId,JSON.stringify(c.after),String(by),at));
    else statements.push(db.prepare(`DELETE FROM hx_rows WHERE org_id=?1 AND table_id=?5 AND id=?4 AND ${guard}`).bind(orgId,app.id,nonce,c.id,c.tableId));
    const table=await getTable(db,orgId,c.tableId);
    if(table) {
      const schemaChange=plan.schemaChanges.find(change=>change.tableId===c.tableId);
      if(schemaChange)table.columns=schemaChange.after;
      const before=c.operation==='create'?null:{id:c.id,tableId:c.tableId,values:c.before||{},updatedAt:originalRows.get(`${c.tableId}:${c.id}`)?.updatedAt||null};
      const row=c.operation==='remove'?null:{id:c.id,tableId:c.tableId,values:c.after||{},updatedBy:String(by),updatedAt:at};
      // The event directly follows its row statement, which is fenced by the
      // receipt, so a merge rejected at commit time queues no event.
      const event=await prepareWorkflowRowEventIfWatched(db,{orgId,table,before,row,by:String(by)},{afterRowChange:true});
      if(event){statements.push(event.statement);queuedEvents.set(`${c.tableId}:${c.id}`,event.id);}
    }
  }
  for(const change of plan.schemaChanges.filter(item=>item.deletedEntity)) {
    statements.push(db.prepare(`DELETE FROM hx_app_entities WHERE org_id=?1 AND app_id=?2 AND entity_key=?4 AND table_id=?5 AND ${guard}`).bind(orgId,app.id,nonce,change.entity,change.tableId));
    statements.push(db.prepare(`DELETE FROM hx_tables WHERE org_id=?1 AND id=?4 AND NOT EXISTS (SELECT 1 FROM hx_rows WHERE org_id=?1 AND table_id=?4) AND ${guard}`).bind(orgId,app.id,nonce,change.tableId));
  }
  const results=await db.batch(statements);
  if(!results[0].meta?.changes)return err('Production or preview changed during merge. Review again.');
  // The route consumes these only after the atomic merge has committed, then
  // removes them from the public response. Keep the exact prior revision so
  // row-change receipts remain stable when a preview merge is replayed.
  const changedRecords=plan.appliedChanges.map(change=>({
    tableId:change.tableId,id:change.id,operation:change.operation,
    before:change.before,after:change.after,
    beforeUpdatedAt:originalRows.get(`${change.tableId}:${change.id}`)?.updatedAt||null,
    rowEventId:queuedEvents.get(`${change.tableId}:${change.id}`),
  }));
  return {merged:true,mergedAt:at,changed:plan.appliedChanges.length,schemaChanged:plan.schemaChanges.length,keptProduction:plan.conflicts.filter(conflict=>plan.resolutions[conflict.changeId]==='production').length,forkId:plan.forkId,checksum:plan.checksum,changedRecords};
}
