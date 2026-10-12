import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// Every answer said `access-control-allow-origin: *`: any site open in a
// person's browser could call the API and read what came back.

let token;
beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9901", login: "ann", name: "Ann", avatarUrl: null, locale: "en" });
  token = await createSession(env.DB, "9901", "x");
});

const ask = (path, origin, init = {}, base = "https://api.example.com", withEnv = env) =>
  worker.fetch(new Request(base + path, { ...init, headers: { ...(origin ? { origin } : {}), "x-session-token": token, ...(init.headers || {}) } }), withEnv, { waitUntil() {} });

test("the app's own pages are answered by name; any other page is not answered at all", async () => {
  const ours = await ask("/me", "https://app.honmaruai.com");
  expect(ours.status).toBe(200);
  expect(ours.headers.get("access-control-allow-origin")).toBe("https://app.honmaruai.com");
  expect(ours.headers.get("vary")).toContain("Origin");
  const theirs = await ask("/me", "https://evil.example");
  expect(theirs.headers.get("access-control-allow-origin")).toBeNull();
  // The preflight too: the browser does not send the request.
  const pre = await ask("/channels/messages", "https://evil.example", { method: "OPTIONS" });
  expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  expect((await ask("/channels/messages", "https://app.honmaruai.com", { method: "OPTIONS" })).headers.get("access-control-allow-origin")).toBe("https://app.honmaruai.com");
});

test("APP_WEB_URL, CORS_ORIGINS, previews and a local Worker are ours; a native app sends no Origin and is unaffected", async () => {
  const configured = { ...env, APP_WEB_URL: "https://chat.acme.example/", CORS_ORIGINS: "https://staging.honmaru.example, https://other.example" };
  expect((await ask("/me", "https://chat.acme.example", {}, undefined, configured)).headers.get("access-control-allow-origin")).toBe("https://chat.acme.example");
  expect((await ask("/me", "https://other.example", {}, undefined, configured)).headers.get("access-control-allow-origin")).toBe("https://other.example");
  expect((await ask("/me", "https://1a2b3c.honmaru-web.pages.dev")).headers.get("access-control-allow-origin")).toBe("https://1a2b3c.honmaru-web.pages.dev");
  expect((await ask("/me", "http://localhost:5173", {}, "http://localhost:8787")).headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  // A page on localhost is nobody's app against the real API.
  expect((await ask("/me", "http://localhost:5173")).headers.get("access-control-allow-origin")).toBeNull();
  const native = await ask("/me", null);
  expect(native.status).toBe(200);
  expect(native.headers.get("access-control-allow-origin")).toBe("*");
});

test("what any page may fetch keeps answering any page", async () => {
  expect((await ask("/health", "https://evil.example")).headers.get("access-control-allow-origin")).toBe("*");
  const mcp = await ask("/mcp", "https://inspector.example", { method: "OPTIONS" });
  expect(mcp.headers.get("access-control-allow-origin")).toBe("*");
});

test("CORS_ENFORCE=off is the way back", async () => {
  expect((await ask("/me", "https://evil.example", {}, undefined, { ...env, CORS_ENFORCE: "off" })).headers.get("access-control-allow-origin")).toBe("*");
});
