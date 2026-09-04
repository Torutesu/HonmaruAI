// Encryption at rest for the one secret this service holds on someone else's
// behalf: their GitHub access token.
//
// The token carries the `repo` scope. It sat in D1 in plaintext, which means a
// leak of the database — a backup, a misdirected export, a compromised D1 API
// token — was a leak of every user's source code, not just of this app's data.
// The relay itself never hands the token out (`githubProxy.js` exists so it
// does not have to), so it is worth an extra hop for the database to not know
// it either.
//
// AES-GCM, key from a Worker secret. No new dependency: Workers ship Web
// Crypto, same as `apns.js` uses for its ES256 signing.

const PREFIX = "v1";

function base64url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Keyed by the secret itself, so rotating the secret cannot serve a stale key.
const keyCache = new Map();

async function keyFor(secret) {
  const cached = keyCache.get(secret);
  if (cached) return cached;
  // The secret is a passphrase of unknown length; AES-GCM wants exactly 32
  // bytes. SHA-256 is the shortest honest way to get from one to the other.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  keyCache.set(secret, key);
  return key;
}

let warned = false;

/// Whether tokens will actually be encrypted. False in local dev and in any
/// deployment that has not had the secret set, where sealing is a no-op so
/// nothing breaks — but noisily, once per isolate, because a production
/// deployment without this is storing plaintext and believing otherwise.
export function encryptionConfigured(env) {
  const secret = env?.TOKEN_ENCRYPTION_KEY;
  if (secret && String(secret).length >= 16) return true;
  if (!warned) {
    warned = true;
    console.error(
      "TOKEN_ENCRYPTION_KEY is not set: GitHub access tokens are being stored in plaintext"
    );
  }
  return false;
}

/// Encrypt for storage. Returns the input unchanged when no key is configured,
/// which is what keeps `wrangler dev` and the test suite working.
export async function seal(env, plaintext) {
  if (plaintext == null || plaintext === "") return plaintext;
  if (!encryptionConfigured(env)) return plaintext;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(env.TOKEN_ENCRYPTION_KEY);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `${PREFIX}.${base64url(iv)}.${base64url(ciphertext)}`;
}

/// Decrypt from storage.
///
/// A value without the version prefix is a token written before this existed
/// and is returned as it is. That is the whole migration: rows written the old
/// way keep working, and `db.js` re-seals each one the first time it reads it,
/// so the plaintext ages out of the table rather than needing a backfill.
export async function open(env, stored) {
  if (typeof stored !== "string" || !stored.startsWith(`${PREFIX}.`)) return stored;
  const [, ivPart, bodyPart] = stored.split(".");
  if (!ivPart || !bodyPart) return null;
  try {
    const key = await keyFor(env.TOKEN_ENCRYPTION_KEY || "");
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64url(ivPart) },
      key,
      fromBase64url(bodyPart)
    );
    return new TextDecoder().decode(plaintext);
  } catch (err) {
    // Wrong key, rotated key, corrupted row. There is no token here, and
    // pretending the ciphertext is one would send garbage to GitHub as a
    // bearer credential.
    console.error("token decrypt failed", err?.message || err);
    return null;
  }
}

/// True when this value is stored in the clear and should be upgraded.
export function isPlaintext(stored) {
  return typeof stored === "string" && stored !== "" && !stored.startsWith(`${PREFIX}.`);
}
