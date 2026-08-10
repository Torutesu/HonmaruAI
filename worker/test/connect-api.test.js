import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { createSession } from "../src/db.js";
import worker from "../src/index.js";

let token;
const ENV = () => ({ ...env, COMPOSIO_API_KEY: "ak-test" });
const call = (path, init) => worker.fetch(new Request("https://example.com" + path, init), ENV());

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  token = await createSession(env.DB, "900", "gho_conn");
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("connect returns a redirect url for this user", async () => {
  let sentBody;
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/connected_accounts/link", method: "POST",
      body: (b) => { sentBody = JSON.parse(b); return true; } })
    .reply(200, { redirect_url: "https://connect.composio.dev/link/lk_x",
                  connected_account_id: "ca_x" });

  const res = await call("/connectors/slack/connect", {
    method: "POST", headers: { "x-session-token": token },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ redirectUrl: "https://connect.composio.dev/link/lk_x" });
  // The link must be minted for the caller, never a shared identity.
  expect(sentBody.user_id).toBe("900");
  expect(sentBody.auth_config_id).toBe("ac_qv8jozIjt29D");
});

test("status reports which connectors this user has", async () => {
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: (p) => p.startsWith("/api/v3/connected_accounts") })
    .reply(200, { items: [{ id: "ca_1", user_id: "900", status: "ACTIVE", toolkit: { slug: "gmail" } }] });

  const res = await call("/connectors", { headers: { "x-session-token": token } });
  expect(res.status).toBe(200);
  const { connectors } = await res.json();
  expect(connectors.find((c) => c.id === "gmail").status).toBe("active");
  expect(connectors.find((c) => c.id === "slack").status).toBe("none");
});

test("both endpoints need a session", async () => {
  expect((await call("/connectors", {})).status).toBe(401);
  expect((await call("/connectors/slack/connect", { method: "POST" })).status).toBe(401);
});
