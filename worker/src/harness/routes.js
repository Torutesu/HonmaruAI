Warning: truncated output (original token count: 28708)
Total output lines: 1595

import {currentIp} from '../requestContext.js';
import {annotationProofRequiresIp} from './appReplyRequestProof.js';
import {appActivityProof,visibleAppNotifications} from './appActivity.js';
import { prepareAppGuidelines } from './appGuidelinesFence.js';
import { mayUseDatabase } from './databaseAccess.js';
import { mayGenerateFromSchema, finishSchemaGeneration } from './generationAccess.js';
import {handleDocuments,isDocumentNodeRoute} from './documentRoutes.js';
import { createSkillShare, finalizeSkillShare, listSkillShares, revokeSkillShare, readSkillShare, downloadSkillShare, importSkillShare, mayDeliverImportedSkill } from './skillShares.js';
import { currentSkillPolicy } from './skillPolicyProof.js';
import {workflowRevisions,restoreWorkflowRevision} from './workflowRevisions.js';
import {workflowSource} from './workflowSource.js';
import {workflowNotices} from './workflowNotices.js';
import {resumeWorkflowSafety,readWorkflowSafety,saveWorkflowBudget} from './workflowSafety.js';
import {appAutomationFromPrompt} from './appAutomationGeneration.js';
import {readAutomationPlan} from './appAutomationPlan.js';
import {saveAutomationDraft,readAutomationDraft} from './appAutomationDraft.js';
import {releaseAppAutomations} from './appAutomationRelease.js';
import { convertMemoryToSkill } from './memorySkillConversion.js';
import { retryRoomHook } from './roomHookRetryRoute.js';
import { heldWorkflowSummary, discardWorkflowEvents, readHeldWorkflowEvent } from './workflowHeld.js';
import { roomHookStatuses } from './roomHookStatus.js';
import {roomVisualState,setRoomVisual} from './roomVisuals.js';
import { createRoomHook, listRoomHooks, changeRoomHook } from './roomHooks.js';
import {readRoomVisualImage} from './roomVisualImage.js';
import {roomRoleState} from './roomRoles.js';
import {managedRoomSettings,saveManagedRoomSettings} from './roomSettings.js';
import {listBusinesses} from '../db.js';
import { explicitAgentRoles, agentRoleState, setAgentRole, transferAgentOwnership } from './agentRoles.js';
import { announceAgentAccessChanged } from './agentAccessEvents.js';
import { memoryPage, memoryReviewHistory, reviewMemoryEntry, updateMemoryEntry } from './memoryEntries.js';
import { previewSkillImport } from './skillImport.js';
import { writeSkillZip } from './skillZip.js';
import { listSkillFiles, readSkillFile } from './skillFiles.js';
import { generateApp } from './appGeneration.js';
import { announceTo } from '../announce.js';
import { custom as appActivityEvent } from '../agui/events.js';
import { conversationSource, sourceFor, sourceHistory, notifyAppMentions, appNotifications, asksAppAI, replyToApp } from './appConversationFeatures.js';
import { appConversation } from './appConversations.js';
import { listAppAnnotations, normalizeAppAnnotation, saveAppAnnotation } from './appAnnotations.js';
import { personalViews } from './personalViews.js';
import { appPins, setAppPin } from './appPins.js';
import { previewMerge, mergeFork } from './appMerge.js';
import { databaseView, previewMigration, applyMigration, generateMigration, forkDatabase, readFork, mutateFork } from './appDatabase.js';
import { actions, generateAction, saveAction, runAction, readActionJob, connections, saveConnection, invokeConnection } from './appCapabilities.js';
import { generateCustomSource, saveCustomRelease } from "./customApps.js";
import { readAppHosting, changeAppHosting, servePublicAppDomain } from './appHosting.js';
import { handleGateways, isGatewayNodeRoute } from './gateways.js';
import { setSkillAccess } from './skillAccess.js';
import { tableContract } from "./tableContract.js";
import { appAccess, mayUseApp, mayUseTable, mayReadAppRows, setAppAccess, visibleResources, visibleAppLinks } from './resourceAccess.js';
import { mayUseConversation, readableConversation } from './conversationAccess.js';
import { listMembers as memoryMembers } from '../team.js';
import { createAgentAccessRequest, requestableAgentOptions, roomAgentAccessPlans } from './agentAccessRequests.js';
import { announceCards } from '../announce.js';
import { notifyCard, anyChannelConfigured } from '../notify.js';
import { handleRemoteMcp } from './remoteMcp.js';
import { agentAppConnections, setAgentAppGrant } from '../smitheryApps.js';
import { agentSourceConnections, setAgentSourceConnection } from './agentConnections.js';
import { agentRemoteMcpConnections, setAgentRemoteMcpConnection } from './agentRemoteMcp.js';
// The harness routes (docs/kylon-gap-plan.md): the workspace's mode, Tables
// and Apps. Every route asks for a member who is not a guest; building is a
// member's, deleting someone else's is an admin's.

import { caller } from "../channelRoutes.js";
import { allowed } from "../permissions.js";
import { audit, person } from "../audit.js";
import { enforce } from "../ratelimit.js";
import { getMode, setMode, MODES } from "./mode.js";
import { getDisplayPreference, setDisplayPreference } from "./displayPreferences.js";
import {
  listTables, getTable, createTable, updateTable, deleteTable,
  listRows, addRow, updateRow, deleteRow,
} from "./tables.js";
import {
  listApps, getApp, createApp, createFromTemplate, updateApp, deleteApp,
  linkApp, unlinkApp, listVersions, restoreVersion, renderApp,
} from "./apps.js";
import { templateList } from "./templates.js";
import { createTemplateShare, listTemplateShares, revokeTemplateShare, readTemplateShare, importTemplateShare } from './templateShares.js';
import { getProfile, saveProfile, listAgentMemories, addAgentMemory, deleteAgentMemory, TIERS, ACCESS } from "./agents.js";
import { listSkills, createSkill, updateSkill, deleteSkill, getSkill, giveSkill, takeSkill, skillsOf } from "./skills.js";
import { skillMarkdown } from "./skillMarkdown.js";
import { generateWorkflow } from './workflowCreation.js';
import { completer } from "./model.js";
import { listWorkflows, getWorkflow, createWorkflow, updateWorkflow, changeWorkflowHook, replayWorkflowEvents, deleteWorkflow, listRuns, getRun, startRun, TRIGGERS, STEP_TYPES } from "./workflows.js";
import { followupHistory, listFollowups, scheduleFollowup, cancelFollowup } from "./followups.js";
import { onRowChange, onRowDelete } from "./workflows.js";
import { profilesFor, mayAccessAgent } from "./agents.js";
import { listAgents } from "../customAgents.js";
import { resolveChannel, viewOf } from "../channels.js";
import { roomResponses, saveRoomResponses } from "./roomResponses.js";
import { getGuidelines, saveGuidelines, MAX_GUIDELINES } from "./guidelines.js";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-session-token, x-ai-key, authorization",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json", ...CORS_HEADERS },
  });
}

const fail = (result) => json({ message: result.error, ...(result.fields ? { fields: result.fields } : {}) }, result.status || 400);
const importMayBeSaved = 'A copy may have been created. After access is restored, check the Skill list before retrying.';

/// The paths this module answers.
const OURS = /^\/(orgs\/mode|tables|apps|app-domains|app-generation-v2|template-shares|skills|skill-shares|workspace-file-shares|workspace-file-public-urls|gateways|hx|workflows|followups|approvals|harness\/home|remote-mcp)(\/|$)/;

/// The caller, refused if a guest: the harness is the team's.
export async function member(env, request, orgId, options) {
  const who = await caller(env, request, orgId, options);
  if (who.denied) return who;
  const { isGuest } = await import("../access.js");
  if (await isGuest(env.DB, orgId, who.session.github_id)) return { denied: json({ message: "A guest cannot use this." }, 403) };
  return who;
}

async function body(request) {
  const b = await request.json().catch(() => null);
  return b && typeof b === "object" ? b : null;
}

/// Who may change or delete a thing: its maker, or an admin.
async function mayChange(env, orgId, who, createdBy) {
  if (String(createdBy) === String(who.session.github_id)) return true;
  return allowed(env.DB, orgId, who.session.github_id, "harness.delete_others");
}

export async function handleHarness(request, env, url, context = {}) {
  if (!OURS.test(url.pathname)) return null;
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const limited = await enforce(env, request, (isGatewayNodeRoute(url.pathname)||isDocumentNodeRoute(url.pathname)) ? "gateway/edge" : "team");
  if (limited) return limited;

  if (url.pathname === '/app-domains/resolve') return servePublicAppDomain(request, env, url);

  if(url.pathname.startsWith('/workspace-file-public-urls/')){
    const parts=url.pathname.split('/').filter(Boolean),token=parts[1];
    if(parts.length===2){
      const {servePublicFileUrl}=await import('./filePublicUrls.js');
      return servePublicFileUrl(request,env,token);
    }
    return new Response('Not found',{status:404,headers:{'cache-control':'no-store','cdn-cache-control':'no-store','cloudflare-cdn-cache-control':'no-store','referrer-policy':'no-referrer','x-robots-tag':'noindex, nofollow, noarchive','x-content-type-options':'nosniff'}});
  }

  if (url.pathname.startsWith('/workspace-file-shares/')) {
    const parts=url.pathname.split('/').filter(Boolean),token=parts[1];
    if(parts.length===2&&request.method==='GET'){
      const ready=await env.DB.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('hx_workspace_file_shares','hx_workspace_file_share_revisions','hx_workspace_file_share_items')").first();
      if(ready.n!==3)return json({message:'This share is unavailable.'},404);
      const {readPublicFileShare}=await import('./fileShares.js');
      const result=await readPublicFileShare(env,token),response=json(result||{message:'This share is unavailable.'},result?200:404);
      response.headers.set('Referrer-Policy','no-referrer');response.headers.set('X-Robots-Tag','noindex, nofollow, noarchive');response.headers.set('X-Content-Type-Options','nosniff');
      return response;
    }
    if(parts.length===4&&parts[2]==='content'&&request.method==='GET'){
      const ready=await env.DB.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('hx_workspace_file_shares','hx_workspace_file_share_revisions','hx_workspace_file_share_items')").first();
      if(ready.n!==3)return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});
      const index=parts[3]==='preview'?Number(url.searchParams.get('index')):Number(parts[3]);
      const preview=parts[3]==='preview';
      if(!Number.isSafeInteger(index)||index<0)return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});
      const {readPublicFileShareContent}=await import('./fileShares.js');
      return await readPublicFileShareContent(env,token,index,{preview})||new Response('Not found',{status:404,headers:{'cache-control':'no-store','referrer-policy':'no-referrer','x-robots-tag':'noindex, nofollow, noarchive'}});
    }
    return json({message:'This share is unavailable.'},404);
  }

  if (isDocumentNodeRoute(url.pathname)||/^\/hx\/documents(?:\/|$)/.test(url.pathname)) return handleDocuments(request,env,url);

  if (/^\/hx\/files(?:\/|$)/.test(url.pathname)) {
    const orgId=url.searchParams.get('orgId'),who=await member(env,request,orgId);
    if(who.denied)return who.denied;
    const {results}=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('hx_workspace_files','hx_workspace_file_versions','hx_workspace_file_purges','hx_workspace_file_uploads','hx_file_account_erasures','hx_workspace_file_origins')").all();
    if(results.length!==6)return json({message:'Workspace file storage is not ready.'},503);
    const identity={orgId,userId:String(who.session.github_id),headers:CORS_HEADERS};
    const fileParts=url.pathname.split('/').filter(Boolean);
    if(fileParts[3]==='public-url'){
      if(await getMode(env.DB,orgId)!=='harness')return json({message:'Public media URLs are available in Harness mode.'},404);
      if(fileParts.length!==4)return json({message:'Public media URL route not found.'},404);
      const ready=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hx_workspace_file_public_urls'").first();
      if(!ready)return json({message:'Public media URLs are not ready.'},503);
      const fileId=decodeURIComponent(fileParts[2]||'');
      let command=null;
      if(request.method!=='GET'){
        command=await body(request);
        if(!command)return json({message:'Invalid JSON body.'},400);
      }
      const {filePublicUrlState,createFilePublicUrl,revokeFilePublicUrls}=await import('./filePublicUrls.js');
      if(request.method==='GET'){
        const result=await filePublicUrlState(env,{orgId,fileId,userId:identity.userId,baseUrl:request.url});
        return result.error?json({message:result.error},result.status||400):json(result);
      }
      if(request.method==='POST'){
        const result=await createFilePublicUrl(env,{orgId,fileId,userId:identity.userId,login:who.user.login,baseUrl:request.url});
        if(result.error)return json({message:result.error},result.status||400);
        await audit(env,request,{orgId,action:'workspace.file_public_url_created',actor:person(who.user),entity:{type:'file',id:fileId},details:{version:result.version,contentType:result.contentType,reused:Boolean(result.reused)}});
        return json(result,result.reused?200:201);
      }
      if(request.method==='DELETE'){
        const result=await revokeFilePublicUrls(env.DB,{orgId,fileId,userId:identity.userId});
        if(result.error)return json({message:result.error},result.status||400);
        await audit(env,request,{orgId,action:'workspace.file_public_urls_revoked',actor:person(who.user),entity:{type:'file',id:fileId},details:{count:result.count}});
        return json(result);
      }
      return json({message:'Public media URL method not allowed.'},405);
    }
    if(fileParts[3]==='shares'){
      if(await getMode(env.DB,orgId)!=='harness')return json({message:'Public file sharing is available in Harness mode.'},404);
      const shareTables=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('hx_workspace_file_shares','hx_workspace_file_share_revisions','hx_workspace_file_share_items','hx_workspace_file_share_requests','hx_workspace_file_share_events')").all();
      if(shareTables.results.length!==5)return json({message:'Public file sharing is not ready.'},503);
      let command=null;
      if(request.method!=='GET'){
        command=await body(request);
        if(!command)return json({message:'Invalid JSON body.'},400);
      }
      const fileId=decodeURIComponent(fileParts[2]||'');
      const {listFileShares,createDirectFileShare,copyFileShare,updateFileShare,revokeFileShare}=await import('./fileShares.js');
      const canWrite=await allowed(env.DB,orgId,identity.userId,'harness.build');
      if(fileParts.length===4&&request.method==='GET'){
        const result=await listFileShares(env.DB,{orgId,fileId,userId:identity.userId});
        return result.error?json({message:result.error},result.status||400):json(result);
      }
      if(fileParts.length===4&&request.method==='POST'){
        if(!canWrite)return json({message:'File sharing requires current file write access.'},403);
        const result=await createDirectFileShare(env,{...command,orgId,fileId,userId:identity.userId,login:who.user.login});
        if(result.error)return json({message:result.error},result.status||400);
        await audit(env,request,{orgId,action:'workspace.file_share_created',actor:person(who.user),entity:{type:'file',id:fileId},details:{shareId:result.share.id,revision:result.share.currentRevision,expiresAt:result.share.expiresAt,allowDownload:result.share.allowDownload,reusable:result.share.reusable}});
        return json(result,result.replayed?200:201);
      }
      if(fileParts.length===6&&request.method==='POST'){
        const shareId=decodeURIComponent(fileParts[4]),action=fileParts[5];
        if(action==='copy'){
          const result=await copyFileShare(env,{orgId,fileId,shareId,userId:identity.userId,login:who.user.login});
          if(result.error)return json({message:result.error},result.status||400);
          await audit(env,request,{orgId,action:'workspace.file_share_copied',actor:person(who.user),entity:{type:'file',id:fileId},details:{shareId}});
          return json(result);
        }
        if(action==='update'){
          if(!canWrite)return json({message:'File sharing requires current file write access.'},403);
          const result=await updateFileShare(env,{...command,orgId,fileId,shareId,userId:identity.userId,login:who.user.login});
          if(result.error)return json({message:result.error},result.status||400);
          await audit(env,request,{orgId,action:'workspace.file_share_updated',actor:person(who.user),entity:{type:'file',id:fileId},details:{shareId,revision:result.share.currentRevision}});
          return json(result);
        }
        if(action==='revoke'||action==='stop'){
          if(!canWrite)return json({message:'File sharing requires current file write access.'},403);
          const result=await revokeFileShare(env.DB,{orgId,fileId,shareId,userId:identity.userId,login:who.user.login,action});
          if(result.error)return json({message:result.error},result.status||400);
          await audit(env,request,{orgId,action:`workspace.file_share_${action==='stop'?'stopped':'revoked'}`,actor:person(who.user),entity:{type:'file',id:fileId},details:{shareId}});
          return json(result);
        }
      }
      return json({message:'File share route not found.'},405);
    }
    if(request.method==='GET' && url.pathname==='/hx/files/scope'){
      const room=await resolveChannel(env.DB,orgId,who.user,url.searchParams.get('channel'));
      if(!room)return json({message:'No such room.'},404);
      const {fileScopeAuthority}=await import('./fileAuthority.js');
      const accessible=await env.DB.prepare(`SELECT 1 AS ok WHERE ${fileScopeAuthority('?1','?2','?3')}`).bind(orgId,room.key,identity.userId).first();
      if(!accessible)return json({message:'No such room.'},404);
      const response=json({scope:room.key});response.headers.set('Cache-Control','no-store');return response;
    }
    if(request.method==='GET'){
      const {handleFileReads}=await import('./fileReadRoutes.js');
      return handleFileReads(request,env,url,identity);
    }
    if(request.method==='PUT'&&url.pathname.endsWith('/content')){
      const uploadLimit=await enforce(env,request,'media');if(uploadLimit)return uploadLimit;
    }
    const {handleFileWrites}=await import('./fileWriteRoutes.js');
    const response=await handleFileWrites(request,env,url,{...identity,canWrite:await allowed(env.DB,orgId,who.session.github_id,'harness.build'),principalType:'human'});
    if(response.ok){
      const result=await response.clone().json();
      await audit(env,request,{orgId,action:'workspace.file_changed',actor:person(who.user),entity:{type:'file',id:result.id||url.pathname.split('/')[3]},details:{method:request.method,operation:url.pathname.split('/')[4]||'file',version:result.version??null}});
      if(result.version!==0){const {announceFileChanged}=await import('./fileEvents.js');await announceFileChanged(env,orgId,result.id||url.pathname.split('/')[3]);}
    }
    return response;
  }

  const visualRoute = url.pathname === "/hx/rooms/visual";
  const read = request.method === "GET" || request.method === "DELETE";
  const input = read || visualRoute ? null : await body(request);
  if (!read && !visualRoute && !input) return json({ message: "Invalid JSON body." }, 400);
  const orgId = read || visualRoute ? url.searchParams.get("orgId") : input.orgId;
  const parts = url.pathname.split("/").filter(Boolean);

  // A share token is a narrowly scoped bearer credential: GET exposes only
  // the sanitized template blueprint, while importing also requires a valid
  // member session in the destination workspace.
  if (parts[0] === 'template-shares') {
    if (parts.length === 2 && request.method === 'GET') {
      const result = await readTemplateShare(env.DB, parts[1]);
      return result.error ? fail(result) : json(result);
    }
    if (parts.length === 3 && parts[2] === 'import' && request.method === 'POST') {
      const who = await member(env, request, orgId);
      if (who.denied) return who.denied;
      const result = await importTemplateShare(env.DB, parts[1], { orgId, by: who.session.github_id, name: input.name });
      if (result.error) return fail(result);
      await audit(env, request, { orgId, action: 'app.template_imported', actor: person(who.user), entity: { type: 'app', id: result.app.id, name: result.app.name }, details: { sourceVersion: result.sourceVersion } });
      return json(result, 201);
    }
    return json({ message: 'Unknown template link.' }, 404);
  }

  // A bearer link can inspect a Skill's shared metadata, download its
  // temporary ZIP package, or import a private copy after member auth.
  if (parts[0] === 'skill-shares') {
    if (request.method === 'GET' && parts.length === 2) {
      const result = await readSkillShare(env.DB, parts[1]);
      return result.error ? fail(result) : json(result);
    }
    if (request.method === 'GET' && parts.length === 3 && parts[2] === 'import-agents') {
      const who = await member(env, request, orgId);
      if (who.denied) return who.denied;
      const shared = await readSkillShare(env.DB, parts[1]);
      if (shared.error) return fail(shared);
      const visible = await listAgents(env.DB, orgId, who.user.login);
      const agents = [];
      for (const candidate of visible) {
        const agent = await env.DB.prepare("SELECT id, owner_login, scope FROM custom_agents WHERE org_id=?1 AND id=?2 AND deleted_at IS NULL").bind(orgId, candidate.id).first();
        if (!agent || agent.scope === 'personal' && agent.owner_login !== who.user.login) continue;
        const role = (await explicitAgentRoles(env.DB, orgId, [agent.id], who.user.login)).get(agent.id);
        const managedProfile = !!await env.DB.prepare('SELECT 1 FROM hx_agent_profiles WHERE org_id=?1 AND agent_id=?2').bind(orgId, agent.id).first();
        const canManage = agent.owner_login === who.user.login || role === 'admin' || (!managedProfile && await allowed(env.DB, orgId, who.session.github_id, 'agent.manage_others'));
        if (canManage) agents.push({ id: agent.id, name: candidate.name });
      }
      return json({ agents });
    }
    if (request.method === 'GET' && parts.length === 3 && parts[2] === 'download') {
      const result = await downloadSkillShare(env.DB, parts[1]);
      if (result.error) return fail(result);
      return new Response(result.bytes, { headers: { ...CORS_HEADERS, 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="skill.zip"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    }
    if (request.method === 'POST' && parts.length === 3 && parts[2] === 'import') {
      const who = await member(env, request, orgId, { withMembership: true });
      if (who.denied) return who.denied;
      const agentId = typeof input.agentId === 'string' && input.agentId ? input.agentId : null;
      if (agentId) {
        const agent = await env.DB.prepare("SELECT id, owner_login, scope FROM custom_agents WHERE org_id = ?1 AND id = ?2 AND deleted_at IS NULL").bind(orgId, agentId).first();
        if (!agent || agent.scope === 'personal' && agent.owner_login !== who.user.login
          || !await mayAccessAgent(env.DB, orgId, { ...agent, ownerLogin: agent?.owner_login }, who.user.login)) return …16708 tokens truncated…ts.length === 3) {
      const canManage = await mayChange(env, orgId, who, app.createdBy);
      if (request.method === 'GET') {
        if (!canManage) return json({ message: 'Only its maker or an admin can read app hosting settings.' }, 403);
        return json(await readAppHosting(env.DB, env, orgId, appId));
      }
      if (request.method !== 'POST') return json({ message: 'Method not allowed.' }, 405);
      if (!canManage) return json({ message: 'Only its maker or an admin can change app hosting.' }, 403);
      const result = await changeAppHosting(env.DB, env, orgId, app, input || {}, me);
      if (result.error) return fail(result);
      await audit(env, request, { orgId, action: `app.hosting_${input.action}`, actor: person(who.user), entity: { type: 'app', id: appId, name: app.name }, details: {
        ...(result.domain ? { hostname: result.domain.hostname, status: result.domain.status } : {}),
        ...(result.name ? { variable: result.name } : {}),
        ...(input.action === 'remove' ? { removed: true } : {}),
      } });
      return json(result);
    }
    const withGuidedGeneration=async(prompt,makeComplete,generate,finalCheck=null)=>{
      const guidelines=await prepareAppGuidelines(env.DB,orgId,who.user,appId,prompt);
      if(!guidelines)return {error:'The source or your access changed. Reload and try again.',status:403};
      const complete=await makeComplete();
      const combined=()=>finalCheck?finalCheck(guidelines.generationGuard):guidelines.authorize();
      const result=await finishSchemaGeneration(complete,combined,async()=>{
        if(!await guidelines.authorize())return {error:'The source or your access changed. Reload and try again.',status:403};
        return generate(guidelines.request,guidelines.wrap(complete,combined));
      });
      if(!await guidelines.authorize())return {error:'The source or your access changed. Reload and try again.',status:403};
      return await combined()?result:{error:'No such app.',status:404};
    };
    if (['database','actions','connections'].includes(sub)) {
      const canManage = await mayChange(env, orgId, who, app.createdBy);
      const respond = async (result, action, extraTableIds = []) => {
        if (!result.error && action) await audit(env, request, { orgId, action, actor: person(who.user), entity: { type: 'app', id: appId }, details: { version: result.version ?? null, name: typeof input?.name === 'string' ? input.name : null, ...(result.merged?{forkId:result.forkId,checksum:result.checksum,changed:result.changed??null,replay:Boolean(result.replay)}:{}) } });
        if (sub === 'database' && !result.error && !await mayUseDatabase(env.DB, orgId, appId, me, [...extraTableIds,...[...(result.fork?.entities || []), ...(result.entities || [])].map(entity=>entity.table?.id).filter(Boolean)], request.method !== 'GET')) return json({message:'No such app.'},404);
        return result.error ? fail(result) : json(result);
      };
      if (sub === 'database') {
        if (!await mayUseDatabase(env.DB, orgId, appId, me)) return json({message:'No such app.'},404);
        if (request.method === 'GET') return respond({ ...(await databaseView(env.DB, orgId, app)), ...(await readFork(env.DB, orgId, appId, me)) });
        if (request.method !== 'POST') return json({ message: 'Method not allowed.' },405);
        if (!canManage) return json({ message: 'Only its maker or an admin can develop this app.' },403);
        if (input.action === 'generate') {
          const schema=await databaseView(env.DB,orgId,app), ids=schema.entities.map(entity=>entity.table?.id).filter(Boolean);
          const authorize=async guard=>await mayUseDatabase(env.DB,orgId,appId,me,ids,true) && await mayGenerateFromSchema(env.DB,orgId,appId,me,schema.entities,[],guard);
          if (!await authorize()) return json({message:'No such app.'},404);
          const result=await withGuidedGeneration(input.prompt,()=>completer(env,orgId,me,'app_database_generate',{maxTokens:4000,usageContext:{appId}}),
            async(prompt,complete)=>{
              const guarded=complete?async(system,user,options={})=>complete(system,user,{...options,authorize}):null;
              return generateMigration(prompt,schema,guarded);
            },authorize);
          return result.error?fail(result):json(result);
        }
        if (input.action === 'preview') {
          const {tableIds=[],...result}=await previewMigration(env.DB,orgId,app,input,me);
          return respond(result,undefined,tableIds);
        }
        if (input.action === 'migrate') return respond(await applyMigration(env.DB, orgId, app, input, me), 'app.database_migrated');
        if (input.action === 'fork') return respond(await forkDatabase(env.DB, orgId, app, me), 'app.database_forked');
        if (input.action === 'merge_preview') { const result=await previewMerge(env.DB,orgId,app,me,input); const {snapshots,...review}=result; return respond(review,undefined,(snapshots||[]).map(snapshot=>snapshot.tableId)); }
        if (input.action === 'merge_apply') {
          const result=await mergeFork(env.DB,orgId,app,me,input);
          if(result.error)return respond(result);
          const {changedRecords=[],...publicResult}=result;
          if(result.merged&&!result.replay)for(const change of changedRecords) {
            const table=await getTable(env.DB,orgId,change.tableId);
            if(!table)continue;
            const before=change.operation==='create'?null:{id:change.id,values:change.before||{},updatedAt:change.beforeUpdatedAt};
            if(change.operation==='remove')await afterRowDelete(env,{orgId,table,row:before,by:me});
            else await afterRowChange(env,{orgId,table,before,row:{id:change.id,values:change.after||{},updatedAt:result.mergedAt},by:me});
          }
          return respond(publicResult,'app.preview_merged');
        }
        if (input.action === 'fork_write') {
          const {tableIds=[],...result}=await mutateFork(env.DB,orgId,appId,me,input);
          return respond(result,'app.preview_changed',tableIds);
        }
      }
      if (sub === 'actions') {
        if (request.method === 'GET') {
          const history=url.searchParams.get('history');
          if(history){
            if(!canManage)return json({message:'Only its maker or an admin can read draft history.'},403);
            const result=await env.DB.prepare('SELECT version,code,created_at AS createdAt FROM hx_app_action_versions WHERE org_id=?1 AND app_id=?2 AND name=?3 ORDER BY version DESC LIMIT 50').bind(orgId,appId,history).all();return json({versions:result.results||[]});
          }
          const jobId=url.searchParams.get('jobId');
          if(jobId)return respond(await readActionJob(env.DB,orgId,appId,me,jobId));
          const result=await actions(env.DB,orgId,appId);
          return json({actions:canManage?result.actions:result.actions.filter(a=>a.published).map(({draft,...a})=>a)});
        }
        if (request.method !== 'POST') return json({message:'Method not allowed.'},405);
        if(input.action==='run')return respond(await runAction(env.DB,orgId,appId,input,me),'app.action_requested');
        if(!canManage)return json({message:'Only its maker or an admin can publish server actions.'},403);
        if(input.action==='generate')return respond(await withGuidedGeneration(input.prompt,()=>completer(env,orgId,me,'app_action_generate',{maxTokens:6000,usageContext:{appId}}),(prompt,complete)=>generateAction(prompt,complete)));
        return respond(await saveAction(env.DB,orgId,appId,input,me),'app.action_'+input.action);
      }
      if (sub === 'connections') {
        if(request.method==='GET')return json(await connections(env.DB,orgId,appId,me));
        if(request.method!=='POST')return json({message:'Method not allowed.'},405);
        if(input.action==='request')return respond(await invokeConnection(env.DB,orgId,appId,me,input),'app.connection_requested');
        if(input.action==='save')return respond(await saveConnection(env.DB,orgId,appId,me,input),'app.connection_saved');
      }
      return json({message:'Unknown operation.'},400);
    }
    if (sub === 'automations') {
      if (!(await mayChange(env, orgId, who, app.createdBy))) return json({message:'Only its maker or an admin can develop app automations.'},403);
      if(request.method==='POST' && input.action==='generate') {
        const tables=await visibleResources(await listTables(env.DB,orgId),t=>mayUseTable(env.DB,orgId,t.id,me));
        const agents=await listAgents(env.DB,orgId,who.user.login),visibleAgents=[];
        for(const agent of agents)if(await mayAccessAgent(env.DB,orgId,agent,who.user.login))visibleAgents.push({id:agent.id,name:agent.name});
        const appSchema=await databaseView(env.DB,orgId,app);
        const appRecords=[{id:appId,name:app.name,entities:appSchema.entities.map(entity=>({id:entity.key,name:entity.table?.name,columns:entity.table?.columns||[]}))}];
        const authorize=async guard=>{
          if(!await mayGenerateFromSchema(env.DB,orgId,appId,me,appSchema.entities,tables))return false;
          if(visibleAgents.length){
            const current=await listAgents(env.DB,orgId,who.user.login);
            for(const visible of visibleAgents){
              const agent=current.find(candidate=>candidate.id===visible.id && candidate.name===visible.name);
              if(!agent || !await mayAccessAgent(env.DB,orgId,agent,who.user.login))return false;
            }
          }
          // Agent lookups above await other queries, so recheck table schemas
          // and access immediately after them, before allowing model dispatch.
          return mayGenerateFromSchema(env.DB,orgId,appId,me,appSchema.entities,tables,guard,visibleAgents);
        };
        if(!await authorize())return json({message:'No such app.'},404);
        const result=await withGuidedGeneration(input.prompt,()=>input.useModel===false?null:completer(env,orgId,me,'app_automation_generate',{maxTokens:2400,usageContext:{appId}}),
          async(prompt,complete)=>{
            const guarded=complete?async(system,user,options={})=>complete(system,user,{...options,authorize}):null;
            return appAutomationFromPrompt(env.DB,orgId,me,{prompt,timezone:input.timezone,complete:guarded,tables,agents:visibleAgents,appRecords});
          },authorize);
        return result.error?fail(result):json(result);
      }
      if (request.method === 'GET') {
        const result=new URL(request.url).searchParams.get('stateOnly')==='1'
          ?await readAutomationDraft(env.DB,orgId,appId):await readAutomationPlan(env.DB,orgId,appId,me);
        return result.error?fail(result):json({...result,version:app.version});
      }
      if(request.method==='POST') {
        const result=await releaseAppAutomations(env.DB,orgId,app,input,me);
        if(!result.error && !result.replay)await audit(env,request,{orgId,action:'app.automations_'+input.action,actor:person(who.user),entity:{type:'app',id:appId},details:{revision:result.revision,version:result.version,releaseId:result.releaseId}});
        return result.error?fail(result):json(result);
      }
      if (request.method !== 'PUT') return json({message:'Method not allowed.'},405);
      const result=await saveAutomationDraft(env.DB,orgId,app,input,me);
      if(!result.error)await audit(env,request,{orgId,action:'app.automation_draft_saved',actor:person(who.user),entity:{type:'app',id:appId},details:{revision:result.revision}});
      return result.error?fail(result):json(result);
    }
    if (sub === "custom") {
      if (!(await mayChange(env, orgId, who, app.createdBy))) return json({ message: "Only its maker or an admin can change custom code." }, 403);
      if (request.method !== 'POST') return json({ message: 'Method not allowed.' }, 405);
      if (input.action === 'generate') {
        const table = await getTable(env.DB, orgId, app.tableId);
        const entities=(await databaseView(env.DB,orgId,app)).entities;
        const actionSnapshot=(await actions(env.DB,orgId,appId)).actions.filter(a=>a.published).map(a=>({name:a.name,code:a.published,version:a.version,publishedVersion:a.publishedVersion,updatedAt:a.updatedAt}));
        const connectionSnapshot=(await connections(env.DB,orgId,appId,me)).connections.map(c=>({name:c.name,endpoint:c.endpoint,method:c.method,enabled:c.enabled,version:c.version}));
        const gatewaySnapshot=(await env.DB.prepare('SELECT id,name,created_at AS createdAt FROM hx_gateways WHERE org_id=?1 AND revoked_at IS NULL').bind(orgId).all()).results;
        const captured={actions:actionSnapshot,connections:connectionSnapshot,gateways:gatewaySnapshot};
        const capabilities={entities,actions:actionSnapshot.map(({name,code})=>({name,code})),connections:connectionSnapshot.map(({name,endpoint,method,enabled})=>({name,endpoint,method,enabled})),gateways:gatewaySnapshot.map(({id,name})=>({id,name}))};
        const authorize=guard=>mayGenerateFromSchema(env.DB,orgId,appId,me,entities,[table],guard,[],captured);
        if(!table || capabilities.entities.find(entity=>entity.key==='primary')?.table?.id!==table.id || !await authorize())return json({message:'No such app.'},404);
        const result=await withGuidedGeneration(input.prompt,()=>completer(env,orgId,me,'custom_app_generate',{maxTokens:8000,usageContext:{appId}}),
          async(prompt,complete)=>{
            const guarded=complete?async(system,user,options={})=>complete(system,user,{...options,authorize}):null;
            return generateCustomSource(prompt,table,guarded,capabilities);
          },authorize);
        return result.error?fail(result):json(result);
      }
      const result = await saveCustomRelease(env.DB, orgId, app, input, me);
      if (!result.error) await audit(env, request, { orgId, action: 'app.custom_' + input.action, actor: person(who.user), entity: { type: 'app', id: appId }, details: { version: result.version } });
      return result.error ? fail(result) : json(result);
    }
    if (sub === "access") {
      if (request.method === "GET") return json({ access: await appAccess(env.DB, orgId, appId), canEdit: app.createdBy === String(me) });
      if (request.method === "PUT") {
        const result = await setAppAccess(env.DB, orgId, appId, me, input);
        if (!result.error) await audit(env, request, { orgId, action: "app.access_changed", actor: person(who.user), entity: { type: "app", id: appId }, details: { visibility: result.access.visibility, version: result.access.version } });
        return result.error ? fail(result) : json(result);
      }
      return json({ message: "Method not allowed." }, 405);
    }
    if (sub === 'template-shares') {
      if (!(await mayChange(env, orgId, who, app.createdBy))) return json({ message: 'Only its maker or an admin can share this app as a template.' }, 403);
      if (request.method === 'GET' && parts.length === 3) return json({ ...(await listTemplateShares(env.DB, orgId, appId)), canManage: true });
      if (request.method === 'POST' && parts.length === 3) {
        const result = await createTemplateShare(env.DB, orgId, app, input, me);
        if (result.error) return fail(result);
        await audit(env, request, { orgId, action: 'app.template_shared', actor: person(who.user), entity: { type: 'app', id: appId, name: app.name }, details: { shareId: result.share.id, version: result.share.appVersion, expiresAt: result.share.expiresAt } });
        return json(result, 201);
      }
      if (request.method === 'POST' && parts.length === 5 && parts[4] === 'revoke') {
        const result = await revokeTemplateShare(env.DB, orgId, appId, parts[3]);
        if (!result.error) await audit(env, request, { orgId, action: 'app.template_share_revoked', actor: person(who.user), entity: { type: 'app', id: appId, name: app.name }, details: { shareId: parts[3] } });
        return result.error ? fail(result) : json(result);
      }
      return json({ message: 'Method not allowed.' }, 405);
    }
    if (!sub) {
      if (request.method === "GET") {
        const r = await renderApp(env.DB, orgId, appId);
        if (r.error) return fail(r);
        const [visibleApp] = await visibleAppLinks(env.DB, orgId, [r.app], who.user);
        const canCustomize = await mayChange(env, orgId, who, app.createdBy);
        if (!(await mayReadAppRows(env.DB, orgId, appId, r.app.tableId, me))) return json({ message: 'No such app.' }, 404);
        return json({ ...r, app: visibleApp, canCustomize });
      }
      if (request.method === "PUT") {
        // The shared definition is its maker's or an admin's to change, as
        // canCustomize says; everyone else keeps personal views of their own.
        if (!(await mayChange(env, orgId, who, app.createdBy))) return json({ message: "Only its maker or an admin can change this app." }, 403);
        const r = await updateApp(env.DB, orgId, appId, input, me);
        return r.error ? fail(r) : json(r);
      }
      if (request.method === "DELETE") {
        if (!(await mayChange(env, orgId, who, app.createdBy))) return json({ message: "Only its maker or an admin can delete this app." }, 403);
        const r = await deleteApp(env.DB, orgId, appId);
        if (!r.error) await audit(env, request, { orgId, action: "app.deleted", actor: person(who.user), entity: { type: "app", id: appId, name: app.name } });
        return r.error ? fail(r) : json(r);
      }
      return null;
    }
    if (sub === "versions") {
      if (request.method === "GET") {
        const r = await listVersions(env.DB, orgId, appId);
        return r.error ? fail(r) : json(r);
      }
      if (request.method === "POST") {
        if (!(await mayChange(env, orgId, who, app.createdBy))) return json({ message: "Only its maker or an admin can change this app." }, 403);
        const r = await restoreVersion(env.DB, orgId, appId, input.version, me);
        return r.error ? fail(r) : json(r);
      }
    }
    if (sub === "links") {
      if (!await mayChange(env, orgId, who, app.createdBy)) return json({ message: "Only its maker or an admin can change app links." }, 403);
      if (request.method === "POST") {
        const room = await readableConversation(env.DB, orgId, me, input.channel);
        if (!room) return json({ message: 'No such room.' }, 404);
        const result = await linkApp(env.DB, orgId, appId, room.key, me);
        if (result.error) return fail(result);
        await audit(env, request, { orgId, action: 'app.room_linked', actor: person(who.user), entity: { type: 'app', id: appId, name: app.name }, details: {} });
        return json(result);
      }
      if (request.method === "DELETE") {
        const channel = url.searchParams.get("channel");
        if (!channel) return json({ message: 'channel is required' }, 400);
        const result = await unlinkApp(env.DB, orgId, appId, channel);
        if (result.error) return fail(result);
        await audit(env, request, { orgId, action: 'app.room_unlinked', actor: person(who.user), entity: { type: 'app', id: appId, name: app.name }, details: {} });
        return json(result);
      }
    }
    return null;
  }
  return null;
}

/// After a row is added or changed: workflows that watch the table run.
/// Kept as a hook so tables.js stays free of what reacts to it.
async function afterRowChange(env, change) {
  try {
    await onRowChange(env, change);
  } catch (e) {
    console.error("harness: row hook failed", e?.message);
  }
}

async function afterRowDelete(env, change) {
  try {
    await onRowDelete(env, change);
  } catch (e) {
    console.error("harness: row delete hook failed", e?.message);
  }
}

const hookUrl = (url, wf) => (wf.trigger?.type === "webhook" && wf.hookSecret ? `${url.origin}/hooks/workflows/${wf.id}?secret=${wf.hookSecret}` : undefined);

/// What agents and workflows are waiting on: for this person to decide, and
/// what they started that waits on someone else.
async function approvalsFor(env, orgId, login, me) {
  const { results } = await env.DB
    .prepare("SELECT data FROM cards WHERE org_id = ?1 AND recipient_user_id = ?2 AND status = 'pending' ORDER BY created_at DESC LIMIT 200")
    .bind(orgId, login)
    .all();
  const pending = (results || []).map((r) => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
  const cards = pending.filter((c) => c.workflowApproval || c.proxyAction || c.proposal || c.agentAccessRequest || c.fileShareApproval || String(c.senderUserID || "").startsWith("agent:"));
  const { results: waiting } = await env.DB
    .prepare(`SELECT r.id, r.workflow_id, r.card_id, r.started_at, w.name FROM hx_workflow_runs r JOIN hx_workflows w ON w.id = r.workflow_id
      WHERE r.org_id = ?1 AND r.status = 'waiting' AND (r.started_by = ?2 OR w.created_by = ?2) ORDER BY r.started_at DESC LIMIT 100`)
    .bind(orgId, String(me))
    .all();
  return {
    pendingDecisions: pending.length,
    toDecide: cards.map((c) => ({ id: c.id, title: c.title, summary: c.summary, createdAt: c.createdAt, kind: c.workflowApproval ? "workflow" : c.fileShareApproval ? "file-share" : c.agentAccessRequest ? "access" : c.proxyAction ? "agent" : c.proposal ? "proposal" : "agent", source: c.sourceDetail || c.sourceApp || null })),
    waitingOnOthers: (await visibleResources(waiting || [], async w => Boolean(await getRun(env.DB, orgId, w.id, { viewerId: me })))).map((w) => ({ runId: w.id, workflowId: w.workflow_id, workflow: w.name, cardId: w.card_id, startedAt: w.started_at })),
  };
}

async function homeFor(env, orgId, who, me) {
  const db = env.DB;
  const [mode, approvals, appRows, agents, workflows, followups] = await Promise.all([
    getMode(db, orgId),
    approvalsFor(env, orgId, who.user.login, me),
    listApps(db, orgId)
      .then(items => visibleResources(items, a => mayUseApp(db, orgId, a.id, me)))
      .then(items => visibleAppLinks(db, orgId, items, who.user)),
    listAgents(db, orgId, who.user.login).catch(() => []),
    listWorkflows(db, orgId, { viewerId: me }),
    listFollowups(db, orgId, { viewerId: me }),
  ]);
  // An app's headline: the first number its summary view works out.
  const appSummaries = await Promise.all(appRows.slice(0, 12).map(async (a) => {
    const r = await renderApp(db, orgId, a.id).catch(() => null);
    if (!r?.app) return null;
    const metrics = r?.views.find((v) => v.type === "metrics");
    const first = metrics?.values?.[0] || null;
    return { tableId:r.app.tableId, summary:{ id: a.id, name: a.name, icon: a.icon, description: a.description, channels: a.channels || [], rows: r.rows.length, headline: first ? { label: first.label, value: first.value } : null } };
  }));
  const profiles = await profilesFor(db, orgId, agents.map((a) => a.id));
  // Newest first: the first seen for a workflow is how it last ran.
  const { results: runs } = workflows.length
    ? await db.prepare("SELECT workflow_id, status, started_at FROM hx_workflow_runs WHERE org_id = ?1 ORDER BY started_at DESC LIMIT 500").bind(orgId).all()
    : { results: [] };
  const lastOf = new Map();
  for (const r of runs || []) if (!lastOf.has(r.workflow_id)) lastOf.set(r.workflow_id, { status: r.status, startedAt: r.started_at });
  const apps = (await Promise.all(appSummaries.map(async item => item && await mayReadAppRows(db, orgId, item.summary.id, item.tableId, me) ? item.summary : null))).filter(Boolean);
  return {
    mode,
    approvals,
    apps,
    agents: agents.slice(0, 24).map((a) => {
      const p = profiles.get(a.id);
      return { id: a.id, handle: a.handle, name: a.name, emoji: a.emoji || null, description: a.description || "", specialty: p?.specialty || "", tier: p?.tier || "standard", provider: a.provider || null };
    }),
    workflows: workflows.slice(0, 20).map((w) => ({ id: w.id, name: w.name, enabled: w.enabled, trigger: w.trigger.type, nextRunAt: w.nextRunAt, lastRun: lastOf.get(w.id) || null })),
    followups: followups.slice(0, 10),
  };
}
