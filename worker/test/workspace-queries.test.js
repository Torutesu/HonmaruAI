import { expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import baseline from "./fixtures/queries-without-org.json";

// Every workspace's rows share one database, kept apart only by `org_id` on
// every query (docs/architecture/security-and-scale-hardening.md P2 #9). A
// query on a workspace table that does not name `org_id` can reach another
// company's rows. Some are right to: a lookup by a token's hash, a deleted
// account's rows across every workspace, a row by an id that is unique
// everywhere. Those are counted here, per file, as they stand; a new one
// fails this test until someone has looked at it and raised the count, or
// added `org_id` to the query.

const sources = import.meta.glob("../src/**/*.js", { query: "?raw", import: "default", eager: true });

/// The tables that keep rows by workspace.
function workspaceTables() {
  const out = new Set();
  for (const m of schemaSql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
    if (/^\s*org_id\s/m.test(m[2])) out.add(m[1]);
  }
  return out;
}

const LITERAL = /(`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g;

function countsNow() {
  const tables = [...workspaceTables()];
  const touches = new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO)\\s+(?:${tables.join("|")})\\b`, "i");
  const counts = {};
  for (const [path, text] of Object.entries(sources)) {
    for (const [lit] of text.matchAll(LITERAL)) {
      const sql = lit.slice(1, -1);
      if (!/^\s*(SELECT|UPDATE|DELETE|INSERT|WITH)\b/i.test(sql) || !touches.test(sql)) continue;
      if (sql.includes("org_id")) continue;
      const file = path.replace("../src/", "");
      counts[file] = (counts[file] || 0) + 1;
    }
  }
  return counts;
}

test("no new query reaches a workspace table without naming the workspace", () => {
  const now = countsNow();
  const grown = Object.entries(now).filter(([file, n]) => n > (baseline[file] || 0)).map(([file, n]) => `${file}: ${baseline[file] || 0} → ${n}`);
  expect(grown, "A query on a workspace table without org_id. Add org_id, or if it is right not to, raise its count in test/fixtures/queries-without-org.json and say why in the query's comment.").toEqual([]);
});

test("the counts are kept honest: one that fell is lowered", () => {
  const now = countsNow();
  const stale = Object.entries(baseline).filter(([file, n]) => (now[file] || 0) < n).map(([file, n]) => `${file}: ${n} → ${now[file] || 0}`);
  expect(stale, "Fewer queries without org_id than counted: lower the count in test/fixtures/queries-without-org.json.").toEqual([]);
});
