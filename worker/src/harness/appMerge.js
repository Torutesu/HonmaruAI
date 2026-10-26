import { databaseView, readFork, digest } from './appDatabase.js';
import { validateValues } from './tableContract.js';
const err=(error,status=409)=>({error,status});
const canonical=value=>JSON.stringify(value, Object.keys(value).sort());

// Compute a bounded three-way diff. Existing forks without a base cannot merge.
export async function previewMerge(db,orgId,app,by,input) {
  const {fork}=await readFork(db,orgId,app.id,by);
  if(!fork||fork.id!==input.forkId||fork.revision!==input.revision)return err('Preview changed. Reload before reviewing.');
  if(fork.mergedAt)return err('This preview was already merged. Create a fresh preview before editing.');
  const base=await db.prepare('SELECT data FROM hx_app_fork_bases WHERE fork_id=?1 AND org_id=?2 AND app_id=?3 AND created_by=?4').bind(fork.id,orgId,app.id,String(by)).first();
  if(!base)return err('This older preview has no merge baseline. Create a new preview from production.');
  const original=JSON.parse(base.data),schema=await databaseView(db,orgId,app),changes=[],conflicts=[],snapshots=[];
  if(schema.entities.length!==original.length)return err('The production schema changed. Create a fresh preview.');
  for(const entity of original) {
    const current=schema.entities.find(e=>e.key===entity.key),edited=fork.entities.find(e=>e.key===entity.key);
    if(!current||!edited||current.table.id!==entity.table.id||JSON.stringify(current.table.columns)!==JSON.stringify(entity.table.columns))return err('The production schema changed. Create a fresh preview.');
    const {results}=await db.prepare('SELECT id,data,updated_at AS updatedAt FROM hx_rows WHERE org_id=?1 AND table_id=?2 ORDER BY id').bind(orgId,current.table.id).all();
    snapshots.push({key:entity.key,tableId:current.table.id,columns:JSON.stringify(current.table.columns),rows:results});
    const live=new Map(results.map(r=>[r.id,r])),before=new Map(entity.rows.map(r=>[r.id,r])),after=new Map(edited.rows.map(r=>[r.id,r]));
    for(const id of new Set([...before.keys(),...after.keys()])) {
      const a=before.get(id),b=after.get(id);
      if(a&&b&&canonical(a.values)===canonical(b.values))continue;
      const row=live.get(id),operation=!a?'create':!b?'remove':'update';
      if(a?(!row||row.updatedAt!==a.updatedAt||canonical(JSON.parse(row.data))!==canonical(a.values)):!!row)conflicts.push({entity:entity.key,id,reason:'Production changed after this preview was created.'});
      if(b&&validateValues(current.table.columns,b.values).length)return err('Preview contains invalid values.',400);
      changes.push({entity:entity.key,tableId:current.table.id,tableName:current.table.name,id,operation,before:a?.values??null,after:b?.values??null});
    }
    const net=changes.filter(c=>c.entity===entity.key).reduce((n,c)=>n+(c.operation==='create'?1:c.operation==='remove'?-1:0),0);
    if(results.length+net>5000)return err('Production row limit would be exceeded.',400);
  }
  if(changes.length>50)return err('Merge at most 50 changed records at once. Use a smaller preview.',400);
  const review={forkId:fork.id,revision:fork.revision,changes,conflicts};
  const checksum=await digest(JSON.stringify({review,snapshots}));
  return {...review,checksum,snapshots};
}

export async function mergeFork(db,orgId,app,by,input) {
  const previous=await db.prepare('SELECT checksum,created_at AS mergedAt FROM hx_app_fork_merges WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND fork_id=?4').bind(orgId,app.id,String(by),String(input.forkId||'')).first();
  if(previous)return previous.checksum===input.checksum?{merged:true,replay:true,mergedAt:previous.mergedAt,forkId:input.forkId,checksum:input.checksum}:err('This preview was already merged.');
  const plan=await previewMerge(db,orgId,app,by,input);
  if(plan.error)return plan;
  if(!plan.changes.length)return err('There are no changes to merge.',400);
  if(plan.conflicts.length||plan.checksum!==input.checksum)return err('Production or preview changed. Review the differences again.');
  const latest=plan.snapshots.reduce((n,e)=>e.rows.reduce((m,r)=>Math.max(m,Date.parse(r.updatedAt)||0),n),Date.now());
  const nonce=crypto.randomUUID(),at=new Date(latest+1).toISOString();
  // The receipt and every mutation commit in one D1 transaction. Recheck the
  // entire reviewed schema/data snapshot at transaction time, including deletes.
  const receipt=db.prepare(`INSERT OR IGNORE INTO hx_app_fork_merges (org_id,app_id,created_by,fork_id,revision,checksum,nonce,plan,created_at)
    SELECT ?1,?2,?3,?4,?5,?7,?8,?9,?10 WHERE
    EXISTS (SELECT 1 FROM hx_app_forks WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND id=?4 AND revision=?5)
    AND (SELECT COUNT(*)+1 FROM hx_app_entities WHERE org_id=?1 AND app_id=?2)=json_array_length(?6)
    AND NOT EXISTS (SELECT 1 FROM json_each(?6) e WHERE
      NOT EXISTS (SELECT 1 FROM hx_tables t WHERE t.org_id=?1 AND t.id=json_extract(e.value,'$.tableId') AND t.columns=json_extract(e.value,'$.columns'))
      OR NOT EXISTS (SELECT 1 FROM hx_apps a WHERE a.org_id=?1 AND a.id=?2 AND ((json_extract(e.value,'$.key')='primary' AND a.table_id=json_extract(e.value,'$.tableId')) OR EXISTS (SELECT 1 FROM hx_app_entities l WHERE l.org_id=?1 AND l.app_id=?2 AND l.entity_key=json_extract(e.value,'$.key') AND l.table_id=json_extract(e.value,'$.tableId'))))
      OR (SELECT COUNT(*) FROM hx_rows r WHERE r.org_id=?1 AND r.table_id=json_extract(e.value,'$.tableId'))!=json_array_length(e.value,'$.rows')
      OR EXISTS (SELECT 1 FROM json_each(e.value,'$.rows') expected WHERE NOT EXISTS
        (SELECT 1 FROM hx_rows r WHERE r.org_id=?1 AND r.table_id=json_extract(e.value,'$.tableId') AND r.id=json_extract(expected.value,'$.id') AND r.data=json_extract(expected.value,'$.data') AND r.updated_at=json_extract(expected.value,'$.updatedAt')))
    )`).bind(orgId,app.id,String(by),plan.forkId,plan.revision,JSON.stringify(plan.snapshots),plan.checksum,nonce,JSON.stringify(plan.changes),at);
  const guard='EXISTS (SELECT 1 FROM hx_app_fork_merges WHERE org_id=?1 AND app_id=?2 AND nonce=?3)';
  const statements=[receipt];
  for(const c of plan.changes) {
    if(c.operation==='create')statements.push(db.prepare(`INSERT INTO hx_rows (id,table_id,org_id,data,position,created_by,updated_by,created_at,updated_at) SELECT ?4,?5,?1,?6,COALESCE((SELECT MAX(position)+1 FROM hx_rows WHERE org_id=?1 AND table_id=?5),0),?7,?7,?8,?8 WHERE ${guard}`).bind(orgId,app.id,nonce,c.id,c.tableId,JSON.stringify(c.after),String(by),at));
    else if(c.operation==='update')statements.push(db.prepare(`UPDATE hx_rows SET data=?6,updated_by=?7,updated_at=?8 WHERE org_id=?1 AND table_id=?5 AND id=?4 AND ${guard}`).bind(orgId,app.id,nonce,c.id,c.tableId,JSON.stringify(c.after),String(by),at));
    else statements.push(db.prepare(`DELETE FROM hx_rows WHERE org_id=?1 AND table_id=?5 AND id=?4 AND ${guard}`).bind(orgId,app.id,nonce,c.id,c.tableId));
  }
  const results=await db.batch(statements);
  if(!results[0].meta?.changes)return err('Production or preview changed during merge. Review again.');
  const originalRows=new Map(plan.snapshots.flatMap(entity=>entity.rows.map(row=>[`${entity.tableId}:${row.id}`,row])));
  // The route consumes these only after the atomic merge has committed, then
  // removes them from the public response. Keep the exact prior revision so
  // row-change receipts remain stable when a preview merge is replayed.
  const changedRecords=plan.changes.map(change=>({
    tableId:change.tableId,id:change.id,operation:change.operation,
    before:change.before,after:change.after,
    beforeUpdatedAt:originalRows.get(`${change.tableId}:${change.id}`)?.updatedAt||null,
  }));
  return {merged:true,mergedAt:at,changed:plan.changes.length,forkId:plan.forkId,checksum:plan.checksum,changedRecords};
}
