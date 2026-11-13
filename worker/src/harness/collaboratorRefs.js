// Handles for people outside a workspace, as share dialogs see them (#956).
//
// An account id is `email:<address>` for everyone who signed up with an email
// address, and a login is `u:<address>` for email and SSO accounts. A dialog
// that names the person it picked by either of those hands that person's
// address to whoever is sharing, which the collaborator search promises not
// to do. So a dialog gets a sealed copy of the account id instead: only this
// Worker can open it, and it opens only for the one resource it was issued
// for, so it cannot be carried to another Thread, App, File or workspace.
// Every response seals afresh, so two lists cannot be matched up by handle
// either.
//
// The key lives in `kv`, as the legacy file-signing key does. A copy of the
// database already holds every account id, so the key guards nothing a copy
// would not give away anyway; what it keeps is the address out of browsers.

const KEY_NAME = "collaborator-ref-key";
const PREFIX = "c1.";
const MAX_REF = 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();
let cached = null; // { raw, key }

async function refKey(db) {
  let row = await db.prepare("SELECT value FROM kv WHERE key = ?1").bind(KEY_NAME).first();
  if (!row) {
    const raw = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    // Two first uses at once: one wins, and both read the winner.
    await db.prepare("INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)").bind(KEY_NAME, raw, new Date().toISOString()).run();
    row = await db.prepare("SELECT value FROM kv WHERE key = ?1").bind(KEY_NAME).first();
  }
  if (cached?.raw !== row.value) {
    const bytes = new Uint8Array(row.value.match(/../g).map((h) => parseInt(h, 16)));
    cached = { raw: row.value, key: await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]) };
  }
  return cached.key;
}

const scopeOf = ({ orgId, resourceType, resourceId }) => enc.encode(`honmaru/collaborator/v1\n${orgId}\n${resourceType}\n${resourceId}`);

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function unb64url(text) {
  const s = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/// A handle for `userId` that opens only for this one resource.
export async function sealCollaboratorRef(db, scope, userId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: scopeOf(scope) }, await refKey(db), enc.encode(String(userId))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return PREFIX + b64url(out);
}

/// The account id a handle stands for, or null when it was not issued by
/// this Worker for this resource.
export async function openCollaboratorRef(db, scope, ref) {
  if (typeof ref !== "string" || !ref.startsWith(PREFIX) || ref.length > MAX_REF) return null;
  try {
    const bytes = unb64url(ref.slice(PREFIX.length));
    if (bytes.length <= 12) return null;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: scopeOf(scope) }, await refKey(db), bytes.slice(12));
    return dec.decode(plain) || null;
  } catch {
    return null;
  }
}

const emailDerived = (login, githubId) => /^u:|@/.test(String(login || "")) || String(githubId || "").startsWith("email:");

/// How a share dialog may show an account outside the workspace: a GitHub
/// handle stays (it is already public), a login made from an address does
/// not, and an address typed into a display name is cut back to its local
/// part, which is what an email sign-up is named by default anyway.
export function outsiderLabel({ githubId, login, name, email }) {
  const publicLogin = login && !emailDerived(login, githubId) ? String(login) : null;
  const shown = String(name || "").trim().replace(/([^\s@]+)@[^\s@]+/g, "$1").trim();
  const fallback = String(email || login || "").replace(/^u:/, "").split("@")[0];
  return { name: shown || publicLogin || fallback, login: publicLogin };
}

/// A route parameter naming a recipient: a handle from a list or search, or
/// (from older callers) a raw account id, which tells them nothing new.
export async function recipientFromParam(db, scope, param) {
  return (await openCollaboratorRef(db, scope, param)) ?? param;
}
