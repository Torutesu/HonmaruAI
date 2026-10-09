/// Sign in with Apple, from the phone app (POST /auth/apple).
///
/// The app asks Apple for an identity token with a nonce it made up — it
/// hands Apple the SHA-256 of a random string and sends us the string. The
/// token is a JWT signed by Apple (RS256, keys at appleid.apple.com/auth/keys,
/// fetched like an identity provider's in sso.js and kept an hour). Checked:
/// the signature, the issuer, that it is for one of our apps (APPLE_CLIENT_IDS,
/// comma separated; the App Store app and the PoC by default), that it has not
/// expired, and that its nonce is the hash of the string we were sent — so a
/// token lifted from somewhere else is no use without the string behind it.
///
/// Then the person: the Apple account already linked here, or the account
/// with the address Apple vouches for (one that proved it here too), or a new
/// account made the way an emailed-code sign-up makes one. A private relay
/// address (…@privaterelay.appleid.com) is an address like any other.
///
/// The app also sends the authorization code Apple gave it. After the person
/// is in, that code is traded at Apple for a refresh token, which is kept
/// sealed beside the Apple identity. Its only use is the other end of the
/// account: Apple asks that deleting an account here also ends the person's
/// Sign in with Apple authorization for the app (App Review 5.1.1(v)), and the
/// revoke endpoint wants a token to do it with. The trade needs our Sign in
/// with Apple private key (APPLE_SIGNIN_KEY, APPLE_SIGNIN_KEY_ID,
/// APPLE_TEAM_ID); without it, or when Apple says no, the person is signed in
/// all the same and there is simply nothing to revoke later.

import { signedClaims } from "./sso.js";
import { signup, acceptInvite, sha256Hex, EMAIL_AUTH_TOKEN, MAX_NAME_CHARS } from "./auth.js";
import { createSession, primaryOrgId } from "./db.js";
import { base64url, derFromPEM } from "./apns.js";
import { sealField, openField, aad } from "./secrets.js";
import { logJSON, safe } from "./log.js";

export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys";
export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
export const DEFAULT_APPLE_CLIENT_IDS = ["com.honmaru.ai", "com.honmaru.ai.poc"];
const SKEW_SECONDS = 120;

export function appleClientIds(env) {
  const list = String(env.APPLE_CLIENT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_APPLE_CLIENT_IDS;
}

/// Apple's claims when the token holds, or a thrown error that says why not.
export async function verifyAppleToken(token, { clientIds, nonce, now = Date.now() }) {
  const head = String(token || "").split(".")[0];
  let alg = null;
  try { alg = JSON.parse(atob(head.replace(/-/g, "+").replace(/_/g, "/"))).alg; } catch { /* checked below */ }
  // Apple signs with RS256 and nothing else; anything else is not from Apple.
  if (alg !== "RS256") throw new Error("That is not a token from Apple.");
  const c = await signedClaims(token, { jwks_uri: APPLE_KEYS_URL });
  const seconds = Math.floor(now / 1000);
  if (c.iss !== APPLE_ISSUER) throw new Error("That is not a token from Apple.");
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.some((a) => clientIds.includes(a))) throw new Error("The token from Apple is for a different app.");
  if (!Number.isFinite(c.exp) || c.exp + SKEW_SECONDS < seconds) throw new Error("The token from Apple has expired. Try again.");
  if (Number.isFinite(c.iat) && c.iat - SKEW_SECONDS > seconds) throw new Error("The token from Apple was issued in the future.");
  if (typeof c.sub !== "string" || !c.sub) throw new Error("The token from Apple names nobody.");
  if (typeof nonce !== "string" || !nonce || typeof c.nonce !== "string" || c.nonce.toLowerCase() !== (await sha256Hex(nonce))) {
    throw new Error("The token from Apple is not for this sign-in.");
  }
  return c;
}

const verified = (v) => v === true || v === "true";

async function link(env, subject, githubId, email) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO apple_identities (subject, user_github_id, email, created_at, last_login_at) VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(subject) DO UPDATE SET email = COALESCE(excluded.email, apple_identities.email), last_login_at = excluded.last_login_at`
  ).bind(subject, String(githubId), email || null, now).run();
}

/// Verify the token and sign the person in. The same answer as
/// /auth/otp/verify: { token, userId, login, orgId, created, inviteError? },
/// or { error, status }. `after` runs work past the response where the
/// runtime allows it (the route's ctx.waitUntil); without it that work is
/// awaited here, for a few seconds at most.
export async function signInWithApple(env, { identityToken, nonce, name, inviteCode, locale, authorizationCode }, { after } = {}) {
  let claims;
  try {
    claims = await verifyAppleToken(identityToken, { clientIds: appleClientIds(env), nonce });
  } catch (err) {
    return { error: err?.message || "Apple could not sign you in.", status: 401 };
  }
  const subject = claims.sub;
  // The app the token was for is the client_id Apple wants back when the code
  // is traded and when the token is revoked.
  const clientId = (Array.isArray(claims.aud) ? claims.aud : [claims.aud]).find((a) => appleClientIds(env).includes(a));
  // Once the person is linked: the code for a refresh token, off the
  // response's path where it can be. It never decides whether the sign-in
  // worked.
  const keepToken = async () => {
    const work = () => keepRefreshToken(env, { subject, clientId, code: authorizationCode })
      .catch((err) => console.error("apple code exchange failed", safe(err?.message || err)));
    if (after) after(work);
    else await Promise.race([work(), new Promise((r) => setTimeout(r, EXCHANGE_WAIT_MS))]);
  };
  const email = typeof claims.email === "string" && verified(claims.email_verified) ? claims.email.trim().toLowerCase() : null;

  // Linked before: that account, whatever address Apple now forwards to.
  const linked = await env.DB.prepare(
    "SELECT u.github_id, u.login FROM apple_identities a JOIN users u ON u.github_id = a.user_github_id WHERE a.subject = ?1"
  ).bind(subject).first();
  let user = linked;
  if (!user && email) {
    const byEmail = await env.DB.prepare("SELECT github_id, login, email_verified_at FROM users WHERE email = ?1").bind(email).first();
    if (byEmail) {
      // The same address is the same person only where it was proved here as
      // well (the rule SSO keeps, sso.js accountFor): an address someone typed
      // at a password sign-up and never received mail at is not enough.
      if (!byEmail.email_verified_at) {
        return { error: "An account with this address exists but has not proved it. Sign in with an email code once, then try again.", status: 409 };
      }
      user = byEmail;
    }
  }

  if (!user) {
    if (!email) {
      return { error: "Apple did not share an email address with us. Sign in with Apple again and share one (Hide My Email works), or use an email code.", status: 400 };
    }
    const displayName = typeof name === "string" ? name.trim().slice(0, MAX_NAME_CHARS) : undefined;
    const created = await signup(env, { email, name: displayName || undefined, inviteCode, locale, passwordless: true, emailProved: true });
    if (created.error) return { error: created.error, status: 400 };
    // Apple proved the address, as a code would have.
    await env.DB.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?2) WHERE github_id = ?1")
      .bind(created.userId, new Date().toISOString()).run();
    await link(env, subject, created.userId, email);
    await keepToken();
    return { ...created, created: true };
  }

  await link(env, subject, user.github_id, email);
  await keepToken();
  const token = await createSession(env.DB, user.github_id, EMAIL_AUTH_TOKEN);
  // An invitation means the same here as on every other way in; a bad one
  // does not cost the sign-in.
  let joined = null;
  let inviteError;
  if (typeof inviteCode === "string" && inviteCode.trim()) {
    const redeemed = await acceptInvite(env, { code: inviteCode.trim(), userId: user.github_id });
    if (redeemed.error) inviteError = redeemed.error;
    else if (!redeemed.pending) joined = redeemed.orgId;
  }
  return {
    token,
    userId: user.github_id,
    login: user.login,
    created: false,
    orgId: joined || (await primaryOrgId(env.DB, user.github_id)) || undefined,
    ...(inviteError ? { inviteError } : {}),
  };
}

// ---- The refresh token, and revoking it ----

const EXCHANGE_WAIT_MS = 5_000;
const APPLE_CALL_MS = 10_000;
// Apple allows a client secret up to six months; this one is made for each
// call and lives five minutes, so a copy of it is worth little.
const CLIENT_SECRET_SECONDS = 300;

/// Whether this deployment holds the Sign in with Apple private key. Without
/// it there is no client secret, so no trading codes and no revoking.
export function appleKeyConfigured(env) {
  return Boolean(env.APPLE_SIGNIN_KEY && env.APPLE_SIGNIN_KEY_ID && env.APPLE_TEAM_ID);
}

const b64urlJSON = (object) => base64url(new TextEncoder().encode(JSON.stringify(object)));

/// The client_secret Apple's token and revoke endpoints ask for: a JWT signed
/// ES256 with the Sign in with Apple key (the .p8, PKCS#8 PEM), naming the key
/// in its header, and our team, Apple, and the app in its claims.
export async function appleClientSecret(env, clientId, now = Date.now()) {
  const key = await crypto.subtle.importKey(
    "pkcs8", derFromPEM(env.APPLE_SIGNIN_KEY), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
  const iat = Math.floor(now / 1000);
  const header = b64urlJSON({ alg: "ES256", kid: String(env.APPLE_SIGNIN_KEY_ID).trim() });
  const claims = b64urlJSON({
    iss: String(env.APPLE_TEAM_ID).trim(), iat, exp: iat + CLIENT_SECRET_SECONDS, aud: APPLE_ISSUER, sub: clientId,
  });
  const input = `${header}.${claims}`;
  // Web Crypto's ECDSA signature is already r||s, the form a JWT wants.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input));
  return `${input}.${base64url(signature)}`;
}

function claimsOf(jwt) {
  try {
    const part = String(jwt || "").split(".")[1];
    return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

/// Trade the app's authorization code for a refresh token and keep it on the
/// Apple identity, sealed. Says what happened; throws only on the unexpected
/// (Apple unreachable), which the caller logs.
export async function keepRefreshToken(env, { subject, clientId, code }) {
  if (typeof code !== "string" || !code) return { kept: false, reason: "no-code" };
  if (!appleKeyConfigured(env)) return { kept: false, reason: "no-key" };
  if (!clientId) return { kept: false, reason: "no-client" };
  const res = await fetch(APPLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: await appleClientSecret(env, clientId),
      code,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(APPLE_CALL_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.refresh_token !== "string" || !body.refresh_token) {
    logJSON({ event: "apple.code_exchange", outcome: "failed", status: res.status, error: safe(body.error) });
    return { kept: false, reason: body.error || `status ${res.status}` };
  }
  // The code must be this person's. Apple's id_token in the answer, straight
  // from Apple over TLS, names whose it was; a code from another Apple account
  // would otherwise put someone else's authorization on this row, for us to
  // revoke one day.
  if (claimsOf(body.id_token)?.sub !== subject) {
    logJSON({ event: "apple.code_exchange", outcome: "other-subject" });
    return { kept: false, reason: "other-subject" };
  }
  await env.DB.prepare("UPDATE apple_identities SET refresh_token = ?2, client_id = ?3 WHERE subject = ?1")
    .bind(subject, await sealField(body.refresh_token, aad.appleRefresh(subject)), clientId).run();
  logJSON({ event: "apple.code_exchange", outcome: "kept" });
  return { kept: true };
}

/// End the person's Sign in with Apple authorization for every Apple identity
/// linked to this account, before the rows go (account deletion). One log line
/// per identity: revoked, failed (Apple said no, or could not be reached),
/// skipped for want of the key, or nothing to revoke. An identity signed in
/// before refresh tokens were kept, or whose code could not be traded, holds no
/// token and so has nothing to revoke; the person can still remove the app
/// themselves in their Apple Account settings (Sign in with Apple). None of
/// these stops the deletion.
export async function revokeAppleTokens(env, githubId) {
  let rows;
  try {
    ({ results: rows = [] } = await env.DB.prepare(
      "SELECT subject, client_id, refresh_token FROM apple_identities WHERE user_github_id = ?1"
    ).bind(String(githubId)).all());
  } catch (err) {
    if (/no such (table|column)/i.test(String(err?.message))) return [];
    throw err;
  }
  const outcomes = [];
  for (const row of rows) {
    const token = row.refresh_token ? await openField(row.refresh_token, aad.appleRefresh(row.subject)) : null;
    let outcome;
    if (!token || !row.client_id) outcome = { outcome: "nothing-to-revoke" };
    else if (!appleKeyConfigured(env)) outcome = { outcome: "skipped", reason: "no-key" };
    else {
      try {
        const res = await fetch(APPLE_REVOKE_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: row.client_id,
            client_secret: await appleClientSecret(env, row.client_id),
            token,
            token_type_hint: "refresh_token",
          }),
          signal: AbortSignal.timeout(APPLE_CALL_MS),
        });
        // 200 is revoked, or already invalid: either way it is over.
        if (res.ok) outcome = { outcome: "revoked" };
        else {
          const body = await res.json().catch(() => ({}));
          outcome = { outcome: "failed", status: res.status, reason: safe(body.error || "") };
        }
      } catch (err) {
        outcome = { outcome: "failed", reason: safe(err?.message || err) };
      }
    }
    logJSON({ event: "account.apple_revoke", ...outcome });
    if (outcome.outcome === "failed") console.error("apple token not revoked", outcome.status || "", outcome.reason || "");
    outcomes.push(outcome);
  }
  return outcomes;
}
