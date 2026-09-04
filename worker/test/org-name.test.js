import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";

// The id routes sockets, keys memberships, and is stored inside card data. The
// name exists only so a person never has to read it. Keeping those apart is the
// whole point of this table, so it is what these tests hold down.

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

test("renaming an org never changes its id", async () => {
  const { upsertOrg, renameOrg, getOrg } = await import("../src/db.js");
  const id = "personal:abc123";

  await upsertOrg(env.DB, id, "Kinjal's team");
  await renameOrg(env.DB, id, "Acme Design");

  const org = await getOrg(env.DB, id);
  expect(org.id).toBe(id);
  expect(org.name).toBe("Acme Design");

  // And nothing else answers to the new name.
  const { results } = await env.DB.prepare("SELECT id FROM orgs").all();
  expect(results.map((r) => r.id)).toEqual([id]);
});

test("creating an org twice does not overwrite a chosen name", async () => {
  const { upsertOrg, renameOrg, getOrg } = await import("../src/db.js");
  const id = "acme/app";

  await upsertOrg(env.DB, id, "acme/app");
  await renameOrg(env.DB, id, "The Acme Team");
  // Signing in again passes the default through; it must not win.
  await upsertOrg(env.DB, id, "acme/app");

  expect((await getOrg(env.DB, id)).name).toBe("The Acme Team");
});

test("an org with no row is absent rather than an error", async () => {
  const { getOrg } = await import("../src/db.js");
  // Every org predating this table has no row, so callers fall back to the id.
  expect(await getOrg(env.DB, "never/created")).toBeNull();
});
