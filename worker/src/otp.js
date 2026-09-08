// Signing in with a code sent to your email.
//
// The design asks for an OTP screen, and it earns its place: a six-digit code
// is the only credential that works the same on a phone you have just
// installed the app on, a browser you borrowed, and a machine where your
// password manager is not signed in. It also proves the address, which is
// what every notification this product sends depends on.
//
// The code is the whole credential, so this file is mostly about making a
// six-digit secret hard to attack: it is stored hashed, it expires, it counts
// its own wrong guesses, and asking for one is rate limited per address.

import {
  hashPassword, newSaltHex, safeEqual, validEmail,
  signup, EMAIL_AUTH_TOKEN,
} from "./auth.js";
import { createSession } from "./db.js";
import { isMailConfigured, sendMail } from "./mailer.js";
import { composeCodeEmail } from "./notifyCopy.js";

// Long enough to switch to a mail app and back, short enough that a code read
// over someone's shoulder is worth little by the time they type it.
export const CODE_TTL_MS = 10 * 60 * 1000;
// A new code invalidates the old one, so this bounds mail volume, not security.
export const RESEND_COOLDOWN_MS = 60 * 1000;
// 10^6 codes, five guesses: one in two hundred thousand, per code.
export const MAX_ATTEMPTS = 5;

/// Six digits, uniformly. `Math.random()` is not a place to economize on a
/// credential, and rejection sampling keeps every code equally likely.
export function newCode() {
  const buf = new Uint32Array(1);
  let value;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= 4294000000);
  return String(value % 1000000).padStart(6, "0");
}

function normalize(email) {
  return String(email || "").trim().toLowerCase();
}

/// Email a sign-in code, replacing any code that address already has.
///
/// Returns `{ ok: true, expiresInSeconds }` whether or not an account exists:
/// this endpoint is unauthenticated, and answering differently for a known
/// address turns it into a way to test whether someone has an account here.
export async function requestCode(env, { email, locale }) {
  if (!validEmail(email)) return { error: "Please enter a valid email.", status: 400 };
  if (!isMailConfigured(env)) {
    // Said plainly, because the client can offer the password form instead.
    // Pretending to have sent mail nobody can receive is the worse failure.
    return { error: "Email sign-in is not configured on this deployment.", status: 503 };
  }
  const address = normalize(email);
  const now = Date.now();

  const existing = await env.DB
    .prepare("SELECT created_at FROM login_codes WHERE email = ?1")
    .bind(address)
    .first();
  if (existing && now - Date.parse(existing.created_at) < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - Date.parse(existing.created_at))) / 1000);
    return { error: `A code was just sent. Try again in ${wait}s.`, status: 429, retryAfter: wait };
  }

  const code = newCode();
  const salt = newSaltHex();
  const hash = await hashPassword(code, salt);
  const expires = new Date(now + CODE_TTL_MS).toISOString();
  await env.DB
    .prepare(
      `INSERT INTO login_codes (email, code_hash, code_salt, expires_at, attempts, created_at)
       VALUES (?1, ?2, ?3, ?4, 0, ?5)
       ON CONFLICT(email) DO UPDATE SET
         code_hash = excluded.code_hash, code_salt = excluded.code_salt,
         expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at`
    )
    .bind(address, hash, salt, expires, new Date(now).toISOString())
    .run();

  // In the language they read, like every other message this product sends.
  // A person who has not signed in yet has no stored language, so the browser's
  // Accept-Language is all we have — which is exactly what it is for.
  const mail = composeCodeEmail({ code, locale, minutes: Math.round(CODE_TTL_MS / 60000) });
  const sent = await sendMail(env, { to: address, subject: mail.subject, text: mail.text });
  if (!sent.ok) {
    // The row would otherwise sit there refusing a resend for a minute over a
    // code that never left the building.
    await env.DB.prepare("DELETE FROM login_codes WHERE email = ?1 AND code_hash = ?2 AND code_salt = ?3")
      .bind(address, hash, salt).run();
    // The provider's status code travels with the refusal, and its message
    // does not. A number is enough to tell a bad key (401) from a permission
    // (403) from a malformed request (422), which is the whole question when
    // mail is configured and nothing arrives — and unlike the message, it
    // names no domain and no address to whoever is asking.
    return {
      error: "We could not send the code. Try again in a moment.",
      status: 502,
      providerStatus: sent.status || undefined,
    };
  }
  return { ok: true, expiresInSeconds: Math.round(CODE_TTL_MS / 1000) };
}

/// Check a code and sign the person in, creating the account if this address
/// has never been here before. Returns the same shape as `login()`.
export async function verifyCode(env, { email, code, name, inviteCode, locale }) {
  if (!validEmail(email)) return { error: "Please enter a valid email.", status: 400 };
  if (!/^\d{6}$/.test(String(code || "").trim())) {
    return { error: "Enter the six-digit code from your email.", status: 400 };
  }
  const address = normalize(email);
  const row = await env.DB
    .prepare("SELECT code_hash, code_salt, expires_at, attempts FROM login_codes WHERE email = ?1")
    .bind(address)
    .first();
  // One message for missing, expired and exhausted. Which of those it is only
  // ever tells a guesser how close they are.
  const dead = { error: "That code is not valid. Ask for a new one.", status: 400 };
  if (!row) return dead;
  if (Date.parse(row.expires_at) < Date.now() || row.attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare("DELETE FROM login_codes WHERE email = ?1 AND code_hash = ?2 AND code_salt = ?3")
      .bind(address, row.code_hash, row.code_salt).run();
    return dead;
  }

  const attempt = await hashPassword(String(code).trim(), row.code_salt);
  if (!safeEqual(attempt, row.code_hash)) {
    // Counted in the database, not in memory: the guesses arrive on different
    // requests, and a Worker isolate does not survive between them.
    const updated = await env.DB.prepare(
      `UPDATE login_codes SET attempts = attempts + 1
       WHERE email = ?1 AND code_hash = ?2 AND code_salt = ?3
         AND attempts < ?4 AND expires_at > ?5 RETURNING attempts`
    ).bind(address, row.code_hash, row.code_salt, MAX_ATTEMPTS, new Date().toISOString()).first();
    if (!updated) return dead;
    const left = MAX_ATTEMPTS - updated.attempts;
    return left > 0
      ? { error: `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.`, status: 400 }
      : dead;
  }

  // Spend only the code that was checked, while its guess budget and expiry
  // are still valid. Hashing awaited above; another request may have replaced
  // or consumed it in the meantime. Exactly one DELETE may issue a session.
  const spent = await env.DB.prepare(
    `DELETE FROM login_codes WHERE email = ?1 AND code_hash = ?2 AND code_salt = ?3
       AND attempts < ?4 AND expires_at > ?5 RETURNING email`
  ).bind(address, row.code_hash, row.code_salt, MAX_ATTEMPTS, new Date().toISOString()).first();
  if (!spent) return dead;

  const user = await env.DB
    .prepare("SELECT github_id, login FROM users WHERE email = ?1")
    .bind(address)
    .first();
  if (!user) {
    const created = await signup(env, { email: address, name, inviteCode, locale, passwordless: true });
    if (created.error) return { error: created.error, status: 400 };
    return { ...created, created: true };
  }

  // Nothing is written to the account here on purpose. An existing person
  // keeps the name and language they chose; `upsertUser` overwrites `name`
  // with what it is given, and this path is given none.
  const token = await createSession(env.DB, user.github_id, EMAIL_AUTH_TOKEN);
  const membership = await env.DB
    .prepare("SELECT org_id FROM memberships WHERE user_github_id = ?1 ORDER BY created_at, org_id LIMIT 1")
    .bind(user.github_id).first();
  return { token, userId: user.github_id, login: user.login, orgId: membership?.org_id ?? null, created: false };
}
