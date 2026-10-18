import { appConversation } from './appConversations.js';
import { personalViews } from './personalViews.js';
import { appPins, setAppPin } from './appPins.js';
import { previewMerge, mergeFork } from './appMerge.js';
import { databaseView, applyMigration, generateMigration, forkDatabase, readFork, mutateFork } from './appDatabase.js';
import { actions, generateAction, saveAction, runAction, readActionJob, connections, saveConnection, invokeConnection } from './appCapabilities.js';
import { generateCustomSource, saveCustomRelease } from "./customApps.js";
import { handleGateways, isGatewayNodeRoute } from './gateways.js';
import { setSkillAccess } from './skillAccess.js';
import { tableContract } from "./tableContract.js";
import { appAccess, mayUseApp, mayUseTable, setAppAccess, visibleResources } from './resourceAccess.js';
import { mayUseConversation } from './conversationAccess.js';
import { listMembers as memoryMembers } from '../team.js';
// The harness routes (docs/kylon-gap-plan.md): the workspace's mode, Tables
// and Apps. Every route asks for a member who is not a guest; building is a
// member's, deleting someone else's is an admin's.

import { caller } from "../channelRoutes.js";
import { allowed } from "../permissions.js";
import { audit, person } from "../audit.js";
import { enforce } from "../ratelimit.js";
import { getMode, setMode, MODES } from "./mode.js";
import {
  listTables, getTable, createTable, updateTable, deleteTable,
  listRows, addRow, updateRow, deleteRow,
} from "./tables.js";
import {
  listApps, getApp, createApp, createFromTemplate, updateApp, deleteApp,
  linkApp, unlinkApp, listVersions, restoreVersion, renderApp, specFromPrompt,
} from "./apps.js";
import { templateList } from "./templates.js";
import { getProfile, saveProfile, listAgentMemories, addAgentMemory, deleteAgentMemory, TIERS, ACCESS } from "./agents.js";
import { listSkills, createSkill, updateSkill, deleteSkill, getSkill, giveSkill, takeSkill, skillsOf } from "./skills.js";
import { workflowFromPrompt } from './workflowGeneration.js';
import { completer } from "./model.js";
import { listWorkflows, getWorkflow, createWorkflow, updateWorkflow, deleteWorkflow, listRuns, getRun, startRun, TRIGGERS, STEP_TYPES } from "./workflows.js";
import { listFollowups, scheduleFollowup, cancelFollowup } from "./followups.js";
import { onRowChange } from "./workflows.js";
import { profilesFor, mayAccessAgent } from "./agents.js";
import { listAgents } from "../customAgents.js";
import { resolveChannel, viewOf } from "../channels.js";
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
const OURS = /^\/(orgs\/mode|tables|apps|skills|gateways|hx|workflows|followups|approvals|harness\/home)(\/|$)/;

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

export async function handleHarness(request, env, url) {
  if (!OURS.test(url.pathname)) return null;
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const limited = await enforce(env, request, isGatewayNodeRoute(url.pathname) ? "gateway/edge" : "team");
  if (limited) return limited;

  const read = request.method === "GET" || request.method === "DELETE";
  const input = read ? null : await body(request);
  if (!read && !input) return json({ message: "Invalid JSON body." }, 400);
  const orgId = read ? url.searchParams.get("orgId") : input.orgId;
  const parts = url.pathname.split("/").filter(Boolean);

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
    return json({ orgId, mode: await getMode(env.DB, orgId), modes: MODES, canEdit });
  }

  const who = await member(env, request, orgId);
  if (who.denied) return who.denied;
  const me = who.session.github_id;
  if (url.pathname === '/hx/app-pins') {
    if (request.method === 'GET') return json(await appPins(env.DB,orgId,me));
    if (request.method === 'PUT') { const r=await setAppPin(env.DB,orgId,me,input.appId,input.pinned); return r.error ? fail(r) : json(r); }
    return json({message:'Method not allowed.'},405);
  }
  if (parts[0] === 'hx' && parts[1] === 'personal-views' && parts.length === 3) {
    if (!['GET','PUT'].includes(request.method)) return json({message:'Method not allowed.'},405);
    const r = await personalViews(env.DB,orgId,me,parts[2],request.method === 'PUT' ? input : undefined);
    return r.error ? fail(r) : json(r);
  }
  if (!read && !(await allowed(env.DB, orgId, me, "harness.build"))) return json({ message: "You cannot build in this workspace." }, 403);

  if (url.pathname === "/hx/rooms/guidelines") {
    const channel = read ? url.searchParams.get("channel") : input.channel;
    const room = await resolveChannel(env.DB, orgId, who.user, channel);
    if (!room || room.kind !== "business") return json({ message: "No such room." }, 404);
    const exists = await env.DB.prepare("SELECT 1 FROM businesses WHERE org_id = ?1 AND slug = ?2").bind(orgId, room.slug).first();
    if (!exists) return json({ message: "No such room." }, 404);
    if (request.method === "GET") return json({ guidelines: await getGuidelines(env.DB, orgId, room.key), maxLength: MAX_GUIDELINES });
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
        return r.error ? fail(r) : json(r);
      }
    }
    return null;
  }

  // ── Workflows ─────────────────────────────────────────────────────────
  if (parts[0] === "workflows") {
    const [, wfId, sub, runId] = parts;
    if (wfId === 'generate' && request.method === 'POST') {
      let generationRoom = null;
      if (input.channel) {
        generationRoom = await resolveChannel(env.DB, orgId, who.user, input.channel);
        if (!generationRoom || !(await mayUseConversation(env.DB, orgId, me, generationRoom.key))) return json({ message: 'No such room.' }, 403);
        input.channel = generationRoom.key;
      }
      const tables = await visibleResources(await listTables(env.DB, orgId), t => mayUseTable(env.DB, orgId, t.id, me));
      const agents = await listAgents(env.DB, orgId, who.user.login);
      const visibleAgents = [];
      for (const agent of agents) if (await mayAccessAgent(env.DB, orgId, agent, who.user.login)) visibleAgents.push({ id: agent.id, name: agent.name });
      const complete = input.useModel === false ? null : await completer(env, orgId, me, 'workflow_generate', { maxTokens: 2400 });
      const made = await workflowFromPrompt(env.DB, orgId, me, { ...input, complete, tables, agents: visibleAgents });
      if (made.error) return fail(made);
      const r = await createWorkflow(env.DB, orgId, made.workflow, me);
      if (r.error) return fail(r);
      await audit(env, request, { orgId, action: 'workflow.created', actor: person(who.user), entity: { type: 'workflow', id: r.workflow.id, name: r.workflow.name }, details: { source: made.source } });
      return json({ workflow: { ...r.workflow, hookSecret: undefined }, source: made.source }, 201);
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
    // The hook's secret is for whoever may change the workflow.
    const shown = mine ? { ...wf, hookUrl: hookUrl(url, wf) } : { ...wf, hookSecret: undefined };
    if (!sub) {
      if (request.method === "GET") return json({ workflow: shown, runs: await listRuns(env.DB, orgId, wfId, 20, me), canEdit: mine });
      if (!mine) return json({ message: "Only its maker or an admin can change this workflow." }, 403);
      if (request.method === "PUT") {
        const r = await updateWorkflow(env.DB, orgId, wfId, input);
        return r.error ? fail(r) : json({ ...r, hookUrl: hookUrl(url, r.workflow) });
      }
      if (request.method === "DELETE") {
        await audit(env, request, { orgId, action: "workflow.deleted", actor: person(who.user), entity: { type: "workflow", id: wfId, name: wf.name } });
        return json(await deleteWorkflow(env.DB, orgId, wfId));
      }
      return null;
    }
    if (sub === "run" && request.method === "POST") {
      if (!wf.enabled) return json({ message: "This workflow is off." }, 409);
      const run = await startRun(env, { orgId, workflow: wf, trigger: "manual", input: input.input && typeof input.input === "object" ? input.input : { text: String(input.text || "") }, startedBy: me });
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
      return json({ followups: await listFollowups(env.DB, orgId, { channel: url.searchParams.get("channel") || undefined, status: url.searchParams.get("status") || "scheduled", viewerId: me }) });
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
    if (!skillId) {
      if (request.method === "GET") {
        const skills = await listSkills(env.DB, orgId, me);
        for (const skill of skills) skill.canEdit = await mayChange(env, orgId, who, skill.createdBy);
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
    if (parts[2] === 'access' && request.method === 'PUT') {
      const r = await setSkillAccess(env.DB, orgId, skillId, me, input);
      return r.error ? fail(r) : json(r);
    }
    if (request.method === "GET") return json({ skill });
    if (!(await mayChange(env, orgId, who, skill.createdBy))) return json({ message: "Only its maker or an admin can change this skill." }, 403);
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
    if (!(await mayAccessAgent(env.DB, orgId, { ...agent, ownerLogin: agent.owner_login }, who.user.login))) return json({ message: "No such agent." }, 404);
    const canEdit = agent.owner_login === who.user.login || await allowed(env.DB, orgId, me, "agent.manage_others");
    // Anyone who may talk to it may tell it to remember something, as in
    // the chat; everything else is its maker's or an admin's.
    if (!read && !canEdit && !(sub === "memory" && request.method === "POST")) return json({ message: "Only the agent's maker or an admin can change it." }, 403);
    if (sub === "profile") {
      if (request.method === "GET") return json({ profile: await getProfile(env.DB, orgId, agentId), tiers: TIERS, access: ACCESS, canEdit });
      if (request.method === "PUT") {
        const r = await saveProfile(env.DB, orgId, agentId, input, me);
        if (!r.error) await audit(env, request, { orgId, action: "agent.profile_changed", actor: person(who.user), entity: { type: "agent", id: agentId }, details: { tier: r.profile.tier, access: r.profile.access, mentionOnly: r.profile.mentionOnly } });
        return r.error ? fail(r) : json({ ...r, canEdit });
      }
    }
    if (sub === "memory") {
      if (parts[4] === "scopes" && request.method === "GET") {
        const members = await memoryMembers(env.DB, orgId, me);
        const { results } = await env.DB.prepare(`SELECT DISTINCT s.channel FROM hx_memory_scopes s JOIN hx_agent_memories m ON m.id = s.memory_id
          WHERE s.org_id = ?1 AND m.agent_id = ?2 AND s.channel != '' ORDER BY s.channel LIMIT 200`).bind(orgId, agentId).all();
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
      if (request.method === "GET") return json({ memories: await listAgentMemories(env.DB, orgId, agentId, context), canEdit });
      if (request.method === "POST") {
        const r = await addAgentMemory(env.DB, orgId, agentId, input.text, { by: me, channel, kind: input.kind || "context" });
        return r.error ? fail(r) : json(r, 201);
      }
      if (request.method === "DELETE") {
        if (!canEdit) return json({ message: "Only the agent's maker or an admin can make it forget." }, 403);
        return json(await deleteAgentMemory(env.DB, orgId, agentId, parts[4] || url.searchParams.get("id") || "", context));
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
  if (parts[0] === "apps") {
    const [, appId, sub] = parts;
    if (appId === "templates" && request.method === "GET") return json({ templates: templateList() });
    if (appId === "generate" && request.method === "POST") {
      let generationRoom = null;
      if (input.channel) {
        generationRoom = await resolveChannel(env.DB, orgId, who.user, input.channel);
        if (!generationRoom || !(await mayUseConversation(env.DB, orgId, me, generationRoom.key))) return json({ message: 'No such room.' }, 403);
        input.channel = generationRoom.key;
      }
      const complete = input.useModel === false ? null : await completer(env, orgId, me, "app_generate", { maxTokens: 2400 });
      const made = await specFromPrompt(input.prompt, { complete });
      if (made.error) return fail(made);
      const { spec } = made;
      const r = await createApp(env.DB, {
        orgId, by: me, name: input.name || spec.name, description: spec.description, icon: spec.icon,
        columns: spec.columns, definition: spec.definition, template: spec.template || null,
        sample: spec.sample || [], channel: input.channel || null,
      });
      if (r.error) return fail(r);
      if (generationRoom && (generationRoom.kind !== 'business' || generationRoom.private)) await setAppAccess(env.DB, orgId, r.app.id, me, { visibility: 'private', version: 0 });
      await audit(env, request, { orgId, action: "app.created", actor: person(who.user), entity: { type: "app", id: r.app.id, name: r.app.name }, details: { source: made.source } });
      return json({ ...r, source: made.source, room: made.room || null }, 201);
    }
    if (!appId) {
      if (request.method === "GET") {
        const requested = url.searchParams.get('channel');
        const room = requested ? await resolveChannel(env.DB, orgId, who.user, requested) : null;
        if (requested && !room) return json({ message: 'No such room.' }, 403);
        return json({ apps: await visibleResources(await listApps(env.DB, orgId, { channel: room?.key }), a => mayUseApp(env.DB, orgId, a.id, me)) });
      }
      if (request.method === "POST") {
        const r = input.template
          ? await createFromTemplate(env.DB, { orgId, by: me, template: input.template, name: input.name, channel: input.channel, withSample: input.sample !== false })
          : await createApp(env.DB, { ...input, orgId, by: me, channel: input.channel });
        if (r.error) return fail(r);
        await audit(env, request, { orgId, action: "app.created", actor: person(who.user), entity: { type: "app", id: r.app.id, name: r.app.name } });
        return json(r, 201);
      }
      return null;
    }
    if (sub === 'conversation' && parts.length === 3) {
      if (!['GET','POST'].includes(request.method)) return json({message:'Method not allowed.'},405);
      const r = await appConversation(env.DB, orgId, me, appId, request.method === 'GET' ? Object.fromEntries(url.searchParams) : input, request.method === 'POST');
      return r.error ? fail(r) : json(r);
    }
    const app = await getApp(env.DB, orgId, appId);
    if (!app || !(await mayUseApp(env.DB, orgId, appId, me))) return json({ message: "No such app." }, 404);
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
        if (input.action === 'generate') return respond(await generateMigration(input.prompt, await databaseView(env.DB, orgId, app), await completer(env, orgId, me, 'app_database_generate', { maxTokens: 4000 })));
        if (input.action === 'migrate') return respond(await applyMigration(env.DB, orgId, app, input, me), 'app.database_migrated');
        if (input.action === 'fork') return respond(await forkDatabase(env.DB, orgId, app, me), 'app.database_forked');
        if (input.action === 'merge_preview') { const result=await previewMerge(env.DB,orgId,app,me,input); const {snapshots,...review}=result; return respond(review); }
        if (input.action === 'merge_apply') return respond(await mergeFork(env.DB,orgId,app,me,input), 'app.preview_merged');
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
        if(input.action==='generate')return respond(await generateAction(input.prompt,await completer(env,orgId,me,'app_action_generate',{maxTokens:6000})));
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
    if (sub === "custom") {
      if (!(await mayChange(env, orgId, who, app.createdBy))) return json({ message: "Only its maker or an admin can change custom code." }, 403);
      if (request.method !== 'POST') return json({ message: 'Method not allowed.' }, 405);
      if (input.action === 'generate') {
        const table = await getTable(env.DB, orgId, app.tableId);
        const complete = await completer(env, orgId, me, 'custom_app_generate', { maxTokens: 8000 });
        const capabilities = { entities: (await databaseView(env.DB,orgId,app)).entities, actions: (await actions(env.DB,orgId,appId)).actions.filter(a=>a.published).map(a=>({name:a.name,code:a.published})), connections:(await connections(env.DB,orgId,appId,me)).connections.map(c=>({name:c.name,endpoint:c.endpoint,method:c.method,enabled:c.enabled})), gateways:(await env.DB.prepare('SELECT id,name FROM hx_gateways WHERE org_id=?1 AND revoked_at IS NULL').bind(orgId).all()).results };
        const result = await generateCustomSource(input.prompt, table, complete, capabilities);
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
    if (!sub) {
      if (request.method === "GET") {
        const r = await renderApp(env.DB, orgId, appId);
        return r.error ? fail(r) : json({ ...r, canCustomize: await mayChange(env, orgId, who, app.createdBy) });
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
      if (request.method === "POST") return json(await linkApp(env.DB, orgId, appId, input.channel, me));
      if (request.method === "DELETE") return json(await unlinkApp(env.DB, orgId, appId, url.searchParams.get("channel")));
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

const hookUrl = (url, wf) => (wf.trigger?.type === "webhook" && wf.hookSecret ? `${url.origin}/hooks/workflows/${wf.id}?secret=${wf.hookSecret}` : undefined);

/// What agents and workflows are waiting on: for this person to decide, and
/// what they started that waits on someone else.
async function approvalsFor(env, orgId, login, me) {
  const { results } = await env.DB
    .prepare("SELECT data FROM cards WHERE org_id = ?1 AND recipient_user_id = ?2 AND status = 'pending' ORDER BY created_at DESC LIMIT 200")
    .bind(orgId, login)
    .all();
  const pending = (results || []).map((r) => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
  const cards = pending.filter((c) => c.workflowApproval || c.proxyAction || c.proposal || String(c.senderUserID || "").startsWith("agent:"));
  const { results: waiting } = await env.DB
    .prepare(`SELECT r.id, r.workflow_id, r.card_id, r.started_at, w.name FROM hx_workflow_runs r JOIN hx_workflows w ON w.id = r.workflow_id
      WHERE r.org_id = ?1 AND r.status = 'waiting' AND (r.started_by = ?2 OR w.created_by = ?2) ORDER BY r.started_at DESC LIMIT 100`)
    .bind(orgId, String(me))
    .all();
  return {
    pendingDecisions: pending.length,
    toDecide: cards.map((c) => ({ id: c.id, title: c.title, summary: c.summary, createdAt: c.createdAt, kind: c.workflowApproval ? "workflow" : c.proxyAction ? "agent" : c.proposal ? "proposal" : "agent", source: c.sourceDetail || c.sourceApp || null })),
    waitingOnOthers: (await visibleResources(waiting || [], async w => Boolean(await getRun(env.DB, orgId, w.id, { viewerId: me })))).map((w) => ({ runId: w.id, workflowId: w.workflow_id, workflow: w.name, cardId: w.card_id, startedAt: w.started_at })),
  };
}

async function homeFor(env, orgId, who, me) {
  const db = env.DB;
  const [mode, approvals, appRows, agents, workflows, followups] = await Promise.all([
    getMode(db, orgId),
    approvalsFor(env, orgId, who.user.login, me),
    listApps(db, orgId).then(items => visibleResources(items, a => mayUseApp(db, orgId, a.id, me))),
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
