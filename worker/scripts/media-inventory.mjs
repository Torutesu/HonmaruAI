#!/usr/bin/env node
// Which pictures the database points at are missing from the media bucket,
// and, with --restore, put back the ones this repository holds the source of.
//
//   cd worker && node scripts/media-inventory.mjs            # look only
//   cd worker && node scripts/media-inventory.mjs --restore  # and restore
//
// Run by .github/workflows/media-inventory.yml with the deploy's Cloudflare
// token. Every key is read from the production bucket, one by one; nothing
// is ever deleted, and nothing present is ever written over.
//
// What can be restored: a workspace emoji named after one of the ShogunAI
// pictures in assets/emoji/shogunai (shogun_fire, and shogun_fir — the same
// name a letter short, as some were imported), put back under the media id
// its row already has, so messages and reactions that use it show it again.
// Profile photos, workspace logos and agent pictures were uploaded by people
// and have no copy here: they are reported, and left for their owners.
//
// WRANGLER overrides the command (a stub in a dry run), DB and BUCKET the
// names; the defaults are production's (wrangler.toml).

import { execFile } from "node:child_process";
import { readdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const PACK = join(here, "../../assets/emoji/shogunai");
const DB = process.env.DB || "tiktokforwork";
const BUCKET = process.env.BUCKET || "tiktokforwork-media";
const [command, ...prefix] = (process.env.WRANGLER || "npx -y wrangler@4").split(" ");
const restore = process.argv.includes("--restore");
const ATTACHMENT_SAMPLE = 200;

const wrangler = (args) => run(command, [...prefix, ...args], { maxBuffer: 64 * 1024 * 1024 });

async function query(sql) {
  const { stdout } = await wrangler(["d1", "execute", DB, "--remote", "--json", "--command", sql]);
  const out = JSON.parse(stdout.slice(stdout.indexOf("[")));
  return out.flatMap((part) => part.results || []);
}

/// "present", "missing", or throws: an error that is not "no such key"
/// (a token, the network) must never read as missing.
async function exists(key) {
  try {
    await wrangler(["r2", "object", "get", `${BUCKET}/${key}`, "--remote", "--pipe"]);
    return "present";
  } catch (err) {
    if (/does not exist/i.test(`${err.stderr || ""}${err.stdout || ""}`)) return "missing";
    throw new Error(`Could not read ${key}: ${String(err.stderr || err.message).trim().split("\n").pop()}`);
  }
}

/// The pack's file for an emoji name: its own, or the one a letter longer.
export function packFileFor(name, files) {
  const stems = files.filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4));
  if (stems.includes(name)) return `${name}.svg`;
  const longer = stems.filter((s) => s.length === name.length + 1 && s.startsWith(name));
  return longer.length === 1 ? `${longer[0]}.svg` : null;
}

const keyOf = (url, path) => new RegExp(`/${path}/([a-z-]+-[0-9a-f-]{36})$`).exec(String(url || ""))?.[1] || null;

async function references() {
  const rows = [];
  for (const r of await query("SELECT org_id, name, media_id, created_at FROM org_emoji ORDER BY org_id, name")) rows.push({ kind: "emoji", where: r.org_id, label: `:${r.name}:`, name: r.name, key: r.media_id, at: r.created_at });
  for (const r of await query("SELECT org_id, media_id, updated_at FROM org_icons ORDER BY org_id")) rows.push({ kind: "workspace logo", where: r.org_id, label: r.org_id, key: r.media_id, at: r.updated_at });
  for (const r of await query("SELECT login, avatar_url FROM users WHERE avatar_url LIKE '%/users/avatar/user-avatar-%' ORDER BY login")) rows.push({ kind: "profile photo", where: "", label: r.login, key: keyOf(r.avatar_url, "users/avatar") });
  for (const r of await query("SELECT org_id, handle, avatar_url, updated_at FROM custom_agents WHERE avatar_url LIKE '%/agents/avatar/agent-avatar-%' ORDER BY org_id, handle")) rows.push({ kind: "agent picture", where: r.org_id, label: `@${r.handle}`, key: keyOf(r.avatar_url, "agents/avatar"), at: r.updated_at });
  // A sample of attachments, newest first: whether the loss is these
  // pictures alone or the bucket. Kept under org/<id>/files/, or file-<id>
  // before that layout.
  for (const r of await query(`SELECT id, org_id, created_at FROM message_files WHERE message_id IS NOT NULL ORDER BY created_at DESC LIMIT ${ATTACHMENT_SAMPLE}`)) rows.push({ kind: "attachment", where: r.org_id, label: r.id, key: `org/${encodeURIComponent(r.org_id)}/files/${r.id}`, legacy: `file-${r.id}`, at: r.created_at });
  return rows.filter((r) => r.key);
}

/// The bucket itself: when it was made, what it holds, and any rule that
/// deletes from it by age. Read only; a line that cannot be read says so.
async function bucketFacts() {
  const out = [];
  for (const [label, args] of [["buckets", ["r2", "bucket", "list"]], ["info", ["r2", "bucket", "info", BUCKET]], ["lifecycle rules", ["r2", "bucket", "lifecycle", "list", BUCKET]]]) {
    try {
      const { stdout } = await wrangler(args);
      const text = label === "buckets" ? stdout.split(/\n(?=name:)/).filter((b) => b.includes(BUCKET)).join("\n") : stdout;
      out.push(`### ${label}`, "```", text.split("\n").filter((l) => !/WARNING|wrangler \d|^─+$|Proxy environment/.test(l)).join("\n").trim(), "```");
    } catch (err) { out.push(`### ${label}`, `could not be read: ${String(err.stderr || err.message).trim().split("\n").pop()}`); }
  }
  return out;
}

/// When the pictures still there were made, and when the missing ones: a
/// line between them says from when the bucket's contents were lost.
function timeline(rows) {
  const span = (list) => { const at = list.filter((r) => r.at).map((r) => r.at).sort(); return at.length ? `${at[0]} … ${at[at.length - 1]} (${at.length})` : "none"; };
  // A restored one was missing when this run began.
  return ["### when made", `- missing: ${span(rows.filter((r) => r.status !== "present"))}`, `- present: ${span(rows.filter((r) => r.status === "present"))}`];
}

async function main() {
  const pack = readdirSync(PACK);
  const rows = await references();
  let next = 0;
  // A few at a time: one wrangler per key.
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < rows.length) {
      const row = rows[next++];
      row.status = await exists(row.key);
      if (row.status === "missing" && row.legacy && (await exists(row.legacy)) === "present") row.status = "present";
    }
  }));
  for (const row of rows) {
    if (row.status !== "missing" || row.kind !== "emoji") continue;
    row.source = packFileFor(row.name, pack);
    if (!row.source || !restore) continue;
    // Read again just before: never write over a picture that is there.
    if ((await exists(row.key)) !== "missing") { row.status = "present"; continue; }
    await wrangler(["r2", "object", "put", `${BUCKET}/${row.key}`, "--file", join(PACK, row.source), "--content-type", "image/svg+xml", "--remote"]);
    row.status = (await exists(row.key)) === "present" ? "restored" : "restore failed";
  }

  const kinds = [...new Set(rows.map((r) => r.kind))];
  const count = (kind, status) => rows.filter((r) => r.kind === kind && r.status === status).length;
  const lines = [
    `## Media in ${BUCKET}${restore ? " (restore)" : " (look only)"}`, "",
    "| | present | missing | restored |", "| --- | --- | --- | --- |",
    ...kinds.map((k) => `| ${k}${k === "attachment" ? ` (newest ${ATTACHMENT_SAMPLE})` : ""} | ${count(k, "present")} | ${count(k, "missing")} | ${count(k, "restored")} |`), "",
  ];
  lines.push(...await bucketFacts(), ...timeline(rows), "");
  const notPresent = rows.filter((r) => r.status !== "present");
  if (notPresent.length) {
    lines.push("| kind | workspace | name | key | made | status | source |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const r of notPresent) lines.push(`| ${r.kind} | ${r.where} | ${r.label} | \`${r.key}\` | ${r.at || ""} | ${r.status} | ${r.source || (r.kind === "emoji" ? "no copy in the repo" : "uploaded by a person; no copy")} |`);
  }
  const text = lines.join("\n") + "\n";
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  if (rows.some((r) => r.status === "restore failed")) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
