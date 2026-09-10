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
  signup, acceptInvite, EMAIL_AUTH_TOKEN,
} from "./auth.js";
import { createSession, primaryOrgId } from "./db.js";
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
    await env.DB.prepare("DELETE FROM login_codes WHERE email = ?1").bind(address).run();
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
    await env.DB.prepare("DELETE FROM login_codes WHERE email = ?1").bind(address).run();
    return dead;
  }

  const attempt = await hashPassword(String(code).trim(), row.code_salt);
  if (!safeEqual(attempt, row.code_hash)) {
    // Counted in the database, not in memory: the guesses arrive on different
    // requests, and a Worker isolate does not survive between them.
    await env.DB
      .prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?1")
      .bind(address)
      .run();
    const left = MAX_ATTEMPTS - (row.attempts + 1);
    return left > 0
      ? { error: `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.`, status: 400 }
      : dead;
  }

  // Spent. A correct code is single-use, whatever happens after this line.
  await env.DB.prepare("DELETE FROM login_codes WHERE email = ?1").bind(address).run();

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

  // An invite handed to someone who already has an account used to be dropped
  // on the floor: `signup` redeems one, this branch did not, and the sign-in
  // screen offers the field to everyone. So the person pasted the code they
  // were sent, was signed in, and landed back in their own empty workspace
  // with no error and no way to try again — the code was never spent, and
  // nothing in either client redeems one.
  //
  // The emailed code is a credential and it was correct, so a bad invite never
  // costs the session: they are signed in either way, and `inviteError` says
  // what did not happen. Anything else burns a single-use sign-in code on a
  // typo in a different field.
  let joined = null;
  let inviteError;
  if (inviteCode?.trim()) {
    const redeemed = await acceptInvite(env, { code: inviteCode.trim(), userId: user.github_id });
    if (redeemed.error) inviteError = redeemed.error;
    else joined = redeemed.orgId;
  }

  return {
    token,
    userId: user.github_id,
    login: user.login,
    created: false,
    // Where to put them. The org they just joined if they joined one, and
    // otherwise where they already work — a returning person on a second
    // browser has nothing stored to fall back on.
    orgId: joined || (await primaryOrgId(env.DB, user.github_id)) || undefined,
    ...(inviteError ? { inviteError } : {}),
  };
}
