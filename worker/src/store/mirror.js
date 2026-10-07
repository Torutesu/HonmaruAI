// Dual writing: D1 stays the record, and every message written there is also
// written to the workspace's own Durable Object (workspace/do.js), so the
// object can take over with nothing missing (M1 in
// docs/architecture/discord-model-platform-plan.md §10).
//
// Only for workspaces WORKSPACE_DUAL names ("*" for every one, or a
// comma-separated list of org ids). Everywhere else this is a no-op.
//
// What is copied is the row as D1 has it after the write, not the change —
// so copies are idempotent and a repeated or late one cannot invent a state
// D1 never had. A copy that fails is logged and left to `reconcile`, which
// compares a workspace with its object range by range and repairs what
// differs (including rows D1 has since removed, e.g. a deleted account's).
// Reactions and read positions are not copied yet: the object does not keep
// them in the D1 shape.

import { digest, digestFields } from "../workspace/do.js";

let env = null;

/// The Worker's bindings, from each entry point (like secrets.js).
export function useMirrorEnv(next) {
  env = next || null;
}

export function dualWriting(orgId, e = env) {
  if (!e?.WORKSPACE || !orgId) return false;
  const list = String(e.WORKSPACE_DUAL || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes("*") || list.includes(orgId);
}

const stub = (e, orgId) => e.WORKSPACE.get(e.WORKSPACE.idFromName(orgId));
const COLUMNS = "id, channel, author_login, kind, body, parent_id, created_at, edited_at, deleted_at, also_channel";

/// These messages, as D1 has them now, into the workspace's object.
export async function mirrorIds(db, orgId, ids, e = env) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length || !dualWriting(orgId, e)) return;
  try {
    const rows = [];
    for (let i = 0; i < list.length; i += 90) {
      const chunk = list.slice(i, i + 90);
      const { results = [] } = await db.prepare(
        `SELECT ${COLUMNS} FROM channel_messages WHERE org_id = ?1 AND id IN (${chunk.map((_, j) => `?${j + 2}`).join(", ")})`
      ).bind(orgId, ...chunk).all();
      rows.push(...results);
    }
    const found = new Set(rows.map((r) => r.id));
    await stub(e, orgId).mirror({ upserts: rows, deletes: list.filter((id) => !found.has(id)) });
  } catch (err) {
    console.error("mirror failed", orgId, err?.message || err);
  }
}

/// Messages D1 no longer has, gone from the object too.
export async function mirrorDeletes(orgId, ids, e = env) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length || !dualWriting(orgId, e)) return;
  try {
    await stub(e, orgId).mirror({ deletes: list });
  } catch (err) {
    console.error("mirror delete failed", orgId, err?.message || err);
  }
}

const PAGE = 500;
const LAST = "￿";

/// D1 and the object compared range by range in id order; where they differ,
/// the object is made to match D1. Returns what it checked and fixed.
export async function reconcile(e, orgId, { until = new Date().toISOString(), maxPages = 200 } = {}) {
  const s = stub(e, orgId);
  let after = "";
  let checked = 0;
  let upserts = 0;
  let deletes = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const { results = [] } = await e.DB.prepare(
      `SELECT ${COLUMNS} FROM channel_messages WHERE org_id = ?1 AND created_at < ?2 AND id > ?3 ORDER BY id LIMIT ?4`
    ).bind(orgId, until, after, PAGE).all();
    const through = results.length === PAGE ? results[results.length - 1].id : LAST;
    const theirs = await s.rows({ after, through, until });
    const mine = await digest(results.map(digestFields));
    const other = await digest(theirs.map(digestFields));
    if (mine.hash !== other.hash) {
      const held = new Map(theirs.map((r) => [r.id, digestFields(r).join("\u001f")]));
      const fix = results.filter((r) => held.get(r.id) !== digestFields(r).join("\u001f"));
      const d1Ids = new Set(results.map((r) => r.id));
      const extra = theirs.filter((r) => !d1Ids.has(r.id)).map((r) => r.id);
      await s.mirror({ upserts: fix, deletes: extra });
      upserts += fix.length;
      deletes += extra.length;
    }
    checked += results.length;
    if (through === LAST) return { orgId, checked, upserts, deletes, done: true };
    after = through;
  }
  return { orgId, checked, upserts, deletes, done: false };
}

/// Once a day: every dual-writing workspace named outright, reconciled.
/// ("*" is left to /v2 backfill and checksum: every workspace at once is
/// not a cron's job.)
export async function reconcileAll(e) {
  const list = String(e?.WORKSPACE_DUAL || "").split(",").map((x) => x.trim()).filter((x) => x && x !== "*");
  const out = [];
  for (const orgId of list) {
    try { out.push(await reconcile(e, orgId)); } catch (err) { console.error("reconcile failed", orgId, err?.message || err); }
  }
  return out;
}
