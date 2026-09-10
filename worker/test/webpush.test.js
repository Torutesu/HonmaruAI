import { SELF, env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import {
  vapidToken, resetVapidTokens, encryptPayload, decryptPayload, sendWebPush,
  isDeadSubscription, parseSubscription, b64url, fromB64url, vapidSubject,
} from "../src/webpush.js";
import { notifyCard } from "../src/notify.js";

// Web Push is the channel that reaches a browser, an Android phone and an
// iPhone that has never seen the App Store. These tests are about the two
// standards it stands on: the Worker proving who it is (VAPID) and the bytes
// on the wire being unreadable to the push service in between (aes128gcm).

async function vapidPair() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { publicKey: b64url(raw), privateKey: jwk.d, verifyKey: pair.publicKey };
}

/// What a browser holds: its own ECDH key pair and a 16-byte auth secret.
async function subscriber(endpoint) {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = b64url(crypto.getRandomValues(new Uint8Array(16)));
  return {
    endpoint, keys: { p256dh: b64url(raw), auth },
    privateKey: pair.privateKey, publicRaw: raw,
  };
}

let vapid;
let pushEnv;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  vapid = await vapidPair();
  pushEnv = {
    ...env,
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: "mailto:ops@example.com",
  };
  const { upsertUser, createSession } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "6001", login: "alice", name: "Alice", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "6002", login: "bob", name: "Bob", avatarUrl: null, locale: "ja" });
  globalThis.__aliceSession = await createSession(env.DB, "6001", "gho_alice");
});

beforeEach(() => {
  resetVapidTokens();
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("the VAPID token is an ES256 JWT for the push service's origin, and is reused", async () => {
  const jwt = await vapidToken(pushEnv, "https://push.example.com", 1_000_000);
  const [header, claims, signature] = jwt.split(".");
  expect(JSON.parse(new TextDecoder().decode(fromB64url(header)))).toEqual({ typ: "JWT", alg: "ES256" });
  const body = JSON.parse(new TextDecoder().decode(fromB64url(claims)));
  expect(body.aud).toBe("https://push.example.com");
  expect(body.sub).toBe("mailto:ops@example.com");
  // Push services refuse a token good for more than 24 hours.
  expect(body.exp - 1000).toBeLessThanOrEqual(24 * 60 * 60);

  // Verifiable with the public half, which is what the push service holds.
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, vapid.verifyKey, fromB64url(signature),
    new TextEncoder().encode(`${header}.${claims}`)
  );
  expect(ok).toBe(true);

  expect(await vapidToken(pushEnv, "https://push.example.com", 1_000_000 + 60_000)).toBe(jwt);
  expect(await vapidToken(pushEnv, "https://other.example.com", 1_000_000)).not.toBe(jwt);
});

test("a payload encrypted to a subscription decrypts with the subscriber's key, and only that key", async () => {
  const sub = await subscriber("https://push.example.com/send/abc");
  const message = JSON.stringify({ title: "承認: Q3予算", body: "aliceのAI → あなた", cardId: "c-1" });
  const { body } = await encryptPayload({ p256dh: sub.keys.p256dh, auth: sub.keys.auth, plaintext: message });

  // RFC 8188 header: 16-byte salt, 4-byte record size, 1-byte key id length, 65-byte key.
  expect(body.length).toBeGreaterThan(86);
  expect(new DataView(body.buffer, body.byteOffset).getUint32(16)).toBe(4096);
  expect(body[20]).toBe(65);
  // The message is not on the wire in the clear.
  expect(new TextDecoder().decode(body)).not.toContain("Q3");

  const decrypted = await decryptPayload({
    body, uaPrivateKey: sub.privateKey, uaPublicRaw: sub.publicRaw, auth: sub.keys.auth,
  });
  expect(decrypted).toBe(message);

  const stranger = await subscriber("https://push.example.com/send/xyz");
  await expect(decryptPayload({
    body, uaPrivateKey: stranger.privateKey, uaPublicRaw: stranger.publicRaw, auth: stranger.keys.auth,
  })).rejects.toThrow();
});

test("a payload too big for one record is refused, not sent unopenable", async () => {
  // The push service does not decrypt, so a record over `rs` is relayed and
  // answered 201 while the browser silently fails to open it — an absence with
  // no error on either side. The header says 4096; the encryptor has to mean it.
  const sub = await subscriber("https://push.example.com/send/big");
  const room = { p256dh: sub.keys.p256dh, auth: sub.keys.auth };

  // 4079 bytes of message plus the 0x02 delimiter plus the 16-byte GCM tag is
  // exactly the record size, and still fits.
  const exact = "x".repeat(4096 - 1 - 16);
  const { body } = await encryptPayload({ ...room, plaintext: exact });
  expect(body.length).toBeGreaterThan(4096);
  const back = await decryptPayload({
    body, uaPrivateKey: sub.privateKey, uaPublicRaw: sub.publicRaw, auth: sub.keys.auth,
  });
  expect(back).toBe(exact);

  // One byte more is not a smaller notification, it is an unopenable one.
  await expect(encryptPayload({ ...room, plaintext: `${exact}x` })).rejects.toThrow(/record size/);
});

test("sendWebPush posts encrypted bytes with VAPID and content-coding headers", async () => {
  const sub = await subscriber("https://push.example.com/send/headers");
  let seen;
  fetchMock.get("https://push.example.com")
    .intercept({ path: "/send/headers", method: "POST", headers: (h) => { seen = h; return true; } })
    .reply(201, "");

  const result = await sendWebPush(pushEnv, {
    subscription: { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    payload: { title: "hi" }, topic: "card-1", urgency: "high",
  });
  expect(result.ok).toBe(true);
  expect(seen.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  expect(seen.authorization).toContain(`k=${vapid.publicKey}`);
  expect(seen["content-encoding"]).toBe("aes128gcm");
  expect(seen["content-type"]).toBe("application/octet-stream");
  expect(seen.topic).toBe("card-1");
  expect(seen.urgency).toBe("high");
  expect(Number(seen.ttl)).toBeGreaterThan(0);
});

test("a subscription the push service says is gone is dropped, and a bad day is not", async () => {
  expect(isDeadSubscription({ status: 410 })).toBe(true);
  expect(isDeadSubscription({ status: 404 })).toBe(true);
  expect(isDeadSubscription({ status: 500 })).toBe(false);
  expect(isDeadSubscription({ status: 429 })).toBe(false);

  const { registerSubscription, subscriptionsForLogin } = await import("../src/db.js");
  const gone = await subscriber("https://push.example.com/send/gone");
  const flaky = await subscriber("https://push.example.com/send/flaky");
  await registerSubscription(env.DB, { endpoint: gone.endpoint, githubId: "6001", login: "alice", ...gone.keys });
  await registerSubscription(env.DB, { endpoint: flaky.endpoint, githubId: "6001", login: "alice", ...flaky.keys });

  fetchMock.get("https://push.example.com").intercept({ path: "/send/gone", method: "POST" }).reply(410, "");
  fetchMock.get("https://push.example.com").intercept({ path: "/send/flaky", method: "POST" }).reply(503, "");

  const result = await notifyCard(pushEnv, {
    card: { id: "c-dead", recipientUserID: "alice", senderUserID: "bob", title: "Sign the lease", status: "pending" },
    kind: "created", excludeLogin: "bob",
  });
  expect(result.sent).toBe(0);
  const left = await subscriptionsForLogin(env.DB, "alice");
  expect(left.map((s) => s.endpoint)).toEqual([flaky.endpoint]);
});

test("the recipient's browsers get the alert in their language", async () => {
  const { registerSubscription } = await import("../src/db.js");
  const phone = await subscriber("https://push.example.com/send/bob-phone");
  const laptop = await subscriber("https://push.example.com/send/bob-laptop");
  await registerSubscription(env.DB, { endpoint: phone.endpoint, githubId: "6002", login: "bob", ...phone.keys });
  await registerSubscription(env.DB, { endpoint: laptop.endpoint, githubId: "6002", login: "bob", ...laptop.keys });

  const bodies = {};
  for (const [name, sub] of [["phone", phone], ["laptop", laptop]]) {
    fetchMock.get("https://push.example.com")
      .intercept({ path: new URL(sub.endpoint).pathname, method: "POST" })
      .reply(201, (opts) => { bodies[name] = opts.body; return ""; });
  }

  const result = await notifyCard(pushEnv, {
    card: { id: "c-ja", recipientUserID: "bob", senderUserID: "alice", title: "Approve the lease", status: "pending", priority: "high" },
    kind: "created", excludeLogin: "alice", badge: 2,
  });
  expect(result.sent).toBe(2);
  expect(result.channels).toEqual({ apns: 0, webpush: 2, email: 0 });
  expect(result.locale).toBe("ja");
});

test("what a browser posts is validated, and bound to the session's login", async () => {
  const sub = await subscriber("https://push.example.com/send/route");

  const anonymous = await SELF.fetch("https://example.com/push/subscriptions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }),
  });
  expect(anonymous.status).toBe(401);

  const malformed = await SELF.fetch("https://example.com/push/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": globalThis.__aliceSession },
    body: JSON.stringify({ endpoint: "http://not-https.example.com/x", keys: sub.keys }),
  });
  expect(malformed.status).toBe(400);

  const res = await SELF.fetch("https://example.com/push/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": globalThis.__aliceSession },
    body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys, login: "bob" }),
  });
  expect(res.status).toBe(200);
  const row = await env.DB.prepare("SELECT login FROM push_subscriptions WHERE endpoint = ?1").bind(sub.endpoint).first();
  expect(row).toMatchObject({ login: "alice" });

  const gone = await SELF.fetch("https://example.com/push/subscriptions", {
    method: "DELETE",
    headers: { "content-type": "application/json", "x-session-token": globalThis.__aliceSession },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  expect(gone.status).toBe(200);
  expect(await env.DB.prepare("SELECT login FROM push_subscriptions WHERE endpoint = ?1").bind(sub.endpoint).first()).toBeNull();
});

test("parseSubscription refuses anything that is not a real subscription", () => {
  expect(parseSubscription(null)).toBeNull();
  expect(parseSubscription({ endpoint: "https://p.example.com/x" })).toBeNull();
  expect(parseSubscription({ endpoint: "https://p.example.com/x", keys: { p256dh: "short", auth: "short" } })).toBeNull();
});

test("the public key is served only when web push is configured", async () => {
  const off = await SELF.fetch("https://example.com/push/vapid");
  expect(off.status).toBe(503);
});

test("a contact typed as a bare address still makes a token a push service accepts", async () => {
  // RFC 8292 wants a URI. "selectdev111@gmail.com" is what a person types when
  // asked for a contact, and sending it verbatim is a 400 from every push
  // service that reads exactly like a bad key.
  expect(vapidSubject({ VAPID_SUBJECT: "someone@example.com" })).toBe("mailto:someone@example.com");
  expect(vapidSubject({ VAPID_SUBJECT: "  someone@example.com  " })).toBe("mailto:someone@example.com");
  // Already a URI, either spelling: left exactly as it is.
  expect(vapidSubject({ VAPID_SUBJECT: "mailto:someone@example.com" })).toBe("mailto:someone@example.com");
  expect(vapidSubject({ VAPID_SUBJECT: "https://example.com/contact" })).toBe("https://example.com/contact");
  expect(vapidSubject({ VAPID_SUBJECT: "MAILTO:someone@example.com" })).toBe("MAILTO:someone@example.com");
  // Nothing to complete: passed through rather than guessed at.
  expect(vapidSubject({ VAPID_SUBJECT: "" })).toBe("");
  expect(vapidSubject({})).toBe("");

  // And the claim on the wire carries the completed value.
  const jwt = await vapidToken({ ...pushEnv, VAPID_SUBJECT: "someone@example.com" }, 2_000_000);
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(jwt.split(".")[1])));
  expect(claims.sub).toBe("mailto:someone@example.com");
});
