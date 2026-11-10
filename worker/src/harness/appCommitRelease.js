import { getTable } from './tables.js';
import { appAccess } from './resourceAccess.js';
import { MAX_PREVIEW_SOURCE, validateSource } from './customApps.js';
import { currentCustomPreviewCandidate, previewCandidateExistsSql } from './customAppPreview.js';

const err = (error, status = 400) => ({ error, status });
const sha = /^[a-f0-9]{64}$/i;

export async function commitPublishScope(db, orgId, appId) {
  const access = await appAccess(db, orgId, appId);
  if (!access) return null;
  const domain = await db.prepare(
    'SELECT hostname,status FROM hx_app_domains WHERE org_id=?1 AND app_id=?2'
  ).bind(orgId, appId).first();
  return {
    visibility: access.visibility || 'workspace',
    accessVersion: Number(access.version || 0),
    domainScope: domain ? `${domain.hostname}#${domain.status}` : '',
  };
}

export async function customCommitState(db, orgId, app) {
  const scope = await commitPublishScope(db, orgId, app.id);
  const { results = [] } = await db.prepare(
    'SELECT id,app_version AS appVersion,repo_owner AS owner,repo_name AS repo,branch_name AS branch,commit_sha AS commitSha,file_path AS path,source_hash AS sourceHash,visibility_scope AS visibility,access_version AS accessVersion,domain_scope AS domainScope,requested_by AS requestedBy,reviewer_id AS reviewerId,status,created_at AS createdAt,reviewed_at AS reviewedAt,preview_candidate_id AS previewCandidateId FROM hx_app_commit_approvals WHERE org_id=?1 AND app_id=?2 ORDER BY created_at DESC LIMIT 1'
  ).bind(orgId, app.id).all();
  const rawCommit=app.definition?.custom?.draftCommit||null;
  const commit=rawCommit?(({assetToken,...visible})=>visible)(rawCommit):null;
  return { commit, scope, approval: results[0] || null };
}

function sameCommit(draft, commit) {
  return draft && commit && draft.owner === commit.owner && draft.repo === commit.repo
    && draft.branch === commit.branch && draft.sha === commit.sha && draft.path === commit.path
    && draft.sourceHash === commit.sourceHash;
}

export async function requestCustomCommitApproval(db, orgId, app, by, input) {
  const commit = app.definition?.custom?.draftCommit;
  const currentHtml = app.definition?.custom?.draft;
  if (!Number.isSafeInteger(input.version) || input.version !== app.version) return err('The app changed. Reload before requesting approval.', 409);
  if (!commit || !validateSource(currentHtml) || !sameCommit(commit, input.commit) || commit.sourceHash !== input.sourceHash) {
    return err('Import and save the exact GitHub commit before requesting approval.', 409);
  }
  const actualHash = await hashSource(currentHtml);
  if (actualHash !== commit.htmlHash || !await assetManifestMatches(db,orgId,app.id,commit)) return err('The imported source bundle changed. Import the commit again.', 409);
  const candidate=await currentCustomPreviewCandidate(db,orgId,app,input.candidateId);
  if(!candidate?.current || candidate.sourceHash!==commit.htmlHash)return err('Review the current preview of this exact commit before requesting approval.',409);
  const scope = await commitPublishScope(db, orgId, app.id);
  if (!scope) return err('No such app.', 404);
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  const saved = await db.prepare(`INSERT OR IGNORE INTO hx_app_commit_approvals
    (id,org_id,app_id,app_version,repo_owner,repo_name,branch_name,commit_sha,file_path,source_hash,visibility_scope,access_version,domain_scope,requested_by,status,created_at,preview_candidate_id)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'pending',?15,?16
    WHERE EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=?2 AND a.id=?3 AND a.version=?4
      AND json_extract(a.definition,'$.custom.draftCommit.sha')=?8
      AND json_extract(a.definition,'$.custom.draftCommit.sourceHash')=?10
      AND json_extract(a.definition,'$.custom.draft') IS NOT NULL AND ${previewCandidateExistsSql('?16','?3','?2','?4','?17')})
      AND COALESCE((SELECT visibility FROM hx_app_access WHERE org_id=?2 AND app_id=?3),'workspace')=?11
      AND COALESCE((SELECT version FROM hx_app_access WHERE org_id=?2 AND app_id=?3),0)=?12
      AND COALESCE((SELECT hostname||'#'||status FROM hx_app_domains WHERE org_id=?2 AND app_id=?3),'')=?13
      AND EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=?2 AND m.user_github_id=?14 AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest')`)
    .bind(id,orgId,app.id,app.version,commit.owner,commit.repo,commit.branch,commit.sha,commit.path,commit.sourceHash,scope.visibility,scope.accessVersion,scope.domainScope,String(by),at,input.candidateId,commit.htmlHash).run();
  if (!saved.meta?.changes) return err('The app or its visibility changed. Reload and request approval again.', 409);
  const row = await db.prepare('SELECT * FROM hx_app_commit_approvals WHERE id=?1 AND org_id=?2 AND app_id=?3').bind(id,orgId,app.id).first();
  return { requested: true, approval: row };
}

export async function reviewCustomCommitApproval(db, orgId, app, input, by, isAdmin) {
  if (!isAdmin) return err('Only a workspace Owner or Admin can review this commit.', 403);
  if (!['approve','reject'].includes(input.decision)) return err('Choose approve or reject.');
  const scope = await commitPublishScope(db, orgId, app.id);
  if (!scope) return err('No such app.', 404);
  const at = new Date().toISOString();
  const candidate=await currentCustomPreviewCandidate(db,orgId,app,input.candidateId);
  if(!candidate?.current || candidate.sourceHash!==app.definition?.custom?.draftCommit?.htmlHash)return err('The reviewed preview changed. Recreate the approval for the current preview.',409);
  const out = await db.prepare(`UPDATE hx_app_commit_approvals
    SET status=?1,reviewer_id=?2,reviewed_at=?3
    WHERE org_id=?4 AND app_id=?5 AND id=?6 AND status='pending' AND app_version=?7
      AND commit_sha=?8 AND source_hash=?9 AND visibility_scope=?10 AND access_version=?11 AND domain_scope=?12
      AND requested_by<>?2
      AND preview_candidate_id=?13
      AND EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=?4 AND a.id=?5 AND a.version=?7
        AND json_extract(a.definition,'$.custom.draftCommit.sha')=?8
        AND json_extract(a.definition,'$.custom.draftCommit.sourceHash')=?9 AND ${previewCandidateExistsSql('?13','?5','?4','?7','?14')})
      AND COALESCE((SELECT visibility FROM hx_app_access WHERE org_id=?4 AND app_id=?5),'workspace')=?10
      AND COALESCE((SELECT version FROM hx_app_access WHERE org_id=?4 AND app_id=?5),0)=?11
      AND COALESCE((SELECT hostname||'#'||status FROM hx_app_domains WHERE org_id=?4 AND app_id=?5),'')=?12
      AND EXISTS(SELECT 1 FROM memberships r WHERE r.org_id=?4 AND r.user_github_id=?2 AND LOWER(TRIM(r.role)) IN ('owner','admin'))
      AND EXISTS(SELECT 1 FROM memberships q WHERE q.org_id=?4 AND q.user_github_id=(SELECT requested_by FROM hx_app_commit_approvals WHERE id=?6 AND org_id=?4 AND app_id=?5) AND LOWER(TRIM(COALESCE(q.role,'guest')))!='guest')`)
    .bind(input.decision === 'approve' ? 'approved' : 'rejected',String(by),at,orgId,app.id,input.approvalId,app.version,input.commitSha,input.sourceHash,scope.visibility,scope.accessVersion,scope.domainScope,input.candidateId,app.definition.custom.draftCommit.htmlHash).run();
  if (!out.meta?.changes) return err('The commit changed or the reviewer is no longer an independent Owner or Admin.', 409);
  const approval = await db.prepare('SELECT * FROM hx_app_commit_approvals WHERE org_id=?1 AND app_id=?2 AND id=?3').bind(orgId,app.id,input.approvalId).first();
  return { reviewed: true, approval };
}

export async function publishApprovedCustomCommit(db, orgId, app, input, by, scope) {
  if (!Number.isSafeInteger(input.version) || input.version !== app.version) return err('The app changed. Reload before publishing.', 409);
  const custom = app.definition?.custom || {};
  const commit = custom.draftCommit;
  const draft = custom.draft;
  if (!commit || !validateSource(draft) || await hashSource(draft) !== commit.htmlHash || !await assetManifestMatches(db,orgId,app.id,commit)) {
    return err('The saved draft bundle no longer matches its pinned GitHub commit.', 409);
  }
  if (draft.length > MAX_PREVIEW_SOURCE) return err(`Shorten the imported source to ${MAX_PREVIEW_SOURCE} characters before publishing.`, 400);
  const approvalId = String(input.approvalId || '');
  if (!approvalId) return err('An independent Owner or Admin must approve this exact commit before publishing.', 409);
  const at = new Date().toISOString();
  const version = app.version + 1;
  const definition = { ...app.definition, custom: {
    ...custom,
    published: draft,
    publishedBy: String(by),
    publishedAt: at,
    publishedCommit: { ...commit },
    publishedCommitApprovalId: approvalId,
    publishedPreviewCandidateId: input.candidateId,
  } };
  const table = await getTable(db, orgId, app.tableId);
  if (!table) return err('The app data is unavailable.', 503);
  let result;
  try { result = await db.batch([
    db.prepare(`UPDATE hx_apps SET definition=?1,version=?2,updated_at=?3
      WHERE org_id=?4 AND id=?5 AND version=?6
        AND json_extract(definition,'$.custom.draftCommit.sha')=?7
        AND json_extract(definition,'$.custom.draftCommit.sourceHash')=?8
        AND ${previewCandidateExistsSql('?14','?5','?4','?6','?15')}
        AND EXISTS(SELECT 1 FROM hx_app_commit_approvals a
          WHERE a.org_id=?4 AND a.app_id=?5 AND a.id=?9 AND a.app_version=?6
            AND a.preview_candidate_id=?14
            AND a.commit_sha=?7 AND a.source_hash=?8 AND a.status='approved' AND a.consumed_at IS NULL
            AND a.reviewer_id<>?10 AND a.visibility_scope=?11 AND a.access_version=?12 AND a.domain_scope=?13
            AND EXISTS(SELECT 1 FROM memberships r WHERE r.org_id=a.org_id AND r.user_github_id=a.reviewer_id AND LOWER(TRIM(r.role)) IN ('owner','admin'))
            AND EXISTS(SELECT 1 FROM memberships p WHERE p.org_id=a.org_id AND p.user_github_id=?10 AND LOWER(TRIM(COALESCE(p.role,'guest')))!='guest'))
        AND (created_by=?10 OR EXISTS(SELECT 1 FROM memberships admin WHERE admin.org_id=?4 AND admin.user_github_id=?10 AND LOWER(TRIM(admin.role)) IN ('owner','admin')))
        AND COALESCE((SELECT visibility FROM hx_app_access WHERE org_id=?4 AND app_id=?5),'workspace')=?11
        AND COALESCE((SELECT version FROM hx_app_access WHERE org_id=?4 AND app_id=?5),0)=?12
        AND COALESCE((SELECT hostname||'#'||status FROM hx_app_domains WHERE org_id=?4 AND app_id=?5),'')=?13`)
      .bind(JSON.stringify(definition),version,at,orgId,app.id,app.version,commit.sha,commit.sourceHash,approvalId,String(by),scope.visibility,scope.accessVersion,scope.domainScope,input.candidateId,commit.htmlHash),
    db.prepare(`INSERT INTO hx_app_versions(app_id,org_id,version,definition,note,created_by,created_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=?2 AND a.id=?1 AND a.version=?3
        AND json_extract(a.definition,'$.custom.publishedCommitApprovalId')=?8)`)
      .bind(app.id,orgId,version,JSON.stringify({...definition,name:app.name,columns:table.columns}),`GitHub commit: ${commit.owner}/${commit.repo}@${commit.sha}`,String(by),at,approvalId),
  ]); } catch (error) {
    if (String(error?.message || error).includes('Custom commit approval could not be consumed atomically')) {
      return err('The commit approval is stale, revoked, or no longer matches the publish scope.', 409);
    }
    throw error;
  }
  if (!result[0]?.meta?.changes) return err('The commit approval is stale, revoked, or no longer matches the publish scope.', 409);
  return { saved: true, version, commit, approvalId };
}

export async function assetManifestMatches(db,orgId,appId,commit){
  const expected=Array.isArray(commit?.assets)?[...commit.assets].sort((a,b)=>a.path.localeCompare(b.path)):[];
  const {results=[]}=await db.prepare(`SELECT path,content_type AS mimeType,content_hash AS contentHash,size
    FROM hx_app_git_assets WHERE org_id=?1 AND app_id=?2 AND app_version=?3 AND commit_sha=?4 ORDER BY path`)
    .bind(orgId,appId,commit.appVersion,commit.sha).all();
  if(results.length!==expected.length)return false;
  return results.every((row,index)=>row.path===expected[index].path&&row.mimeType===expected[index].mimeType&&row.contentHash===expected[index].contentHash&&Number(row.size)===Number(expected[index].size));
}

export async function hashSource(source) {
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(source||'')));
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
