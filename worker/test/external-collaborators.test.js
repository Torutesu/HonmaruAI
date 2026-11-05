import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import migrationsSql from "../migrations.sql?raw";
import {
  externalResourcePermission,
  grantExternalResource,
  revokeExternalResource,
} from "../src/harness/externalCollaborators.js";

const migration = migrationsSql.split("\n").filter((line) =>
  /^CREATE (TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS hx_external_resource_grants/.test(line));

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  for (const statement of migration) await env.DB.exec(statement);
});

async function identity(id) {
  await env.DB.prepare("INSERT OR IGNORE INTO users (github_id, login, created_at) VALUES (?1, ?2, ?3)")
    .bind(id, id, "2026-11-06T00:00:00.000Z").run();
}

async function workspace(id) {
  await env.DB.prepare("INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES (?1, ?2, ?3)")
    .bind(id, id, "2026-11-06T00:00:00.000Z").run();
}

test("a named external identity gets only its exact resource and permission without membership", async () => {
  const suffix = crypto.randomUUID();
  const orgId = `external-org-${suffix}`;
  const owner = `external-owner-${suffix}`;
  const guest = `external-guest-${suffix}`;
  await workspace(orgId);
  await identity(owner);
  await identity(guest);

  await grantExternalResource(env.DB, {
    orgId, resourceType: "thread", resourceId: "thread-1",
    recipientGithubId: guest, permission: "view", grantedBy: owner,
  });

  expect(await externalResourcePermission(env.DB, {
    orgId, resourceType: "thread", resourceId: "thread-1", githubId: guest,
  })).toBe("view");
  expect(await externalResourcePermission(env.DB, {
    orgId, resourceType: "thread", resourceId: "thread-2", githubId: guest,
  })).toBeNull();
  expect(await externalResourcePermission(env.DB, {
    orgId: `${orgId}-other`, resourceType: "thread", resourceId: "thread-1", githubId: guest,
  })).toBeNull();
  expect(await externalResourcePermission(env.DB, {
    orgId, resourceType: "thread", resourceId: "thread-1", githubId: guest, principalType: "agent",
  })).toBeNull();
  expect(await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(orgId, guest).first()).toBeNull();
});

test("edit implies view; revocation takes effect immediately and keeps grant history", async () => {
  const suffix = crypto.randomUUID();
  const orgId = `external-org-${suffix}`;
  const owner = `external-owner-${suffix}`;
  const guest = `external-guest-${suffix}`;
  await workspace(orgId);
  await identity(owner);
  await identity(guest);
  const grant = await grantExternalResource(env.DB, {
    orgId, resourceType: "app", resourceId: "app-1",
    recipientGithubId: guest, permission: "edit", grantedBy: owner,
  });

  expect(await externalResourcePermission(env.DB, {
    orgId, resourceType: "app", resourceId: "app-1", githubId: guest,
  })).toBe("edit");
  expect(await revokeExternalResource(env.DB, {
    orgId, resourceType: "app", resourceId: "app-1", recipientGithubId: guest, revokedBy: owner,
  })).toBe(1);
  expect(await externalResourcePermission(env.DB, {
    orgId, resourceType: "app", resourceId: "app-1", githubId: guest,
  })).toBeNull();
  expect(await env.DB.prepare("SELECT revoked_at, revoked_by FROM hx_external_resource_grants WHERE id = ?1")
    .bind(grant.id).first()).toMatchObject({ revoked_by: owner });
});

test("expired grants and malformed or cross-workspace scopes fail closed", async () => {
  const suffix = crypto.randomUUID();
  const orgId = `external-org-${suffix}`;
  const owner = `external-owner-${suffix}`;
  const guest = `external-guest-${suffix}`;
  await workspace(orgId);
  await identity(owner);
  await identity(guest);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await grantExternalResource(env.DB, {
    orgId, resourceType: "file", resourceId: "file-1",
    recipientGithubId: guest, permission: "view", grantedBy: owner,
    expiresAt,
  });

  expect(await externalResourcePermission(env.DB, {
    orgId, resourceType: "file", resourceId: "file-1", githubId: guest,
    now: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  })).toBeNull();
  await expect(grantExternalResource(env.DB, {
    orgId, resourceType: "workspace", resourceId: `${orgId}-other`,
    recipientGithubId: guest, permission: "edit", grantedBy: owner,
  })).rejects.toThrow(/Workspace grants/);
  expect(await externalResourcePermission(env.DB, {
    orgId, resourceType: "unknown", resourceId: "file-1", githubId: guest,
  })).toBeNull();
});
