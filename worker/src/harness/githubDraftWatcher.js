import { audit } from '../audit.js';
import { sessionByKey, getUserByGithubId } from '../db.js';
import { getApp } from './apps.js';
import { saveCustomRelease } from './customApps.js';
import { fetchGitHubCommitSource } from './githubCommitSource.js';
import { readGitHubAppDraftHead } from './githubDraftWriter.js';

const CHECK_MS = 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;
const BATCH_LIMIT = 5;

function safeFailure(value) {
  return String(value || 'GitHub draft refresh failed.').replace(/[\r\n\t]+/g, ' ').slice(0, 180);
}

async function editorStillAllowed(db, orgId, appId, actorId) {
  return Boolean(await db.prepare(`SELECT 1 AS allowed FROM hx_apps current
    JOIN memberships m ON m.org_id=current.org_id AND m.user_github_id=?3
      AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'
    LEFT JOIN hx_app_access access ON access.org_id=current.org_id AND access.app_id=current.id
    LEFT JOIN hx_app_person_access person ON person.org_id=current.org_id AND person.app_id=current.id AND person.user_github_id=?3
    WHERE current.org_id=?1 AND current.id=?2 AND current.deleted_at IS NULL AND (
      current.created_by=?3 OR person.permission='edit'
      OR (person.user_github_id IS NULL AND COALESCE(access.visibility,'workspace')='workspace' AND LOWER(TRIM(m.role)) IN ('owner','admin'))
    )`).bind(orgId, appId, actorId).first());
}

async function actorSession(db, actorId, nowIso) {
  const { results = [] } = await db.prepare(`SELECT token FROM sessions
    WHERE github_id=?1 AND github_access_token IS NOT NULL AND github_access_token!='' AND github_access_token!='email-auth'
      AND (expires_at IS NULL OR expires_at>?2) ORDER BY created_at DESC LIMIT 8`).bind(String(actorId), nowIso).all();
  for (const row of results) {
    const session = await sessionByKey(db, row.token).catch(() => null);
    if (session?.github_access_token && session.github_access_token !== 'email-auth') return session;
  }
  return null;
}

async function claimDue(db, nowIso, limit) {
  const leaseUntil = new Date(Date.parse(nowIso) + CHECK_MS).toISOString();
  const { results = [] } = await db.prepare(`SELECT w.org_id,w.app_id,w.next_check_at,w.failures,a.version,a.name,a.definition
    FROM hx_app_git_draft_watches w JOIN hx_apps a ON a.org_id=w.org_id AND a.id=w.app_id
    WHERE w.next_check_at<=?1 AND a.deleted_at IS NULL AND json_extract(a.definition,'$.custom.gitDraft') IS NOT NULL
    ORDER BY w.next_check_at,w.app_id LIMIT ?2`).bind(nowIso, limit).all();
  const claimed = [];
  for (const row of results) {
    const result = await db.prepare(`UPDATE hx_app_git_draft_watches SET next_check_at=?1
      WHERE org_id=?2 AND app_id=?3 AND next_check_at=?4 AND next_check_at<=?5`)
      .bind(leaseUntil, row.org_id, row.app_id, row.next_check_at, nowIso).run();
    if (result.meta?.changes) claimed.push(row);
  }
  return claimed;
}

async function finish(db, row, { now, error = null, deferMs = CHECK_MS } = {}) {
  const at = new Date(now).toISOString();
  const next = new Date(Number(now) + deferMs).toISOString();
  await db.prepare(`UPDATE hx_app_git_draft_watches SET next_check_at=?1,last_check_at=?2,last_error=?3,
      failures=CASE WHEN ?3 IS NULL THEN 0 ELSE MIN(failures+1,12) END
    WHERE org_id=?4 AND app_id=?5`).bind(next, at, error ? safeFailure(error) : null, row.org_id, row.app_id).run();
}

/**
 * Pulls new commits from explicitly connected generated draft branches. A
 * bounded minute poll replaces unavailable repo-hook permissions: it uses
 * only the connector owner's current GitHub session, never publishes, and
 * feeds commits through the same immutable-source and ACL/CAS path as manual
 * refresh. New drafts still require the normal preview and approval to publish.
 */
export async function refreshConnectedGitDrafts(env, { now = Date.now(), limit = BATCH_LIMIT } = {}) {
  const db = env?.DB;
  if (!db) return { checked: 0, imported: 0, failed: 0 };
  const at = Number(now instanceof Date ? now.getTime() : now);
  const nowIso = new Date(at).toISOString();
  const rows = await claimDue(db, nowIso, Math.max(1, Math.min(BATCH_LIMIT, Number(limit) || BATCH_LIMIT)));
  const summary = { checked: 0, imported: 0, failed: 0 };
  for (const row of rows) {
    summary.checked += 1;
    let deferMs = CHECK_MS;
    try {
      const app = await getApp(db,row.org_id,row.app_id);
      if (!app) { await db.prepare('DELETE FROM hx_app_git_draft_watches WHERE org_id=?1 AND app_id=?2').bind(row.org_id,row.app_id).run(); continue; }
      const definition = app.definition || {};
      const binding = definition.custom?.gitDraft;
      if (!binding) { await db.prepare('DELETE FROM hx_app_git_draft_watches WHERE org_id=?1 AND app_id=?2').bind(row.org_id,row.app_id).run(); continue; }
      const boundBy = String(binding.boundBy || '');
      if (!/^\d{1,30}$/.test(boundBy) || !(await editorStillAllowed(db,row.org_id,row.app_id,boundBy))) {
        deferMs = 24 * 60 * 60_000;
        throw new Error('The GitHub connection owner no longer has permission to edit this app.');
      }
      const session = await actorSession(db,boundBy,nowIso);
      if (!session) { deferMs = 60 * 60_000; throw new Error('Reconnect the GitHub account to resume automatic draft updates.'); }
      const head = await readGitHubAppDraftHead(session.github_access_token,{owner:binding.owner,repo:binding.repo,appId:app.id});
      if (!head.ok) {
        if (head.status === 401 || head.status === 403) deferMs = 60 * 60_000;
        else if (head.status === 404) deferMs = 10 * CHECK_MS;
        throw new Error(head.error);
      }
      if (head.owner!==binding.owner||head.repo!==binding.repo||head.defaultBranch!==binding.defaultBranch||head.branch!==binding.branch||head.path!==binding.path) {
        deferMs = 60 * 60_000;
        throw new Error('The connected repository draft target changed.');
      }
      const priorHead = String(binding.headSha || definition.custom?.draftCommit?.sha || '').toLowerCase();
      if (priorHead === head.commitSha) { await finish(db,row,{now:at}); continue; }
      const imported=await fetchGitHubCommitSource(session.github_access_token,{owner:binding.owner,repo:binding.repo,branch:binding.branch,commitSha:head.commitSha,path:binding.path});
      if (imported.error) throw new Error(imported.error);
      const latest = await getApp(db,row.org_id,row.app_id);
      const latestDefinition=latest?.definition;
      const currentBinding=latestDefinition?.custom?.gitDraft;
      if (!latest || latest.version!==app.version || currentBinding?.owner!==binding.owner || currentBinding?.repo!==binding.repo || currentBinding?.branch!==binding.branch || currentBinding?.headSha!==binding.headSha) {
        throw new Error('The app or GitHub binding changed during the refresh.');
      }
      const saved=await saveCustomRelease(db,row.org_id,latest,{action:'draft',version:latest.version,html:imported.source},boundBy,{
        commit:imported.commit,assets:imported.assets,gitDraftHeadSha:head.commitSha,actorId:boundBy,
      });
      if (saved.error) throw new Error(saved.error);
      const user=await getUserByGithubId(db,boundBy).catch(()=>null);
      await audit(env,null,{orgId:row.org_id,action:'app.git_draft_auto_refreshed',actor:{type:'system'},entity:{type:'app',id:row.app_id,name:latest.name},details:{repository:`${binding.owner}/${binding.repo}`,branch:binding.branch,commitSha:head.commitSha,sourceHash:imported.commit.sourceHash,assetCount:imported.assets.length,version:saved.version,connectionOwner:user?.login||boundBy}});
      summary.imported += 1;
      await finish(db,row,{now:at});
    } catch (error) {
      summary.failed += 1;
      const exponential=Math.min(CHECK_MS*(2**Math.min(Number(row.failures)||0,12)),MAX_BACKOFF_MS);
      const delay=error?.message?.includes('no longer has permission')?24*60*60_000:error?.message?.includes('Reconnect the GitHub account')?60*60_000:Math.max(deferMs,exponential);
      await finish(db,row,{now:at,error:error?.message||error,deferMs:delay}).catch(()=>{});
    }
  }
  return summary;
}
