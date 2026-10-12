import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { aad, forgetWorkspaceKey, openField, sealField, useSecretKey } from "../src/secrets.js";

// One key sealed every workspace's secrets: nothing set one tenant's apart
// from another's, and deleting a workspace left its secrets readable in any
// backup. Each workspace now has a key of its own.

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM workspace_keys;");
  useSecretKey({ DB: env.DB, DATA_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))) });
});
afterEach(() => useSecretKey({ DB: env.DB }));

test("a workspace's secret is sealed under its own key, opens only as itself, and is gone with the key", async () => {
  const sealed = await sealField("sk-acme", aad.aiKey("team:acme", "openai_key"), "team:acme");
  expect(sealed).toMatch(/^enc:v2:/);
  expect(await openField(sealed, aad.aiKey("team:acme", "openai_key"))).toBe("sk-acme");
  // Copied into another workspace's row: the context differs, it does not open.
  expect(await openField(sealed, aad.aiKey("team:other", "openai_key"))).toBeNull();
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM workspace_keys").first()).n).toBe(1);
  // One per workspace.
  await sealField("sk-other", aad.aiKey("team:other", "openai_key"), "team:other");
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM workspace_keys").first()).n).toBe(2);

  // The workspace deleted, its key with it: the value opens nowhere.
  await env.DB.prepare("DELETE FROM workspace_keys WHERE org_id = 'team:acme'").run();
  forgetWorkspaceKey("team:acme");
  expect(await openField(sealed, aad.aiKey("team:acme", "openai_key"))).toBeNull();
});

test("a value sealed before, under the deployment's key, still opens", async () => {
  const before = await sealField("gho_x", aad.githubWorkspace("team:acme"));
  expect(before).toMatch(/^enc:v1:/);
  expect(await openField(before, aad.githubWorkspace("team:acme"))).toBe("gho_x");
});
