import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { createSession, getConnectorConfig } from "../src/db.js";
import worker from "../src/index.js";

let token;
const ENV = () => ({ ...env, COMPOSIO_API_KEY: "ak-test" });
const call = (path, init) => worker.fetch(new Request("https://example.com" + path, init), ENV());

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  token = await createSession(env.DB, "800", "gho_notion");
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("databases are listed for the caller", async () => {
  let sent;
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: (p) => p.includes("/tools/execute/"), method: "POST",
      body: (b) => { sent = JSON.parse(b); return true; } })
    .reply(200, { successful: true, data: { results: [
      { id: "db-1", title: [{ plain_text: "Decisions" }] }] } });

  const res = await call("/connectors/notion/databases", { headers: { "x-session-token": token } });
  expect(res.status).toBe(200);
  const { databases } = await res.json();
  expect(databases[0]).toMatchObject({ id: "db-1", title: "Decisions" });
  expect(sent.user_id).toBe("800");
  // The README pins the search to filter on the object type — a plain
  // filter_value returns pages too.
  expect(sent.arguments.filter_value).toBe("database");
  expect(sent.arguments.filter_property).toBe("object");
});

test("choosing a database is stored against this user", async () => {
  const res = await call("/connectors/notion/config", {
    method: "PUT",
    headers: { "x-session-token": token, "content-type": "application/json" },
    body: JSON.stringify({ databaseId: "db-1" }),
  });
  expect(res.status).toBe(200);
  expect(await getConnectorConfig(env.DB, "800", "notion")).toMatchObject({ databaseId: "db-1" });
});

test("both need a session", async () => {
  expect((await call("/connectors/notion/databases", {})).status).toBe(401);
  expect((await call("/connectors/notion/config", { method: "PUT" })).status).toBe(401);
});
