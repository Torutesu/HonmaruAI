// Simple email/password auth helpers. Passwords are hashed with PBKDF2 (built
// into the Workers runtime — no external dependency). This is intentionally
// simple; stronger token handling is a later concern.

import { createSession, upsertUser, upsertMembership } from "./db.js";

const ENC = new TextEncoder();

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
export async function signup(env, { email, password, name, orgId }) {
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
  const login = name?.trim() || normalizedEmail.split("@")[0];

  await upsertUser(env.DB, { githubId: userId, login, name: login, avatarUrl: null, locale: "en" });
  await env.DB
    .prepare("UPDATE users SET email = ?1, password_hash = ?2, password_salt = ?3 WHERE github_id = ?4")
    .bind(normalizedEmail, hash, salt, userId)
    .run();

  const org = orgId?.trim() || "web-team";
  await upsertMembership(env.DB, org, userId, "member");

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