import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { resolveMentions } from "../src/threads.js";
import { listMembers } from "../src/team.js";

// A person names themselves — a display name and a username — and @ finds
// them by either.

const ORG = "personal:names";
let toru; let mika;
const call = (path, init) => worker.fetch(new Request("https://example.com" + path, init), env);
const put = (token, body) => call("/me", { method: "PUT", headers: { "content-type": "application/json", "x-session-token": token }, body: JSON.stringify(body) });

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9901", login: "torutesu", name: "torutesu", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "email:mika@example.com", login: "u:mika@example.com", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "9901", "admin");
  await upsertMembership(env.DB, ORG, "email:mika@example.com", "member");
  toru = await createSession(env.DB, "9901", "gho_t");
  mika = await createSession(env.DB, "email:mika@example.com", "gho_m");
});

test("a name and a username are set, read back, and the name survives the next GitHub sign-in", async () => {
  const res = await put(toru, { name: "  Toru Tano ", handle: "@Toru" });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ name: "Toru Tano", handle: "toru" });
  const me = await (await call("/me", { headers: { "x-session-token": toru } })).json();
  expect(me).toMatchObject({ name: "Toru Tano", handle: "toru" });
  const { upsertUser } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9901", login: "torutesu", name: "torutesu (GitHub)", avatarUrl: null, locale: "ja" });
  const again = await (await call("/me", { headers: { "x-session-token": toru } })).json();
  expect(again.name).toBe("Toru Tano");
});

test("a username is checked, reserved words are refused, and one person's is not another's", async () => {
  expect((await put(toru, { handle: "a" })).status).toBe(400);
  expect((await put(toru, { handle: "has space" })).status).toBe(400);
  expect((await put(toru, { handle: "ai" })).status).toBe(400);
  expect((await put(toru, { handle: "toru" })).status).toBe(200);
  const taken = await put(mika, { handle: "TORU" });
  expect(taken.status).toBe(409);
  expect((await taken.json()).field).toBe("handle");
  expect((await put(toru, { name: "" })).status).toBe(400);
  expect((await put(toru, { name: "x".repeat(61) })).status).toBe(400);
  // Clearing a username is allowed.
  expect((await put(toru, { handle: "" })).status).toBe(200);
});

test("@ finds a person by username, by the name they chose, and the router knows the username", async () => {
  await put(mika, { name: "Mika Sato", handle: "mikas" });
  await put(toru, { handle: "toru" });
  const members = await listMembers(env.DB, ORG, "9901");
  expect(members.find((m) => m.name === "Mika Sato").handle).toBe("mikas");
  expect(resolveMentions("@mikas please approve", members).map((m) => m.login)).toEqual(["u:mika@example.com"]);
  expect(resolveMentions("@Mika please approve", members).map((m) => m.login)).toEqual(["u:mika@example.com"]);
  const { listOrgNodes } = await import("../src/db.js");
  const node = (await listOrgNodes(env.DB, ORG)).find((n) => n.id === "u:mika@example.com");
  expect(node.aliases).toContain("mikas");
  // The client's member list carries the username, never the login.
  const list = await (await call(`/members?orgId=${encodeURIComponent(ORG)}`, { headers: { "x-session-token": toru } })).json();
  const shown = list.members.find((m) => m.name === "Mika Sato");
  expect(shown.handle).toBe("mikas");
  expect(JSON.stringify(list)).not.toContain("mika@example.com");
});
