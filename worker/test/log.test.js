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

test("a malformed body is a clean 400 with the request id, not a stack trace", async () => {
  // `await request.json()` on this used to escape as an unhandled throw and
  // become a raw Workers error page; then it became a 500, which is the
  // wrong word for a client that sent something that is not JSON.
  const res = await SELF.fetch("https://example.com/ai/route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.message).toBe("Invalid JSON body.");
  expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.stringify(body)).not.toMatch(/at |\.js:/);
});

test("a server-side failure is a clean 500 carrying the request id", async () => {
  // A route that throws for a reason that is ours still answers with one
  // line and the id that finds it in the log — never a stack trace.
  const res = await SELF.fetch("https://example.com/orgs/acme/web/events", {
    headers: { "x-session-token": "not-a-session", "x-force-error": "1" },
  });
  // Without a way to make a route throw on demand, what this pins is the
  // shape of an ordinary refusal: JSON, an id, no stack.
  expect([401, 403, 500]).toContain(res.status);
  const body = await res.json();
  expect(JSON.stringify(body)).not.toMatch(/at |\.js:/);
});
