import {handleDocuments,isDocumentNodeRoute} from './documentRoutes.js';
import { createSkillShare, listSkillShares, revokeSkillShare, readSkillShare, downloadSkillShare, importSkillShare } from './skillShares.js';
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
import { conversationSource, sourceFor, sourceHistory, withAppRoomGuidelinesRequest, notifyAppMentions, appNotifications, asksAppAI, replyToApp } from './appConversationFeatures.js';
import { appConversation } from './appConversations.js';
import { listAppAnnotations, normalizeAppAnnotation, saveAppAnnotation } from './appAnnotations.js';
import { personalViews } from './personalViews.js';
import { appPins, setAppPin } from './appPins.js';
import { previewMerge, mergeFork } from './appMerge.js';
import { databaseView, previewMigration, applyMigration, generateMigration, forkDatabase, readFork, mutateFork } from './appDatabase.js';
import { actions, generateAction, saveAction, runAction, readActionJob, connections, saveConnection, invokeConnection } from './appCapabilities.js';
import { generateCustomSource, saveCustomRelease } from "./customApps.js";
import { handleGateways, isGatewayNodeRoute } from './gateways.js';
import { setSkillAccess } from './skillAccess.js';
import { tableContract } from "./tableContract.js";
import { appAccess, mayUseApp, mayUseTable, setAppAccess, visibleResources, visibleAppLinks } from './resourceAccess.js';
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

/// The paths this module answers.
const OURS = /^\/(orgs\/mode|tables|apps|app-generation-v2|template-shares|skills|skill-shares|gateways|hx|workflows|followups|approvals|harness\/home|remote-mcp)(\/|$)/;

/// The caller, refused if a guest: the harness is the team's.
export async function member(env, request, orgId) {
  const who = await caller(env, request, orgId);
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

  if (isDocumentNodeRoute(url.pathname)||/^\/hx\/documents(?:\/|$)/.test(url.pathname)) return handleDocuments(request,env,url);

  if (/^\/hx\/files(?:\/|$)/.test(url.pathname)) {
    const orgId=url.searchParams.get('orgId'),who=await member(env,request,orgId);
    if(who.denied)return who.denied;
    const {results}=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('hx_workspace_files','hx_workspace_file_versions','hx_workspace_file_purges','hx_workspace_file_uploads','hx_file_account_erasures','hx_workspace_file_origins')").all();
    if(results.length!==6)return json({message:'Workspace file storage is not ready.'},503);
    const identity={orgId,userId:String(who.session.github_id),headers:CORS_HEADERS};
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
      const who = await member(env, request, orgId);
      if (who.denied) return who.denied;
      const agentId = typeof input.agentId === 'string' && input.agentId ? input.agentId : null;
      if (agentId) {
        const agent = await env.DB.prepare("SELECT id, owner_login, scope FROM custom_agents WHERE org_id = ?1 AND id = ?2 AND deleted_at IS NULL").bind(orgId, agentId).first();
        if (!agent || agent.scope === 'personal' && agent.owner_login !== who.user.login
          || !await mayAccessAgent(env.DB, orgId, { ...agent, ownerLogin: agent?.owner_login }, who.user.login)) return json({ message: 'No such agent.' }, 404);
        const delegatedRole = (await explicitAgentRoles(env.DB, orgId, [agentId], who.user.login)).get(agentId);
        const managedProfile = !!await env.DB.prepare('SELECT 1 FROM hx_agent_profiles WHERE org_id=?1 AND agent_id=?2').bind(orgId, agentId).first();
        const canEditAgent = agent.owner_login === who.user.login || delegatedRole === 'admin' || (!managedProfile && await allowed(env.DB, orgId, who.session.github_id, 'agent.manage_others'));
        if (!canEditAgent) return json({ message: "Only an agent's maker or admin can install Skills on it." }, 403);
      }
      const result = await importSkillShare(env.DB, parts[1], { orgId, userId: who.session.github_id, name: input.name });
      if (result.error) return fail(result);
      if (agentId) await giveSkill(env.DB, orgId, agentId, result.skill.id, who.session.github_id);
      await audit(env, request, { orgId, action: 'skill.share_imported', actor: person(who.user), entity: { type: 'skill', id: result.skill.id, name: result.skill.name }, details: { installedOnAgent: Boolean(agentId) } });
      return json({ ...result, installedOnAgent: Boolean(agentId) }, 201);
    }
    return json({ message: 'This Skill share link is unavailable.' }, 404);
  }

  // A Simple-only preference belongs to this signed-in member, not to the
  // workspace. It is delivered only to that person's open devices.
  if (url.pathname === '/hx/display-preference') {
    if (request.method !== 'PUT') return json({ message: 'Method not allowed.' }, 405);
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    if (typeof input?.simpleOnly !== 'boolean') return json({ message: 'simpleOnly must be true or false.' }, 400);
    const preference = await setDisplayPreference(env.DB, orgId, who.session.github_id, input.simpleOnly);
    if (preference.error) return fail(preference);
    await announceTo(env, orgId, [{
      to: who.user.login,
      event: appActivityEvent('display_preference_changed', { orgId, ...preference }),
    }]);
    return json(preference);
  }

  if (parts[0] === 'gateways') return handleGateways(request, env, url, input);

  // ── Mode ──────────────────────────────────────────────────────────────
  if (url.pathname === "/orgs/mode") {
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    const canEdit = await allowed(env.DB, orgId, who.session.github_id, "workspace.mode");
    if (request.method === "PUT") {
      if (!canEdit) return json({ message: "Only an admin can change how this workspace looks." }, 403);
      const result = await setMode(env.DB, orgId, input.mode, who.session.github_id);
      if (result.error) return fail(result);
      await audit(env, request, { orgId, action: "workspace.mode_changed", actor: person(who.user), details: { mode: result.mode } });
    } else if (request.method !== "GET") return null;
    const preference = await getDisplayPreference(env.DB, orgId, who.session.github_id);
    return json({ orgId, mode: await getMode(env.DB, orgId), modes: MODES, canEdit, ...preference });
  }

  const who = await member(env, request, orgId);
  if (who.denied) return who.denied;
  const me = who.session.github_id;
  if (url.pathname === "/remote-mcp" || url.pathname.startsWith("/remote-mcp/")) {
    if (request.method === "GET" && url.pathname === "/remote-mcp/registry") {
      const limited = await enforce(env, request, "remote-mcp/registry");
      if (limited) return limited;
    }
    if (request.method === "POST" && url.pathname.endsWith("/oauth/start")) {
      const limited = await enforce(env, request, "remote-mcp/oauth");
      if (limited) return limited;
    }
    const canManage = await allowed(env.DB, orgId, me, "workspace.integrations");
    return handleRemoteMcp(request, env, url, input, { orgId, who, canManage });
  }
  if (parts[0] === 'hx' && parts[1] === 'agent-access-options') {
    if (request.method !== 'GET') return json({ message: 'Method not allowed.' }, 405);
    const roster=await memoryMembers(env.DB,orgId,me);
    const actor=roster.find(m=>String(m.userId)===String(me));
    if(!actor||String(actor.role||'guest').toLowerCase()==='guest')return json({agents:[],addableAgents:[]});
    const agents=await requestableAgentOptions(env.DB,orgId,who.user.login);
    const workspacePeople=roster.filter(m=>String(m.role||'guest').toLowerCase()!=='guest')
      .map(m=>({kind:'person',id:String(m.userId),eligible:true,membership:m.joinedAt}));
    const accessible=await listAgents(env.DB,orgId,who.user.login);
    const plans=await roomAgentAccessPlans(env.DB,orgId,accessible.map(a=>a.id),workspacePeople,me);
    const memberRefs=new Map(roster.map(m=>[String(m.userId),m.ref]));
    const addableAgents=accessible.map(a=>{
      const plan=plans.get(a.id)||{missing:[],canGrantAccess:false};
      return {id:a.id,name:a.name,avatarUrl:a.avatarUrl||null,missingAccessMembers:plan.missing.map(m=>({ref:memberRefs.get(m.id),name:m.name})).filter(m=>m.ref),canGrantAccess:plan.canGrantAccess};
    });
    return json({ agents, addableAgents });
  }
  if (url.pathname === '/hx/rooms/webhooks') {
    if (!['GET','POST','PUT'].includes(request.method)) return json({message:'Method not allowed.'},405);
    const channel = request.method === 'GET' ? url.searchParams.get('channel') : input.channel;
    const room = await resolveChannel(env.DB,orgId,who.user,channel);
    if (!room || room.kind !== 'business') return json({message:'No such room.'},404);
    if (!await allowed(env.DB,orgId,me,'harness.build')) return json({message:'You cannot manage integrations in this workspace.'},403);
    const result = request.method === 'GET'
      ? await listRoomHooks(env.DB,orgId,room.key,me)
      : request.method === 'POST'
        ? await createRoomHook(env.DB,orgId,room.key,me,input.name,{provider:input.provider,channelSecret:input.channelSecret})
        : input.action==='retry' ? await retryRoomHook(env,orgId,room.key,me,input) : await changeRoomHook(env.DB,orgId,room.key,me,input.id,input.version,input.action,input.channelSecret);
    if (result.error) return fail(result);
    if (request.method === 'GET') result.events = await roomHookStatuses(env,orgId,result.events,me);
    if (request.method !== 'GET') await audit(env,request,{orgId,action:'room.webhook_changed',actor:person(who.user),entity:{type:'channel',id:room.key},details:{action:request.method==='POST'?'create':input.action}});
    const response = json(result);
    response.headers.set('Cache-Control','no-store');
    return response;
  }
  if (url.pathname === '/hx/app-pins') {
    if (request.method === 'GET') return json(await appPins(env.DB,orgId,me));
    if (request.method === 'PUT') { const r=await setAppPin(env.DB,orgId,me,input.appId,input.pinned); return r.error ? fail(r) : json(r); }
    return json({message:'Method not allowed.'},405);
  }
  if (parts[0] === 'hx' && parts[1] === 'personal-views' && parts.length === 3) {
    if (!['GET','PUT'].includes(request.method)) return json({message:'Method not allowed.'},405);
    const r = await personalViews(env.DB,orgId,me,parts[2],request.method === 'PUT' ? input : undefined);
    if (r.error) return fail(r);
    const [visibleApp] = await visibleAppLinks(env.DB, orgId, [r.snapshot.app], who.user);
    r.snapshot.app = visibleApp;
    r.snapshot.canCustomize = await mayChange(env, orgId, who, visibleApp.createdBy);
    return json(r);
  }
  if(visualRoute) {
    if(!['GET','POST','DELETE'].includes(request.method))return json({message:'Method not allowed.'},405);
    const channel=url.searchParams.get('channel');
    const room=await resolveChannel(env.DB,orgId,who.user,channel);
    if(!room||room.kind!=='business')return json({message:'No such room.'},404);
    if(request.method==='GET') {
      const state=await roomRoleState(env.DB,orgId,room.key);
      if(!state?.managed)return json({message:'No such active managed room.'},404);
      const visual=await env.DB.prepare('SELECT object_key,content_type FROM hx_room_visuals WHERE org_id=?1 AND channel=?2').bind(orgId,room.key).first();
      if(!visual)return json({message:'No room visual.'},404);
      const object=await env.MEDIA.get(visual.object_key);
      if(!object)return json({message:'No room visual.'},404);
      // Storage may take time. Revalidate membership/access after fetching it.
      const again=await member(env,request,orgId);
      if(again.denied)return again.denied;
      const currentRoom=await resolveChannel(env.DB,orgId,again.user,channel);
      const current=await roomRoleState(env.DB,orgId,room.key);
      if(!currentRoom||!current?.managed||current.version!==state.version)return json({message:'Room access or visual changed. Reload.'},409);
      return new Response(object.body,{headers:{...CORS_HEADERS,'content-type':visual.content_type,'x-content-type-options':'nosniff','cache-control':'private, no-store','vary':'x-session-token'}});
    }
    const version=Number(url.searchParams.get('version'));
    if(!Number.isSafeInteger(version)||version<1)return json({message:'A current room version is required.'},400);
    const check=await roomVisualState(env.DB,orgId,room.key,me);
    if(check.error)return fail(check);
    if(check.version!==version)return json({message:'Room settings changed. Reload before saving.'},409);
    let objectKey=null,contentType=null;
    if(request.method==='POST') {
      const image=await readRoomVisualImage(request);
      if(image.error)return fail(image);
      objectKey=`room-visual-${crypto.randomUUID()}`;contentType=image.contentType;
      await env.MEDIA.put(objectKey,image.bytes,{httpMetadata:{contentType}});
    }
    let result;
    try {result=await setRoomVisual(env.DB,orgId,room.key,me,{version,objectKey,contentType});}
    catch(error) {
      // A storage error can have an uncertain commit outcome. Never delete
      // bytes still referenced by a committed pointer.
      if(objectKey)try {const used=await env.DB.prepare('SELECT 1 FROM hx_room_visuals WHERE object_key=?1').bind(objectKey).first();if(!used)await env.MEDIA.delete(objectKey);}catch {}
      throw error;
    }
    if(result.error){if(objectKey)await env.MEDIA.delete(objectKey).catch(()=>{});return fail(result);}
    if(result.previous&&result.previous!==objectKey)await env.MEDIA.delete(result.previous).catch(()=>{});
    await audit(env,request,{orgId,action:'room.visual_changed',actor:person(who.user),entity:{type:'channel',id:room.key},details:{version:result.version,picture:objectKey?'set':'removed'}});
    const members=await memoryMembers(env.DB,orgId,me);
    await announceTo(env,orgId,await Promise.all(members.map(async m=>({to:m.login,event:appActivityEvent('businesses',{businesses:await listBusinesses(env.DB,orgId,{viewer:m.login})})}))));
    return json({version:result.version,hasVisual:!!objectKey});
  }
  if(url.pathname==='/hx/rooms/settings') {
    if(!['GET','PUT'].includes(request.method))return json({message:'Method not allowed.'},405);
    const channel=request.method==='GET'?url.searchParams.get('channel'):input.channel;
    const room=await resolveChannel(env.DB,orgId,who.user,channel);
    if(!room||room.kind!=='business')return json({message:'No such room.'},404);
    const canChangeResponses=await allowed(env.DB,orgId,me,'harness.build');
    if(request.method==='GET'){
      const result=await managedRoomSettings(env.DB,orgId,room.key,me);
      if(result.error)return fail(result);
      const visual=await env.DB.prepare('SELECT 1 FROM hx_room_visuals WHERE org_id=?1 AND channel=?2').bind(orgId,room.key).first();
      return json({settings:result.settings,canEdit:result.canEdit,canChangeResponses:result.canEdit&&canChangeResponses,...(visual?{visualVersion:result.settings.version}:{})});
    }
    const result=await saveManagedRoomSettings(env.DB,orgId,room.key,me,input,{canChangeResponses});
    if(result.error)return fail(result);
    await audit(env,request,{orgId,action:'room.settings_changed',actor:person(who.user),entity:{type:'channel',id:room.key},details:{version:result.settings.version,responseVersion:result.settings.responseVersion}});
    const members=await memoryMembers(env.DB,orgId,me);
    await announceTo(env,orgId,await Promise.all(members.map(async m=>({to:m.login,event:appActivityEvent('businesses',{businesses:await listBusinesses(env.DB,orgId,{viewer:m.login})})}))));
    return json({...result,businesses:await listBusinesses(env.DB,orgId,{viewer:who.user.login})});
  }
  if (!read && !(await allowed(env.DB, orgId, me, "harness.build"))) return json({ message: "You cannot build in this workspace." }, 403);

  if (url.pathname === "/hx/rooms/responses") {
    const channel = read ? url.searchParams.get("channel") : input.channel;
    const room = await resolveChannel(env.DB, orgId, who.user, channel);
    if (!room || room.kind !== "business") return json({ message: "No such room." }, 404);
    const exists = await env.DB.prepare("SELECT 1 FROM businesses WHERE org_id = ?1 AND slug = ?2").bind(orgId, room.slug).first();
    if (!exists) return json({ message: "No such room." }, 404);
    if (request.method === "GET") {
      const managed=await env.DB.prepare('SELECT 1 FROM hx_room_access WHERE org_id=?1 AND channel=?2').bind(orgId,room.key).first();
      const settings=managed?await managedRoomSettings(env.DB,orgId,room.key,me):null;
      if(settings?.error)return fail(settings);
      return json({responses:await roomResponses(env.DB,orgId,room.key),canEdit:(!managed||settings.canEdit)&&await allowed(env.DB,orgId,me,'harness.build')});
    }
    if (request.method === "PUT") {
      const result = await saveRoomResponses(env.DB, orgId, room.key, input, me);
      if (result.error) return fail(result);
      await audit(env, request, { orgId, action: "room.responses_changed", actor: person(who.user), entity: { type: "channel", id: room.key }, details: result.responses });
      return json(result);
    }
    return json({ message: "Method not allowed." }, 405);
  }

  if (url.pathname === "/hx/rooms/guidelines") {
    const channel = read ? url.searchParams.get("channel") : input.channel;
    const room = await resolveChannel(env.DB, orgId, who.user, channel);
    if (!room || room.kind !== "business") return json({ message: "No such room." }, 404);
    const exists = await env.DB.prepare("SELECT 1 FROM businesses WHERE org_id = ?1 AND slug = ?2").bind(orgId, room.slug).first();
    if (!exists) return json({ message: "No such room." }, 404);
    if (request.method === "GET") {
      const state=await roomRoleState(env.DB,orgId,room.key);
      if(!state)return json({message:'No such active room.'},404);
      const joined=!state.managed||state.members.some(member=>member.kind==='person'&&member.id===String(me)&&member.eligible);
      return json({guidelines:await getGuidelines(env.DB,orgId,room.key),maxLength:MAX_GUIDELINES,canEdit:joined&&await allowed(env.DB,orgId,me,'harness.build')});
    }
    if (request.method === "PUT") {
      const result = await saveGuidelines(env.DB, orgId, room.key, input, me);
      if (result.error) return fail(result);
      await audit(env, request, { orgId, action: "room.guidelines_changed", actor: person(who.user), entity: { type: "channel", id: room.key }, details: { version: result.guidelines.version } });
      return json(result);
    }
    return json({ message: "Method not allowed." }, 405);
  }

  // ── Tables ────────────────────────────────────────────────────────────
  if (parts[0] === "tables") {
    const [, tableId, sub, rowId] = parts;
    if (!tableId) {
      if (request.method === "GET") return json({ tables: await visibleResources(await listTables(env.DB, orgId), t => mayUseTable(env.DB, orgId, t.id, me)) });
      if (request.method === "POST") {
        const r = await createTable(env.DB, { orgId, name: input.name, columns: input.columns, by: me });
        return r.error ? fail(r) : json(r, 201);
      }
      return null;
    }
    if (!(await mayUseTable(env.DB, orgId, tableId, me))) return json({ message: "No such table." }, 404);
    if (sub === "contract" && request.method === "GET") {
      const table = await getTable(env.DB, orgId, tableId);
      return table ? json(tableContract(table)) : json({ message: "No such table." }, 404);
    }
    if (!sub) {
      if (request.method === "GET") {
        let where;
        try { where = url.searchParams.has("where") ? JSON.parse(url.searchParams.get("where")) : undefined; }
        catch { return json({ message: "where must contain valid JSON." }, 400); }
        const r = await listRows(env.DB, orgId, tableId, {
          limit: url.searchParams.get("limit") ?? undefined,
          offset: url.searchParams.get("offset") ?? undefined,
          q: url.searchParams.get("q") || undefined,
          sort: url.searchParams.get("sort") || undefined,
          where,
        });
        return r.error ? fail(r) : json(r);
      }
      const table = await getTable(env.DB, orgId, tableId);
      if (!table) return json({ message: "No such table." }, 404);
      if (request.method === "PUT") {
        const r = await updateTable(env.DB, orgId, tableId, input);
        return r.error ? fail(r) : json(r);
      }
      if (request.method === "DELETE") {
        if (!(await mayChange(env, orgId, who, table.createdBy))) return json({ message: "Only its maker or an admin can delete this table." }, 403);
        const r = await deleteTable(env.DB, orgId, tableId);
        return r.error ? fail(r) : json(r);
      }
      return null;
    }
    if (sub === "rows") {
      if (!rowId && request.method === "POST") {
        const r = await addRow(env.DB, orgId, tableId, input.values, me, input.validation);
        if (r.error) return fail(r);
        await afterRowChange(env, { orgId, table: r.table, before: null, row: r.row, by: me });
        return json({ row: r.row }, 201);
      }
      if (rowId && (request.method === "PUT" || request.method === "PATCH")) {
        const r = await updateRow(env.DB, orgId, tableId, rowId, input.values, me, input.expectedUpdatedAt, input.validation);
        if (r.error) return fail(r);
        await afterRowChange(env, { orgId, table: r.table, before: r.before, row: r.row, by: me });
        return json({ row: r.row });
      }
      if (rowId && request.method === "DELETE") {
        const r = await deleteRow(env.DB, orgId, tableId, rowId, url.searchParams.get("expectedUpdatedAt") ?? undefined);
        if (r.error) return fail(r);
        await afterRowDelete(env, { orgId, table: r.table, row: r.before, by: me });
        return json({ deleted: true, before: r.before });
      }
    }
    return null;
  }

  // ── Workflows ─────────────────────────────────────────────────────────
  if (parts[0] === "workflows") {
    const [, wfId, sub, runId] = parts;
    if(wfId==='notices'&&!sub&&['GET','POST'].includes(request.method)){
      const result=await workflowNotices(env.DB,orgId,me,input,request.method==='POST');
      return result.error?fail(result):json(result);
    }
    if (wfId === 'generate' && request.method === 'POST') {
      const r = await generateWorkflow(env,request,orgId,who,input);
      if(r.response)return r.response;
      if(r.error)return fail(r);
      if(!r.replay)await audit(env, request, { orgId, action: 'workflow.created', actor: person(who.user), entity: { type: 'workflow', id: r.workflow.id, name: r.workflow.name }, details: { source: r.source } });
      return json({ ...r, workflow: { ...r.workflow, hookSecret: undefined } }, 201);
    }

    if (!wfId) {
      if (request.method === "GET") return json({ workflows: await listWorkflows(env.DB, orgId, { viewerId: me }), triggers: TRIGGERS, steps: STEP_TYPES });
      if (request.method === "POST") {
        const r = await createWorkflow(env.DB, orgId, input, me);
        if (!r.error) await audit(env, request, { orgId, action: "workflow.created", actor: person(who.user), entity: { type: "workflow", id: r.workflow.id, name: r.workflow.name } });
        return r.error ? fail(r) : json({ ...r, hookUrl: hookUrl(url, r.workflow) }, 201);
      }
      return null;
    }
    const wf = await getWorkflow(env.DB, orgId, wfId, { withSecret: true, viewerId: me });
    if (!wf) return json({ message: "No such workflow." }, 404);
    const mine = await mayChange(env, orgId, who, wf.createdBy);
    if(sub==='revisions' && request.method==='GET') {
      const before=url.searchParams.has('before')?Number(url.searchParams.get('before')):undefined;
      const result=await workflowRevisions(env.DB,orgId,wfId,me,{before});
      return result.error?fail(result):json(result);
    }
    if(sub==='rollback' && request.method==='POST'){
      if(!mine)return json({message:'Only its maker or an admin can restore this workflow.'},403);
      const result=await restoreWorkflowRevision(env.DB,orgId,wfId,me,input||{});
      if(result.error)return fail(result);
      await audit(env,request,{orgId,action:'workflow.revision_restored',actor:person(who.user),entity:{type:'workflow',id:wfId,name:result.workflow.name},details:{restoredRevision:result.restoredRevision,newRevision:result.revision,automaticTriggersEnabled:result.workflow.enabled,safetyPaused:result.safetyPaused}});
      return json({...result,hookUrl:hookUrl(url,result.workflow)});
    }
    // The hook's secret is for whoever may change the workflow.
    const shown = mine ? { ...wf, hookUrl: hookUrl(url, wf) } : { ...wf, hookSecret: undefined };
    if(sub==='budget' && request.method==='PUT'){
      if(!mine)return json({message:'Only its maker or an admin can change this workflow.'},403);
      const result=await saveWorkflowBudget(env.DB,orgId,wfId,input);
      if(result.error)return json({message:result.error},result.status);
      await audit(env,request,{orgId,action:'workflow.budget_updated',actor:person(who.user),entity:{type:'workflow',id:wfId,name:wf.name},details:{dailyLimit:input.dailyLimit,weeklyLimit:input.weeklyLimit,monthlyLimit:input.monthlyLimit,dailyAiLimitUsd:input.dailyAiLimitUsd,weeklyAiLimitUsd:input.weeklyAiLimitUsd,monthlyAiLimitUsd:input.monthlyAiLimitUsd,aiBudgetAction:input.aiBudgetAction}});
      return json(result);
    }
    if (!sub) {
      if (request.method === "GET") return json({ workflow: shown, runs: await listRuns(env.DB, orgId, wfId, 20, me), canEdit: mine,
        ...(mine && wf.trigger.type === 'webhook' ? { held: await heldWorkflowSummary(env.DB, orgId, wfId) } : {}) });
      if (!mine) return json({ message: "Only its maker or an admin can change this workflow." }, 403);
      if (request.method === "PUT") {
        const r = await updateWorkflow(env.DB, orgId, wfId, input, me);
        return r.error ? fail(r) : json({ ...r, hookUrl: hookUrl(url, r.workflow) });
      }
      if (request.method === "DELETE") {
        await audit(env, request, { orgId, action: "workflow.deleted", actor: person(who.user), entity: { type: "workflow", id: wfId, name: wf.name } });
        return json(await deleteWorkflow(env.DB, orgId, wfId));
      }
      return null;
    }
    if(sub==='source'&&['GET','POST'].includes(request.method)){
      const result=await workflowSource(env.DB,orgId,me,wfId,input||{candidates:url.searchParams.get('candidates')==='1',before:url.searchParams.get('before')},request.method==='POST');
      return result.error?fail(result):json(result);
    }
    if(sub==='resume' && request.method==='POST'){
      if(!mine)return json({message:'Only its maker or an admin can resume this workflow.'},403);
      if(wf.safety?.pause_reason?.startsWith('budget_ai_'))return json({message:'This workflow reached its estimated AI usage limit or has unpriced usage. It can run again after the rolling window resets or after you change its budget.',reason:wf.safety.pause_reason},409);
      if(wf.safety?.pause_reason?.startsWith('budget_'))return json({message:'This workflow can run again on its next trigger after the budget window resets, or as soon as you raise the limit.'},409);
      if(typeof input.generation!=='string')return json({message:'Reload the workflow before resuming it.'},400);
      if(!await resumeWorkflowSafety(env.DB,orgId,wfId,input.generation))return json({message:'The workflow state changed. Reload before resuming.'},409);
      await audit(env,request,{orgId,action:'workflow.safety_resumed',actor:person(who.user),entity:{type:'workflow',id:wfId}});
      return json({safety:await readWorkflowSafety(env.DB,orgId,wfId)});
    }
    if (sub === 'webhook' && runId === 'events' && parts[4] && request.method === 'GET') {
      if (!mine) return json({ message: 'Only its maker or an admin can inspect held input.' }, 403);
      const event = await readHeldWorkflowEvent(env.DB, orgId, wfId, parts[4]);
      return event ? json({ event }) : json({ message: 'No such held event.' }, 404);
    }
    if (sub === 'webhook' && request.method === 'POST') {
      if (!mine) return json({ message: 'Only its maker or an admin can change this workflow.' }, 403);
      if (runId === 'discard') {
        const result = await discardWorkflowEvents(env.DB, orgId, wfId, input.eventIds);
        if (result.error) return fail(result);
        await audit(env, request, { orgId, action: 'workflow.webhook_discarded', actor: person(who.user), entity: { type: 'workflow', id: wfId }, details: { count: result.discarded } });
        return json(result);
      }
      if (runId === 'replay') {
        const result = await replayWorkflowEvents(env, orgId, wf, input.eventIds, me);
        if (result.error) return fail(result);
        await audit(env, request, { orgId, action: 'workflow.webhook_replayed', actor: person(who.user), entity: { type: 'workflow', id: wfId }, details: { count: result.runs.length } });
        return json(result);
      }
      if (runId) return null;
      const r = await changeWorkflowHook(env.DB, orgId, wfId, input);
      if (r.error) return fail(r);
      await audit(env, request, { orgId, action: `workflow.webhook_${input.action === 'rotate' ? 'rotated' : 'revoked'}`, actor: person(who.user), entity: { type: 'workflow', id: wfId, name: wf.name } });
      return json({ workflow: { ...r.workflow, hookUrl: hookUrl(url, r.workflow) } });
    }
    if (sub === "run" && request.method === "POST") {
      // Pausing stops automatic triggers; an explicit manual run does not
      // enable the workflow or replay its queued webhook deliveries.
      const run = await startRun(env, { orgId, workflow: wf, trigger: "manual", input: input.input && typeof input.input === "object" ? input.input : { text: String(input.text || "") }, startedBy: me });
      if(run?.status==='paused')return json({message:run.reason?.startsWith('budget_ai_')?'This workflow reached its estimated AI usage budget or has unpriced usage. It can run again after the rolling window resets or after you change its budget.':run.reason?.startsWith('budget_')?'This workflow reached its run budget. It can run again on its next trigger after the window resets, or as soon as you raise the limit.':'This workflow paused after repeated failures. Review its history and resume it.',reason:run.reason},409);
      if (run?.status === 'skipped') return json({ message: 'This workflow is already running or waiting for approval.', reason: run.reason }, 409);
      if (!run) return json({ message: 'This automation is no longer available in its current published release.' }, 409);
      return json({ run }, 201);
    }
    if (sub === "runs" && request.method === "GET") {
      if (runId) {
        const run = await getRun(env.DB, orgId, runId, { viewerId: me });
        return run && run.workflowId === wfId ? json({ run }) : json({ message: "No such run." }, 404);
      }
      return json({ runs: await listRuns(env.DB, orgId, wfId, url.searchParams.get("limit"), me) });
    }
    return null;
  }

  // ── Follow-ups ────────────────────────────────────────────────────────
  if (parts[0] === "followups") {
    const [, fuId] = parts;
    if (!fuId && request.method === "GET") {
      if (url.searchParams.get("paged") === "1") {
        const result = await followupHistory(env.DB, orgId, { channel: url.searchParams.get("channel") || undefined, agentId: url.searchParams.get("agentId") || undefined, status: url.searchParams.get("status") || "scheduled", viewerId: me, cursor: url.searchParams.get("cursor") });
        return result.error ? json({ message: result.error }, result.status) : json(result);
      }
      return json({ followups: await listFollowups(env.DB, orgId, { channel: url.searchParams.get("channel") || undefined, agentId: url.searchParams.get("agentId") || undefined, status: url.searchParams.get("status") || "scheduled", viewerId: me }) });
    }
    if (!fuId && request.method === "POST") {
      const dueAt = input.dueAt || (Number(input.minutes) > 0 ? new Date(Date.now() + Number(input.minutes) * 60000).toISOString() : null);
      const r = await scheduleFollowup(env.DB, { orgId, channel: input.channel, threadId: input.threadId || null, agentId: input.agentId || null, instruction: input.instruction, dueAt, by: me });
      return r.error ? fail(r) : json(r, 201);
    }
    if (fuId && request.method === "DELETE") {
      const followup = await env.DB.prepare("SELECT channel FROM hx_followups WHERE org_id = ?1 AND id = ?2").bind(orgId, fuId).first();
      if (!followup || !(await mayUseConversation(env.DB, orgId, me, followup.channel))) return json({ message: "Nothing scheduled by that id." }, 404);
      const r = await cancelFollowup(env.DB, orgId, fuId);
      return r.error ? fail(r) : json(r);
    }
    return null;
  }

  // ── Approvals ─────────────────────────────────────────────────────────
  // What agents and workflows are waiting on: for me to decide, and what I
  // started that waits on someone else.
  if (parts[0] === "approvals" && request.method === "GET") {
    return json(await approvalsFor(env, orgId, who.user.login, me));
  }

  // ── Home ──────────────────────────────────────────────────────────────
  // The harness's front page in one call: what waits on me, the apps with
  // their headline number, the agents with their roles, the workflows with
  // how they last ran, and the follow-ups to come.
  if (parts[0] === "harness" && parts[1] === "home" && request.method === "GET") {
    return json(await homeFor(env, orgId, who, me));
  }

  // ── Skills ────────────────────────────────────────────────────────────
  if (parts[0] === "skills") {
    const [, skillId] = parts;
    if (skillId === 'preview-import' && parts.length === 2 && request.method === 'POST') {
      const result = previewSkillImport(input);
      return result.error ? fail(result) : json(result);
    }
    if (!skillId) {
      if (request.method === "GET") {
        const skills = await listSkills(env.DB, orgId, me);
        for (const skill of skills) skill.canEdit = (skill.canShare || await allowed(env.DB, orgId, who.session.github_id, 'harness.delete_others'));
        return json({ skills });
      }
      if (request.method === "POST") {
        const r = await createSkill(env.DB, orgId, input, me);
        return r.error ? fail(r) : json(r, 201);
      }
      return null;
    }
    const skill = await getSkill(env.DB, orgId, skillId, me);
    if (!skill) return json({ message: "No such skill." }, 404);
    if (parts[2] === 'shares') {
      if (skill.sourceScope) return json({ message: 'Only workspace custom Skills can be shared by link.' }, 409);
      if (!skill.canShare) return json({ message: 'Only its owner can create or revoke Skill share links.' }, 403);
      if (request.method === 'GET' && parts.length === 3) return json(await listSkillShares(env.DB, orgId, skillId));
      if (request.method === 'POST' && parts.length === 3) {
        const result = await createSkillShare(env.DB, orgId, skill, me, input);
        if (result.error) return fail(result);
        await audit(env, request, { orgId, action: 'skill.share_created', actor: person(who.user), entity: { type: 'skill', id: skillId, name: skill.name }, details: { shareId: result.share.id, expiresAt: result.share.expiresAt } });
        return json(result, 201);
      }
      if (request.method === 'POST' && parts.length === 5 && parts[4] === 'revoke') {
        const result = await revokeSkillShare(env.DB, orgId, skillId, parts[3]);
        if (!result.error) await audit(env, request, { orgId, action: 'skill.share_revoked', actor: person(who.user), entity: { type: 'skill', id: skillId, name: skill.name }, details: { shareId: parts[3] } });
        return result.error ? fail(result) : json(result);
      }
      return json({ message: 'Method not allowed.' }, 405);
    }
    if (parts[2] === 'files' && parts.length === 3 && request.method === 'GET') {
      const path = url.searchParams.get('path');
      if (!path) return json({ files: await listSkillFiles(env.DB,orgId,skillId,me) });
      const file = await readSkillFile(env.DB,orgId,skillId,path,me);
      if (!file) return json({message:'No such skill file.'},404);
      return new Response(file.bytes,{headers:{...CORS_HEADERS,'cache-control':'private, no-store','content-type':'application/octet-stream','x-content-type-options':'nosniff','content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.path.split('/').pop())}`}});
    }
    if (parts[2] === 'export' && parts.length === 3 && request.method === 'GET') {
      if (!skill.description.trim()) return json({ message: 'Add a description before exporting SKILL.md.' }, 400);
      if (url.searchParams.get('format') === 'zip') {
        const files = await listSkillFiles(env.DB,orgId,skillId,me);
        const entries = [{path:'SKILL.md',bytes:new TextEncoder().encode(skillMarkdown(skill))}];
        for (const file of files || []) {
          const stored=await readSkillFile(env.DB,orgId,skillId,file.path,me);
          if(!stored)return json({message:'Skill files changed. Retry the export.'},409);
          entries.push(stored);
        }
        const result=writeSkillZip(entries);
        if(result.error)return fail(result);
        return new Response(result.bytes,{headers:{...CORS_HEADERS,'content-type':'application/zip','content-disposition':'attachment; filename="skill.zip"','cache-control':'private, no-store','x-content-type-options':'nosniff'}});
      }
      return json({ filename: 'SKILL.md', markdown: skillMarkdown(skill) });
    }
    if (parts[2] === 'access' && request.method === 'PUT') {
      const r = await setSkillAccess(env.DB, orgId, skillId, me, input);
      return r.error ? fail(r) : json(r);
    }
    if (request.method === "GET") return json({ skill });
    if (!(skill.canShare || await allowed(env.DB, orgId, who.session.github_id, 'harness.delete_others'))) return json({ message: "Only its owner or an admin can change this skill." }, 403);
    if (request.method === "PUT") {
      const r = await updateSkill(env.DB, orgId, skillId, input, me);
      return r.error ? fail(r) : json(r);
    }
    if (request.method === "DELETE") {
      const r = await deleteSkill(env.DB, orgId, skillId, me);
      return r.error ? fail(r) : json(r);
    }
    return null;
  }

  // ── Agents as members ─────────────────────────────────────────────────
  if (parts[0] === "hx" && parts[1] === "agents" && parts[2]) {
    const agentId = parts[2];
    const sub = parts[3];
    const agent = await env.DB
      .prepare("SELECT id, owner_login, scope FROM custom_agents WHERE org_id = ?1 AND id = ?2 AND deleted_at IS NULL")
      .bind(orgId, agentId)
      .first();
    // Someone else's personal agent is theirs alone: it is not here at all.
    if (!agent || (agent.scope === "personal" && agent.owner_login !== who.user.login)) return json({ message: "No such agent." }, 404);
    if (sub === 'access-request' && request.method === 'POST') {
      if (agent.scope !== 'team') return json({ message: 'No such shared team agent.' }, 404);
      const result = await createAgentAccessRequest(env.DB, orgId, { agentId, requesterId: me, requestKey: input.requestKey });
      if (result.error) return fail(result);
      if (result.created) {
        const cards=result.cards||[result.card];
        await announceCards(env, orgId, cards);
        if (anyChannelConfigured(env)) await Promise.all(cards.map(card=>notifyCard(env, { card, kind: 'created', excludeLogin: null, orgId }).catch(() => {})));
        await audit(env, request, { orgId, action: 'agent.access_requested', actor: person(who.user), entity: { type: 'custom_agent', id: agentId, name: agent.name }, details: { requestId: result.request.id } });
      }
      return json({ request: result.request }, result.created ? 201 : 200);
    }
    if (!(await mayAccessAgent(env.DB, orgId, { ...agent, ownerLogin: agent.owner_login }, who.user.login))) return json({ message: "No such agent." }, 404);
    const delegatedRole=(await explicitAgentRoles(env.DB,orgId,[agentId],who.user.login)).get(agentId);
    const managedProfile=!!await env.DB.prepare('SELECT 1 FROM hx_agent_profiles WHERE org_id=?1 AND agent_id=?2').bind(orgId,agentId).first();
    const canEdit = agent.owner_login === who.user.login || delegatedRole==='admin' || (!managedProfile&&await allowed(env.DB, orgId, me, "agent.manage_others"));
    // Anyone who may talk to it may add a private grant for their own app
    // connection. Agent-wide settings remain its maker's or an admin's.
    if (!read && !canEdit && sub !== 'members' && sub !== 'apps' && !(sub === "memory" && request.method === "POST")) return json({ message: "Only the agent's maker or an admin can change it." }, 403);
    if (sub === 'ownership' && request.method==='PUT') {
      const people=await memoryMembers(env.DB,orgId,me);
      const target=people.find(p=>p.ref===input.ref);
      if(!target)return json({message:'No such workspace member.'},404);
      const r=await transferAgentOwnership(env.DB,orgId,agentId,{actorId:me,targetId:target.userId,expectedVersion:input.expectedVersion});
      if(!r.error){
        await announceAgentAccessChanged(env,orgId,agentId,[who.user.login,target.login]);
        await audit(env,request,{orgId,action:'agent.ownership_transferred',actor:person(who.user),entity:{type:'custom_agent',id:agentId},details:{memberRef:target.ref,version:r.version}});
      }
      return r.error?fail(r):json(r);
    }
    if (sub === 'members') {
      const state=await agentRoleState(env.DB,orgId,agentId);
      if (!state) return json({message:'No such agent.'},404);
      const people=await memoryMembers(env.DB,orgId,me);
      const canManage=state.members.some(m=>m.userId===String(me)&&m.role==='admin');
      const canAddMembers=canManage||state.members.some(m=>m.userId===String(me)&&m.role==='member');
      if (request.method==='GET') {
        const shown=state.members.flatMap(m=>{const person=people.find(p=>p.userId===m.userId);return person?[{ref:person.ref,name:person.name,role:m.role,owner:!!m.owner,mine:m.userId===String(me)}]:[]});
        return json({version:state.version,scope:state.scope,canManage,canAddMembers,members:shown,candidates:canAddMembers?people.filter(p=>p.role!=='guest').map(p=>({ref:p.ref,name:p.name})):[]});
      }
      if (request.method==='PUT') {
        if (!canAddMembers) return json({message:'Only an agent member can manage assigned members.'},403);
        const target=people.find(p=>p.ref===input.ref);
        if (!target) return json({message:'No such workspace member.'},404);
        const r=await setAgentRole(env.DB,orgId,agentId,{actorId:me,targetId:target.userId,role:input.role,expectedVersion:input.expectedVersion});
        if (!r.error) {
          await announceAgentAccessChanged(env,orgId,agentId,[who.user.login,target.login]);
          await audit(env,request,{orgId,action:'agent.member_role_changed',actor:person(who.user),entity:{type:'custom_agent',id:agentId},details:{memberRef:target.ref,role:input.role,version:r.version}});
        }
        return r.error?fail(r):json(r);
      }
    }
    if (sub === 'apps') {
      if (await getMode(env.DB, orgId) !== 'harness') return json({ message: 'Agent app permissions are available in Harness mode.' }, 404);
      if (request.method === 'GET') {
        const [connections, nativeConnections, remoteMcpConnections] = await Promise.all([
          agentAppConnections(env.DB, { orgId, agentId, githubId: me }),
          agentSourceConnections(env, { orgId, agentId, session: who.session }),
          agentRemoteMcpConnections(env.DB, { orgId, agentId, githubId: me }),
        ]);
        return json({ connections, nativeConnections: nativeConnections.connections, remoteMcpConnections });
      }
      if (request.method === 'POST' || request.method === 'DELETE') {
        const source = String(input?.source || url.searchParams.get('source') || '');
        if (source) {
          const granted = request.method === 'POST';
          const result = await setAgentSourceConnection(env, { orgId, agentId, session: who.session, source, enabled: granted });
          if (result.error) return json({ message: result.error }, result.status || 400);
          await announceAgentAccessChanged(env, orgId, agentId, [who.user.login]);
          await audit(env, request, {
            orgId,
            action: granted ? 'agent.native_connection_granted' : 'agent.native_connection_revoked',
            actor: person(who.user),
            entity: { type: 'custom_agent', id: agentId },
            details: { source },
          });
          return json({
            connections: await agentAppConnections(env.DB, { orgId, agentId, githubId: me }),
            nativeConnections: result.connections,
            remoteMcpConnections: await agentRemoteMcpConnections(env.DB, { orgId, agentId, githubId: me }),
          });
        }
        const remoteMcpServerId = String(input?.remoteMcpServerId || url.searchParams.get('remoteMcpServerId') || '');
        if (remoteMcpServerId) {
          const granted = request.method === 'POST';
          const result = await setAgentRemoteMcpConnection(env, { orgId, agentId, session: who.session, serverId: remoteMcpServerId, enabled: granted });
          if (result.error) return json({ message: result.error }, result.status || 400);
          await announceAgentAccessChanged(env, orgId, agentId, [who.user.login]);
          await audit(env, request, {
            orgId,
            action: granted ? 'agent.remote_mcp_granted' : 'agent.remote_mcp_revoked',
            actor: person(who.user),
            entity: { type: 'custom_agent', id: agentId },
            details: { serverId: remoteMcpServerId },
          });
          return json({
            connections: await agentAppConnections(env.DB, { orgId, agentId, githubId: me }),
            nativeConnections: (await agentSourceConnections(env, { orgId, agentId, session: who.session })).connections,
            remoteMcpConnections: result.connections,
          });
        }
        const server = String(input?.server || url.searchParams.get('server') || '');
        const granted = request.method === 'POST';
        const result = await setAgentAppGrant(env.DB, { orgId, agentId, githubId: me, server, granted });
        if (result.error) return json({ message: result.error }, result.status || 400);
        await audit(env, request, {
          orgId,
          action: granted ? 'agent.connection_granted' : 'agent.connection_revoked',
          actor: person(who.user),
          entity: { type: 'custom_agent', id: agentId },
          details: { app: server },
        });
        return json({
          connections: result.connections,
          nativeConnections: (await agentSourceConnections(env, { orgId, agentId, session: who.session })).connections,
          remoteMcpConnections: await agentRemoteMcpConnections(env.DB, { orgId, agentId, githubId: me }),
        });
      }
      return json({ message: 'Method not allowed.' }, 405);
    }
    if (sub === "profile") {
      if (request.method === "GET") return json({ profile: await getProfile(env.DB, orgId, agentId), tiers: TIERS, access: ACCESS, canEdit });
      if (request.method === "PUT") {
        const accessFieldsChanged=input.access!==undefined||input.people!==undefined;
        const previousAccess=accessFieldsChanged?await getProfile(env.DB,orgId,agentId):null;
        const r = await saveProfile(env.DB, orgId, agentId, input, me);
        if (!r.error) {
          if(previousAccess&&(previousAccess.access!==r.profile.access||JSON.stringify(previousAccess.people)!==JSON.stringify(r.profile.people))){
            const affected=[...previousAccess.people,...r.profile.people,who.user.login];
            if(previousAccess.access==='everyone'||r.profile.access==='everyone')affected.push(...(await memoryMembers(env.DB,orgId,me)).map(member=>member.login));
            await announceAgentAccessChanged(env,orgId,agentId,affected);
          }
          await audit(env, request, { orgId, action: "agent.profile_changed", actor: person(who.user), entity: { type: "agent", id: agentId }, details: { tier: r.profile.tier, access: r.profile.access, mentionOnly: r.profile.mentionOnly } });
        }
        return r.error ? fail(r) : json({ ...r, canEdit });
      }
    }
    if (sub === "memory") {
      if (parts[4] === "scopes" && request.method === "GET") {
        const members = await memoryMembers(env.DB, orgId, me);
        const { results } = await env.DB.prepare(`SELECT channel FROM (SELECT s.channel FROM hx_memory_scopes s JOIN hx_agent_memories m ON m.id = s.memory_id AND m.org_id=s.org_id WHERE s.org_id=?1 AND m.agent_id=?2 UNION SELECT channel FROM hx_memory_review_audit WHERE org_id=?1 AND agent_id=?2) WHERE channel != '' ORDER BY channel LIMIT 200`).bind(orgId, agentId).all();
        const scopes = [];
        for (const entry of results || []) {
          const view = viewOf(entry.channel, who.user.login, members);
          if (!view) continue;
          const room = await resolveChannel(env.DB, orgId, who.user, view, members);
          if (!room || room.key !== entry.channel) continue;
          let label = room.agent?.name || room.other?.name || room.others?.map(m => m.name).join(', ') || room.slug;
          if (room.kind === "business") {
            const business = await env.DB.prepare("SELECT name FROM businesses WHERE org_id = ?1 AND slug = ?2").bind(orgId, room.slug).first();
            if (!business) continue;
            label = business.name;
          }
          scopes.push({ channel: view, label: label || view });
        }
        return json({ scopes });
      }
      const requestedChannel = read ? url.searchParams.get("channel") : input.channel;
      let channel = "";
      if (requestedChannel) {
        const room = await resolveChannel(env.DB, orgId, who.user, requestedChannel);
        if (!room) return json({ message: "No such conversation." }, 404);
        channel = room.key;
      }
      const context = { channel };
      if (request.method === 'GET' && (parts[5] === 'reviews' || parts[4] === 'reviews')) {
        const r = await memoryReviewHistory(env.DB, orgId, agentId, parts[4] === 'reviews' ? null : parts[4], { ...context, cursor: url.searchParams.get('cursor') });
        return r.error ? fail(r) : json(r);
      }
      if (request.method === "GET") {
        if (url.searchParams.get('paged') === '1') {
          const result = await memoryPage(env.DB, orgId, agentId, { ...context, cursor: url.searchParams.get('cursor'), query: url.searchParams.get('query') || '', kind: url.searchParams.get('kind') || 'all' });
          return result.error ? fail(result) : json({ ...result, canEdit });
        }
        return json({ memories: await listAgentMemories(env.DB, orgId, agentId, context), canEdit });
      }
      if (request.method === 'POST' && parts[5] === 'to-skill') {
        if (!canEdit) return json({message:"Only the agent's maker or an admin can convert its memory."},403);
        const r=await convertMemoryToSkill(env.DB,orgId,agentId,parts[4],input,{channel,by:me});
        if (!r.error && !r.replayed) await audit(env,request,{orgId,action:'agent.memory_converted',actor:person(who.user),entity:{type:'custom_agent',id:agentId},details:{memoryId:parts[4],skillId:r.skill.id,version:input.expectedVersion,keptMemory:r.keptMemory,scope:channel?'conversation':'shared'}});
        return r.error?fail(r):json(r,r.replayed?200:201);
      }
      if (request.method === "POST") {
        const r = await addAgentMemory(env.DB, orgId, agentId, input.body !== undefined ? { title: input.title, description: input.description, body: input.body } : input.text, { by: me, channel, kind: input.kind || "context" });
        if (!r.error && !r.duplicate) await audit(env, request, { orgId, action: "agent.memory_created", actor: person(who.user), entity: { type: "custom_agent", id: agentId }, details: { memoryId: r.memory.id, kind: r.memory.kind, version: r.memory.version, scope: channel ? "conversation" : "shared" } });
        return r.error ? fail(r) : json(r, 201);
      }
      if (request.method === "PUT" && parts[5] === 'review') {
        const r = await reviewMemoryEntry(env.DB, orgId, agentId, parts[4], input, { channel, by: me });
        if (!r.error) await audit(env, request, { orgId, action: 'agent.memory_reviewed', actor: person(who.user), entity: { type: 'custom_agent', id: agentId }, details: { memoryId: parts[4], version: r.review.version, verdict: input.verdict || 'keep', scope: channel ? 'conversation' : 'shared' } });
        return r.error ? fail(r) : json(r);
      }
      if (request.method === "PUT") {
        const r = await updateMemoryEntry(env.DB, orgId, agentId, parts[4] || input.id || "", input, { channel, by: me });
        if (!r.error) await audit(env, request, { orgId, action: "agent.memory_updated", actor: person(who.user), entity: { type: "custom_agent", id: agentId }, details: { memoryId: r.memory.id, kind: r.memory.kind, version: r.memory.version, scope: channel ? "conversation" : "shared" } });
        return r.error ? fail(r) : json(r);
      }
      if (request.method === "DELETE") {
        if (!canEdit) return json({ message: "Only the agent's maker or an admin can make it forget." }, 403);
        const id = parts[4] || url.searchParams.get("id") || "";
        const r = await deleteAgentMemory(env.DB, orgId, agentId, id, context);
        if (r.deleted) await audit(env, request, { orgId, action: "agent.memory_deleted", actor: person(who.user), entity: { type: "custom_agent", id: agentId }, details: { memoryId: id, count: r.deleted, scope: channel ? "conversation" : "shared" } });
        return json(r);
      }
    }
    if (sub === "skills") {
      if (request.method === "GET") return json({ skills: await skillsOf(env.DB, orgId, agentId, me) });
      if (request.method === "POST") {
        const r = await giveSkill(env.DB, orgId, agentId, input.skillId, me);
        return r.error ? fail(r) : json(r);
      }
      if (request.method === "DELETE") {
        if (!canEdit) return json({ message: "Only the agent's maker or an admin can change it." }, 403);
        const id = parts[4] || url.searchParams.get("skillId") || "";
        if (!(await getSkill(env.DB, orgId, id, me))) return json({ message: 'No such skill.' }, 404);
        return json(await takeSkill(env.DB, orgId, agentId, id));
      }
    }
    return null;
  }

  // ── Apps ──────────────────────────────────────────────────────────────
  if (parts[0] === "apps" || url.pathname === "/app-generation-v2") {
    const [, appId, sub] = parts;
    if (appId === "templates" && request.method === "GET") return json({ templates: templateList() });
    if ((appId === "generate" || url.pathname === "/app-generation-v2") && request.method === "POST") {
      const r = await generateApp(env, request, orgId, who, input);
      if (r.response) return r.response;
      if (r.error) return r.code ? json({message:r.error,code:r.code},r.status || 400) : fail(r);
      if (!r.replay) await audit(env, request, { orgId, action: "app.created", actor: person(who.user), entity: { type: "app", id: r.app.id, name: r.app.name }, details: { source: r.source } });
      return json(r, r.replay ? 200 : 201);
    }
    if (url.pathname === "/app-generation-v2") return json({message:'Method not allowed.'},405);
    if (!appId) {
      if (request.method === "GET") {
        const requested = url.searchParams.get('channel');
        const room = requested ? await readableConversation(env.DB, orgId, me, requested) : null;
        if (requested && !room) return json({ message: 'No such room.' }, 404);
        const apps = await visibleResources(await listApps(env.DB, orgId, { channel: room?.key }), a => mayUseApp(env.DB, orgId, a.id, me));
        return json({ apps: await visibleAppLinks(env.DB, orgId, apps, who.user) });
      }
      if (request.method === "POST") {
        let privateByDefault = Boolean(input.privateByDefault);
        let channel = input.channel;
        let channelCreatedAt = null;
        let channelPrivateAt = null;
        if (channel && !input.sourceThreadId) {
          const room = await readableConversation(env.DB, orgId, me, channel);
          if (!room) return json({ message: 'No such room.' }, 404);
          channel = room.key;
          privateByDefault ||= room.kind !== 'business' || Boolean(room.private);
          if(room.kind==='business') {channelCreatedAt=room.deliveryBoundary?.businessCreatedAt||null;channelPrivateAt=Boolean(room.private);}
        }
        const r = input.template
          ? await createFromTemplate(env.DB, { orgId, by: me, template: input.template, name: input.name, tableName: input.tableName, channel, sourceThreadId:input.sourceThreadId, withSample: input.sample !== false, privateByDefault, channelCreatedAt, channelPrivateAt })
          : await createApp(env.DB, { ...input, orgId, by: me, channel, privateByDefault, channelCreatedAt, channelPrivateAt });
        if (r.error) return fail(r);
        await audit(env, request, { orgId, action: "app.created", actor: person(who.user), entity: { type: "app", id: r.app.id, name: r.app.name } });
        return json(r, 201);
      }
      return null;
    }
    if (['conversation-source','conversation-notifications'].includes(sub) && parts.length === 3) {
      if(!['GET','POST'].includes(request.method))return json({message:'Method not allowed.'},405);
      const r=sub==='conversation-source'
        ? await conversationSource(env.DB,orgId,who.user,appId,input,request.method==='POST')
        : await appNotifications(env.DB,orgId,me,appId,input,request.method==='POST');
      if(!r.error&&sub==='conversation-source'&&request.method==='POST')await audit(env,request,{orgId,action:'app.conversation_inherited',actor:person(who.user),entity:{type:'app',id:appId},details:{threadId:input.messageId}});
      if(!r.error&&sub==='conversation-notifications'&&request.method==='POST')await announceTo(env,orgId,[{to:who.user.login,event:appActivityEvent('reads_changed',{items:[`a:${input.messageId}`],threads:[]})}]);
      return r.error?fail(r):json(r);
    }
    if (sub === 'conversation' && parts.length === 3) {
      if (!['GET','POST'].includes(request.method)) return json({message:'Method not allowed.'},405);
      const query=request.method==='GET'?Object.fromEntries(url.searchParams):input;
      const annotation=request.method==='POST'?normalizeAppAnnotation(input.annotation):null;
      if(annotation?.error)return fail(annotation);
      if(annotation&&query.rowId)return json({message:'Annotations are only available in app conversations.'},400);
      // Validate both app and record before looking up any source thread.
      const access=await appConversation(env.DB,orgId,me,appId,query);
      if(access.error)return fail(access);
      const source=!query.rowId?await sourceFor(env.DB,orgId,who.user,appId):null;
      if(source?.error)return fail(source);
      if(request.method==='POST'&&source){
        if(typeof input.body!=='string'||!input.body.trim()||input.body.length>4000||typeof input.requestId!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestId))return json({message:'Invalid message.'},400);
        if(!context.dispatch)return json({message:'Conversation routing unavailable.'},503);
        const members=await memoryMembers(env.DB,orgId,me);
        const channel=viewOf(source.channel,who.user.login,members);
        const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([appId,source.threadId,input.requestId])));
        const clientId='tmp-'+Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
        const forwarded=await context.dispatch(new Request(new URL('/channels/messages',url.origin),{method:'POST',headers:request.headers,body:JSON.stringify({orgId,channel,parentId:source.threadId,body:input.body,clientId})}));
        if(!forwarded.ok)return forwarded;
        const sent=await forwarded.json();
        if(sent.message?.body!==input.body.replace(/\r\n/g,'\n').trim())return json({message:'Request ID was already used for a different message.'},409);
        const marker=await saveAppAnnotation(env.DB,{orgId,appId,tableId:input.tableId||'',rowId:input.rowId||'',messageSource:'channel',messageId:sent.message.id,authorId:me,annotation});
        if(marker.error)return fail(marker);
        return json({threadId:source.threadId,source:true,...(marker.annotationId?{annotationId:marker.annotationId}:{})});
      }
      if(request.method==='GET'){
        const {results:aiReplies}=await env.DB.prepare(`SELECT r.message_id AS messageId,CASE WHEN r.status='running' AND r.started_at<unixepoch()-120 THEN 'failed' ELSE r.status END AS status,CASE WHEN r.status='running' AND r.started_at<unixepoch()-120 THEN 'AIの応答待ちが終了しました。再度質問してください。' ELSE r.error END AS error FROM hx_app_ai_replies r JOIN hx_app_messages m ON m.sequence=r.message_id WHERE m.org_id=? AND m.app_id=? AND m.table_id=? AND m.row_id=? ORDER BY m.sequence DESC LIMIT 10`).bind(orgId,appId,query.tableId||'',query.rowId||'').all();
        const annotations=await listAppAnnotations(env.DB,orgId,appId,query);
        return json({...access,source:source?await sourceHistory(env.DB,orgId,who.user,source):null,aiReplies,annotations});
      }
      const r=await appConversation(env.DB,orgId,me,appId,input,true);
      if(r.error)return fail(r);
      const marker=await saveAppAnnotation(env.DB,{orgId,appId,tableId:input.tableId||'',rowId:input.rowId||'',messageSource:'app',messageId:r.messageId,authorId:me,annotation});
      if(marker.error)return fail(marker);
      await notifyAppMentions(env.DB,orgId,who.user,appId,input,r.messageId,env);
      if(asksAppAI(input.body)){
        const work=()=>replyToApp(env,orgId,who.user,appId,input,r.messageId,env);
        if(context.after)context.after(work);else await work();
      }
      return json({...r,...(marker.annotationId?{annotationId:marker.annotationId}:{})});
    }
    const app = await getApp(env.DB, orgId, appId);
    if (!app || !(await mayUseApp(env.DB, orgId, appId, me))) return json({ message: "No such app." }, 404);
    const withAppRoomGuidelines=prompt=>withAppRoomGuidelinesRequest(env.DB,orgId,who.user,appId,prompt);
    if (['database','actions','connections'].includes(sub)) {
      const canManage = await mayChange(env, orgId, who, app.createdBy);
      const respond = async (result, action) => {
        if (!result.error && action) await audit(env, request, { orgId, action, actor: person(who.user), entity: { type: 'app', id: appId }, details: { version: result.version ?? null, name: typeof input?.name === 'string' ? input.name : null, ...(result.merged?{forkId:result.forkId,checksum:result.checksum,changed:result.changed??null,replay:Boolean(result.replay)}:{}) } });
        return result.error ? fail(result) : json(result);
      };
      if (sub === 'database') {
        if (request.method === 'GET') return json({ ...(await databaseView(env.DB, orgId, app)), ...(await readFork(env.DB, orgId, appId, me)) });
        if (request.method !== 'POST') return json({ message: 'Method not allowed.' },405);
        if (!canManage) return json({ message: 'Only its maker or an admin can develop this app.' },403);
        if (input.action === 'generate') return respond(await generateMigration(await withAppRoomGuidelines(input.prompt), await databaseView(env.DB, orgId, app), await completer(env, orgId, me, 'app_database_generate', { maxTokens: 4000 })));
        if (input.action === 'preview') return respond(await previewMigration(env.DB, orgId, app, input));
        if (input.action === 'migrate') return respond(await applyMigration(env.DB, orgId, app, input, me), 'app.database_migrated');
        if (input.action === 'fork') return respond(await forkDatabase(env.DB, orgId, app, me), 'app.database_forked');
        if (input.action === 'merge_preview') { const result=await previewMerge(env.DB,orgId,app,me,input); const {snapshots,...review}=result; return respond(review); }
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
        if (input.action === 'fork_write') return respond(await mutateFork(env.DB, orgId, appId, me, input), 'app.preview_changed');
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
        if(input.action==='generate')return respond(await generateAction(await withAppRoomGuidelines(input.prompt),await completer(env,orgId,me,'app_action_generate',{maxTokens:6000})));
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
        const complete=input.useModel===false?null:await completer(env,orgId,me,'app_automation_generate',{maxTokens:2400});
        const result=await appAutomationFromPrompt(env.DB,orgId,me,{prompt:await withAppRoomGuidelines(input.prompt),timezone:input.timezone,complete,tables,agents:visibleAgents,appRecords});
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
        const complete = await completer(env, orgId, me, 'custom_app_generate', { maxTokens: 8000 });
        const capabilities = { entities: (await databaseView(env.DB,orgId,app)).entities, actions: (await actions(env.DB,orgId,appId)).actions.filter(a=>a.published).map(a=>({name:a.name,code:a.published})), connections:(await connections(env.DB,orgId,appId,me)).connections.map(c=>({name:c.name,endpoint:c.endpoint,method:c.method,enabled:c.enabled})), gateways:(await env.DB.prepare('SELECT id,name FROM hx_gateways WHERE org_id=?1 AND revoked_at IS NULL').bind(orgId).all()).results };
        const result = await generateCustomSource(await withAppRoomGuidelines(input.prompt), table, complete, capabilities);
        return result.error ? fail(result) : json(result);
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
        return json({ ...r, app: visibleApp, canCustomize: await mayChange(env, orgId, who, app.createdBy) });
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
  const cards = pending.filter((c) => c.workflowApproval || c.proxyAction || c.proposal || c.agentAccessRequest || String(c.senderUserID || "").startsWith("agent:"));
  const { results: waiting } = await env.DB
    .prepare(`SELECT r.id, r.workflow_id, r.card_id, r.started_at, w.name FROM hx_workflow_runs r JOIN hx_workflows w ON w.id = r.workflow_id
      WHERE r.org_id = ?1 AND r.status = 'waiting' AND (r.started_by = ?2 OR w.created_by = ?2) ORDER BY r.started_at DESC LIMIT 100`)
    .bind(orgId, String(me))
    .all();
  return {
    pendingDecisions: pending.length,
    toDecide: cards.map((c) => ({ id: c.id, title: c.title, summary: c.summary, createdAt: c.createdAt, kind: c.workflowApproval ? "workflow" : c.agentAccessRequest ? "access" : c.proxyAction ? "agent" : c.proposal ? "proposal" : "agent", source: c.sourceDetail || c.sourceApp || null })),
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
  const apps = await Promise.all(appRows.slice(0, 12).map(async (a) => {
    const r = await renderApp(db, orgId, a.id).catch(() => null);
    const metrics = r?.views.find((v) => v.type === "metrics");
    const first = metrics?.values?.[0] || null;
    return { id: a.id, name: a.name, icon: a.icon, description: a.description, channels: a.channels || [], rows: r?.rows.length ?? 0, headline: first ? { label: first.label, value: first.value } : null };
  }));
  const profiles = await profilesFor(db, orgId, agents.map((a) => a.id));
  // Newest first: the first seen for a workflow is how it last ran.
  const { results: runs } = workflows.length
    ? await db.prepare("SELECT workflow_id, status, started_at FROM hx_workflow_runs WHERE org_id = ?1 ORDER BY started_at DESC LIMIT 500").bind(orgId).all()
    : { results: [] };
  const lastOf = new Map();
  for (const r of runs || []) if (!lastOf.has(r.workflow_id)) lastOf.set(r.workflow_id, { status: r.status, startedAt: r.started_at });
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
