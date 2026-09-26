#!/usr/bin/env node
// Add a folder of pictures to ONE workspace as its own emoji, each named
// after its file (shogun_party.svg → :shogun_party:). The same thing as
// Studio → Emoji → Choose files, for when a pack is kept in the repo.
//
//   HONMARU_SESSION=<session token> node worker/scripts/add-emoji.mjs \
//     --api https://<your worker> --org <orgId> assets/emoji/shogunai
//
// The session is yours (a member of that workspace); the org is the one
// the emoji are for, and only that workspace gets them. A name the
// workspace already has is left as it is.

import { readdirSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : null; };
const api = (opt("api") || process.env.HONMARU_API || "").replace(/\/$/, "");
const org = opt("org") || process.env.HONMARU_ORG;
const token = process.env.HONMARU_SESSION;
const dir = args[0];
if (!api || !org || !token || !dir) {
  console.error("usage: HONMARU_SESSION=<token> node add-emoji.mjs --api <url> --org <orgId> <folder>");
  process.exit(2);
}
const TYPES = { ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml" };
let added = 0; let kept = 0; let failed = 0;
for (const file of readdirSync(dir).sort()) {
  const type = TYPES[extname(file).toLowerCase()];
  if (!type) continue;
  const name = file.slice(0, -extname(file).length).toLowerCase();
  const res = await fetch(`${api}/emoji?orgId=${encodeURIComponent(org)}&name=${encodeURIComponent(name)}`, {
    method: "POST", headers: { "x-session-token": token, "content-type": type }, body: readFileSync(join(dir, file)),
  });
  if (res.status === 201) { added += 1; console.log(`added  :${name}:`); }
  else if (res.status === 409) { kept += 1; console.log(`kept   :${name}: (already there)`); }
  else { failed += 1; console.log(`failed :${name}: ${res.status} ${(await res.json().catch(() => ({}))).message || ""}`); }
}
console.log(`${added} added, ${kept} already there, ${failed} failed`);
process.exit(failed ? 1 : 0);
