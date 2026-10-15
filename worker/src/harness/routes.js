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
import { completer } from "./model.js";
import { onRowChange } from "./workflows.js";

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

const fail = (result) => json({ message: result.error }, result.status || 400);

/// The paths this module answers.
const OURS = /^\/(orgs\/mode|tables|apps)(\/|$)/;

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
  const limited = await enforce(env, request, "team");
  if (limited) return limited;

  const read = request.method === "GET" || request.method === "DELETE";
  const input = read ? null : await body(request);
  if (!read && !input) return json({ message: "Invalid JSON body." }, 400);
  const orgId = read ? url.searchParams.get("orgId") : input.orgId;
  const parts = url.pathname.split("/").filter(Boolean);

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
  if (!read && !(await allowed(env.DB, orgId, me, "harness.build"))) return json({ message: "You cannot build in this workspace." }, 403);

  // ── Tables ────────────────────────────────────────────────────────────
  if (parts[0] === "tables") {
    const [, tableId, sub, rowId] = parts;
    if (!tableId) {
      if (request.method === "GET") return json({ tables: await listTables(env.DB, orgId) });
      if (request.method === "POST") {
        const r = await createTable(env.DB, { orgId, name: input.name, columns: input.columns, by: me });
        return r.error ? fail(r) : json(r, 201);
      }
      return null;
    }
    if (!sub) {
      if (request.method === "GET") {
        const r = await listRows(env.DB, orgId, tableId, {
          q: url.searchParams.get("q") || undefined,
          sort: url.searchParams.get("sort") || undefined,
          where: url.searchParams.get("where") ? JSON.parse(url.searchParams.get("where") || "{}") : undefined,
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
        const r = await addRow(env.DB, orgId, tableId, input.values, me);
        if (r.error) return fail(r);
        await afterRowChange(env, { orgId, table: r.table, before: null, row: r.row, by: me });
        return json({ row: r.row }, 201);
      }
      if (rowId && (request.method === "PUT" || request.method === "PATCH")) {
        const r = await updateRow(env.DB, orgId, tableId, rowId, input.values, me);
        if (r.error) return fail(r);
        await afterRowChange(env, { orgId, table: r.table, before: r.before, row: r.row, by: me });
        return json({ row: r.row });
      }
      if (rowId && request.method === "DELETE") {
        const r = await deleteRow(env.DB, orgId, tableId, rowId);
        return r.error ? fail(r) : json(r);
      }
    }
    return null;
  }

  // ── Apps ──────────────────────────────────────────────────────────────
  if (parts[0] === "apps") {
    const [, appId, sub] = parts;
    if (appId === "templates" && request.method === "GET") return json({ templates: templateList() });
    if (appId === "generate" && request.method === "POST") {
      const complete = input.useModel === false ? null : await completer(env, orgId, me, "app_generate");
      const made = await specFromPrompt(input.prompt, { complete });
      if (made.error) return fail(made);
      const { spec } = made;
      const r = await createApp(env.DB, {
        orgId, by: me, name: input.name || spec.name, description: spec.description, icon: spec.icon,
        columns: spec.columns, definition: spec.definition, template: spec.template || null,
        sample: spec.sample || [], channel: input.channel || null,
      });
      if (r.error) return fail(r);
      await audit(env, request, { orgId, action: "app.created", actor: person(who.user), entity: { type: "app", id: r.app.id, name: r.app.name }, details: { source: made.source } });
      return json({ ...r, source: made.source, room: made.room || null }, 201);
    }
    if (!appId) {
      if (request.method === "GET") return json({ apps: await listApps(env.DB, orgId, { channel: url.searchParams.get("channel") || undefined }) });
      if (request.method === "POST") {
        const r = input.template
          ? await createFromTemplate(env.DB, { orgId, by: me, template: input.template, name: input.name, channel: input.channel, withSample: input.sample !== false })
          : await createApp(env.DB, { orgId, by: me, ...input, channel: input.channel });
        if (r.error) return fail(r);
        await audit(env, request, { orgId, action: "app.created", actor: person(who.user), entity: { type: "app", id: r.app.id, name: r.app.name } });
        return json(r, 201);
      }
      return null;
    }
    const app = await getApp(env.DB, orgId, appId);
    if (!app) return json({ message: "No such app." }, 404);
    if (!sub) {
      if (request.method === "GET") {
        const r = await renderApp(env.DB, orgId, appId);
        return r.error ? fail(r) : json(r);
      }
      if (request.method === "PUT") {
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
