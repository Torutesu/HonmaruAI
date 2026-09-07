// Web Push, from the Worker, with nothing but Web Crypto.
//
// This is the channel that makes notifications cross-platform: a browser on a
// desk, Chrome on an Android phone, Safari on an iPhone once the site is added
// to the home screen (iOS 16.4+), and any desktop shell that wraps a browser.
// None of them need an app store, a provisioning profile, or an entitlement —
// the four things standing between the iOS build and its first push.
//
// Two standards, both small enough to write out:
//   RFC 8292 (VAPID)   — the Worker proves who it is with an ES256 JWT, exactly
//                        the way apns.js already does for Apple.
//   RFC 8291 + 8188    — the payload is encrypted to the subscription's own key
//                        (aes128gcm), so the push service relays bytes it
//                        cannot read. The recipient's browser is the only thing
//                        that can turn them back into a title.
//
// Keys are in the format the `web-push` npm tool prints, so anyone who has
// generated VAPID keys before has the right ones: a base64url 65-byte raw
// public point and a base64url 32-byte private scalar.
// `scripts/vapid-keys.mjs` prints a fresh pair.

const RECORD_SIZE = 4096;
const JWT_TTL_S = 12 * 60 * 60;   // Push services refuse anything over 24h.
const JWT_REUSE_MS = 60 * 60 * 1000;

const encoder = new TextEncoder();
// One signed token per push service origin, reused for an hour. There are
// only a handful of push services in the world, so this stays small.
const tokens = new Map();

export function b64url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text) {
  const padded = String(text).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(text).length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

export function isWebPushConfigured(env) {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

/// The raw public point split into the JWK coordinates Web Crypto wants.
function jwkFromRaw(publicRaw, privateRaw) {
  if (publicRaw.length !== 65 || publicRaw[0] !== 4) throw new Error("VAPID public key must be a raw uncompressed P-256 point");
  const jwk = {
    kty: "EC", crv: "P-256",
    x: b64url(publicRaw.slice(1, 33)),
    y: b64url(publicRaw.slice(33, 65)),
  };
  if (privateRaw) jwk.d = b64url(privateRaw);
  return jwk;
}

async function signingKey(env) {
  return crypto.subtle.importKey(
    "jwk",
    jwkFromRaw(fromB64url(env.VAPID_PUBLIC_KEY), fromB64url(env.VAPID_PRIVATE_KEY)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

/// The VAPID token for one push service. RFC 8292: `aud` is the origin of the
/// endpoint, `sub` is who to contact when our pushes misbehave.
export async function vapidToken(env, audience, now = Date.now()) {
  const cached = tokens.get(audience);
  if (cached && cached.key === env.VAPID_PRIVATE_KEY && now - cached.mintedAt < JWT_REUSE_MS) return cached.jwt;

  const header = b64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(encoder.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(now / 1000) + JWT_TTL_S,
    sub: env.VAPID_SUBJECT,
  })));
  const input = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, await signingKey(env), encoder.encode(input)
  );
  const jwt = `${input}.${b64url(signature)}`;
  tokens.set(audience, { jwt, mintedAt: now, key: env.VAPID_PRIVATE_KEY });
  return jwt;
}

/// Only for tests, and for a key rotated under us.
export function resetVapidTokens() {
  tokens.clear();
}

async function hkdf(salt, ikm, info, bits) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bits));
}

/// Encrypt a payload to one subscription (RFC 8291, aes128gcm content coding).
///
/// Exported so a test can decrypt the result with the subscriber's private key
/// and prove the bytes on the wire are the message, rather than trusting that
/// the derivation is right because it did not throw.
export async function encryptPayload({ p256dh, auth, plaintext, salt, localKeyPair }) {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  if (uaPublic.length !== 65) throw new Error("subscription key is not a raw P-256 point");
  if (authSecret.length !== 16) throw new Error("subscription auth secret must be 16 bytes");

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const local = localKeyPair || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  // IKM = HKDF(auth, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 256);

  const theSalt = salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(theSalt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(theSalt, ikm, encoder.encode("Content-Encoding: nonce\0"), 96);

  // One record: the message, then the 0x02 delimiter that marks the last record.
  const padded = concat(encoder.encode(plaintext), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded));

  // RFC 8188 header: salt(16) | rs(4) | idlen(1) | keyid(65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE);
  const body = concat(theSalt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
  return { body, asPublic };
}

/// The inverse, for tests: what a browser does with the bytes it is handed.
export async function decryptPayload({ body, uaPrivateKey, uaPublicRaw, auth }) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, uaPrivateKey, 256));
  const keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublicRaw, asPublic);
  const ikm = await hkdf(fromB64url(auth), shared, keyInfo, 256);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 96);
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, ciphertext));
  // Strip the delimiter and any padding after it.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  return new TextDecoder().decode(padded.slice(0, end));
}

/// Send one notification to one subscription.
///
/// Returns `{ ok, status }` and never throws, on the same rule as apns.js: a
/// push is a courtesy on top of a decision already recorded, and a push service
/// having a bad day must not reach back into the relay.
export async function sendWebPush(env, { subscription, payload, topic, urgency = "high", ttl = 86400 }) {
  try {
    const endpoint = new URL(subscription.endpoint);
    const jwt = await vapidToken(env, endpoint.origin);
    const { body } = await encryptPayload({
      p256dh: subscription.p256dh, auth: subscription.auth, plaintext: JSON.stringify(payload),
    });
    const headers = {
      authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(ttl),
      urgency,
    };
    // A card created and then decided collapses to one notification, as it
    // does on APNs. The spec allows 32 URL-safe characters.
    if (topic) headers.topic = String(topic).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
    const res = await fetch(endpoint.toString(), { method: "POST", headers, body });
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    return { ok: false, status: res.status };
  } catch (err) {
    console.error("web push send failed", err?.message || err);
    return { ok: false, status: 0 };
  }
}

/// A subscription the push service says is gone. 404 and 410 both mean it —
/// the browser unsubscribed, or the site data was cleared.
export function isDeadSubscription({ status }) {
  return status === 404 || status === 410;
}

/// What a browser posts to us: the shape PushSubscription.toJSON() produces.
export function parseSubscription(body) {
  const endpoint = body?.endpoint;
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;
  if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint) || endpoint.length > 2048) return null;
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  try {
    if (fromB64url(p256dh).length !== 65 || fromB64url(auth).length !== 16) return null;
  } catch {
    return null;
  }
  return { endpoint, p256dh, auth };
}
