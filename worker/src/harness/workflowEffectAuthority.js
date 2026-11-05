import { conversationWriteAuthority } from './conversationWriteAuthority.js';
import { agentRunAuthority } from './agentRunAuthority.js';
import { appRecordSourceAuthority as appRecordSourceSql, followupSourceAuthority } from './appRecordSourceAuthority.js';
import { managedAutomationGuard } from './appAutomationGuard.js';
import { ROLE_RANK } from '../auth.js';
import { can } from '../permissions.js';

const builderRoles = [...ROLE_RANK.keys()].filter(role => can(role, 'harness.build')).map(role => `'${role.replaceAll("'", "''")}'`).join(',');
const sourceTable = "COALESCE(json_extract(d.definition,'$.trigger.tableId'),json_extract(r.input,'$.tableId'))";
export const sourceTableAuthority = `(json_extract(d.definition,'$.trigger.type')='app_record_change' OR ${sourceTable} IS NULL OR (
  EXISTS(SELECT 1 FROM hx_tables t WHERE t.org_id=r.org_id AND t.id=${sourceTable})
  AND NOT EXISTS(SELECT 1 FROM hx_apps app LEFT JOIN hx_app_access access ON access.org_id=app.org_id AND access.app_id=app.id
    WHERE app.org_id=r.org_id AND app.created_by!=json_extract(d.definition,'$.createdBy')
      AND COALESCE(access.visibility,'workspace')!='workspace' AND (app.table_id=${sourceTable} OR EXISTS(
        SELECT 1 FROM hx_app_entities entity WHERE entity.org_id=app.org_id AND entity.app_id=app.id AND entity.table_id=${sourceTable})))))`;
export const runSourceAuthority = `(${sourceTableAuthority} AND (json_extract(d.definition,'$.trigger.type')!='app_record_change' OR (
  json_extract(r.input,'$.records[0].appId')=json_extract(d.definition,'$.trigger.appId')
  AND json_extract(r.input,'$.records[0].entityId')=json_extract(d.definition,'$.trigger.entityId')
  AND ${appRecordSourceSql('r.org_id',"json_extract(d.definition,'$.trigger.appId')","json_extract(d.definition,'$.trigger.entityId')","json_extract(r.input,'$.tableId')","json_extract(d.definition,'$.createdBy')")})))`;

// A side effect is admitted in the same SQL statement that commits it. This
// fences the running workflow, its current source App/Table/Room access, the
// destination conversation and (when present) the exact Agent grant.
export function workflowEffectAuthority({ org, runId, ownerId, status = 'running', channel = null, agentId = null, recipientLogin = null, sourceSnapshot = null }) {
  const base = `r.org_id=${org} AND r.id=${runId} AND r.status='${status}'`;
  const runExists = predicate => `EXISTS(SELECT 1 FROM hx_workflow_runs r JOIN hx_workflow_run_definitions d
    ON d.org_id=r.org_id AND d.run_id=r.id WHERE ${base} AND (${predicate}))`;
  // Keep each live authority in its own EXISTS. Combining their nested access
  // policies in one WHERE exceeded SQLite/D1's expression-depth limit on
  // perfectly normal Agent posts and approvals.
  const checks = [runExists(runSourceAuthority),
    runExists(managedAutomationGuard('r.org_id','r.workflow_id',"json_extract(d.definition,'$.automationReleaseId')")),
    runExists(`(json_type(d.definition,'$.safetyGeneration') IS NULL OR EXISTS(SELECT 1 FROM hx_workflow_safety safety
      WHERE safety.org_id=r.org_id AND safety.workflow_id=r.workflow_id
        AND safety.generation=json_extract(d.definition,'$.safetyGeneration') AND safety.paused_at IS NULL))`),
    runExists(`EXISTS(SELECT 1 FROM hx_workflows w JOIN memberships builder_membership
      ON builder_membership.org_id=w.org_id AND builder_membership.user_github_id=w.created_by
      WHERE w.org_id=r.org_id AND w.id=r.workflow_id AND w.created_by=${ownerId}
        AND json_extract(d.definition,'$.id')=w.id AND json_extract(d.definition,'$.createdBy')=w.created_by
        AND LOWER(COALESCE(builder_membership.role,'guest')) IN (${builderRoles}))`),
    runExists(`(NOT EXISTS(SELECT 1 FROM hx_workflow_sources missing_source WHERE missing_source.org_id=r.org_id AND missing_source.workflow_id=r.workflow_id)
      OR EXISTS(SELECT 1 FROM hx_workflow_sources source WHERE source.org_id=r.org_id AND source.workflow_id=r.workflow_id
        AND source.created_by=${ownerId} AND ${conversationWriteAuthority(org,'source.channel',ownerId)}))`)];
  if (channel) checks.push(runExists(conversationWriteAuthority(org, channel, ownerId)));
  if (agentId) checks.push(runExists(agentRunAuthority(org, ownerId, agentId)));
  if (recipientLogin) checks.push(`EXISTS(SELECT 1 FROM users workflow_recipient
    JOIN memberships recipient_membership ON recipient_membership.org_id=${org}
      AND recipient_membership.user_github_id=workflow_recipient.github_id
      AND LOWER(COALESCE(recipient_membership.role,'guest'))!='guest'
    WHERE workflow_recipient.login=${recipientLogin})`);
  if (sourceSnapshot) checks.push(runExists(`((json_extract(d.definition,'$.trigger.type')='app_record_change'
      AND ${sourceSnapshot.appId}=json_extract(d.definition,'$.trigger.appId')
      AND ${sourceSnapshot.entityId}=json_extract(d.definition,'$.trigger.entityId')
      AND ${sourceSnapshot.tableId}=json_extract(r.input,'$.tableId'))
    OR (json_extract(d.definition,'$.trigger.type')!='app_record_change'
      AND ${sourceSnapshot.appId} IS NULL AND ${sourceSnapshot.entityId} IS NULL AND ${sourceSnapshot.tableId} IS NULL))`));
  return checks.join(' AND ');
}

// Approval resumes have a compact claim fence. continueRun performs the full
// live source/automation check immediately after this CAS and fails before
// executing any step; individual external side effects retain their own SQL
// authority fences. Keeping the claim predicate small avoids D1's expression
// depth limit from nesting every side-effect policy into one UPDATE.
export function workflowApprovalClaimAuthority({ org, runId, recipientLogin }) {
  return `EXISTS(SELECT 1 FROM hx_workflow_runs r
    JOIN hx_workflow_run_definitions d ON d.org_id=r.org_id AND d.run_id=r.id
    JOIN hx_workflows w ON w.org_id=r.org_id AND w.id=r.workflow_id
    JOIN memberships builder_membership ON builder_membership.org_id=w.org_id AND builder_membership.user_github_id=w.created_by
    WHERE r.org_id=${org} AND r.id=${runId} AND r.status='waiting'
      AND d.definition IS NOT NULL AND json_extract(d.definition,'$.id')=w.id
      AND json_extract(d.definition,'$.createdBy')=w.created_by
      AND LOWER(COALESCE(builder_membership.role,'guest')) IN (${builderRoles})
      AND EXISTS(SELECT 1 FROM users recipient JOIN memberships member
        ON member.org_id=${org} AND member.user_github_id=recipient.github_id
        WHERE recipient.login=${recipientLogin} AND LOWER(COALESCE(member.role,'guest'))!='guest')
      AND (json_extract(d.definition,'$.trigger.type')!='app_record_change' OR (
        json_extract(r.input,'$.records[0].appId')=json_extract(d.definition,'$.trigger.appId')
        AND json_extract(r.input,'$.records[0].entityId')=json_extract(d.definition,'$.trigger.entityId')
        AND ${appRecordSourceSql('r.org_id',"json_extract(d.definition,'$.trigger.appId')","json_extract(d.definition,'$.trigger.entityId')","json_extract(r.input,'$.tableId')","json_extract(d.definition,'$.createdBy')")})))`;
}

// A scheduled follow-up is a narrower side effect than a message or Agent
// turn. Keep its transactional predicate to the exact source snapshot, its
// maker's current membership/room rights, the optional Agent grant and the
// current workflow/release identity; this stays below D1's expression-depth
// ceiling while still closing authorization races at INSERT time.
export function workflowFollowupScheduleAuthority({ org, runId, ownerId, channel, agentId = null, sourceSnapshot = null }) {
  const checks = [managedAutomationGuard('r.org_id','r.workflow_id',"json_extract(d.definition,'$.automationReleaseId')"),
    `EXISTS(SELECT 1 FROM hx_workflows w JOIN memberships builder_membership
      ON builder_membership.org_id=w.org_id AND builder_membership.user_github_id=w.created_by
      WHERE w.org_id=r.org_id AND w.id=r.workflow_id AND w.created_by=${ownerId}
        AND json_extract(d.definition,'$.id')=w.id AND json_extract(d.definition,'$.createdBy')=w.created_by
        AND LOWER(COALESCE(builder_membership.role,'guest')) IN (${builderRoles}))`,
    `(${conversationWriteAuthority(org, channel, ownerId)})`,
    `(NOT EXISTS(SELECT 1 FROM hx_workflow_sources missing_source WHERE missing_source.org_id=r.org_id AND missing_source.workflow_id=r.workflow_id)
      OR EXISTS(SELECT 1 FROM hx_workflow_sources source WHERE source.org_id=r.org_id AND source.workflow_id=r.workflow_id
        AND source.created_by=${ownerId} AND ${conversationWriteAuthority(org,'source.channel',ownerId)}))`];
  if (agentId) checks.push(agentRunAuthority(org, ownerId, agentId));
  if (sourceSnapshot) checks.push(`((json_extract(d.definition,'$.trigger.type')='app_record_change'
      AND ${sourceSnapshot.appId}=json_extract(d.definition,'$.trigger.appId')
      AND ${sourceSnapshot.entityId}=json_extract(d.definition,'$.trigger.entityId')
      AND ${sourceSnapshot.tableId}=json_extract(r.input,'$.tableId')
      AND json_extract(r.input,'$.records[0].appId')=${sourceSnapshot.appId}
      AND json_extract(r.input,'$.records[0].entityId')=${sourceSnapshot.entityId}
      AND ${appRecordSourceSql('r.org_id',sourceSnapshot.appId,sourceSnapshot.entityId,sourceSnapshot.tableId,ownerId)})
    OR (json_extract(d.definition,'$.trigger.type')!='app_record_change'
      AND ${sourceSnapshot.appId} IS NULL AND ${sourceSnapshot.entityId} IS NULL AND ${sourceSnapshot.tableId} IS NULL))`);
  return `EXISTS(SELECT 1 FROM hx_workflow_runs r JOIN hx_workflow_run_definitions d
    ON d.org_id=r.org_id AND d.run_id=r.id
    WHERE r.org_id=${org} AND r.id=${runId} AND r.status='running' AND (${checks.join(' AND ')}))`;
}

// Followups outlive their workflow run. Their own scheduled row is the CAS
// token; retain and re-evaluate the source snapshot and current Agent/Room ACL.
export function followupEffectAuthority({ org, followupId, ownerId, channel, agentId = null }) {
  return `EXISTS(SELECT 1 FROM hx_followups f WHERE f.org_id=${org} AND f.id=${followupId}
    AND f.status='running' AND f.created_by=${ownerId} AND f.channel=${channel}
    AND ${followupSourceAuthority('f')}
    AND ${conversationWriteAuthority(org, channel, ownerId)}
    AND ${agentId ? `f.agent_id=${agentId} AND ${agentRunAuthority(org, ownerId, agentId)}` : 'f.agent_id IS NULL'})`;
}
