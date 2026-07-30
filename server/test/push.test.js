import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { createAPNS, createPushRegistry, shouldNotify } from "../push.js";

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

test("registry: register, move between users, prune", () => {
  const registry = createPushRegistry(null);
  assert.equal(registry.register("user-alice", TOKEN_A), true);
  assert.deepEqual(registry.tokensFor("user-alice"), [TOKEN_A]);

  // Same device switches to Bob — the token moves.
  registry.register("user-bob", TOKEN_A);
  assert.deepEqual(registry.tokensFor("user-alice"), []);
  assert.deepEqual(registry.tokensFor("user-bob"), [TOKEN_A]);

  registry.register("user-bob", TOKEN_B);
  registry.prune(TOKEN_A);
  assert.deepEqual(registry.tokensFor("user-bob"), [TOKEN_B]);
});

test("registry: rejects junk tokens and round-trips serialization", () => {
  const registry = createPushRegistry(null);
  assert.equal(registry.register("user-alice", "not-a-token!"), false);
  assert.equal(registry.register("", TOKEN_A), false);

  registry.register("user-alice", TOKEN_A);
  const restored = createPushRegistry(registry.serialize());
  assert.deepEqual(restored.tokensFor("user-alice"), [TOKEN_A]);
});

test("policy: only pending high/urgent cards for offline users ring", () => {
  const base = { recipientUserID: "user-bob", status: "pending", priority: "urgent" };

  assert.equal(shouldNotify({ card: base, onlineUserIDs: [] }), true);
  assert.equal(shouldNotify({ card: { ...base, priority: "high" }, onlineUserIDs: [] }), true);
  assert.equal(shouldNotify({ card: { ...base, priority: "medium" }, onlineUserIDs: [] }), false);
  assert.equal(shouldNotify({ card: { ...base, priority: "low" }, onlineUserIDs: [] }), false);
  assert.equal(shouldNotify({ card: base, onlineUserIDs: ["user-bob"] }), false);
  assert.equal(shouldNotify({ card: { ...base, status: "approved" }, onlineUserIDs: [] }), false);
  assert.equal(shouldNotify({ card: {}, onlineUserIDs: [] }), false);
});

test("apns: unconfigured client refuses to send", async () => {
  const apns = createAPNS({});
  assert.equal(apns.configured, false);
  const result = await apns.send({ deviceToken: TOKEN_A, title: "t", body: "b" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_configured");
});

test("apns: provider JWT is a valid ES256 token", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });

  const apns = createAPNS({
    APNS_KEY_P8: pem,
    APNS_KEY_ID: "KEY123",
    APNS_TEAM_ID: "TEAM456",
    APNS_BUNDLE_ID: "com.tangle.tiktokforwork",
  });
  assert.equal(apns.configured, true);

  const token = apns.authToken();
  const [headerB64, payloadB64, signatureB64] = token.split(".");
  const decode = (part) =>
    JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());

  const header = decode(headerB64);
  assert.equal(header.alg, "ES256");
  assert.equal(header.kid, "KEY123");
  const payload = decode(payloadB64);
  assert.equal(payload.iss, "TEAM456");
  assert.ok(Number.isInteger(payload.iat));

  const signature = Buffer.from(
    signatureB64.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  );
  const valid = cryptoVerify(
    "sha256",
    Buffer.from(`${headerB64}.${payloadB64}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    signature
  );
  assert.equal(valid, true);

  // Cached within the refresh window.
  assert.equal(apns.authToken(), token);
});
