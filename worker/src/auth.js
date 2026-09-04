// Simple email/password auth helpers. Passwords are hashed with PBKDF2 (built
// into the Workers runtime — no external dependency). This is intentionally
// simple; stronger token handling is a later concern.

import { createSession, upsertUser, upsertMembership } from "./db.js";

const ENC = new TextEncoder();

// How long an invite stays redeemable.
const INVITE_TTL_DAYS = 7;

// Ordered so an invite can be compared against the inviter's own standing.
// Everything outside this map is not a role.
const ROLE_RANK = new Map([
  ["member", 0], ["designer", 0], ["engineer", 0], ["triager", 1], ["admin", 2],
]);

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Derive a hash from a password + salt using PBKDF2-SHA256.
async function hashPassword(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", ENC.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  return toHex(bits);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", ENC.encode(value));
  return toHex(digest);
}

function newSaltHex() {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

// Constant-time-ish string compare to avoid leaking timing on the hash.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function validEmail(email) {
  return typeof email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

// Create an account: hash the password, store the user, put them in a default
// org, and return a session token the client can use immediately.
export async function signup(env, { email, password, name, inviteCode }) {
  if (!validEmail(email)) return { error: "Please enter a valid email." };
  if (typeof password !== "string" || password.length < 8) {
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
  const salt = newSaltHex();
  const hash = await hashPassword(password, salt);
  // `login` is the relay's identity: sendTo() matches on exactly this string,
  // so it must be unique and must not be chosen by the caller. Derive it from
  // the email (already unique) and keep `name` as display text only.
  const login = `u:${normalizedEmail}`;
  const displayName = name?.trim() || normalizedEmail.split("@")[0];

  await upsertUser(env.DB, { githubId: userId, login, name: displayName, avatarUrl: null, locale: "en" });
  await env.DB
    .prepare("UPDATE users SET email = ?1, password_hash = ?2, password_salt = ?3 WHERE github_id = ?4")
    .bind(normalizedEmail, hash, salt, userId)
    .run();

  // A caller-supplied orgId is not authorization. Signup may only place a user
  // in an org a valid invite names, or in a fresh org of their own. Trusting
  // body.orgId let anyone write a membership row for a private org, and
  // authorizeOrgAccess treats that row as proof of access.
  let org;
  let joinRole = "member";
  if (inviteCode?.trim()) {
    const invite = await env.DB
      .prepare("SELECT org_id, role, expires_at FROM invites WHERE code = ?1")
      .bind(inviteCode.trim())
      .first();
    const expired = invite?.expires_at && new Date(invite.expires_at) < new Date();
    if (!invite || expired) return { error: "That invite code is not valid." };
    org = invite.org_id;
    joinRole = invite.role || "member";
  } else {
    // Their own org. Derived from the user id so no one else can claim it, but
    // hashed: this id travels in the socket's query string, and a URL is the
    // classic place an address ends up somewhere it was never meant to be.
    org = `personal:${(await sha256Hex(userId)).slice(0, 24)}`;
    joinRole = "admin";
  }
  await upsertMembership(env.DB, org, userId, joinRole);
  const token = await createSession(env.DB, userId, "email-auth");
  return { token, userId, login, orgId: org };
}

// Log in: look up by email, verify the password, return a session token.
export async function login(env, { email, password }) {
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

  const token = await createSession(env.DB, row.github_id, "email-auth");
  return { token, userId: row.github_id, login: row.login };
}


// Create a reusable invite code for an org. Any current member can make one.
export async function createInvite(env, { orgId, createdBy, role }) {
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
  const now = new Date();
  const expires = new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  await env.DB
    .prepare("INSERT INTO invites (code, org_id, created_by, role, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(code, orgId, createdBy, inviteRole, now.toISOString(), expires.toISOString())
    .run();
  return { code, orgId, role: inviteRole, expiresAt: expires.toISOString() };
}

// Redeem an invite code: look it up, add the user to that org.
export async function acceptInvite(env, { code, userId }) {
  if (!code || !userId) return { error: "Missing code." };
  const row = await env.DB
    .prepare("SELECT org_id, role, expires_at FROM invites WHERE code = ?1")
    .bind(code.trim())
    .first();
  // One message for "no such code" and "expired": distinguishing them tells a
  // guesser which of their guesses was once real.
  if (!row) return { error: "That invite code is not valid." };
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return { error: "That invite code is not valid." };
  }
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
  await upsertMembership(env.DB, row.org_id, userId, keep);
  return { orgId: row.org_id };
}