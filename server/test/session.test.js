import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessionStore,
  parseCookies,
  serializeCookie,
  clearCookie,
  originFor,
} from "../session.js";
import { resolveStaticFile } from "../static.js";
import { createPushRegistry, createWebPush } from "../push.js";

test("cookies: parse, serialize, clear", () => {
  assert.deepEqual(parseCookies("a=1; ttfw_session=abc%20d; b=2"), {
    a: "1",
    ttfw_session: "abc d",
    b: "2",
  });
  assert.deepEqual(parseCookies(undefined), {});

  const cookie = serializeCookie("ttfw_session", "xyz");
  assert.ok(cookie.includes("HttpOnly"));
  assert.ok(cookie.includes("Secure"));
  assert.ok(cookie.includes("SameSite=Lax"));
  assert.ok(!serializeCookie("k", "v", { secure: false }).includes("Secure"));
  assert.ok(clearCookie("ttfw_session").includes("Max-Age=0"));
});

test("oauth state is single-use and rejects forgeries", () => {
  const store = createSessionStore(null);
  const state = store.beginAuth();

  assert.equal(store.consumeAuth(state), true);
  assert.equal(store.consumeAuth(state), false, "replay must fail");
  assert.equal(store.consumeAuth("forged-state"), false);
  assert.equal(store.consumeAuth(undefined), false);
});

test("oauth state expires after its TTL", () => {
  const store = createSessionStore(null);
  const now = Date.now();
  const state = store.beginAuth(now);
  assert.equal(store.consumeAuth(state, now + 11 * 60 * 1000), false);
});

test("sessions: create, read via cookie, update, destroy", () => {
  const store = createSessionStore(null);
  const id = store.create({
    userId: "user-alice",
    githubToken: "gho_secret",
    githubLogin: "alice",
  });

  const req = { headers: { cookie: `ttfw_session=${id}` } };
  const found = store.fromRequest(req);
  assert.equal(found.session.userId, "user-alice");
  assert.equal(found.session.githubToken, "gho_secret");

  assert.equal(store.setRepository(id, "torutesu/honmaruai"), true);
  assert.equal(store.get(id).repository, "torutesu/honmaruai");

  assert.equal(store.destroy(id), true);
  assert.equal(store.fromRequest(req), null);
  assert.equal(store.get("nope"), null);
});

test("sessions expire and survive a restart", () => {
  const store = createSessionStore(null);
  const now = Date.now();
  const id = store.create({ userId: "user-bob", githubToken: "t" }, now);
  assert.equal(store.get(id, now + 31 * 24 * 3600 * 1000), null);

  const fresh = createSessionStore(null);
  const keep = fresh.create({ userId: "user-bob", githubToken: "t" });
  const restored = createSessionStore(fresh.serialize());
  assert.equal(restored.get(keep).userId, "user-bob");
});

test("originFor prefers explicit config, then forwarded proto", () => {
  const req = { headers: { host: "relay.example.com", "x-forwarded-proto": "https" } };
  assert.equal(originFor(req, "https://app.example.com/"), "https://app.example.com");
  assert.equal(originFor(req, ""), "https://relay.example.com");
  assert.equal(
    originFor({ headers: { host: "127.0.0.1:8080" }, socket: {} }, ""),
    "http://127.0.0.1:8080"
  );
});

test("static: serves files and falls back to index.html for SPA routes", () => {
  const root = mkdtempSync(join(tmpdir(), "ttfw-web-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<html></html>");
  writeFileSync(join(root, "assets", "app.a1b2c3d4.js"), "//");

  assert.ok(resolveStaticFile(root, "/index.html").endsWith("index.html"));
  assert.ok(resolveStaticFile(root, "/assets/app.a1b2c3d4.js").endsWith("app.a1b2c3d4.js"));
  // SPA route (no extension) → shell
  assert.ok(resolveStaticFile(root, "/settings").endsWith("index.html"));
  // Missing asset with an extension → 404, never the shell
  assert.equal(resolveStaticFile(root, "/assets/missing.js"), null);
  // Disabled when no build exists
  assert.equal(resolveStaticFile("", "/"), null);
  assert.equal(resolveStaticFile(join(root, "nope"), "/"), null);
});

test("static: never resolves outside the web root", () => {
  const parent = mkdtempSync(join(tmpdir(), "ttfw-outside-"));
  const root = join(parent, "dist");
  mkdirSync(root);
  writeFileSync(join(root, "index.html"), "<html></html>");
  // A secret sitting next to the web root — must stay unreachable.
  writeFileSync(join(parent, "secret.env"), "APNS_KEY_P8=...");

  for (const attack of [
    "/../secret.env",
    "/../../etc/passwd.txt",
    "/assets/../../secret.env",
    "/%2e%2e/secret.env",
  ]) {
    const resolved = resolveStaticFile(root, attack);
    if (resolved !== null) {
      // Containment is the guarantee: an unknown in-root path may resolve to
      // the SPA shell, but never to a file outside the root.
      assert.ok(
        resolved.startsWith(root + "/"),
        `${attack} escaped the web root: ${resolved}`
      );
      assert.ok(!resolved.includes("secret.env"));
    }
  }
});

test("push registry holds ios and web targets side by side", () => {
  const registry = createPushRegistry(null);
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    keys: { p256dh: "k", auth: "a" },
  };

  assert.equal(registry.register("user-alice", "a".repeat(64)), true);
  assert.equal(registry.registerWeb("user-alice", subscription), true);

  const targets = registry.targetsFor("user-alice");
  assert.deepEqual(targets.map((t) => t.platform).sort(), ["ios", "web"]);
  assert.deepEqual(registry.tokensFor("user-alice"), ["a".repeat(64)]);

  // A browser subscription moves with the user, like a device token
  registry.registerWeb("user-bob", subscription);
  assert.deepEqual(registry.targetsFor("user-alice").map((t) => t.platform), ["ios"]);

  registry.prune(subscription.endpoint);
  assert.deepEqual(registry.targetsFor("user-bob"), []);
});

test("push registry rejects malformed web subscriptions", () => {
  const registry = createPushRegistry(null);
  assert.equal(registry.registerWeb("user-alice", { endpoint: "http://insecure" }), false);
  assert.equal(registry.registerWeb("user-alice", { endpoint: "https://x" }), false, "keys required");
  assert.equal(registry.registerWeb("", { endpoint: "https://x", keys: { p256dh: "k", auth: "a" } }), false);
});

test("legacy string push tokens still load", () => {
  const registry = createPushRegistry({ tokens: { "user-alice": ["b".repeat(64)] } });
  assert.deepEqual(registry.tokensFor("user-alice"), ["b".repeat(64)]);
  assert.equal(registry.targetsFor("user-alice")[0].platform, "ios");
});

test("web push is disabled without VAPID keys", async () => {
  const push = createWebPush({});
  assert.equal(push.configured, false);
  const result = await push.send({ subscription: {}, title: "t", body: "b" });
  assert.equal(result.reason, "not_configured");
});
