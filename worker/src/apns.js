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

function base64url(bytes) {
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
function derFromPEM(pem) {
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
export async function sendPush(env, { deviceToken, payload, collapseId, priority = 10 }) {
  try {
    const jwt = await providerToken(env);
    const headers = {
      authorization: `bearer ${jwt}`,
      "apns-topic": env.APNS_TOPIC,
      "apns-push-type": "alert",
      "apns-priority": String(priority),
      "content-type": "application/json",
    };
    if (collapseId) headers["apns-collapse-id"] = collapseId.slice(0, 64);

    const res = await fetch(`${apnsHost(env)}/3/device/${deviceToken}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (res.status === 200) return { ok: true, status: 200 };

    let reason = "";
    try {
      reason = (await res.json())?.reason || "";
    } catch {
      reason = "";
    }
    return { ok: false, status: res.status, reason };
  } catch (err) {
    console.error("apns send failed", err?.message || err);
    return { ok: false, status: 0, reason: "exception" };
  }
}

export function isDeadToken({ status, reason }) {
  return status === 410 || (status === 400 && reason === "BadDeviceToken");
}
