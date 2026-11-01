import { mayUseConversation } from './conversationAccess.js';
import { conversationWriteAuthority } from './conversationWriteAuthority.js';
import { getMessage } from '../channels.js';
import { SYSTEM_COLUMN_IDS, isSystemTimestamp, queryValue } from './systemColumns.js';
// Apps: internal tools built on a Table (docs/kylon-gap-plan.md).
//
// An app is a table plus views over it — table, board, metrics — kept as a
// versioned definition. It can be linked to rooms, where it shows next to the
// conversation. Apps start from a template or from a sentence ("an invoice
// tracker for #ops"); with a model the sentence can describe any table, and
// without one it still lands on the closest template.

import { TEMPLATES, matchTemplate } from "./templates.js";
import { prepareTable, getTable, listRows, cleanValues, normalizeColumns, planTableUpdate, MAX_ROWS } from "./tables.js";
import { normalizeMemberFields } from "./memberFields.js";

export const VIEW_TYPES = ["table", "board", "metrics", "calendar"];
export const METRIC_OPS = ["count", "sum", "avg", "min", "max"];
export const MAX_APPS_PER_ORG = 100;

const newId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
const now = () => new Date().toISOString();
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

/// Views as the app keeps them: each names columns by id, so a column the
/// table no longer has is dropped instead of breaking the app.
export function normalizeDefinition(definition, columns) {
  const ids = new Set(columns.map((c) => c.id));
  const byName = new Map(columns.map((c) => [c.name.toLowerCase(), c.id]));
  const col = (ref) => (ids.has(ref) ? ref : byName.get(String(ref ?? "").toLowerCase()) || null);
  const queryCol = ref => SYSTEM_COLUMN_IDS.includes(ref) ? ref : col(ref);
  const where = (w, resolve = queryCol) => {
    if (!w || typeof w !== "object") return undefined;
    const out = {};
    for (const [k, v] of Object.entries(w)) {
      const id = resolve(k);
      if (id) out[id] = (Array.isArray(v) ? v : [v]).map(String);
    }
    return Object.keys(out).length ? out : undefined;
  };
  const views = [];
  for (const raw of Array.isArray(definition?.views) ? definition.views.slice(0, 12) : []) {
    const type = VIEW_TYPES.includes(raw?.type) ? raw.type : null;
    if (!type) continue;
    const view = { id: typeof raw.id === "string" ? raw.id.slice(0, 32) : newId("view"), type, name: String(raw.name || type).slice(0, 40) };
    if (Array.isArray(raw.filters)) view.filters = raw.filters.slice(0,20).filter(f => queryCol(f?.column) && ['eq','neq','contains','empty','not_empty','gt','lt'].includes(f.op)).map(f => ({column:queryCol(f.column),op:f.op,value:String(f.value ?? '').slice(0,500)}));
    if (type === 'table' && col(raw.groupBy)) view.groupBy = col(raw.groupBy);
    const w = where(raw.where);
    if (w) view.where = w;
    if (raw.sort) {
      const desc = String(raw.sort).startsWith("-");
      const id = queryCol(String(raw.sort).replace(/^-/, ""));
      if (id) view.sort = desc ? `-${id}` : id;
    }
    if (type === "calendar") {
      const dateColumn = col(raw.dateColumn) || columns.find(c => c.type === "date")?.id;
      if (!columns.some(c => c.id === dateColumn && c.type === "date")) continue;
      view.dateColumn = dateColumn;
    }
    if (type === "board") {
      const groupBy = col(raw.groupBy) || columns.find((c) => c.type === "select")?.id;
      if (!groupBy) continue;
      view.groupBy = groupBy;
    }
    if (type === "metrics") {
      view.metrics = (Array.isArray(raw.metrics) ? raw.metrics.slice(0, 8) : [])
        .map((m) => {
          const op = METRIC_OPS.includes(m?.op) ? m.op : "count";
          const metric = { label: String(m?.label || op).slice(0, 40), op };
          if (op !== "count") {
            const c = col(m.column);
            if (!c) return null;
            metric.column = c;
          }
          const mw = where(m.where, col);
          if (mw) metric.where = mw;
          if (m.overdue) {
            const c = col(m.overdue);
            if (c) metric.overdue = c;
          }
          return metric;
        })
        .filter(Boolean);
    }
    views.push(view);
  }
  if (!views.length) views.push({ id: newId("view"), type: "table", name: "All" });
  return { views };
}

const matches = (values, where) => !where || Object.entries(where).every(([k, allowed]) => allowed.includes(String(values[k] ?? "")));

/// What a view shows, worked out on the server so every client — web, iOS,
/// an agent over MCP — reads the same numbers.
export function computeView(view, table, rows, today = new Date().toISOString().slice(0, 10)) {
  let shown = rows.filter((r) => (!view.where || Object.entries(view.where).every(([key, allowed]) => allowed.includes(String(queryValue(r,key) ?? '')))) && (view.filters || []).every(f => {
    const value=queryValue(r,f.column); const empty=value==null || value==='' || Array.isArray(value)&&value.length===0; const text=String(value ?? '');
    if(f.op==='empty') return empty;
    if(f.op==='not_empty') return !empty;
    const column=table.columns.find(c=>c.id===f.column);
    if(column?.type==='relation'&&['eq','neq','contains'].includes(f.op)) {
      const has=Array.isArray(value)?value.some(id=>String(id)===f.value):text===f.value;
      return f.op==='neq'?!has:has;
    }
    if(isSystemTimestamp(f.column)) {
      // The editor and visible timestamps have second precision.
      const a=Math.floor(Date.parse(text)/1000), b=Math.floor(Date.parse(f.value)/1000);
      if(!Number.isFinite(a)||!Number.isFinite(b)) return false;
      if(f.op==='eq') return a===b;
      if(f.op==='neq') return a!==b;
      if(f.op==='gt') return a>b;
      if(f.op==='lt') return a<b;
    }
    if(f.op==='eq') return text===f.value;
    if(f.op==='neq') return text!==f.value;
    if(f.op==='contains') return text.toLocaleLowerCase().includes(f.value.toLocaleLowerCase());
    if(empty) return false;
    const numeric=column?.type==='number';
    const a=numeric?Number(value):text, b=numeric?Number(f.value):f.value;
    return f.op==='gt'?a>b:a<b;
  }));
  if (view.sort) {
    const desc = view.sort.startsWith("-");
    const key = view.sort.replace(/^-/, "");
    shown = [...shown].sort((a, b) => {
      let x = queryValue(a,key), y = queryValue(b,key);
      if(isSystemTimestamp(key)) { x=Number.isFinite(Date.parse(x))?Date.parse(x):null; y=Number.isFinite(Date.parse(y))?Date.parse(y):null; }
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return desc ? -c : c;
    });
  }
  if (view.type === "calendar") {
    const days = new Map();
    const undated = [];
    for (const row of shown) {
      const date = row.values[view.dateColumn];
      const valid = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
        && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
      if (!valid) { undated.push(row); continue; }
      if (!days.has(date)) days.set(date, []);
      days.get(date).push(row);
    }
    return { ...view, days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => ({ date, rows })), undated };
  }
  if (view.type === "board" || view.type === "table" && view.groupBy) {
    const column = table.columns.find((c) => c.id === view.groupBy);
    const lanes = (column?.options || []).map((option) => ({ key: option, rows: [] }));
    const none = { key: null, rows: [] };
    for (const row of shown) {
      const value = row.values[view.groupBy];
      if(value == null || value === '') { none.rows.push(row); continue; }
      const key=String(value);
      let lane=lanes.find(l=>l.key===key);
      if(!lane) { lane={key,rows:[]}; lanes.push(lane); }
      lane.rows.push(row);
    }
    if (none.rows.length) lanes.push(none);
    return { ...view, lanes, rows: shown };
  }
  if (view.type === "metrics") {
    const values = (view.metrics || []).map((m) => {
      let set = shown.filter((r) => matches(r.values, m.where));
      if (m.overdue) set = set.filter((r) => r.values[m.overdue] && r.values[m.overdue] < today);
      const nums = m.column ? set.map((r) => r.values[m.column]).filter((v) => typeof v === "number") : [];
      let value;
      switch (m.op) {
        case "sum": value = nums.reduce((a, b) => a + b, 0); break;
        case "avg": value = nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null; break;
        case "min": value = nums.length ? Math.min(...nums) : null; break;
        case "max": value = nums.length ? Math.max(...nums) : null; break;
        default: value = set.length;
      }
      return { ...m, value };
    });
    return { ...view, values };
  }
  return { ...view, rows: shown };
}

const publicApp = (row) => row && ({
  id: row.id, orgId: row.org_id, name: row.name, description: row.description || "", icon: row.icon || "📋",
  tableId: row.table_id, template: row.template || null, version: row.version,
  definition: parse(row.definition, { views: [] }),
  createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
});

export async function getApp(db, orgId, id) {
  return publicApp(await db.prepare("SELECT * FROM hx_apps WHERE id = ?1 AND org_id = ?2").bind(id, orgId).first());
}

export async function listApps(db, orgId, { channel } = {}) {
  const sql = channel
    ? "SELECT a.* FROM hx_apps a JOIN hx_app_links l ON l.app_id = a.id WHERE a.org_id = ?1 AND l.channel = ?2 ORDER BY a.created_at ASC"
    : "SELECT * FROM hx_apps WHERE org_id = ?1 ORDER BY created_at ASC";
  const stmt = db.prepare(sql);
  const { results } = await (channel ? stmt.bind(orgId, channel) : stmt.bind(orgId)).all();
  const apps = (results || []).map(publicApp);
  if (!apps.length) return apps;
  const { results: links } = await db
    .prepare(`SELECT app_id, channel FROM hx_app_links WHERE org_id = ?1 AND app_id IN (${apps.map((_, i) => `?${i + 2}`).join(",")})`)
    .bind(orgId, ...apps.map((a) => a.id))
    .all();
  for (const app of apps) app.channels = (links || []).filter((l) => l.app_id === app.id).map((l) => l.channel);
  return apps;
}

/// Build an app: a new table from the spec, its views, and the first version.
export async function appCreationSource(db, orgId, by, sourceThreadId) {
  const source = typeof sourceThreadId === 'string' ? await getMessage(db, orgId, sourceThreadId) : null;
  if (!source || source.deleted_at || source.parent_id || !await mayUseConversation(db, orgId, by, source.channel)) {
    return { error: 'No such source thread.', status: 404 };
  }
  const room = source.channel.startsWith('b:')
    ? await db.prepare('SELECT private,created_at FROM businesses WHERE org_id = ? AND slug = ?').bind(orgId, source.channel.slice(2)).first()
    : null;
  if(source.channel.startsWith('b:') && (!room || !room.created_at))return {error:'No such source thread.',status:404};
  return { source, private: !room || Boolean(room.private), roomCreatedAt:room?.created_at || null };
}

export async function createApp(db, { orgId, by, name, tableName, description, icon, columns, definition, template, sample = [], channel, sourceThreadId, sourceBodyExpected = null, privateByDefault = false, channelCreatedAt = null, channelPrivateAt = null }, { commitGuard, announceInSource = false } = {}) {
  let source=null, sourcePrivate=false;
  if(sourceThreadId){
    const origin = await appCreationSource(db, orgId, by, sourceThreadId);
    if (origin.error) return origin;
    if((channelCreatedAt && origin.roomCreatedAt!==channelCreatedAt) || (channelPrivateAt!==null && origin.private!==channelPrivateAt))return {error:'The source conversation changed. Try again.',status:409};
    source = origin.source; sourcePrivate = origin.private; channelCreatedAt=channelCreatedAt||origin.roomCreatedAt;
    channel=source.channel;
    if(channel.startsWith('b:'))channelPrivateAt=channelPrivateAt??origin.private;
  }
  if(channel && String(channel).startsWith('b:') && (channelCreatedAt===null || channelPrivateAt===null)) {
    const room=await db.prepare('SELECT private,created_at FROM businesses WHERE org_id=? AND slug=?').bind(orgId,String(channel).slice(2)).first();
    if(room){channelCreatedAt=channelCreatedAt||room.created_at;channelPrivateAt=channelPrivateAt??Boolean(room.private);}
  }
  const count = await db.prepare("SELECT COUNT(*) AS n FROM hx_apps WHERE org_id = ?1").bind(orgId).first();
  if (Number(count?.n || 0) >= MAX_APPS_PER_ORG) return { error: "This workspace has as many apps as it can hold." };
  const clean = String(name ?? "").trim().slice(0, 80);
  if (!clean) return { error: "Give the app a name." };
  const cleanTableName = String(tableName ?? "").trim().slice(0, 80) || clean;
  const made = await prepareTable(db, { orgId, name: cleanTableName, columns, by });
  if (made.error) return made;
  const table = made.table;
  const def = normalizeDefinition(definition, table.columns);
  const id = newId("app");
  const at = now();
  const insertApp = db
    .prepare(
      `INSERT INTO hx_apps (id, org_id, name, description, icon, table_id, template, version, definition, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8,
         CASE WHEN EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=?2 AND member.user_github_id=?9 AND LOWER(COALESCE(member.role,'guest'))!='guest'
           AND NOT EXISTS(SELECT 1 FROM workspace_deletions deletion WHERE deletion.org_id=member.org_id AND deletion.purge_started_at IS NOT NULL)
           AND NOT EXISTS(SELECT 1 FROM workspace_tombstones deleted WHERE deleted.org_id=member.org_id)) THEN ?9 ELSE NULL END, ?10, ?10)`,
    )
    .bind(id, orgId, clean, String(description || "").slice(0, 300), String(icon || "📋").slice(0, 8), table.id, template || null, JSON.stringify(def), String(by), at);
  // Publish the app and its inherited policy together: no workspace-visible
  // interval for an app originating in a private room, DM or agent chat.
  const statements = [...(commitGuard ? [commitGuard(id)] : []), made.statement, insertApp, ...(sourcePrivate || privateByDefault ? [db.prepare(
    "INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES (?,?,'private',1)",
  ).bind(orgId,id)] : [])];
  statements.push(db
    .prepare("INSERT INTO hx_app_versions (app_id, org_id, version, definition, note, created_by, created_at) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6)")
    .bind(id, orgId, JSON.stringify({ name: clean, tableName: table.name, columns: table.columns, ...def }), "Created", String(by), at));
  for (const [position,values] of (Array.isArray(sample) ? sample : []).slice(0,20).entries()) statements.push(db.prepare(
    'INSERT INTO hx_rows(id,table_id,org_id,data,position,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).bind(newId('row'),table.id,orgId,JSON.stringify(cleanValues(table.columns,values)),position+1,String(by),String(by),at,at));
  if(channel) statements.push(db.prepare(`INSERT INTO hx_app_links(app_id,org_id,channel,created_by,created_at)
    VALUES (?1,?2,CASE WHEN ${conversationWriteAuthority('?2','?3','?4')}
      AND (?6 IS NULL OR EXISTS(SELECT 1 FROM channel_messages root WHERE root.org_id=?2 AND root.id=?6 AND root.channel=?3 AND root.deleted_at IS NULL AND root.parent_id IS NULL AND (?10 IS NULL OR root.body=?10)))
      AND (substr(?3,1,2)!='b:' OR EXISTS(SELECT 1 FROM businesses room WHERE room.org_id=?2 AND 'b:'||room.slug=?3
        AND (?8 IS NULL OR room.created_at=?8) AND (?9 IS NULL OR room.private=?9) AND (?7=1 OR room.private=0)))
      AND (?7=1 OR substr(?3,1,2)='b:') THEN ?3 ELSE NULL END,?4,?5)`)
    .bind(id,orgId,String(channel).trim().slice(0,200),String(by),at,source?.id||null,sourcePrivate||privateByDefault?1:0,channelCreatedAt,channelPrivateAt===null?null:Number(channelPrivateAt),sourceBodyExpected));
  if(source) statements.push(db.prepare(`INSERT INTO hx_app_conversation_sources(org_id,app_id,channel,thread_id,created_by)
    VALUES (?,?,?,(SELECT id FROM channel_messages WHERE org_id=? AND id=? AND channel=? AND deleted_at IS NULL AND parent_id IS NULL),?)`)
    .bind(orgId,id,source.channel,orgId,source.id,source.channel,String(by)));
  // The result lives in the same transaction as the app: retries cannot
  // announce it twice, and failed publication cannot leave a success reply.
  const announcementId = source && announceInSource ? `app-created-${id}` : null;
  if(announcementId){
    const label=clean.replace(/[\\\[\]()*`]/g,'\\$&');
    const body=`[${label}](#/apps/${encodeURIComponent(id)}/${encodeURIComponent(orgId)}) を作成しました。\n${table.columns.map(column=>column.name).join('・')}の項目を設定しました。`;
    statements.push(db.prepare(`INSERT INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at,parent_id)
      VALUES (?,?,?,NULL,'ai',?,?,?)`).bind(announcementId,orgId,source.channel,body,at,source.id));
  }
  try { await db.batch(statements); }
  catch(error) {
    if(/NOT NULL constraint failed: hx_apps\.created_by/i.test(String(error?.message || error))) {
      return {error:'Workspace membership is required.',status:403};
    }
    // The guarded link's NOT NULL constraint rolls back the whole batch,
    // including a generation job's commit guard, when access changed.
    if(channel && /NOT NULL constraint failed: hx_app_links\.channel/i.test(String(error?.message || error))) {
      return {error:'The source conversation or its access changed. Try again.',status:409};
    }
    throw error;
  }
  return { app: await getApp(db, orgId, id), ...(announcementId ? {announcementId} : {}) };
}

export async function createFromTemplate(db, { orgId, by, template, name, tableName, channel, sourceThreadId, withSample = true, privateByDefault = false, channelCreatedAt = null, channelPrivateAt = null }) {
  const t = TEMPLATES[template];
  if (!t) return { error: "No such template." };
  return createApp(db, {
    orgId, by, template, channel, sourceThreadId, channelCreatedAt, channelPrivateAt,
    name: name || t.name, tableName: tableName || t.tableName || t.name, description: t.description, icon: t.icon,
    columns: t.columns, definition: { views: t.views }, sample: withSample ? t.sample : [], privateByDefault,
  });
}

/// A new version: change the name, the views, or the table's columns. The
/// previous definition is kept, so a change can be undone.
export async function updateApp(db, orgId, id, { name, tableName, description, icon, columns, definition, note, expectedVersion }, by) {
  const app = await getApp(db, orgId, id);
  if (!app) return { error: "No such app.", status: 404 };
  if (expectedVersion !== undefined && expectedVersion !== app.version) return { error: "This app changed. Reload before saving.", status: 409 };
  const existingViewIds=new Set((Array.isArray(app.definition.views)?app.definition.views:[]).map(view=>view.id));
  const introducedIds=def=>def.views.map(view=>view.id).filter(viewId=>viewId.startsWith('personal_')&&!existingViewIds.has(viewId));
  let table = await getTable(db, orgId, app.tableId);
  // The table's new columns, written only in the same transaction as the
  // app's new version below: a save that loses to another leaves both alone.
  let schema = null;
  if (columns !== undefined || tableName !== undefined) {
    schema = await planTableUpdate(db, orgId, app.tableId, { name: tableName, columns }, planned => ({ sql: `EXISTS (SELECT 1 FROM hx_apps WHERE id = ?9 AND org_id = ?5 AND version = ?10)
      AND (?11='[]' OR NOT EXISTS (SELECT 1 FROM hx_personal_views p, json_each(p.settings,'$.views') v, json_each(?11) incoming
        WHERE p.org_id=?5 AND p.app_id=?9 AND json_extract(v.value,'$.id')=incoming.value))`, binds: [id, app.version, JSON.stringify(introducedIds(normalizeDefinition(definition ?? app.definition,planned.columns)))] }));
    if (schema.error) return schema;
    table = schema.table;
  }
  const def = normalizeDefinition(definition ?? app.definition, table.columns);
  // A personal ID belongs to its owner's settings. A new shared view may not
  // take the same ID, even if another user's settings are not visible here.
  // The SQL check below runs with the versioned write to fence concurrent
  // personal-view creation. Already-shared legacy IDs are preserved.
  const introducedPersonalIds=introducedIds(def);
  if (app.definition.custom) def.custom = app.definition.custom;
  const next = {
    name: name !== undefined ? String(name).trim().slice(0, 80) || app.name : app.name,
    description: description !== undefined ? String(description).slice(0, 300) : app.description,
    icon: icon !== undefined ? String(icon).slice(0, 8) : app.icon,
  };
  const version = app.version + 1;
  const at = now();
  // One D1 transaction, in order: the table (only while the app is still
  // this version), the app (only when the table was written, if it was to
  // be), then the version's snapshot (only when the app was).
  const results = await db.batch([
    ...(schema ? [schema.statement] : []),
    db.prepare(`UPDATE hx_apps SET name = ?1, description = ?2, icon = ?3, definition = ?4, version = ?5, updated_at = ?6 WHERE id = ?7 AND org_id = ?8 AND version = ?9${schema ? " AND changes() = 1" : ""}
      AND (?10='[]' OR NOT EXISTS (SELECT 1 FROM hx_personal_views p, json_each(p.settings,'$.views') v, json_each(?10) incoming
        WHERE p.org_id=?8 AND p.app_id=?7 AND json_extract(v.value,'$.id')=incoming.value))`)
      .bind(next.name, next.description, next.icon, JSON.stringify(def), version, at, id, orgId, app.version, JSON.stringify(introducedPersonalIds)),
    db.prepare("INSERT INTO hx_app_versions (app_id, org_id, version, definition, note, created_by, created_at) SELECT ?1, ?7, ?2, ?3, ?4, ?5, ?6 WHERE changes() = 1")
      .bind(id, version, JSON.stringify({ name: next.name, tableName: table.name, columns: table.columns, ...def }), note ? String(note).slice(0, 200) : null, String(by), at, orgId),
  ]);
  if (!results[schema ? 1 : 0].meta?.changes) return { error: "This app changed. Reload before saving.", status: 409 };
  return { app: await getApp(db, orgId, id) };
}

export async function listVersions(db, orgId, id) {
  const app = await getApp(db, orgId, id);
  if (!app) return { error: "No such app.", status: 404 };
  const { results } = await db
    .prepare("SELECT version, note, created_by, created_at FROM hx_app_versions WHERE app_id = ?1 AND org_id = ?2 ORDER BY version DESC")
    .bind(id, orgId)
    .all();
  return { versions: (results || []).map((v) => ({ version: v.version, note: v.note, createdBy: v.created_by, createdAt: v.created_at })) };
}

/// Go back to an earlier version — as a new version, so nothing is lost.
export async function restoreVersion(db, orgId, id, version, by) {
  const row = await db.prepare("SELECT definition FROM hx_app_versions WHERE app_id = ?1 AND org_id = ?2 AND version = ?3").bind(id, orgId, Number(version)).first();
  if (!row) return { error: "No such version.", status: 404 };
  const old = parse(row.definition, {});
  return updateApp(db, orgId, id, { name: old.name, tableName: old.tableName, columns: old.columns, definition: { views: old.views }, note: `Restored version ${version}` }, by);
}

export async function deleteApp(db, orgId, id) {
  const app = await getApp(db, orgId, id);
  if (!app) return { error: "No such app.", status: 404 };
  await db.batch([
    // Keep bindings as tombstones: a deleted app must never turn its runs
    // into standalone workflows. Stop scheduling in the same transaction.
    db.prepare("UPDATE hx_workflows SET enabled=0,next_run_at=NULL WHERE org_id=?2 AND id IN (SELECT workflow_id FROM hx_app_automation_bindings WHERE org_id=?2 AND app_id=?1)").bind(id,orgId),
    db.prepare("DELETE FROM hx_app_links WHERE app_id = ?1 AND org_id = ?2").bind(id, orgId),
    db.prepare("DELETE FROM hx_app_versions WHERE app_id = ?1 AND org_id = ?2").bind(id, orgId),
    db.prepare("DELETE FROM hx_rows WHERE org_id=?2 AND table_id IN (SELECT table_id FROM hx_app_entities WHERE org_id=?2 AND app_id=?1)").bind(id,orgId),
    db.prepare("DELETE FROM hx_tables WHERE org_id=?2 AND id IN (SELECT table_id FROM hx_app_entities WHERE org_id=?2 AND app_id=?1)").bind(id,orgId),
    db.prepare("DELETE FROM hx_apps WHERE id = ?1 AND org_id = ?2").bind(id, orgId),
    db.prepare("DELETE FROM hx_rows WHERE table_id = ?1 AND org_id = ?2").bind(app.tableId, orgId),
    db.prepare("DELETE FROM hx_tables WHERE id = ?1 AND org_id = ?2").bind(app.tableId, orgId),
  ]);
  return { deleted: true };
}

export async function linkApp(db, orgId, id, channel, by) {
  const key = String(channel || "").trim().slice(0, 200);
  if (!key) return { error: "channel is required" };
  await db
    .prepare("INSERT OR IGNORE INTO hx_app_links (app_id, org_id, channel, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(id, orgId, key, String(by), now())
    .run();
  return { linked: true };
}

export async function unlinkApp(db, orgId, id, channel) {
  await db.prepare("DELETE FROM hx_app_links WHERE app_id = ?1 AND org_id = ?2 AND channel = ?3").bind(id, orgId, String(channel)).run();
  return { unlinked: true };
}

/// The app with every view worked out, ready to draw.
export async function renderApp(db, orgId, id) {
  const app = await getApp(db, orgId, id);
  if (!app) return { error: "No such app.", status: 404 };
  const { table, rows } = await listRows(db, orgId, app.tableId, { limit: MAX_ROWS });
  const { results: links } = await db.prepare("SELECT channel FROM hx_app_links WHERE app_id = ?1 AND org_id = ?2").bind(id, orgId).all();
  app.channels = (links || []).map((l) => l.channel);
  return { app, table, rows, views: app.definition.views.map((v) => computeView(v, table, rows)) };
}

const VIEW_TERMS = {
  board: '\\b(?:board|kanban|pipeline)\\b|ボード|カンバン|パイプライン',
  metrics: '\\b(?:dashboard|analytics|metrics|reports?|charts?|kpis?)\\b|ダッシュボード|分析|集計|レポート|グラフ|KPI',
  calendar: '\\bcalendar\\b|カレンダー',
};

function viewIntent(prompt, pattern) {
  const positive = new RegExp(pattern, 'iu');
  const clause = String(prompt).split(/[、。,，.!！?？;；\n]+/u).filter(part => positive.test(part)).at(-1);
  if (!clause) return {mentioned:false, excluded:false};
  const negative = new RegExp(`(?:\\b(?:no|without|exclude|avoid|omit|remove)\\s+(?:a\\s+|the\\s+)?(?:${pattern})|\\b(?:do not|don't|never)\\s+(?:add|use|create|show|include)\\s+(?:a\\s+|the\\s+)?(?:${pattern})|(?:${pattern})\\s*(?:は|を|が|の)?\\s*(?:不要|いらな|要らな|なし|無し|なく|ない|無い|省い|省く|外し|外す|除い|除く|非表示|作らな|作成しな|追加しな|使わな|使わず|含めな|表示しな|必要ない|必要ありません|(?:is\\s+)?not\\s+(?:needed|required)|omitted|excluded|removed))`, 'iu');
  return {mentioned:true, excluded:negative.test(clause)};
}

/// The model-free tracker can recognize a few common view requests. A model's
/// structured result is handled separately so richer requests are not discarded.
function requestedAppViews(prompt, candidates, columns = []) {
  const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(prompt);
  const tableName = japanese ? "すべて" : "All";
  const requested = type => {const intent = viewIntent(prompt, VIEW_TERMS[type]); return intent.mentioned && !intent.excluded;};
  const wantsBoard = requested('board');
  const wantsMetrics = requested('metrics');
  const wantsCalendar = requested('calendar');
  const source = Array.isArray(candidates) ? candidates : [];
  // A template's first table can have its own filters (for example, open
  // invoices). Do not silently apply those filters to a different request.
  const table = { type: "table", name: tableName };
  const asksForDateOrder = /(?:期限|期日|due(?: date)?|deadline)[^、。,，.!！?？;；\n]{0,20}(?:順|並べ替|ソート|sort|order)|(?:sort|order)[^、。,，.!！?？;；\n]{0,20}(?:due|deadline)/iu.test(prompt);
  const dateColumn = columns.find(column => column.type === 'date' && /due|deadline|期限|期日/iu.test(column.name)) || columns.find(column => column.type === 'date');
  if (asksForDateOrder && dateColumn) table.sort = `${/降順|新しい順|descending|newest first|latest first/iu.test(prompt) ? '-' : ''}${dateColumn.name}`;
  const extras = [];
  if (wantsBoard) {
    const board = source.find(view => view?.type === "board");
    const groupColumn = columns.find(column => column.type === "select");
    if (board) extras.push(board);
    else if (groupColumn) extras.push({ type: "board", name: japanese ? "ボード" : "Board", groupBy: groupColumn.name });
  }
  if (wantsMetrics) extras.push(source.find(view => view?.type === "metrics") || { type: "metrics", name: japanese ? "集計" : "Summary", metrics: [{ label: japanese ? "レコード数" : "Records", op: "count" }] });
  if (wantsCalendar) {
    const calendar = source.find(view => view?.type === "calendar");
    if (calendar) extras.push(calendar);
  }
  if (wantsCalendar && !extras.some(view => view.type === "calendar")) {
    const dateColumn = columns.find(column => column.type === "date");
    if (dateColumn) extras.push({ type: "calendar", name: japanese ? "カレンダー" : "Calendar", dateColumn: dateColumn.name });
  }
  return [table, ...extras];
}

// Example rows are real workspace data. Only the explicit count in the
// creation form or API can opt in; language-model guesses cannot create rows.
export function requestedSampleRows(sample, columns, sampleCount = 0) {
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0 || !Array.isArray(sample)) return [];
  const limit = Math.min(20, sampleCount);
  const normalized = normalizeColumns(columns).columns || [];
  const safe = normalized.filter(column => column.type !== 'person');
  const names = new Set(safe.map(column => column.name.toLowerCase()));
  const ids = new Set(safe.map(column => column.id));
  const people = new Set(normalized.filter(column => column.type === 'person').flatMap(column => [column.name.toLowerCase(), column.id.toLowerCase()]));
  return sample.filter(row => row && typeof row === 'object' && !Array.isArray(row)).slice(0, 20)
    .map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !people.has(key.toLowerCase()) && (ids.has(key) || names.has(key.toLowerCase())))))
    .filter(row => Object.keys(row).length > 0).slice(0, limit);
}

/// A spec from a sentence. A model, when there is one, may design any table;
/// it answers in JSON and the answer is validated like any other input.
/// Without a model, or when its answer does not hold up, the closest
/// template is used — "an invoice tracker for #ops" always gets an app.
export async function specFromPrompt(prompt, { complete, modelRequest, guidelines = '', sampleCount = 0 } = {}) {
  const text = String(prompt || "").trim().slice(0, 4000);
  if (!text) return { error: "Say what the app is for." };
  if (complete) {
    try {
      const raw = await complete(
        [
          "Design a small internal business app as JSON, nothing else.",
          'Shape: {"name": app title string, "tableName": primary table label string, "icon": one emoji, "description": string, "columns": [{"name": string, "type": "text"|"number"|"date"|"select"|"checkbox"|"url"|"person"|"email", "options"?: string[]}],',
          '"viewPolicy": "default"|"requested", "views": [{"type": "table"|"board"|"metrics"|"calendar", "dateColumn"?: column name, "name": string, "groupBy"?: column name, "sort"?: column name or "-name", "metrics"?: [{"label": string, "op": "count"|"sum"|"avg", "column"?: column name}]}], "sample"?: [object keyed by column name]}',
          "Set viewPolicy to default when the request does not specify views, filters, grouping or ordering; use one unfiltered table view named すべて (Japanese) or All (English). Otherwise set it to requested and honor the requested view types, number, names, filters, ordering and exclusions.",
          `The user selected a maximum of ${sampleCount} example rows. Return at most that many in sample; return none when the maximum is zero. Do not invent workspace members.`,
          "At most 10 columns. A board needs a select column to group by. Name things in the language of the request. Keep the app title and primary table label distinct when the request implies they have different names; the table label should be concise and natural for the records users add. Use type person for internal owners, assignees, reviewers, interviewers and approvers so users select workspace members; do not model those as free text unless the request explicitly asks for that field to be free text.",
        ].join("\n"),
        typeof modelRequest === 'string' ? modelRequest : text,
      );
      const spec = JSON.parse(String(raw).replace(/^```(?:json)?|```$/gm, "").trim());
      if (spec && Array.isArray(spec.columns) && spec.columns.length && spec.name) {
        // Give internal assignees a real workspace-member picker even when
        // the model falls back to a generic text column.
        const columns = normalizeMemberFields(text, spec.columns.slice(0, 10), {guidelines});
        const explicitViewHint = /ボード|カンバン|カレンダー|ダッシュボード|ビュー|カード表示|並べ替|ソート|絞り込|フィルタ|グループ|(?:期限|期日|日付|状態|担当|進捗|優先度)[^、。,，.!！?？;；\n]{0,8}(?:順|別|毎|ごと)|\b(?:board|kanban|calendar|dashboard|view|views|filter|sort|group|order)\b/iu.test(text);
        const candidates = spec.viewPolicy === 'default' && !explicitViewHint ? [] : (Array.isArray(spec.views) ? spec.views : [])
          .filter(view => VIEW_TYPES.includes(view?.type) && !(VIEW_TERMS[view.type] && viewIntent(text, VIEW_TERMS[view.type]).excluded));
        if (candidates.length > 12) return {error: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text) ? 'アプリのビューは最大12件です。数を減らして再試行してください。' : 'An app can have at most 12 views. Reduce the number and try again.'};
        const views = candidates.map(({id, ...view}) => view);
        if (!views.length) views.push({type: 'table', name: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text) ? 'すべて' : 'All'});
        const normalized = normalizeColumns(columns);
        if (normalized.error) return {error: normalized.error};
        for (const view of views) {
          if (!['board','calendar'].includes(view.type)) continue;
          const type = view.type === 'board' ? 'select' : 'date';
          const ref = view.type === 'board' ? view.groupBy : view.dateColumn;
          const column = ref ? normalized.columns.find(item => item.id === ref || item.name.toLowerCase() === String(ref).toLowerCase()) : normalized.columns.find(item => item.type === type);
          if (!column || column.type !== type) {
            const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text);
            return {error: view.type === 'board'
              ? japanese ? '生成されたボードには、グループ化できる選択肢フィールドが必要です。依頼に項目を追加して再試行してください。' : 'The generated board needs a select field for grouping. Add one to the request and try again.'
              : japanese ? '生成されたカレンダーには日付フィールドが必要です。依頼に日付項目を追加して再試行してください。' : 'The generated calendar needs a date field. Add one to the request and try again.'};
          }
        }
        return { spec: { name: spec.name, tableName: typeof spec.tableName === "string" && spec.tableName.trim() ? spec.tableName.trim().slice(0, 80) : spec.name, icon: spec.icon, description: spec.description, columns, definition: { views }, sample: requestedSampleRows(spec.sample, columns, sampleCount) }, source: "model" };
      }
    } catch { /* fall through to a template */ }
  }
  const id = matchTemplate(text) || "tracker";
  const t = TEMPLATES[id];
  const room = text.match(/#([\p{L}\p{N}_-]+)/u)?.[1];
  return {
    spec: { name: t.name, tableName: t.tableName || t.name, icon: t.icon, description: t.description, columns: t.columns, definition: { views: requestedAppViews(text, t.views, t.columns) }, template: id, sample: requestedSampleRows(t.sample, t.columns, sampleCount) },
    source: "template",
    room: room || null,
  };
}
