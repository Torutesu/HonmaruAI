// SQL authority for an app-record source snapshot. Callers supply trusted SQL
// expressions, never request text. A table remains usable only while the
// exact app/entity mapping and every linked app's current visibility allow it.
export function appRecordSourceAuthority(org, appId, entityId, tableId, userId) {
  return `EXISTS(SELECT 1 FROM hx_apps source_app
    JOIN hx_tables source_table ON source_table.org_id=source_app.org_id AND source_table.id=${tableId}
    LEFT JOIN hx_app_access source_policy ON source_policy.org_id=source_app.org_id AND source_policy.app_id=source_app.id
    WHERE source_app.org_id=${org} AND source_app.id=${appId}
      AND (((${entityId})='primary' AND source_app.table_id=${tableId}) OR EXISTS(
        SELECT 1 FROM hx_app_entities source_entity WHERE source_entity.org_id=source_app.org_id
          AND source_entity.app_id=source_app.id AND source_entity.entity_key=${entityId} AND source_entity.table_id=${tableId}))
      AND (COALESCE(source_policy.visibility,'workspace')='workspace' OR source_app.created_by=${userId})
      AND EXISTS(SELECT 1 FROM memberships source_member WHERE source_member.org_id=${org}
        AND source_member.user_github_id=${userId} AND LOWER(COALESCE(source_member.role,'guest'))!='guest')
      AND NOT EXISTS(SELECT 1 FROM hx_apps linked_app LEFT JOIN hx_app_access linked_policy
        ON linked_policy.org_id=linked_app.org_id AND linked_policy.app_id=linked_app.id
        WHERE linked_app.org_id=${org} AND (linked_app.table_id=${tableId} OR EXISTS(
          SELECT 1 FROM hx_app_entities linked_entity WHERE linked_entity.org_id=linked_app.org_id
            AND linked_entity.app_id=linked_app.id AND linked_entity.table_id=${tableId}))
          AND COALESCE(linked_policy.visibility,'workspace')!='workspace' AND linked_app.created_by!=${userId})
      AND NOT EXISTS(SELECT 1 FROM hx_app_entities orphan_entity WHERE orphan_entity.org_id=${org}
        AND orphan_entity.table_id=${tableId} AND NOT EXISTS(SELECT 1 FROM hx_apps parent_app
          WHERE parent_app.org_id=orphan_entity.org_id AND parent_app.id=orphan_entity.app_id)))`;
}

export function followupSourceAuthority(alias = 'f') {
  const noSource = `${alias}.source_app_id IS NULL AND ${alias}.source_entity_id IS NULL AND ${alias}.source_table_id IS NULL`;
  const legacyAppRecord = `EXISTS(SELECT 1 FROM hx_workflow_runs legacy_run
    JOIN hx_workflow_run_definitions legacy_definition ON legacy_definition.org_id=legacy_run.org_id AND legacy_definition.run_id=legacy_run.id
    WHERE legacy_run.org_id=${alias}.org_id AND json_extract(legacy_definition.definition,'$.trigger.type')='app_record_change'
      AND EXISTS(SELECT 1 FROM json_each(legacy_run.log) legacy_entry WHERE json_extract(legacy_entry.value,'$.output')=${alias}.id))`;
  // Version 0 identifies rows that predate persisted provenance. Preserve
  // standalone/known non-App legacy reminders, but fail closed if a retained
  // run log proves the reminder came from an App-record trigger. Deletion
  // paths may mark unclassifiable App-sourced legacy rows with -1; every
  // unknown version fails closed. New rows use v1, where null provenance
  // explicitly means they were not App-sourced.
  return `((COALESCE(${alias}.source_authority_version,0)=1 AND (
      (${noSource}) OR (${alias}.source_app_id IS NOT NULL AND ${alias}.source_entity_id IS NOT NULL AND ${alias}.source_table_id IS NOT NULL
        AND ${appRecordSourceAuthority(`${alias}.org_id`, `${alias}.source_app_id`, `${alias}.source_entity_id`, `${alias}.source_table_id`, `${alias}.created_by`)})))
    OR (COALESCE(${alias}.source_authority_version,0)=0 AND (${noSource}) AND NOT ${legacyAppRecord}))`;
}
