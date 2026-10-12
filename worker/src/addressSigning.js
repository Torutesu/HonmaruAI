// Short-lived addresses the API signs itself, for bytes a browser fetches
// without a header — an <img>, an <audio>, a <video> — when the media
// origin (mediaToken.js) is not doing it.
//
// The key is derived from the Worker's DATA_KEY secret (FILE_SIGNING_KEY
// when set), never kept in the database: a copy of the database is not a way
// to mint addresses. What is signed names its kind, its workspace and its
// object, and the moment it stops; an address lasts ten to twenty minutes.

export const WINDOW_SECONDS = 600;

const derived = new Map(); // secret -> CryptoKey

async function keyFor(env) {
  const secret = env?.FILE_SIGNING_KEY || env?.DATA_KEY;
  if (!secret) return null;
  let key = derived.get(secret);
  if (!key) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
    key = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("honmaru/file-urls/v2") },
      base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]
    );
    derived.set(secret, key);
  }
  return key;
}

/// Whether this Worker can sign addresses.
export const canSign = (env) => Boolean(env?.FILE_SIGNING_KEY || env?.DATA_KEY);

/// Until when an address made now is good (seconds): the end of the next
/// window, so it is the same address all through this one.
export function validUntil(now = Date.now()) {
  return (Math.floor(now / 1000 / WINDOW_SECONDS) + 2) * WINDOW_SECONDS;
}

/// The MAC for one address, or null without a key. `kind` is "f2" for a
/// message file, "a1" for a recording, "v1" for a card's video.
export async function addressMac(env, kind, orgId, id, until) {
  const key = await keyFor(env);
  if (!key) return null;
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${kind}\n${orgId}\n${id}\n${until}`));
  return [...new Uint8Array(sig)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/// The query an address carries: v=2&e=…&s=…, and until when (s).
export async function signedQuery(env, kind, orgId, id, now = Date.now()) {
  const until = validUntil(now);
  const s = await addressMac(env, kind, orgId, id, until);
  return s ? { query: `v=2&e=${until}&s=${s}`, until } : null;
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/// Whether a request's v=2 address was signed for this object and is still
/// good.
export async function addressHolds(env, url, kind, orgId, id, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (url.searchParams.get("v") !== "2") return false;
  const until = Number(url.searchParams.get("e"));
  const sig = String(url.searchParams.get("s") || "");
  if (!Number.isInteger(until) || until < nowSeconds || until > nowSeconds + 2 * WINDOW_SECONDS) return false;
  const want = await addressMac(env, kind, orgId, id, until);
  return Boolean(want) && sameText(sig, want);
}
