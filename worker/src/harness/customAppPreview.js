import { databaseAuthority, mayUseDatabase } from './databaseAccess.js';
import { databaseView, relationStateError, snapshotDatabase } from './appDatabase.js';
import { validateValues } from './tableContract.js';
import { sourceHash } from './customAppPublishApproval.js';

function normalizedSchema(entities) {
  return (entities || []).filter(entity => entity?.table?.id).map(entity => ({
    key: entity.key,
    tableId: entity.table.id,
    tableName: entity.table.name,
    columns: JSON.stringify(entity.table.columns || []),
  })).sort((a, b) => a.key.localeCompare(b.key));
}

function schemaMatchesSnapshot(snapshot, schema) {
  try {
    const parsed = JSON.parse(snapshot || '[]');
    return Array.isArray(parsed) && JSON.stringify(parsed) === JSON.stringify(schema);
  } catch { return false; }
}

async function currentDatabaseSchema(db, orgId, app) {
  const view = await databaseView(db, orgId, app);
  return { version: view.version, schema: normalizedSchema(view.entities) };
}

async function releaseDraftIdentity(app, version) {
  const draft = app.definition.custom?.draft || '';
  if (!Number.isSafeInteger(Number(version)) || Number(version) !== app.version || !draft.trim()) return null;
  return { version: app.version, draft, sourceHash: await sourceHash(draft) };
}

export async function readCustomDraftPreviewFork(db, orgId, app, by, version) {
  const identity = await releaseDraftIdentity(app, version);
  if (!identity) return { error: 'The App draft changed. Reload before opening its preview database.', status: 409 };
  if (!await mayUseDatabase(db, orgId, app.id, by, [], false)) return { error: 'No such app.', status: 404 };
  const row = await db.prepare(`SELECT id,revision,data,created_at AS createdAt,schema_version AS schemaVersion,schema_snapshot AS schemaSnapshot
    FROM hx_app_release_preview_forks WHERE org_id=?1 AND app_id=?2 AND app_version=?3 AND source_hash=?4`)
    .bind(orgId,app.id,identity.version,identity.sourceHash).first();
  if (!row) return { fork: null };
  let entities;
  try { entities = JSON.parse(row.data); } catch { return { error: 'The saved preview data is invalid. Recreate its validation database.', status: 409 }; }
  if (!Array.isArray(entities) || !await mayUseDatabase(db,orgId,app.id,by,entities.map(entity=>entity?.table?.id).filter(Boolean),false)) return { error: 'No such app.', status: 404 };
  return { fork: { id: row.id, revision: row.revision, entities, createdAt: row.createdAt, mergedAt: null } };
}

export async function createCustomDraftPreviewFork(db, orgId, app, by, input, refresh = false) {
  const identity = await releaseDraftIdentity(app, input.version);
  if (!identity) return { error: 'The App draft changed. Reload before creating its preview database.', status: 409 };
  if (!await mayUseDatabase(db,orgId,app.id,by,[],true)) return { error: 'No such app.', status: 404 };
  const current = await db.prepare(`SELECT id,revision,data,schema_version AS schemaVersion,schema_snapshot AS schemaSnapshot
    FROM hx_app_release_preview_forks WHERE org_id=?1 AND app_id=?2 AND app_version=?3 AND source_hash=?4`)
    .bind(orgId,app.id,identity.version,identity.sourceHash).first();

  if (current && !refresh) return readCustomDraftPreviewFork(db,orgId,app,by,identity.version);
  if (refresh && (!current || current.id !== input.forkId || current.revision !== input.revision)) return { error: 'The preview database changed. Reload before replacing it.', status: 409 };

  const snapshot = await snapshotDatabase(db,orgId,app,by);
  if (snapshot.error) return snapshot;
  const schema = normalizedSchema(snapshot.entities), schemaSnapshot = JSON.stringify(schema);
  if (refresh && Number(current.schemaVersion) === snapshot.schemaVersion && schemaMatchesSnapshot(current.schemaSnapshot,schema)) {
    return { error: 'The database schema has not changed. The current preview data is still valid.', status: 409 };
  }
  const id = crypto.randomUUID(), at = new Date().toISOString(), tableJson = JSON.stringify(snapshot.tableIds);
  const authority = databaseAuthority('?1','?2','?9','?11',true);
  let saved;
  if (refresh) {
    saved = await db.batch([
      db.prepare(`INSERT OR IGNORE INTO hx_app_release_preview_fork_history
        (id,org_id,app_id,app_version,source_hash,revision,data,schema_version,schema_snapshot,created_by,created_at,archived_at,archive_reason)
        SELECT id,org_id,app_id,app_version,source_hash,revision,data,schema_version,schema_snapshot,created_by,created_at,?10,'database_schema_changed'
        FROM hx_app_release_preview_forks WHERE org_id=?1 AND app_id=?2 AND app_version=?3 AND source_hash=?4 AND id=?12 AND revision=?13`)
        .bind(orgId,app.id,identity.version,identity.sourceHash,id,1,snapshot.data,snapshot.schemaVersion,schemaSnapshot,at,String(by),current.id,current.revision),
      db.prepare(`UPDATE hx_app_release_preview_forks SET id=?5,revision=revision+1,data=?6,schema_version=?7,schema_snapshot=?8,created_at=?10
        WHERE org_id=?1 AND app_id=?2 AND app_version=?3 AND source_hash=?4 AND id=?12 AND revision=?13 AND ${authority}
          AND COALESCE((SELECT version FROM hx_app_database_state WHERE org_id=?1 AND app_id=?2),0)=?7
          AND EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=?1 AND a.id=?2 AND a.version=?3 AND json_extract(a.definition,'$.custom.draft')=?14)`)
        .bind(orgId,app.id,identity.version,identity.sourceHash,id,snapshot.data,snapshot.schemaVersion,schemaSnapshot,String(by),at,tableJson,current.id,current.revision,identity.draft),
    ]);
    if (!saved[1]?.meta?.changes) return { error: 'The preview database or App access changed. Reload before trying again.', status: 409 };
  } else {
    saved = await db.prepare(`INSERT OR IGNORE INTO hx_app_release_preview_forks
      (org_id,app_id,app_version,source_hash,id,revision,data,schema_version,schema_snapshot,created_by,created_at)
      SELECT ?1,?2,?3,?4,?5,1,?6,?7,?8,?9,?10 WHERE ${authority}
        AND COALESCE((SELECT version FROM hx_app_database_state WHERE org_id=?1 AND app_id=?2),0)=?7
        AND (SELECT COUNT(DISTINCT id) FROM (SELECT table_id AS id FROM hx_apps WHERE org_id=?1 AND id=?2 UNION SELECT table_id FROM hx_app_entities WHERE org_id=?1 AND app_id=?2))=json_array_length(?11)
        AND NOT EXISTS(SELECT 1 FROM json_each(?11) selected WHERE selected.value NOT IN (SELECT table_id FROM hx_apps WHERE org_id=?1 AND id=?2 UNION SELECT table_id FROM hx_app_entities WHERE org_id=?1 AND app_id=?2))
        AND EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=?1 AND a.id=?2 AND a.version=?3 AND json_extract(a.definition,'$.custom.draft')=?12)`)
      .bind(orgId,app.id,identity.version,identity.sourceHash,id,snapshot.data,snapshot.schemaVersion,schemaSnapshot,String(by),at,tableJson,identity.draft).run();
    // Another request may have created the same draft fork first; returning it is safe because it is shared by draft identity.
    if (!saved.meta?.changes) {
      const raced = await db.prepare('SELECT id FROM hx_app_release_preview_forks WHERE org_id=?1 AND app_id=?2 AND app_version=?3 AND source_hash=?4').bind(orgId,app.id,identity.version,identity.sourceHash).first();
      if (!raced) return { error: 'The App database or access changed. Reload before creating a preview.', status: 409 };
    }
  }
  if (!await mayUseDatabase(db,orgId,app.id,by,snapshot.tableIds,true)) return { error: 'No such app.', status: 404 };
  return readCustomDraftPreviewFork(db,orgId,app,by,identity.version);
}

export async function mutateCustomDraftPreviewFork(db, orgId, app, by, input) {
  const identity = await releaseDraftIdentity(app,input.version);
  if (!identity) return { error: 'The App draft changed. Reload before editing its preview.', status: 409 };
  const fork = await db.prepare(`SELECT id,revision,data,schema_version AS schemaVersion,schema_snapshot AS schemaSnapshot
    FROM hx_app_release_preview_forks WHERE org_id=?1 AND app_id=?2 AND app_version=?3 AND source_hash=?4`)
    .bind(orgId,app.id,identity.version,identity.sourceHash).first();
  if (!fork || fork.id !== input.forkId || fork.revision !== input.revision) return { error: 'Preview data changed. Reload before editing.', status: 409 };
  let entities;
  try { entities = JSON.parse(fork.data); } catch { return { error: 'The saved preview data is invalid.', status: 409 }; }
  const ids = entities.map(entity=>entity.table?.id).filter(Boolean);
  if (!await mayUseDatabase(db,orgId,app.id,by,ids,true)) return { error: 'No such app.', status: 404 };
  const live = await currentDatabaseSchema(db,orgId,app);
  if (Number(fork.schemaVersion) !== live.version || !schemaMatchesSnapshot(fork.schemaSnapshot,live.schema) || !schemaMatchesSnapshot(JSON.stringify(normalizedSchema(entities)),live.schema)) {
    return { error: 'The App database schema changed. Recreate the validation database before editing or publishing this preview.', status: 409 };
  }
  const entity=entities.find(item=>item.key===input.entity);
  if (!entity || !['create','update','remove'].includes(input.operation)) return { error: 'Invalid preview operation.' };
  const row=entity.rows.find(item=>item.id===input.rowId);
  if (input.operation!=='create' && !row) return { error: 'No such preview row.', status: 404 };
  if (row && input.expectedUpdatedAt !== undefined && row.updatedAt !== input.expectedUpdatedAt) return { error: 'Preview row changed. Review it again.', status: 409 };
  if (input.operation!=='remove') {
    const invalid=validateValues(entity.table.columns,input.values);
    if (invalid.length) return { error: 'Invalid record values: '+invalid.map(item=>item.message||item).join(', ') };
  }
  const at=new Date(Math.max(Date.now(),row?Date.parse(row.updatedAt)+1:0)).toISOString();
  let result;
  if (input.operation==='create') {
    if (entity.rows.length>=5000) return { error: 'Preview row limit reached.' };
    result={id:crypto.randomUUID(),values:input.values,updatedAt:at};entity.rows.push(result);
  } else if(input.operation==='update') { row.values={...row.values,...input.values};row.updatedAt=at;result=row; }
  else { entity.rows=entity.rows.filter(item=>item.id!==input.rowId);result={deleted:true}; }
  const relationError=relationStateError(entities);
  if(relationError)return {error:relationError,status:409};
  const data=JSON.stringify(entities);
  if(new TextEncoder().encode(data).length>750000)return {error:'Preview database is too large.',status:413};
  const tableJson=JSON.stringify(ids), authority=databaseAuthority('?2','?3','?8','?9',true);
  const saved=await db.prepare(`UPDATE hx_app_release_preview_forks SET data=?1,revision=revision+1 WHERE org_id=?2 AND app_id=?3 AND app_version=?4 AND source_hash=?5 AND id=?6 AND revision=?7 AND ${authority}
    AND schema_version=?11 AND schema_snapshot=?12 AND COALESCE((SELECT version FROM hx_app_database_state WHERE org_id=?2 AND app_id=?3),0)=?11
    AND EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=?2 AND a.id=?3 AND a.version=?4 AND json_extract(a.definition,'$.custom.draft')=?13)`)
    .bind(data,orgId,app.id,identity.version,identity.sourceHash,fork.id,fork.revision,String(by),tableJson,live.version,fork.schemaVersion,fork.schemaSnapshot,identity.draft).run();
  if(!saved.meta?.changes)return {error:'Preview data, App schema, or access changed. Reload before editing.',status:409};
  if(!await mayUseDatabase(db,orgId,app.id,by,ids,true))return {error:'No such app.',status:404};
  return {result,revision:fork.revision+1,tableIds:ids};
}

export async function createCustomPreviewCandidate(db, orgId, app, by, input) {
  const identity=await releaseDraftIdentity(app,input.version);
  if(!identity)return {error:'The app changed or has no saved custom draft. Reload before reviewing this preview.',status:409};
  const fork=await db.prepare(`SELECT id,revision,data,schema_version AS schemaVersion,schema_snapshot AS schemaSnapshot FROM hx_app_release_preview_forks
    WHERE org_id=?1 AND app_id=?2 AND app_version=?3 AND source_hash=?4`).bind(orgId,app.id,identity.version,identity.sourceHash).first();
  if(!fork||fork.id!==input.forkId||fork.revision!==input.revision)return {error:'The preview database changed. Reload it before reviewing.',status:409};
  let entities;
  try{entities=JSON.parse(fork.data)}catch{return {error:'The preview database is invalid. Recreate it before reviewing.',status:409};}
  const live=await currentDatabaseSchema(db,orgId,app), schema=normalizedSchema(entities);
  if(Number(fork.schemaVersion)!==live.version||!schemaMatchesSnapshot(fork.schemaSnapshot,live.schema)||!schemaMatchesSnapshot(JSON.stringify(schema),live.schema))return {error:'The App database schema changed after this preview was created. Recreate the validation database and review the draft again. Previous preview data is retained in preview history.',status:409};
  if(!await mayUseDatabase(db,orgId,app.id,by,entities.map(entity=>entity.table.id),true))return {error:'No such app.',status:404};
  const id=crypto.randomUUID(),at=new Date().toISOString();
  const saved=await db.prepare(`INSERT OR IGNORE INTO hx_app_preview_candidates
    (id,org_id,app_id,app_version,source_hash,fork_id,fork_revision,created_by,created_at,schema_version,schema_snapshot,fork_kind)
    SELECT ?1,?2,?3,?4,?5,f.id,f.revision,?6,?7,f.schema_version,f.schema_snapshot,'custom_draft' FROM hx_app_release_preview_forks f
    WHERE f.org_id=?2 AND f.app_id=?3 AND f.app_version=?4 AND f.source_hash=?5 AND f.id=?8 AND f.revision=?9
      AND EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=?2 AND a.id=?3 AND a.version=?4 AND json_extract(a.definition,'$.custom.draft')=?10)`)
    .bind(id,orgId,app.id,identity.version,identity.sourceHash,String(by),at,input.forkId,input.revision,identity.draft).run();
  const active=await db.prepare(`SELECT id,created_at AS createdAt FROM hx_app_preview_candidates WHERE org_id=?1 AND app_id=?2 AND app_version=?3 AND source_hash=?4 AND fork_id=?5 AND fork_revision=?6 AND created_by=?7 AND fork_kind='custom_draft'`)
    .bind(orgId,app.id,identity.version,identity.sourceHash,input.forkId,input.revision,String(by)).first();
  if(!active)return {error:'The preview database or app changed. Reload and review the preview again.',status:409};
  await db.batch([
    db.prepare("UPDATE hx_app_publish_approvals SET status='revoked',reviewed_at=?1 WHERE org_id=?2 AND app_id=?3 AND draft_version=?4 AND source_hash=?5 AND status IN ('pending','approved') AND consumed_at IS NULL AND preview_candidate_id IS NOT ?6").bind(at,orgId,app.id,identity.version,identity.sourceHash,active.id),
    db.prepare("UPDATE hx_app_commit_approvals SET status='revoked',reviewed_at=?1 WHERE org_id=?2 AND app_id=?3 AND app_version=?4 AND source_hash IN (?5,(SELECT json_extract(definition,'$.custom.draftCommit.sourceHash') FROM hx_apps WHERE org_id=?2 AND id=?3)) AND status IN ('pending','approved') AND consumed_at IS NULL AND preview_candidate_id IS NOT ?6").bind(at,orgId,app.id,identity.version,identity.sourceHash,active.id),
  ]);
  return {saved:true,candidate:{id:active.id,appVersion:identity.version,sourceHash:identity.sourceHash,forkId:input.forkId,forkRevision:input.revision,createdAt:active.createdAt}};
}

export async function currentCustomPreviewCandidate(db, orgId, app, id) {
  if(!id)return null;
  const row=await db.prepare(`SELECT c.id,c.app_version AS appVersion,c.source_hash AS sourceHash,c.fork_id AS forkId,c.fork_revision AS forkRevision,
      c.created_by AS createdBy,c.created_at AS createdAt,c.schema_version AS schemaVersion,c.schema_snapshot AS schemaSnapshot,c.fork_kind AS forkKind,
      CASE WHEN c.fork_kind='custom_draft' AND a.version=c.app_version AND f.id=c.fork_id AND f.revision=c.fork_revision
        AND f.app_version=c.app_version AND f.source_hash=c.source_hash THEN 1 ELSE 0 END AS current
    FROM hx_app_preview_candidates c JOIN hx_apps a ON a.org_id=c.org_id AND a.id=c.app_id
    LEFT JOIN hx_app_release_preview_forks f ON f.org_id=c.org_id AND f.app_id=c.app_id AND f.app_version=c.app_version AND f.source_hash=c.source_hash AND f.id=c.fork_id
    WHERE c.org_id=?1 AND c.app_id=?2 AND c.id=?3`).bind(orgId,app.id,id).first();
  if(!row)return null;
  const hash=await sourceHash(app.definition.custom?.draft||'');
  let currentSchema=false,forkSchema=false;
  if(row.forkKind==='custom_draft')try{
    const live=await currentDatabaseSchema(db,orgId,app);
    currentSchema=Number(row.schemaVersion)===live.version&&schemaMatchesSnapshot(row.schemaSnapshot,live.schema);
    const fork=await db.prepare(`SELECT data,schema_version AS schemaVersion,schema_snapshot AS schemaSnapshot FROM hx_app_release_preview_forks
      WHERE org_id=?1 AND app_id=?2 AND app_version=?3 AND source_hash=?4 AND id=?5 AND revision=?6`).bind(orgId,app.id,row.appVersion,row.sourceHash,row.forkId,row.forkRevision).first();
    const entities=JSON.parse(fork?.data||'null');
    forkSchema=!!fork&&Number(fork.schemaVersion)===live.version&&schemaMatchesSnapshot(fork.schemaSnapshot,live.schema)&&schemaMatchesSnapshot(JSON.stringify(normalizedSchema(entities)),live.schema);
  }catch{currentSchema=false;}
  const current=row.forkKind==='custom_draft'&&Boolean(row.current)&&row.appVersion===app.version&&row.sourceHash===hash&&currentSchema&&forkSchema;
  const {schemaVersion:_schemaVersion,schemaSnapshot:_schemaSnapshot,...publicRow}=row;
  const staleReason=row.forkKind!=='custom_draft'?'legacy_preview':!currentSchema||!forkSchema?'database_schema_changed':!row.current?'preview_fork_changed':undefined;
  return {...publicRow,current,...(staleReason?{staleReason}:{})};
}

export function previewCandidateExistsSql(candidateParam, appParam, orgParam, versionParam, hashParam) {
  return `EXISTS(SELECT 1 FROM hx_app_preview_candidates c
    JOIN hx_app_release_preview_forks f ON f.org_id=c.org_id AND f.app_id=c.app_id AND f.app_version=c.app_version AND f.source_hash=c.source_hash AND f.id=c.fork_id AND f.revision=c.fork_revision
    LEFT JOIN hx_app_database_state dbs ON dbs.org_id=c.org_id AND dbs.app_id=c.app_id
    WHERE c.id=${candidateParam} AND c.org_id=${orgParam} AND c.app_id=${appParam} AND c.fork_kind='custom_draft'
      AND c.app_version=${versionParam} AND c.source_hash=${hashParam}
      AND c.schema_version=f.schema_version AND c.schema_snapshot=f.schema_snapshot
      AND COALESCE(dbs.version,0)=c.schema_version
      AND json_array_length(c.schema_snapshot)=(SELECT COUNT(*)+1 FROM hx_app_entities e WHERE e.org_id=c.org_id AND e.app_id=c.app_id)
      AND NOT EXISTS(SELECT 1 FROM json_each(c.schema_snapshot) s WHERE NOT EXISTS(
        SELECT 1 FROM hx_tables t WHERE t.org_id=c.org_id AND t.id=json_extract(s.value,'$.tableId')
          AND t.name=json_extract(s.value,'$.tableName') AND t.columns=json_extract(s.value,'$.columns')
          AND ((json_extract(s.value,'$.key')='primary' AND EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=c.org_id AND a.id=c.app_id AND a.table_id=t.id))
            OR EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=c.org_id AND e.app_id=c.app_id AND e.entity_key=json_extract(s.value,'$.key') AND e.table_id=t.id)))))`;
}
