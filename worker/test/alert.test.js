import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import { alert } from "../src/alert.js";

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

const ctx = () => {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(p) };
};

// No URL configured means no alert and no throw — most deployments will
// never set one, and the code must be silent there, not broken.
test("unconfigured alerting is silent", () => {
  const c = ctx();
  expect(() => alert(c, {}, "unconfigured-kind", "nothing happened")).not.toThrow();
  expect(c.pending).toHaveLength(0);
});

test("a configured webhook hears the kind and the detail", async () => {
  let posted;
  fetchMock.get("https://hooks.example.com")
    .intercept({ path: "/ops", method: "POST", body: (b) => { posted = JSON.parse(b); return true; } })
    .reply(200, {});

  const c = ctx();
  alert(c, { ALERT_WEBHOOK_URL: "https://hooks.example.com/ops" }, "test-webhook", "sync blew up");
  await Promise.all(c.pending);

  expect(posted.text).toContain("test-webhook");
  expect(posted.text).toContain("sync blew up");
});

// A 500 on every request must not become a Slack message on every request.
test("the same kind is throttled to one a minute", async () => {
  let calls = 0;
  fetchMock.get("https://hooks.example.com")
    .intercept({ path: "/throttle", method: "POST" })
    .reply(200, {})
    .persist();

  const env = { ALERT_WEBHOOK_URL: "https://hooks.example.com/throttle" };
  const c1 = ctx();
  const c2 = ctx();
  alert(c1, env, "test-throttle", "first");
  alert(c2, env, "test-throttle", "second");
  await Promise.all([...c1.pending, ...c2.pending]);
  // The second call produced no waitUntil work at all — it never reached fetch.
  expect(c2.pending).toHaveLength(0);
});
