#!/usr/bin/env node
// Verify a workspace's audit archive with nothing but the files and the
// public key — no Honmaru API (docs/audit-log-phase2.md §3.5).
//
//   node scripts/verify-audit-archive.mjs <dir> <public-keys.json>
//
// <dir> holds the objects downloaded from the archive bucket for one
// workspace (…/<yyyy>/<mm>/<dd>/<hh>.jsonl.gz and .digest.json, in any
// layout). <public-keys.json> is what GET /audit/public-key answers.
// Checks, hour by hour in order: each digest's Ed25519 signature; each
// archive's SHA-256; every row's hash over the one before it; each hour
// starting where the last ended; and each digest naming the one before.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash, webcrypto } from "node:crypto";
import { gunzipSync } from "node:zlib";

const [dir, keysPath] = process.argv.slice(2);
if (!dir || !keysPath) {
  console.error("usage: node scripts/verify-audit-archive.mjs <dir> <public-keys.json>");
  process.exit(2);
}
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
  : JSON.stringify(v ?? null);
const sha = (data) => createHash("sha256").update(data).digest("hex");
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const unb64url = (t) => Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64");

const keys = JSON.parse(readFileSync(keysPath, "utf8")).keys || [];
const digests = walk(dir).filter((f) => f.endsWith(".digest.json")).map((f) => ({ file: f, text: readFileSync(f, "utf8") }))
  .map((d) => ({ ...d, digest: JSON.parse(d.text) })).sort((a, b) => a.digest.hour.localeCompare(b.digest.hour));
if (!digests.length) { console.error("No digests found."); process.exit(1); }

let prevDigest = null;
let prevLastHash = null;
let rows = 0;
const fail = (hour, what) => { console.error(`FAIL ${hour}: ${what}`); process.exit(1); };
for (const [i, { file, text, digest }] of digests.entries()) {
  const { sig, ...signed } = digest;
  const jwk = keys.find((k) => k.kid === digest.key_id);
  if (!jwk) fail(digest.hour, `no public key ${digest.key_id}`);
  const key = await webcrypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
  if (!(await webcrypto.subtle.verify({ name: "Ed25519" }, key, unb64url(sig), Buffer.from(canonical(signed))))) fail(digest.hour, "signature");
  if (i > 0 && digest.prev_digest !== prevDigest) fail(digest.hour, "does not follow the previous digest");
  const archive = readFileSync(file.replace(/\.digest\.json$/, ".jsonl.gz"));
  if (sha(archive) !== digest.archive_sha256) fail(digest.hour, "archive hash");
  const lines = gunzipSync(archive).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  if (lines.length !== digest.count) fail(digest.hour, "row count");
  if (i > 0 && prevLastHash && lines[0].prev_hash !== prevLastHash && digest.first_prev_hash !== prevLastHash) fail(digest.hour, "a gap before this hour");
  for (const [j, r] of lines.entries()) {
    if (j > 0 && r.prev_hash !== lines[j - 1].hash) fail(digest.hour, `row ${r.seq} does not follow row ${lines[j - 1].seq}`);
    if (sha(`${r.prev_hash || ""}\n${r.seq}\n${canonical(r.body)}`) !== r.hash) fail(digest.hour, `row ${r.seq} hash`);
  }
  if (lines[0].hash !== digest.first_hash || lines[lines.length - 1].hash !== digest.last_hash) fail(digest.hour, "first or last hash");
  prevDigest = sha(text);
  prevLastHash = digest.last_hash;
  rows += lines.length;
}
console.log(`OK: ${digests.length} hours, ${rows} rows, ${digests[0].digest.hour} … ${digests[digests.length - 1].digest.hour}`);
