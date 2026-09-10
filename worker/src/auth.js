// Simple email/password auth helpers. Passwords are hashed with PBKDF2 (built
// into the Workers runtime — no external dependency). This is intentionally
// simple; stronger token handling is a later concern.

import { createSession, upsertUser, upsertMembership, primaryOrgId } from "./db.js";

const ENC = new TextEncoder();

// How long an invite stays redeemable.
const INVITE_TTL_DAYS = 7;

// Sessions carry a GitHub access token. An email account has none, so it gets
// this marker in that column instead. Anything that would spend the token has
// to ask first — sending this string to GitHub buys a 401 and an error message
// written for someone else's problem.
export const EMAIL_AUTH_TOKEN = "email-auth";

export function isGitHubSession(session) {
  const token = session?.github_access_token;
  return Boolean(token) && token !== EMAIL_AUTH_TOKEN;
}

// Ordered so an invite can be compared against the inviter's own standing.
// Everything outside this map is not a role.
/// How far a role reaches, for deciding who may invite whom.
///
/// This is administrative reach, not GitHub's permission ladder. `designer` and
/// `engineer` are descriptive labels the router matches on, so they sit level
/// with `member`; `triager`, `maintainer` and `admin` are granted standing.
///
/// `maintainer` was missing entirely, which made it unusable in both
/// directions: `roleName()` hands it out for GitHub's `maintain` permission, so
/// a person could hold it — and then rank 0, unable to invite a triager — while
/// an admin asking to invite one was told "That is not a role."
export const ROLE_RANK = new Map([
  ["member", 0], ["designer", 0], ["engineer", 0],
  ["triager", 1], ["maintainer", 2], ["admin", 3],
]);

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Derive a hash from a password + salt using PBKDF2-SHA256.
export async function hashPassword(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", ENC.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  return toHex(bits);
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", ENC.encode(value));
  return toHex(digest);
}

export function newSaltHex() {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

// Constant-time-ish string compare to avoid leaking timing on the hash.
export function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function validEmail(email) {
  return typeof email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

// Create an account: hash the password, store the user, put them in a default
// org, and return a session token the client can use immediately.
export async function signup(env, { email, password, name, inviteCode, locale, passwordless }) {
  if (!validEmail(email)) return { error: "Please enter a valid email." };
  // A passwordless sign-up has already proved the address by receiving a code
  // there, which is the thing a password stands in for. It gets no password
  // hash at all rather than a placeholder one, so `login()` — which requires a
  // hash — can never be talked into accepting an empty string as the secret.
  if (!passwordless && (typeof password !== "string" || password.length < 8)) {
    return { error: "Password must be at least 8 characters." };
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await env.DB
    .prepare("SELECT github_id FROM users WHERE email = ?1")
    .bind(normalizedEmail)
    .first();
  if (existing) return { error: "An account with this email already exists." };

  // Reuse the users table: the primary key is called github_id for historical
  // reasons, but it is just a stable user id. Email users get an "email:" id.
  const userId = `email:${normalizedEmail}`;
  const salt = passwordless ? null : newSaltHex();
  const hash = passwordless ? null : await hashPassword(password, salt);
  // `login` is the relay's identity: sendTo() matches on exactly this string,
  // so it must be unique and must not be chosen by the caller. Derive it from
  // the email (already unique) and keep `name` as display text only.
  const login = `u:${normalizedEmail}`;
  const displayName = name?.trim() || normalizedEmail.split("@")[0];

  // A caller-supplied orgId is not authorization. Signup may only place a user
  // in an org a valid invite names, or in a fresh org of their own. Trusting
  // body.orgId let anyone write a membership row for a private org, and
  // authorizeOrgAccess treats that row as proof of access.
  //
  // Settled before the account is written, so a mistyped code cannot leave a
  // real account behind with no org at all.
  //
  // A code that does not work no longer refuses the sign-up, though. It used
  // to, and the emailed six digits have already been spent by the time this
  // runs — so one wrong character cost the account *and* the credential, and
  // the only way on was to start over and ask for another code. They get the
  // workspace they would have got with no code at all, `inviteError` says what
  // did not happen, and You → Join a team takes another attempt at it.
  let org;
  let joinRole = "member";
  let inviteError;
  if (inviteCode?.trim()) {
    const invite = await readInvite(env.DB, inviteCode.trim());
    if (invite && (await spendInvite(env.DB, inviteCode.trim()))) {
      org = invite.org_id;
      joinRole = invite.role || "member";
    } else {
      inviteError = "That invite code is not valid.";
    }
  }
  if (!org) {
    // Their own org. Derived from the user id so no one else can claim it, but
    // hashed: this id travels in the socket's query string, and a URL is the
    // classic place an address ends up somewhere it was never meant to be.
    org = `personal:${(await sha256Hex(userId)).slice(0, 24)}`;
    joinRole = "admin";
  }

  await upsertUser(env.DB, { githubId: userId, login, name: displayName, avatarUrl: null, locale: locale || undefined });
  await env.DB
    .prepare("UPDATE users SET email = ?1, password_hash = ?2, password_salt = ?3 WHERE github_id = ?4")
    .bind(normalizedEmail, hash, salt, userId)
    .run();
  await upsertMembership(env.DB, org, userId, joinRole);
  const token = await createSession(env.DB, userId, EMAIL_AUTH_TOKEN);
  return { token, userId, login, orgId: org, ...(inviteError ? { inviteError } : {}) };
}

// Log in: look up by email, verify the password, return a session token.
export async function login(env, { email, password, inviteCode }) {
  if (!validEmail(email) || typeof password !== "string") {
    return { error: "Invalid email or password." };
  }
  const normalizedEmail = email.trim().toLowerCase();
  const row = await env.DB
    .prepare("SELECT github_id, login, password_hash, password_salt FROM users WHERE email = ?1")
    .bind(normalizedEmail)
    .first();
  if (!row || !row.password_hash) return { error: "Invalid email or password." };

  const attempt = await hashPassword(password, row.password_salt);
  if (!safeEqual(attempt, row.password_hash)) return { error: "Invalid email or password." };

  const token = await createSession(env.DB, row.github_id, EMAIL_AUTH_TOKEN);
  // An invite means the same thing on both ways in. A wrong one does not cost
  // the sign-in — the password was right — it is reported alongside it.
  let joined = null;
  let inviteError;
  if (inviteCode?.trim()) {
    const redeemed = await acceptInvite(env, { code: inviteCode.trim(), userId: row.github_id });
    if (redeemed.error) inviteError = redeemed.error;
    else joined = redeemed.orgId;
  }
  return {
    token,
    userId: row.github_id,
    login: row.login,
    // Signing in says nothing about where you work, so this does. Without it a
    // client with no stored org had only a placeholder to guess at.
    orgId: joined || (await primaryOrgId(env.DB, row.github_id)) || undefined,
    ...(inviteError ? { inviteError } : {}),
  };
}


// Create a reusable invite code for an org. Any current member can make one.

// Spend one use of a code, atomically. Checking the count and then writing it
// lets two concurrent redemptions both see room on a single-use code; making
// the condition part of the UPDATE lets the database decide who got there
// first. Returns the invite when the use was granted, null when it was not.
async function readInvite(db, code) {
  const row = await db
    .prepare("SELECT org_id, role, expires_at, max_uses, uses FROM invites WHERE code = ?1")
    .bind(code)
    .first();
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
  return row;
}

/// Take one use, or report that there was none left to take.
///
/// The condition lives in the UPDATE rather than in a read before it, so two
/// concurrent redemptions of a single-use code cannot both see room.
async function spendInvite(db, code) {
  const { meta } = await db
    .prepare("UPDATE invites SET uses = uses + 1 WHERE code = ?1 AND uses < max_uses")
    .bind(code)
    .run();
  return Boolean(meta?.changes);
}

export async function createInvite(env, { orgId, createdBy, role, uses }) {
  if (!orgId) return { error: "Missing team." };
  // 16 bytes, and the org is not in the code. Three bytes with the org name as
  // a known prefix is 16.7M guesses against an endpoint that grants membership
  // — a weekend of traffic. The code carries no hint of what it opens.
  const code = toHex(crypto.getRandomValues(new Uint8Array(16)));
  // Only known roles, and never above the caller's own. Membership alone was
  // enough to mint an admin code and redeem it, so any member could promote
  // themselves in two calls.
  const requested = String(role || "member").trim().toLowerCase();
  if (!ROLE_RANK.has(requested)) return { error: "That is not a role." };
  const callerRole = String(
    (await env.DB
      .prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
      .bind(orgId, createdBy)
      .first())?.role || "member"
  ).toLowerCase();
  if (ROLE_RANK.get(requested) > (ROLE_RANK.get(callerRole) ?? 0)) {
    return { error: "You cannot invite someone above your own role." };
  }
  const inviteRole = requested;
  // Invites expire. A code that works forever is a permanent unaudited way in,
  // and the only way to close it would be deleting the row by hand.
  // One by default: an invite is normally "join my team", sent to one person.
  // Unlimited was the old behaviour and is the wrong default for something
  // whoever holds it can spend.
  const maxUses = Math.min(Math.max(parseInt(uses, 10) || 1, 1), 50);
  const now = new Date();
  const expires = new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  // The non-secret name for this code, written now rather than derived on
  // every read: cancelling one by reference otherwise means reading every
  // invite in the workspace and hashing each until one matches.
  const ref = (await sha256Hex(code)).slice(0, 16);
  await env.DB
    .prepare("INSERT INTO invites (code, org_id, created_by, role, created_at, expires_at, max_uses, ref) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
    .bind(code, orgId, createdBy, inviteRole, now.toISOString(), expires.toISOString(), maxUses, ref)
    .run();
  return { code, orgId, role: inviteRole, expiresAt: expires.toISOString(), maxUses, ref };
}

// Redeem an invite code: look it up, add the user to that org.
export async function acceptInvite(env, { code, userId }) {
  if (!code || !userId) return { error: "Missing code." };
  // One message for unknown, expired and spent: distinguishing them tells a
  // guesser which of their guesses was once real.
  const row = await readInvite(env.DB, code.trim());
  if (!row) return { error: "That invite code is not valid." };
  // upsertMembership assigns the role outright, so redeeming a member link for
  // an org you already administer used to demote you. An invite can add you,
  // and can raise you, but must never take standing away.
  const existing = await env.DB
    .prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(row.org_id, userId)
    .first();
  const offered = String(row.role || "member").toLowerCase();
  const held = String(existing?.role || "").toLowerCase();
  const keep = existing && (ROLE_RANK.get(held) ?? 0) >= (ROLE_RANK.get(offered) ?? 0) ? held : offered;

  // A redemption that grants nothing costs nothing. Spending first meant the
  // inviter testing their own link — or anyone already in the org — burned the
  // single use, and the person it was actually for was then told the code was
  // not valid. Only a redemption that adds someone, or raises them, takes one.
  if (!existing || keep !== held) {
    if (!(await spendInvite(env.DB, code.trim()))) {
      return { error: "That invite code is not valid." };
    }
    await upsertMembership(env.DB, row.org_id, userId, keep);
  }
  return { orgId: row.org_id };
}