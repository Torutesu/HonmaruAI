import { SELF, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { routeLabel, safe } from "../src/log.js";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

test("routes collapse ids so lines group", () => {
  // Two people reading two orgs' histories are the same route. A per-org label
  // makes that impossible to see at a glance, which is the only thing a log
  // line is for.
  expect(routeLabel("GET", "/orgs/acme/app/events")).toBe("GET /orgs/:owner/:repo/events");
  expect(routeLabel("GET", "/orgs/acme/app/cards/c-123/events"))
    .toBe("GET /orgs/:owner/:repo/cards/:id/events");
  expect(routeLabel("GET", "/media/8f2c-uuid")).toBe("GET /media/:id");
  expect(routeLabel("POST", "/connectors/gmail/sync")).toBe("POST /connectors/:id/sync");
  expect(routeLabel("POST", "/ai/route")).toBe("POST /ai/route");
});

test("credentials never reach a log line", () => {
  // A log that leaks the thing the product exists to protect is worse than no
  // log at all.
  expect(safe("failed with gho_16C7e42F292c6912E7710c838347Ae178B4a")).toBe("failed with [redacted]");
  expect(safe("Authorization: Bearer sk-proj-abc123")).toBe("Authorization: [redacted]");
  expect(safe("OpenAI rejected sk-abc123def")).toBe("OpenAI rejected [redacted]");
  expect(safe("x".repeat(900)).length).toBe(500);
});

test("every response carries the id its log line was written under", async () => {
  const res = await SELF.fetch("https://example.com/health");
  expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
});

test("a malformed body is refused as the caller's mistake, not ours", async () => {
  // `await request.json()` on this used to escape as an unhandled throw and
  // become a raw Workers error page. It was then caught and answered "something
  // went wrong on our side" — truthful about the crash, wrong about whose fault
  // it was, and unactionable either way. A body we cannot read is a 400.
  const res = await SELF.fetch("https://example.com/ai/route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.message).toBe("The request could not be read.");
  expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.stringify(body)).not.toMatch(/at |\.js:/);
});
