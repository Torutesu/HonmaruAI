// Signed addresses for files on the media origin (docs/architecture/
// media-delivery.md §5, phase 1).
//
// A file is served from its own domain (MEDIA_ORIGIN, media.honmaruai.com)
// by a Worker that reads no database: everything it needs — whose file,
// which file, its type and name — is in the address, signed with a key only
// the API and that Worker hold (MEDIA_SIGNING_KEYS, a Secret on both).
//
// Time is cut into ten-minute windows. An address made in window W is good
// through the end of W+1 — ten to twenty minutes — and is the same address
// all through W, so a picture loads once per window, not once per scroll.
// Someone who leaves a channel can fetch nothing new from it twenty minutes
// later. Clients keep files by id, not by address, and ask for fresh
// addresses (POST /media/urls) when theirs run out.
//
// Off — the API keeps handing out its own /files addresses — until both
// MEDIA_ORIGIN and MEDIA_SIGNING_KEYS are set, and whenever MEDIA_ORIGIN_V2
// is "off" (the way back, §9).

export const WINDOW_SECONDS = 600;

// The Worker's env, for code that signs without being handed it (toFile).
let current = null;
export function useMediaEnv(next) { current = next || null; }
export const mediaEnv = () => current;

/// The window a moment falls in.
export const windowOf = (nowMs) => Math.floor(nowMs / 1000 / WINDOW_SECONDS);

/// The signing keys, by id: `{"k1":"<secret>","k0":"<older>"}`. The one to
/// sign with is MEDIA_SIGNING_KID, else the first. Older ones still verify,
/// so a key can be rotated without breaking addresses already out.
export function signingKeys(env) {
  let parsed = null;
  try { parsed = JSON.parse(String(env?.MEDIA_SIGNING_KEYS || "")); } catch { parsed = null; }
  if (!parsed || typeof parsed !== "object") return null;
  const keys = new Map(Object.entries(parsed).filter(([kid, v]) => /^[A-Za-z0-9_-]{1,16}$/.test(kid) && typeof v === "string" && v.length >= 32));
  if (!keys.size) return null;
  const kid = keys.has(env.MEDIA_SIGNING_KID) ? env.MEDIA_SIGNING_KID : keys.keys().next().value;
  return { keys, kid };
}

/// Whether files are served from the media origin.
export function mediaOriginOn(env) {
  if (String(env?.MEDIA_ORIGIN_V2 || "").toLowerCase() === "off") return false;
  return Boolean(origin(env) && signingKeys(env));
}

function origin(env) {
  const raw = String(env?.MEDIA_ORIGIN || "").replace(/\/+$/, "");
  return /^https:\/\/[a-z0-9.-]+$/i.test(raw) ? raw : null;
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (s) => b64url(new TextEncoder().encode(String(s)));
const dec = (s) => {
  const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

const imported = new Map();
async function hmac(secret, text) {
  let key = imported.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    imported.set(secret, key);
  }
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text))));
}

/// What is signed: every field, in order, one per line. The window is in it,
/// so an address cannot be stretched; the type and the name are in it, so
/// the Worker can trust them without asking anyone.
const payload = ({ kid, orgId, id, type, name, w }) => ["f1", kid, orgId, id, type, name, String(w)].join("\n");

/// A signed address for a file, and until when it is good (ms).
export async function signFileUrl(env, { orgId, id, type, name }, now = Date.now()) {
  const keys = signingKeys(env);
  const base = origin(env);
  if (!keys || !base) return null;
  const w = windowOf(now);
  const kid = keys.kid;
  const s = await hmac(keys.keys.get(kid), payload({ kid, orgId, id, type, name, w }));
  const q = new URLSearchParams({ t: type, n: name, w: String(w), s });
  return { url: `${base}/f/${kid}/${enc(orgId)}/${id}?${q.toString()}`, expiresAt: (w + 2) * WINDOW_SECONDS * 1000 };
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/// What a signed address says, when it is genuine and still good; null
/// otherwise — whatever is wrong with it, the answer is the same.
export async function verifyFileUrl(env, url, now = Date.now()) {
  const m = url.pathname.match(/^\/f\/([A-Za-z0-9_-]{1,16})\/([A-Za-z0-9_-]+)\/(f_[0-9a-f]{24})$/);
  if (!m) return null;
  const keys = signingKeys(env);
  const secret = keys?.keys.get(m[1]);
  if (!secret) return null;
  let orgId;
  try { orgId = dec(m[2]); } catch { return null; }
  const type = url.searchParams.get("t") || "";
  const name = url.searchParams.get("n") || "";
  const w = Number(url.searchParams.get("w"));
  const s = url.searchParams.get("s") || "";
  const current = windowOf(now);
  // Made this window or the one before: ten to twenty minutes in all.
  if (!Number.isInteger(w) || w > current || w < current - 1) return null;
  if (!sameText(s, await hmac(secret, payload({ kid: m[1], orgId, id: m[3], type, name, w })))) return null;
  return { orgId, id: m[3], type, name, expiresAt: (w + 2) * WINDOW_SECONDS * 1000 };
}
