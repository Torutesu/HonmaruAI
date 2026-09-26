#!/usr/bin/env node
// Give every workspace made before owners existed an owner: the admin who has
// been in it longest (docs/admin-controls.md §4.3).
//
// The Worker does the same thing lazily — the first time anyone reads a
// workspace's members, or an admin of it acts — so this is only to settle
// them all at once rather than one by one. Idempotent: a workspace that has
// an owner is left alone. A repository's workspace is skipped; GitHub decides
// who its admins are, and its admins are its owners.
//
//   node scripts/assign-owners.mjs            # print the SQL
//   node scripts/assign-owners.mjs --apply    # run it against production D1
//   node scripts/assign-owners.mjs --apply --env staging

import { execFileSync } from "node:child_process";

const SQL = `UPDATE memberships SET role = 'owner'
 WHERE role = 'admin' AND org_id NOT LIKE '%/%'
   AND NOT EXISTS (SELECT 1 FROM memberships o WHERE o.org_id = memberships.org_id AND o.role = 'owner')
   AND user_github_id = (SELECT a.user_github_id FROM memberships a WHERE a.org_id = memberships.org_id AND a.role = 'admin'
                          ORDER BY a.created_at ASC, a.user_github_id ASC LIMIT 1);`;

const args = process.argv.slice(2);
if (!args.includes("--apply")) {
  process.stdout.write(`${SQL}\n`);
  process.exit(0);
}
const envAt = args.indexOf("--env");
const env = envAt >= 0 ? args[envAt + 1] : null;
const db = env === "staging" ? "tiktokforwork-staging" : "tiktokforwork";
execFileSync("npx", ["-y", "wrangler@4", "d1", "execute", db, "--remote", ...(env ? ["--env", env] : []), "--command", SQL.replace(/\n/g, " "), "--yes"], { stdio: "inherit" });
