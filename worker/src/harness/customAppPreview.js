import { sourceHash } from './customAppPublishApproval.js';
import { databaseView } from './appDatabase.js';

function normalizedSchema(entities) {
  return (entities || []).filter(entity => entity?.table?.id).map(entity => ({
    key: entity.key,
    tableId: entity.table.id,
    tableName: entity.table.name,
    columns: JSON.stringify(entity.table.columns || []),
  })).sort((a, b) => a.key.localeCompare(b.key));
}

async function currentDatabaseSchema(db, orgId, app) {
  const view = await databaseView(db, orgId, app);
  return { version: view.version, schema: normalizedSchema(view.entities) };
}

function schemaMatchesSnapshot(snapshot, schema) {
  try {
    const parsed = JSON.parse(snapshot || '[]');
    return Array.isArray(parsed) && JSON.stringify(parsed) === JSON.stringify(schema);
  } catch { return false; }
}

export async function createCustomPreviewCandidate(db, orgId, app, by, input) {
  if (Number(input.version) !== app.version) return { error: 'The app changed. Reload before reviewing this preview.', status: 409 };
  const draft = app.definition.custom?.draft || '';
  if (!draft.trim()) return { error: 'Save a custom app draft before reviewing its preview.', status: 400 };
  const { fork } = await (async () => {
    const row = await db.prepare('SELECT id,revision,data FROM hx_app_forks WHERE org_id=?1 AND app_id=?2 AND created_by=?3').bind(orgId,app.id,String(by)).first();
    if (!row) return { fork: null };
    try { return { fork: { ...row, entities: JSON.parse(row.data) } }; } catch { return { fork: null }; }
  })();
  if (!fork || fork.id !== input.forkId || fork.revision !== input.revision) return { error: 'The preview database changed. Reload it before reviewing.', status: 409 };
  const liveSchema = await currentDatabaseSchema(db,orgId,app);
  if (!schemaMatchesSnapshot(JSON.stringify(normalizedSchema(fork.entities)),liveSchema.schema)) {
    return { error: 'The App database schema changed after this preview was created. Recreate the validation database and review the draft again. Recreating it replaces preview-only data.', status: 409 };
  }
  const hash = await sourceHash(draft);
  const id = crypto.randomUUID(), at = new Date().toISOString();
  const saved = await db.prepare(`INSERT OR IGNORE INTO hx_app_preview_candidates
    (id,org_id,app_id,app_version,source_hash,fork_id,fork_revision,created_by,created_at,schema_version,schema_snapshot)
    SELECT ?1,?2,?3,?4,?5,f.id,f.revision,?6,?7,?11,?12 FROM hx_app_forks f
    WHERE f.org_id=?2 AND f.app_id=?3 AND f.created_by=?6 AND f.id=?8 AND f.revision=?9
      AND EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=?2 AND a.id=?3 AND a.version=?4 AND json_extract(a.definition,'$.custom.draft')=?10)`)
    .bind(id,orgId,app.id,app.version,hash,String(by),at,input.forkId,input.revision,draft,liveSchema.version,JSON.stringify(liveSchema.schema)).run();
  const active=await db.prepare('SELECT id,created_at AS createdAt FROM hx_app_preview_candidates WHERE org_id=?1 AND app_id=?2 AND app_version=?3 AND source_hash=?4 AND fork_id=?5 AND fork_revision=?6 AND created_by=?7').bind(orgId,app.id,app.version,hash,input.forkId,input.revision,String(by)).first();
  if(!active)return { error: 'The preview database or app changed. Reload and review the preview again.', status: 409 };
  await db.batch([
    db.prepare("UPDATE hx_app_publish_approvals SET status='revoked',reviewed_at=?1 WHERE org_id=?2 AND app_id=?3 AND draft_version=?4 AND source_hash=?5 AND status IN ('pending','approved') AND consumed_at IS NULL AND preview_candidate_id IS NOT ?6")
      .bind(at,orgId,app.id,app.version,hash,active.id),
    db.prepare("UPDATE hx_app_commit_approvals SET status='revoked',reviewed_at=?1 WHERE org_id=?2 AND app_id=?3 AND app_version=?4 AND source_hash IN (?5,(SELECT json_extract(definition,'$.custom.draftCommit.sourceHash') FROM hx_apps WHERE org_id=?2 AND id=?3)) AND status IN ('pending','approved') AND consumed_at IS NULL AND preview_candidate_id IS NOT ?6")
      .bind(at,orgId,app.id,app.version,hash,active.id)]);
  return { saved: true, candidate: { id: active.id, appVersion: app.version, sourceHash: hash, forkId: input.forkId, forkRevision: input.revision, createdAt: active.createdAt } };
}

export async function currentCustomPreviewCandidate(db, orgId, app, id) {
  if (!id) return null;
  const row = await db.prepare(`SELECT c.id,c.app_version AS appVersion,c.source_hash AS sourceHash,c.fork_id AS forkId,
      c.fork_revision AS forkRevision,c.created_by AS createdBy,c.created_at AS createdAt,
      c.schema_version AS schemaVersion,c.schema_snapshot AS schemaSnapshot,
      CASE WHEN a.version=c.app_version AND json_extract(a.definition,'$.custom.draft') IS NOT NULL
        AND f.id=c.fork_id AND f.revision=c.fork_revision THEN 1 ELSE 0 END AS current
    FROM hx_app_preview_candidates c JOIN hx_apps a ON a.org_id=c.org_id AND a.id=c.app_id
    LEFT JOIN hx_app_forks f ON f.org_id=c.org_id AND f.app_id=c.app_id AND f.created_by=c.created_by AND f.id=c.fork_id
    WHERE c.org_id=?1 AND c.app_id=?2 AND c.id=?3`).bind(orgId,app.id,id).first();
  if (!row) return null;
  const hash = await sourceHash(app.definition.custom?.draft || '');
  let currentSchema=false, forkSchema=false;
  try {
    const live=await currentDatabaseSchema(db,orgId,app);
    currentSchema=Number(row.schemaVersion)===live.version&&schemaMatchesSnapshot(row.schemaSnapshot,live.schema);
    const fork=await db.prepare('SELECT data FROM hx_app_forks WHERE org_id=?1 AND app_id=?2 AND created_by=?3').bind(orgId,app.id,row.createdBy).first();
    const entities=JSON.parse(fork?.data||'null');
    forkSchema=schemaMatchesSnapshot(JSON.stringify(normalizedSchema(entities)),live.schema);
  } catch { currentSchema=false; }
  const current=Boolean(row.current) && row.appVersion===app.version && row.sourceHash===hash && currentSchema && forkSchema;
  const {schemaVersion:_schemaVersion,schemaSnapshot:_schemaSnapshot,...publicRow}=row;
  return { ...publicRow, current, ...(!currentSchema||!forkSchema?{staleReason:'database_schema_changed'}:{}) };
}

export function previewCandidateExistsSql(candidateParam, appParam, orgParam, versionParam, hashParam) {
  return `EXISTS(SELECT 1 FROM hx_app_preview_candidates c
    JOIN hx_app_forks f ON f.org_id=c.org_id AND f.app_id=c.app_id AND f.created_by=c.created_by AND f.id=c.fork_id AND f.revision=c.fork_revision
    LEFT JOIN hx_app_database_state dbs ON dbs.org_id=c.org_id AND dbs.app_id=c.app_id
    WHERE c.id=${candidateParam} AND c.org_id=${orgParam} AND c.app_id=${appParam}
      AND c.app_version=${versionParam} AND c.source_hash=${hashParam}
      AND COALESCE(dbs.version,0)=c.schema_version
      AND json_array_length(c.schema_snapshot)=(SELECT COUNT(*)+1 FROM hx_app_entities e WHERE e.org_id=c.org_id AND e.app_id=c.app_id)
      AND NOT EXISTS(SELECT 1 FROM json_each(c.schema_snapshot) s WHERE NOT EXISTS(
        SELECT 1 FROM hx_tables t WHERE t.org_id=c.org_id AND t.id=json_extract(s.value,'$.tableId')
          AND t.name=json_extract(s.value,'$.tableName') AND t.columns=json_extract(s.value,'$.columns')
          AND ((json_extract(s.value,'$.key')='primary' AND EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=c.org_id AND a.id=c.app_id AND a.table_id=t.id))
            OR EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=c.org_id AND e.app_id=c.app_id AND e.entity_key=json_extract(s.value,'$.key') AND e.table_id=t.id)))))`;
}
