import { reset, env } from "cloudflare:test";
import { beforeEach } from "vitest";
import schemaSql from "../schema.sql?raw";

// vitest-pool-workers 0.22 isolates storage per FILE — the suite was written
// against per-test isolation, where a test's writes never reached the next
// one. reset() gives that back: wipe everything, then put the schema back so
// a file's beforeEach seeds land on real tables. Hooks here run before the
// test file's own beforeEach, so seeds still apply on top.
beforeEach(async () => {
  await reset();
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});
