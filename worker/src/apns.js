// APNs over HTTP/2, with token-based authentication.
//
// No dependency: the provider token is an ES256 JWT, and Workers ship Web
// Crypto, so signing it is thirty lines. A JWT library would be a supply chain
// for a job that is two base64url encodings and one `crypto.subtle.sign`.
//
// The token is cached in module scope. Apple rejects a provider token refreshed
// more than once every 20 minutes (TooManyProviderTokenUpdates) and refuses one
// older than 60 minutes, so the window is real and minting per request is a way
// to get throttled.

const TOKEN_TTL_MS = 45 * 60 * 1000;

let cached = null; // { jwt, mintedAt, keyId }

export function base64url(bytes) {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlJSON(object) {
  return base64url(new TextEncoder().encode(JSON.stringify(object)));
}

// The .p8 Apple hands out is PKCS#8 PEM. Stored as a Worker secret it usually
// arrives with literal "\n" rather than newlines, because that is what survives
// a shell, so both spellings are accepted.
export function derFromPEM(pem) {
  const body = String(pem)
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function providerToken(env, now = Date.now()) {
  if (cached && cached.keyId === env.APNS_KEY_ID && now - cached.mintedAt < TOKEN_TTL_MS) {
    return cached.jwt;
  }

  const key = await crypto.subtle.importKey(
    "pkcs8",
    derFromPEM(env.APNS_PRIVATE_KEY),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const header = base64urlJSON({ alg: "ES256", kid: env.APNS_KEY_ID });
  const claims = base64urlJSON({ iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) });
  const signingInput = `${header}.${claims}`;

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput)
  );

  const jwt = `${signingInput}.${base64url(signature)}`;
  cached = { jwt, mintedAt: now, keyId: env.APNS_KEY_ID };
  return jwt;
}

/// Only for tests, and for the case where the key is rotated under us.
export function resetProviderToken() {
  cached = null;
}

export function apnsHost(env) {
  return env.APNS_ENVIRONMENT === "production"
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";
}

/// The apps this deployment may send to: the App Store app and the Expo
/// build beside it (apps/mobile). APNS_APP_IDS widens it; APNS_TOPIC is
/// always in it.
export function allowedAppIds(env) {
  const list = String(env.APNS_APP_IDS || "com.honmaru.ai,com.honmaru.ai.poc").split(",").map((s) => s.trim()).filter(Boolean);
  if (env.APNS_TOPIC && !list.includes(env.APNS_TOPIC)) list.push(env.APNS_TOPIC);
  return list;
}

/// Where one phone's notification goes. A device that said which app it is
/// and which APNs environment its token is from (a development build's
/// token is a sandbox token) is sent exactly there. One registered before
/// devices said so — the App Store app — keeps the deployment's topic and
/// environment, as it always had.
export function targetFor(env, device) {
  const app = device?.app_id && allowedAppIds(env).includes(device.app_id) ? device.app_id : null;
  if (!app) return { topic: env.APNS_TOPIC, host: apnsHost(env) };
  const host = device.environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  return { topic: app, host };
}

/// An APNs device token is hexadecimal. Sixty-four characters is the usual
/// length; some push types are longer, so the ceiling is generous and the
/// alphabet is the part that matters.
///
/// Checked where a client hands one over, because from there it goes into the
/// path of a request to Apple signed with our provider token — and `fetch`
/// resolves `..` in a path exactly the way a browser does.
export function isDeviceToken(value) {
  return typeof value === "string" && /^[0-9a-fA-F]{64,200}$/.test(value);
}

export function isConfigured(env) {
  return Boolean(env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY && env.APNS_TOPIC);
}

/// Send one notification.
///
/// Returns `{ ok, status, reason }`. It never throws: a push is a courtesy on
/// top of a decision that has already been recorded and broadcast, and an APNs
/// outage must not be able to reach back and break either.
///
/// A 410, or a 400 saying BadDeviceToken, means the token is dead — the caller
/// deletes it rather than retrying forever against an app that was uninstalled.
export async function sendPush(env, { deviceToken, device = null, payload, collapseId, priority = 10, pushType = "alert" }) {
  try {
    const jwt = await providerToken(env);
    const target = targetFor(env, device);
    const headers = {
      authorization: `bearer ${jwt}`,
      "apns-topic": target.topic,
      "apns-push-type": pushType === "background" ? "background" : "alert",
      "apns-priority": String(priority),
      "content-type": "application/json",
    };
    // Stripped, not just cut. This is a card's id, which is length-capped and
    // not charset-checked, and in a header value a newline is not a character:
    // the Headers constructor throws, the catch below swallows it, and that
    // card's push silently never goes out. webpush.js has always stripped its
    // equivalent field; this one only trimmed the length.
    const collapse = collapseId ? String(collapseId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) : "";
    if (collapse) headers["apns-collapse-id"] = collapse;

    // Encoded even though the route now refuses anything but hex: a token that
    // predates that check is still in the table, and this is the line where a
    // path would be walked rather than sent.
    const res = await fetch(`${target.host}/3/device/${encodeURIComponent(deviceToken)}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 200) return { ok: true, status: 200 };

    let reason = "";
    try {
      reason = (await res.json())?.reason || "";
    } catch {
      reason = "";
    }
    // Apple's own words, where the logs can find them. Only the status was
    // kept before, so a misconfiguration (BadDeviceToken from the wrong
    // gateway, InvalidProviderToken, TopicDisallowed) read the same as a
    // phone that simply had no app any more. No token: it identifies a phone.
    console.error("apns refused", JSON.stringify({ status: res.status, reason, host: target.host, topic: target.topic }));
    return { ok: false, status: res.status, reason };
  } catch (err) {
    console.error("apns send failed", err?.message || err);
    return { ok: false, status: 0, reason: "exception" };
  }
}

export function isDeadToken({ status, reason }) {
  return status === 410 || (status === 400 && reason === "BadDeviceToken");
}
