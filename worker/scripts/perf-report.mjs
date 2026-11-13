#!/usr/bin/env node
// The chat's own waits, as the apps measured them (#845, findings 6–7):
// p50/p95 of each kind, per app, over the last few days, from perf_samples.
//
//   cd worker && node scripts/perf-report.mjs [days]
//
// Run by .github/workflows/perf-report.yml with the deploy's Cloudflare
// token. Reads only. WRANGLER and DB override the command and database.

import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const DB = process.env.DB || "tiktokforwork";
const [command, ...prefix] = (process.env.WRANGLER || "npx -y wrangler@4.149.0").split(" ");
const days = Math.max(1, Math.min(14, Number(process.argv[2]) || 7));

export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

/// Per kind and app: how many, p50, p95, max.
export function summarize(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.kind}\t${r.client}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(Number(r.value));
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => {
    const [kind, client] = key.split("\t");
    const sorted = values.sort((a, b) => a - b);
    return { kind, client, n: sorted.length, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), max: sorted[sorted.length - 1] };
  });
}

/// What the numbers say about the two findings.
export function findings(rows) {
  const of = (kind) => rows.filter((r) => r.kind === kind).map((r) => Number(r.value));
  const queue = of("send.queue"); const http = of("send.http");
  const waited = queue.filter((v) => v >= 50).length;
  const opens = ["open.fresh", "open.revalidate", "open.cold", "open.remount"].map((k) => [k, of(k).length]);
  const total = opens.reduce((n, [, c]) => n + c, 0);
  const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "—");
  return [
    `- sends: ${http.length}; waited ≥50 ms behind an earlier one: ${waited} (${pct(waited, queue.length)})`,
    `- opens: ${total}; ${opens.map(([k, c]) => `${k.slice(5)} ${c} (${pct(c, total)})`).join(", ")}`,
    `- thread refreshes after a reconnect: ${of("thread.pages").length}; more than one page: ${of("thread.pages").filter((v) => v > 1).length}`,
  ];
}

async function main() {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { stdout } = await run(command, [...prefix, "d1", "execute", DB, "--remote", "--json", "--command",
    `SELECT kind, value, client, colo FROM perf_samples WHERE created_at >= '${since}' ORDER BY kind`], { maxBuffer: 256 * 1024 * 1024 });
  const rows = JSON.parse(stdout.slice(stdout.indexOf("["))).flatMap((p) => p.results || []);
  const lines = [
    `## Chat waits, last ${days} day${days === 1 ? "" : "s"} (${rows.length} samples)`, "",
    ...findings(rows), "",
    "| kind | app | n | p50 ms | p95 ms | max ms |", "| --- | --- | --- | --- | --- | --- |",
    ...summarize(rows).map((s) => `| ${s.kind} | ${s.client} | ${s.n} | ${s.p50} | ${s.p95} | ${s.max} |`), "",
    // Where the time goes, by the data centre that answered: a far reader
    // waits on the distance to the database on every statement.
    "| kind | app | data centre | n | p50 ms | p95 ms |", "| --- | --- | --- | --- | --- | --- |",
    ...summarize(rows.filter((r) => r.colo && ["send.http", "send.server", "read.server", "open.cold", "open.revalidate"].includes(r.kind)).map((r) => ({ ...r, client: `${r.client}\u0000${r.colo}` })))
      .map((s) => { const [client, colo] = s.client.split("\u0000"); return `| ${s.kind} | ${client} | ${colo} | ${s.n} | ${s.p50} | ${s.p95} |`; }), "",
  ];
  const text = lines.join("\n") + "\n";
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
