// Signing in with the company's identity provider: OpenID Connect with
// Google Workspace, Okta, Microsoft Entra ID, or any OIDC provider — or
// SAML 2.0 (saml.js). A workspace may connect several, each for its own
// domains.
//
// docs/sso-and-domain-join.md §6–7. An owner connects the provider, proves
// it works with a test sign-in of their own, turns it on, and may then make
// it the only way in for people at the workspace's domains. Everything the
// provider says is checked: the signature on the ID token against its
// published keys, who issued it, who it is for, when, the nonce this sign-in
// sent, and that the address is proved and at one of the workspace's
// domains. The session token never travels in a URL — a one-time code good
// for a minute does, and the client trades it for the session.

import { getSession, getUserByGithubId, createSession, upsertUser, upsertMembership } from "./db.js";
import { sha256Hex, EMAIL_AUTH_TOKEN } from "./auth.js";
import { audit, person, auditEverywhere } from "./audit.js";
import { allowed, ownersOf } from "./permissions.js";
import { memberGate, reauthDenial } from "./policy.js";
import { domainOf, domainMatches } from "./domains.js";
import { enforce } from "./ratelimit.js";
import { spEntityId, acsUrl, spMetadata, redirectUrl, verifyResponse, parseIdpMetadata, normalizeCert } from "./saml.js";

export const PROVIDERS = {
  google: { name: "Google Workspace", issuer: "https://accounts.google.com" },
  okta: { name: "Okta", issuer: null },
  entra: { name: "Microsoft Entra ID", issuer: null },
  oidc: { name: "Single sign-on", issuer: null },
  saml: { name: "SAML 2.0", issuer: null },
};
const STATE_MINUTES = 10;
const HANDOFF_SECONDS = 60;
const SKEW_SECONDS = 120;
const ENFORCE_WITHIN_MINUTES = 10;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-session-token, x-ai-key",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "cache-control": "no-store", "content-type": "application/json", ...CORS } });
}
const redirect = (to) => new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store", "referrer-policy": "no-referrer" } });

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text) => Uint8Array.from(atob(String(text)), (c) => c.charCodeAt(0));
const b64url = (bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (text) => unb64(String(text).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(text).length + 3) % 4));
const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

// ---- The client secret, kept encrypted ----

async function secretKey(env) {
  if (!env.SSO_SECRET_KEY) return null;
  return crypto.subtle.importKey("raw", unb64(env.SSO_SECRET_KEY), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
export async function sealSecret(env, plain) {
  const key = await secretKey(env);
  if (!key) throw new Error("SSO is not set up on this deployment (SSO_SECRET_KEY).");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return `v1:${b64(iv)}:${b64(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain)))}`;
}
async function openSecret(env, sealed) {
  const key = await secretKey(env);
  const [, iv, ct] = String(sealed || "").split(":");
  if (!key || !iv || !ct) return null;
  return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ct)));
}

// ---- The provider's documents ----

const docs = new Map(); // url -> { value, at }
async function fetchJson(url, { fresh = false } = {}) {
  const hit = docs.get(url);
  if (!fresh && hit && Date.now() - hit.at < 3_600_000) return hit.value;
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  const value = await res.json();
  docs.set(url, { value, at: Date.now() });
  return value;
}

/// The provider's discovery document, checked to be for the issuer asked.
export async function discover(issuer) {
  const base = String(issuer || "").replace(/\/$/, "");
  if (!/^https:\/\//.test(base)) throw new Error("The issuer must be an https:// address.");
  const doc = await fetchJson(`${base}/.well-known/openid-configuration`);
  if (String(doc.issuer || "").replace(/\/$/, "") !== base) throw new Error("The provider says it is a different issuer.");
  for (const f of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    if (!/^https:\/\//.test(String(doc[f] || ""))) throw new Error(`The provider has no ${f}.`);
  }
  return doc;
}

export function forgetProviderDocs() {
  docs.clear();
}

// ---- The ID token ----

function decodeJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("The ID token is not a JWT.");
  return {
    header: JSON.parse(dec.decode(unb64url(parts[0]))),
    payload: JSON.parse(dec.decode(unb64url(parts[1]))),
    signed: enc.encode(`${parts[0]}.${parts[1]}`),
    signature: unb64url(parts[2]),
  };
}

async function importJwk(jwk, alg) {
  if (alg === "RS256") return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (alg === "ES256") return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  throw new Error(`The ID token is signed with ${alg}, which is not accepted.`);
}

/// Check an ID token: its signature against the provider's keys (fetched
/// again once when the key is not known — keys rotate), then every claim.
/// A JWT from the provider whose signature holds, as its claims.
async function signedClaims(token, discovery) {
  const jwt = decodeJwt(token);
  const alg = jwt.header.alg;
  if (alg !== "RS256" && alg !== "ES256") throw new Error(`The ID token is signed with ${alg || "nothing"}, which is not accepted.`);
  let keys = (await fetchJson(discovery.jwks_uri)).keys || [];
  let jwk = keys.find((k) => k.kid === jwt.header.kid) || (!jwt.header.kid && keys.length === 1 ? keys[0] : null);
  if (!jwk) {
    keys = (await fetchJson(discovery.jwks_uri, { fresh: true })).keys || [];
    jwk = keys.find((k) => k.kid === jwt.header.kid);
  }
  if (!jwk) throw new Error("The ID token is signed with a key the provider does not publish.");
  const key = await importJwk(jwk, alg);
  const params = alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" };
  if (!(await crypto.subtle.verify(params, key, jwt.signature, jwt.signed))) throw new Error("The ID token's signature is not valid.");
  return jwt.payload;
}

export async function verifyIdToken(token, { discovery, clientId, nonce, now = Date.now() }) {
  const c = await signedClaims(token, discovery);
  const seconds = Math.floor(now / 1000);
  if (String(c.iss || "").replace(/\/$/, "") !== String(discovery.issuer).replace(/\/$/, "")) throw new Error("The ID token is from a different issuer.");
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(clientId)) throw new Error("The ID token is for a different application.");
  if (!Number.isFinite(c.exp) || c.exp + SKEW_SECONDS < seconds) throw new Error("The ID token has expired.");
  if (Number.isFinite(c.iat) && c.iat - SKEW_SECONDS > seconds) throw new Error("The ID token was issued in the future.");
  if (c.nonce !== nonce) throw new Error("The ID token is not for this sign-in.");
  return c;
}

const BACKCHANNEL_EVENT = "http://schemas.openid.net/event/backchannel-logout";
const LOGOUT_TOKEN_MAX_AGE = 10 * 60;

/// Check a logout token (OpenID Connect Back-Channel Logout 1.0 §2.6): the
/// same signature and issuer and audience as an ID token, the logout event,
/// someone or some sign-in named, recent, and no nonce.
export async function verifyLogoutToken(token, { discovery, clientId, now = Date.now() }) {
  const c = await signedClaims(token, discovery);
  const seconds = Math.floor(now / 1000);
  if (String(c.iss || "").replace(/\/$/, "") !== String(discovery.issuer).replace(/\/$/, "")) throw new Error("The logout token is from a different issuer.");
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(clientId)) throw new Error("The logout token is for a different application.");
  if (!Number.isFinite(c.iat) || c.iat - SKEW_SECONDS > seconds || seconds - c.iat > LOGOUT_TOKEN_MAX_AGE) throw new Error("The logout token is too old or from the future.");
  if (Number.isFinite(c.exp) && c.exp + SKEW_SECONDS < seconds) throw new Error("The logout token has expired.");
  if (!c.events || typeof c.events !== "object" || typeof c.events[BACKCHANNEL_EVENT] !== "object") throw new Error("The token is not a logout token.");
  if (!c.sub && !c.sid) throw new Error("The logout token names no one.");
  if ("nonce" in c) throw new Error("A logout token carries no nonce.");
  if (!c.jti) throw new Error("The logout token has no identifier.");
  return c;
}

/// Who the provider says this is: a stable subject and a proved address.
export function identityOf(provider, claims, sso) {
  // Entra's `sub` differs per application; `oid` is the person.
  const subject = provider === "entra" ? (claims.oid || claims.sub) : claims.sub;
  let email = claims.email;
  let proved = claims.email_verified === true || claims.email_verified === "true";
  if (provider === "entra") {
    email = claims.email || claims.preferred_username;
    // Entra says nothing of verification; the tenant and the domain vouch.
    proved = Boolean(email);
    if (sso.tenant_id && claims.tid !== sso.tenant_id) throw new Error("This account is from a different Microsoft tenant.");
  }
  if (provider === "google" && sso.hosted_domain && claims.hd !== sso.hosted_domain) throw new Error("This Google account is not in your Workspace.");
  if (!subject) throw new Error("The provider did not say who this is.");
  if (!email || !proved) throw new Error("The provider did not give a verified email address.");
  const domains = JSON.parse(sso.allowed_domains || "[]");
  if (!domains.some((d) => domainMatches(domainOf(email), d))) throw new Error("This email's domain is not registered for single sign-on here.");
  return { subject: String(subject), email: String(email).trim().toLowerCase(), name: claims.name || null };
}

// ---- The workspace's connections ----
//
// A workspace may have several identity providers — a parent company on
// Okta, a subsidiary on Entra — each for its own domains. A person signs in
// through the one that covers their address. Whether SSO is required is the
// workspace's, not one connection's.

/// The id the one connection a workspace had before there could be several
/// keeps, so links and sessions made then still point at it.
export async function primaryConnectionId(orgId) {
  return `primary-${(await sha256Hex(`sso\u0000${orgId}`)).slice(0, 12)}`;
}

/// A workspace set up with the single `org_sso` row: moved over once.
async function migrateLegacy(db, orgId) {
  const legacy = await db.prepare("SELECT * FROM org_sso WHERE org_id = ?1").bind(orgId).first().catch(() => null);
  if (!legacy) return;
  const id = await primaryConnectionId(orgId);
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO sso_connections (id, org_id, name, provider, issuer, client_id, client_secret, allowed_domains, hosted_domain, tenant_id, session_hours, status, tested_at, test_result, created_by, created_at, updated_at)
       VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)`
    ).bind(id, orgId, legacy.provider, legacy.issuer, legacy.client_id, legacy.client_secret, legacy.allowed_domains, legacy.hosted_domain, legacy.tenant_id,
      legacy.session_hours, legacy.status, legacy.tested_at, legacy.test_result, legacy.created_by, legacy.updated_at),
    db.prepare("INSERT OR IGNORE INTO org_sso_policy (org_id, enforce, enforce_since, updated_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(orgId, legacy.enforce ? 1 : 0, legacy.enforce_since, legacy.updated_at),
    db.prepare("DELETE FROM org_sso WHERE org_id = ?1").bind(orgId),
  ]);
}

export async function connectionsOf(db, orgId) {
  await migrateLegacy(db, orgId);
  const { results } = await db.prepare("SELECT * FROM sso_connections WHERE org_id = ?1 ORDER BY created_at, id").bind(orgId).all().catch(() => ({ results: [] }));
  return results || [];
}
export async function connectionOf(db, orgId, id) {
  await migrateLegacy(db, orgId);
  return db.prepare("SELECT * FROM sso_connections WHERE org_id = ?1 AND id = ?2").bind(orgId, String(id || "")).first().catch(() => null);
}
export async function policyOf(db, orgId) {
  await migrateLegacy(db, orgId);
  const row = await db.prepare("SELECT * FROM org_sso_policy WHERE org_id = ?1").bind(orgId).first().catch(() => null);
  return { enforce: Boolean(row?.enforce), enforceSince: row?.enforce_since || null };
}
const domainsOf = (conn) => JSON.parse(conn?.allowed_domains || "[]");
const covers = (conn, email) => { const d = domainOf(email); return Boolean(d) && domainsOf(conn).some((x) => domainMatches(d, x)); };

/// The switched-on connection that covers an address, if any.
export async function connectionFor(db, orgId, email) {
  return (await connectionsOf(db, orgId)).find((c) => c.status === "active" && covers(c, email)) || null;
}

/// The first connection, as `/orgs/sso` has always shown it.
export async function ssoOf(db, orgId) {
  return (await connectionsOf(db, orgId))[0] || null;
}

export function presentConnection(row, base) {
  if (!row) return null;
  return {
    id: row.id, name: row.name || PROVIDERS[row.provider]?.name || "SSO",
    provider: row.provider, issuer: row.issuer,
    clientId: row.client_id || null, clientSecret: row.client_secret ? "set" : null,
    ssoUrl: row.sso_url || null, certificate: row.idp_cert ? "set" : null,
    allowedDomains: domainsOf(row), hostedDomain: row.hosted_domain, tenantId: row.tenant_id,
    sessionHours: row.session_hours, status: row.status,
    testedAt: row.tested_at, test: row.test_result ? JSON.parse(row.test_result) : null,
    ...(row.provider !== "saml" && base ? { logoutUrl: `${String(base).replace(/\/$/, "")}/sso/oidc/${encodeURIComponent(row.id)}/backchannel-logout` } : {}),
    ...(row.provider === "saml" && base ? { sp: { entityId: spEntityId(base, row.id), acs: acsUrl(base, row.id), metadata: `${spEntityId(base, row.id)}/metadata` } } : {}),
  };
}
export function presentSso(row, policy = null) {
  const out = presentConnection(row);
  return out ? { ...out, enforce: Boolean(policy?.enforce) } : null;
}

/// Whether this workspace requires SSO of this person: it is required, and
/// a switched-on connection covers their address. An owner at some other
/// address — the break-glass owner — never is.
export async function ssoRequiredFor(db, orgId, githubId) {
  const policy = await policyOf(db, orgId);
  if (!policy.enforce) return null;
  const user = await db.prepare("SELECT email FROM users WHERE github_id = ?1").bind(String(githubId)).first();
  if (!domainOf(user?.email)) return null;
  return connectionFor(db, orgId, user.email);
}

/// The refusal for a session this workspace's SSO does not accept, or null.
export async function ssoDenial(env, session, orgId) {
  const required = await ssoRequiredFor(env.DB, orgId, session.github_id);
  const start = (conn) => `/sso/start?orgId=${encodeURIComponent(orgId)}${conn ? `&connection=${encodeURIComponent(conn.id)}` : ""}`;
  if (required && (session.auth_method !== "sso" || session.sso_org_id !== orgId)) {
    return { status: 403, body: { message: "Sign in with your company's single sign-on to open this workspace.", code: "sso-required", orgId, start: start(required) } };
  }
  // An SSO sign-in lasts as long as its connection says, used or not.
  if (session.auth_method === "sso" && session.sso_org_id === orgId) {
    const conn = (session.sso_connection_id && await connectionOf(env.DB, orgId, session.sso_connection_id)) || required || await ssoOf(env.DB, orgId);
    const hours = conn?.session_hours || 24;
    if (Date.now() - Date.parse(session.created_at || "") > hours * 3_600_000) {
      return { status: 401, body: { message: "Sign in with your company's single sign-on again.", code: "sso-reauth", orgId, start: start(conn) } };
    }
  }
  return null;
}

// ---- Signing in ----

async function pkce() {
  const verifier = random(48);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  return { verifier, challenge };
}

const baseOf = (env, url) => String(env.SSO_CALLBACK_BASE || url.origin).replace(/\/$/, "");
function callbackUrl(env, url) {
  return `${baseOf(env, url)}/sso/callback`;
}

/// Which connection a sign-in goes through: the one asked for, the one for
/// the address, or the only one there is.
async function pickConnection(db, orgId, { connectionId, email, test }) {
  if (connectionId) return connectionOf(db, orgId, connectionId);
  if (email) {
    const byEmail = await connectionFor(db, orgId, email);
    if (byEmail) return byEmail;
  }
  const all = (await connectionsOf(db, orgId)).filter((c) => test || c.status === "active");
  return all.length === 1 ? all[0] : null;
}

/// Where the provider's sign-in page is for this workspace, with a state
/// saved to check the answer against.
export async function startUrl(env, url, orgId, { client = "web", email = null, testerId = null, connectionId = null } = {}) {
  const conn = await pickConnection(env.DB, orgId, { connectionId, email, test: client === "test" });
  if (!conn || (client !== "test" && conn.status !== "active")) throw new Error("Single sign-on is not on for this workspace.");
  const state = random(24);
  const now = Date.now();
  const save = (nonce, verifier) => env.DB.prepare(
    `INSERT INTO sso_states (state, org_id, nonce, code_verifier, return_to, tester_id, created_at, expires_at, connection_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  ).bind(state, orgId, nonce, verifier, client, testerId, new Date(now).toISOString(), new Date(now + STATE_MINUTES * 60_000).toISOString(), conn.id).run();

  if (conn.provider === "saml") {
    // The request's ID is what the assertion must answer (InResponseTo).
    const requestId = `_${random(20)}`;
    await save(requestId, "");
    const base = baseOf(env, url);
    return redirectUrl({ ssoUrl: conn.sso_url, requestId, spEntity: spEntityId(base, conn.id), acs: acsUrl(base, conn.id), relayState: state, now });
  }
  const discovery = await discover(conn.issuer);
  const nonce = random(24);
  const { verifier, challenge } = await pkce();
  await save(nonce, verifier);
  const q = new URLSearchParams({
    response_type: "code", client_id: conn.client_id, redirect_uri: callbackUrl(env, url), scope: "openid email profile",
    state, nonce, code_challenge: challenge, code_challenge_method: "S256",
  });
  if (conn.provider === "google" && conn.hosted_domain) q.set("hd", conn.hosted_domain);
  // A refresh token, where the provider gives one, lets us ask it later
  // whether this person may still sign in (checkSsoGrants).
  if (client !== "test") {
    if (conn.provider === "google") q.set("access_type", "offline");
    else if ((discovery.scopes_supported || []).includes("offline_access")) q.set("scope", "openid email profile offline_access");
  }
  if (email) q.set("login_hint", email);
  return `${discovery.authorization_endpoint}?${q.toString()}`;
}

function appUrl(env, fragment) {
  const base = String(env.APP_WEB_URL || "").replace(/\/$/, "");
  return base ? `${base}/#${fragment}` : `/#${fragment}`;
}
const back = (env, client, params) => {
  const q = new URLSearchParams(params).toString();
  if (client === "ios") return `tiktokforwork://sso?${q}`;
  if (client === "test") return appUrl(env, `/tools/sso?${q}`);
  return appUrl(env, `/sso/done?${q}`);
};

/// The account this identity is: already linked, the same proved address,
/// or a new one.
async function accountFor(env, conn, identity) {
  const linked = await env.DB.prepare("SELECT user_github_id FROM sso_identities WHERE issuer = ?1 AND subject = ?2").bind(conn.issuer, identity.subject).first();
  if (linked) return { githubId: String(linked.user_github_id), linked: true };
  const byEmail = await env.DB.prepare("SELECT github_id, email_verified_at FROM users WHERE email = ?1").bind(identity.email).first();
  // The same address is the same person only where it was proved, or the
  // domain is the workspace's own (§6.3): an address somebody typed at
  // sign-up and never received mail at is not enough.
  const domainProved = await env.DB.prepare("SELECT 1 FROM org_domains WHERE org_id = ?1 AND domain = ?2 AND verified_at IS NOT NULL").bind(conn.org_id, domainOf(identity.email)).first()
    || covers(conn, identity.email);
  if (byEmail && (byEmail.email_verified_at || domainProved)) return { githubId: String(byEmail.github_id), linked: false };
  if (byEmail) throw new Error("An account with this address exists but has not proved it. Sign in with an email code once, then try again.");
  const githubId = `sso:${conn.org_id}:${(await sha256Hex(`${conn.issuer}\u0000${identity.subject}`)).slice(0, 24)}`;
  await upsertUser(env.DB, { githubId, login: `u:${identity.email}`, name: identity.name || identity.email.split("@")[0], avatarUrl: null, locale: "en" });
  await env.DB.prepare("UPDATE users SET email = ?2 WHERE github_id = ?1").bind(githubId, identity.email).run();
  return { githubId, linked: false, created: true };
}

/// The state a provider's answer carries: spent once, and its connection.
async function takeState(env, state) {
  const row = await env.DB.prepare("DELETE FROM sso_states WHERE state = ?1 RETURNING *").bind(String(state || "")).first().catch(() => null);
  if (!row) return { row: null };
  const conn = row.connection_id ? await connectionOf(env.DB, row.org_id, row.connection_id) : await ssoOf(env.DB, row.org_id);
  return { row, conn };
}

function failure(env, request, row, client) {
  return async (reason) => {
    await audit(env, request, { orgId: row.org_id, action: "auth.login_failed", actor: { type: "system" }, details: { method: "sso", reason: String(reason).slice(0, 200) }, outcome: "failure" });
    return redirect(back(env, client, { error: String(reason).slice(0, 300) }));
  };
}

/// An identity the provider vouched for: a test result, or a session handed
/// back by a one-time code.
async function finishSignIn(env, request, row, conn, identity, grant = {}) {
  const client = row.return_to || "web";
  const fail = failure(env, request, row, client);
  // A test sign-in proves the connection and signs nobody in.
  if (client === "test") {
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE sso_connections SET tested_at = ?3, test_result = ?4 WHERE org_id = ?1 AND id = ?2")
      .bind(conn.org_id, conn.id, now, JSON.stringify({ email: identity.email, subject: identity.subject, name: identity.name, at: now })).run();
    const tester = row.tester_id ? await getUserByGithubId(env.DB, row.tester_id).catch(() => null) : null;
    await audit(env, request, { orgId: conn.org_id, action: "sso.tested", actor: person(tester) || { type: "system" }, details: { connection: conn.id, provider: conn.provider } });
    return redirect(back(env, "test", { tested: "1", connection: conn.id }));
  }
  let account;
  try { account = await accountFor(env, conn, identity); } catch (err) { return fail(err?.message || String(err)); }
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO sso_identities (org_id, issuer, subject, user_github_id, email, last_login_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(issuer, subject) DO UPDATE SET email = excluded.email, last_login_at = excluded.last_login_at`
  ).bind(conn.org_id, conn.issuer, identity.subject, account.githubId, identity.email, now).run();
  await env.DB.prepare("UPDATE users SET email = ?2, email_verified_at = COALESCE(email_verified_at, ?3) WHERE github_id = ?1").bind(account.githubId, identity.email, now).run();
  // Being in the company's identity provider is being in the company: in,
  // whatever the domain's join policy says.
  if (!(await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id = ?1 AND user_github_id = ?2").bind(conn.org_id, account.githubId).first())) {
    await upsertMembership(env.DB, conn.org_id, account.githubId, "member", "sso");
    const joiner = await getUserByGithubId(env.DB, account.githubId);
    await audit(env, request, { orgId: conn.org_id, action: "member.joined", actor: person(joiner), details: { via: "sso", role: "member" } });
  }
  const token = await createSession(env.DB, account.githubId, EMAIL_AUTH_TOKEN, { client: client === "ios" ? "ios" : "web" });
  const refresh = grant.refresh ? await sealSecret(env, grant.refresh) : null;
  const mark = () => env.DB.prepare(
    "UPDATE sessions SET auth_method = 'sso', sso_org_id = ?2, sso_connection_id = ?3, sso_subject = ?4, sso_sid = ?5, sso_refresh = ?6, sso_checked_at = ?7 WHERE token = ?1"
  ).bind(token, conn.org_id, conn.id, grant.sub || identity.subject, grant.sid || null, refresh, now).run();
  await mark();
  const { signedIn } = await import("./sessions.js");
  await signedIn(env, request, token, account.githubId, "sso");
  await mark();
  const code = random(24);
  await env.DB.prepare("INSERT INTO sso_handoffs (code, token, org_id, client, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(await sha256Hex(code), token, conn.org_id, client, new Date(Date.now() + HANDOFF_SECONDS * 1000).toISOString()).run();
  return redirect(back(env, client, { code }));
}

/// The OIDC provider's answer: checked, and the sign-in finished.
export async function callback(env, request, url) {
  const { row, conn } = await takeState(env, url.searchParams.get("state"));
  if (!row) return redirect(back(env, "web", { error: "This sign-in has expired. Start again." }));
  const fail = failure(env, request, row, row.return_to || "web");
  if (row.expires_at <= new Date().toISOString()) return fail("This sign-in has expired. Start again.");
  if (url.searchParams.get("error")) return fail(`Your identity provider refused: ${url.searchParams.get("error_description") || url.searchParams.get("error")}`);
  if (!conn || conn.provider === "saml") return fail("Single sign-on is not set up for this workspace.");
  let identity;
  let grant = {};
  try {
    const discovery = await discover(conn.issuer);
    const secret = await openSecret(env, conn.client_secret);
    const form = new URLSearchParams({
      grant_type: "authorization_code", code: url.searchParams.get("code") || "", redirect_uri: callbackUrl(env, url),
      client_id: conn.client_id, code_verifier: row.code_verifier, ...(secret ? { client_secret: secret } : {}),
    });
    const res = await fetch(discovery.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form, signal: AbortSignal.timeout(15_000) });
    const tokens = await res.json().catch(() => ({}));
    if (!res.ok || !tokens.id_token) throw new Error(`Your identity provider refused: ${tokens.error_description || tokens.error || res.status}`);
    const claims = await verifyIdToken(tokens.id_token, { discovery, clientId: conn.client_id, nonce: row.nonce });
    identity = identityOf(conn.provider, claims, conn);
    // The token's own `sub` (Entra's is not its `oid`), as a logout token names it.
    grant = { sub: claims.sub ? String(claims.sub) : null, sid: typeof claims.sid === "string" ? claims.sid : null, refresh: typeof tokens.refresh_token === "string" ? tokens.refresh_token : null };
  } catch (err) {
    return fail(err?.message || String(err));
  }
  return finishSignIn(env, request, row, conn, identity, grant);
}

/// The SAML assertion posted back: checked, and the sign-in finished. Only a
/// response to a request we sent is taken (no IdP-initiated sign-in).
export async function samlAcs(env, request, url, connectionId) {
  const form = await request.formData().catch(() => null);
  const { row, conn } = await takeState(env, form?.get("RelayState"));
  if (!row) return redirect(back(env, "web", { error: "This sign-in has expired, or was not started here. Start again from the sign-in page." }));
  const fail = failure(env, request, row, row.return_to || "web");
  if (row.expires_at <= new Date().toISOString()) return fail("This sign-in has expired. Start again.");
  if (!conn || conn.provider !== "saml" || conn.id !== connectionId) return fail("This sign-in is for a different connection.");
  let identity;
  try {
    const base = baseOf(env, url);
    const said = verifyResponse(form.get("SAMLResponse"), {
      cert: conn.idp_cert, idpEntityId: conn.issuer, spEntity: spEntityId(base, conn.id), acs: acsUrl(base, conn.id), requestId: row.nonce,
    });
    if (!covers(conn, said.email)) throw new Error("This email's domain is not registered for single sign-on here.");
    identity = { subject: said.subject, email: said.email, name: said.name };
  } catch (err) {
    return fail(err?.message || String(err));
  }
  return finishSignIn(env, request, row, conn, identity);
}

/// The one-time code for the session it stands for: once, within a minute,
/// by the kind of client it was issued to.
export async function exchange(env, { code, client }) {
  const kind = client === "ios" ? "ios" : "web";
  // Spent only by the kind of client it was issued to, and then only once.
  const row = await env.DB.prepare("DELETE FROM sso_handoffs WHERE code = ?1 AND (CASE WHEN client = 'ios' THEN 'ios' ELSE 'web' END) = ?2 RETURNING *")
    .bind(await sha256Hex(String(code || "")), kind).first().catch(() => null);
  if (!row || row.expires_at <= new Date().toISOString()) return { error: "That sign-in code has expired, or is for a different app. Start again.", status: 400 };
  const session = await env.DB.prepare("SELECT github_id FROM sessions WHERE token = ?1").bind(row.token).first();
  if (!session) return { error: "That sign-in has ended.", status: 400 };
  const user = await getUserByGithubId(env.DB, session.github_id);
  return { token: row.token, userId: String(session.github_id), login: user?.login || null, orgId: row.org_id };
}

/// Required, now: every session of the people it covers that did not come
/// through SSO ends. Their API keys keep working until they next need SSO.
async function endNonSsoSessions(env, orgId, conns) {
  const { results } = await env.DB.prepare(
    `SELECT s.token, s.github_id, s.auth_method, s.sso_org_id, u.email FROM sessions s
       JOIN memberships m ON m.user_github_id = s.github_id AND m.org_id = ?1 JOIN users u ON u.github_id = s.github_id`
  ).bind(orgId).all();
  let ended = 0;
  for (const s of results || []) {
    if (!conns.some((c) => covers(c, s.email))) continue;
    if (s.auth_method === "sso" && s.sso_org_id === orgId) continue;
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?1").bind(s.token).run();
    ended += 1;
  }
  return ended;
}

/// What an owner sends to make or change a connection, checked. Returns the
/// columns to store, or { error }.
async function connectionFields(env, orgId, body, current) {
  const provider = PROVIDERS[body.provider] ? body.provider : current?.provider || null;
  if (!provider) return { error: "Choose an identity provider." };
  const { results } = await env.DB.prepare("SELECT domain FROM org_domains WHERE org_id = ?1 AND verified_at IS NOT NULL").bind(orgId).all();
  const verified = (results || []).map((r) => r.domain);
  const domains = (Array.isArray(body.allowedDomains) ? body.allowedDomains : current ? domainsOf(current) : []).map((d) => String(d).trim().toLowerCase()).filter(Boolean);
  if (!domains.length || domains.some((d) => !verified.includes(d))) return { error: "Choose domains this workspace has verified." };
  // One address, one way in: two connections never cover the same domain.
  const others = (await connectionsOf(env.DB, orgId)).filter((c) => c.id !== current?.id && c.status !== "disabled");
  const clash = domains.find((d) => others.some((c) => domainsOf(c).some((x) => domainMatches(d, x) || domainMatches(x, d))));
  if (clash) return { error: `${clash} is already covered by another connection.`, status: 409 };
  const hours = body.sessionHours === undefined || body.sessionHours === null || body.sessionHours === "" ? (current?.session_hours || 24) : Number(body.sessionHours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) return { error: "An SSO sign-in lasts from 1 to 720 hours." };
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) || null : current?.name || null;
  const common = { provider, allowed_domains: JSON.stringify(domains), session_hours: hours, name };

  if (provider === "saml") {
    let issuer = String(body.issuer ?? current?.issuer ?? "").trim();
    let ssoUrl = String(body.ssoUrl ?? current?.sso_url ?? "").trim();
    let cert = body.certificate ? String(body.certificate) : null;
    if (body.metadataXml) {
      try {
        const md = parseIdpMetadata(String(body.metadataXml));
        issuer = md.entityId || issuer; ssoUrl = md.ssoUrl || ssoUrl; cert = md.cert;
      } catch (err) { return { error: `Could not read the metadata: ${err?.message || err}` }; }
    }
    if (!issuer) return { error: "The identity provider's entity ID is required." };
    if (!/^https:\/\//.test(ssoUrl)) return { error: "The identity provider's sign-in address must be https://." };
    let pem = current?.idp_cert || null;
    if (cert) { try { pem = normalizeCert(cert); } catch (err) { return { error: err.message }; } }
    if (!pem) return { error: "The identity provider's signing certificate is required." };
    const retest = !current || current.issuer !== issuer || current.sso_url !== ssoUrl || current.idp_cert !== pem;
    return { fields: { ...common, issuer, sso_url: ssoUrl, idp_cert: pem, client_id: null, client_secret: null, hosted_domain: null, tenant_id: null }, retest };
  }
  if (!env.SSO_SECRET_KEY) return { error: "Single sign-on is not set up on this deployment yet.", status: 503 };
  const issuer = String(body.issuer || current?.issuer || PROVIDERS[provider].issuer || "").trim().replace(/\/$/, "");
  const clientId = String(body.clientId || current?.client_id || "").trim();
  if (!issuer || !clientId) return { error: "The issuer and client ID are required." };
  if (!body.clientSecret && !current?.client_secret) return { error: "The client secret is required." };
  try { await discover(issuer); } catch (err) { return { error: `Could not read the provider: ${err?.message || err}` }; }
  const secret = body.clientSecret ? await sealSecret(env, String(body.clientSecret)) : current.client_secret;
  // A new provider or application has to be tested again.
  const retest = !current || current.issuer !== issuer || current.client_id !== clientId || Boolean(body.clientSecret);
  return {
    fields: { ...common, issuer, client_id: clientId, client_secret: secret, sso_url: null, idp_cert: null, hosted_domain: body.hostedDomain ?? current?.hosted_domain ?? null, tenant_id: body.tenantId ?? current?.tenant_id ?? null },
    retest, secretChanged: Boolean(body.clientSecret),
  };
}

const COLUMNS = ["name", "provider", "issuer", "client_id", "client_secret", "sso_url", "idp_cert", "allowed_domains", "hosted_domain", "tenant_id", "session_hours"];

async function saveConnection(env, orgId, id, fields, { createdBy, retest, existing }) {
  const now = new Date().toISOString();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO sso_connections (id, org_id, ${COLUMNS.join(", ")}, status, created_by, created_at, updated_at)
       VALUES (?1, ?2, ${COLUMNS.map((_, i) => `?${i + 3}`).join(", ")}, 'draft', ?${COLUMNS.length + 3}, ?${COLUMNS.length + 4}, ?${COLUMNS.length + 4})`
    ).bind(id, orgId, ...COLUMNS.map((c) => fields[c] ?? null), String(createdBy), now).run();
    return;
  }
  await env.DB.prepare(
    `UPDATE sso_connections SET ${COLUMNS.map((c, i) => `${c} = ?${i + 3}`).join(", ")}, updated_at = ?${COLUMNS.length + 3} WHERE org_id = ?1 AND id = ?2`
  ).bind(orgId, id, ...COLUMNS.map((c) => fields[c] ?? null), now).run();
  if (retest) {
    await env.DB.prepare("UPDATE sso_connections SET tested_at = NULL, test_result = NULL, status = CASE WHEN status = 'active' THEN 'testing' ELSE 'draft' END WHERE org_id = ?1 AND id = ?2").bind(orgId, id).run();
  }
}

/// POST /auth/discover · GET /sso/start · GET /sso/callback ·
/// POST /sso/exchange · GET /sso/saml/:id/metadata · POST /sso/saml/:id/acs ·
/// GET /orgs/sso · POST /orgs/sso/connections · PUT|DELETE /orgs/sso/connections/:id ·
/// POST /orgs/sso/connections/:id/test|activate · PUT /orgs/sso/enforce ·
/// and, for the one connection a workspace used to have, PUT|DELETE /orgs/sso,
/// POST /orgs/sso/test|activate.
// ---- The provider ending sign-ins ----

/// POST /sso/oidc/:id/backchannel-logout — the provider says a sign-in (sid)
/// or everything of one person (sub) has ended there: those sessions end
/// here too, at once. Each logout token is taken once.
async function backchannelLogout(env, request, connectionId) {
  const answer = (status, body) => new Response(body ? JSON.stringify(body) : null, { status, headers: { "cache-control": "no-store", ...(body ? { "content-type": "application/json" } : {}) } });
  const refuse = (description) => answer(400, { error: "invalid_request", error_description: description });
  const conn = await env.DB.prepare("SELECT * FROM sso_connections WHERE id = ?1").bind(String(connectionId)).first().catch(() => null);
  if (!conn || conn.provider === "saml") return refuse("There is no such connection.");
  const form = new URLSearchParams(await request.text().catch(() => ""));
  let claims;
  try {
    claims = await verifyLogoutToken(form.get("logout_token") || "", { discovery: await discover(conn.issuer), clientId: conn.client_id });
  } catch (err) {
    return refuse(err?.message || String(err));
  }
  const now = new Date();
  const seen = await env.DB.prepare("INSERT OR IGNORE INTO sso_logout_tokens (id, expires_at) VALUES (?1, ?2)")
    .bind(`${conn.id}:${claims.jti}`, new Date(now.getTime() + 2 * LOGOUT_TOKEN_MAX_AGE * 1000).toISOString()).run();
  if (!seen.meta?.changes) return refuse("This logout token was already used.");
  const sid = typeof claims.sid === "string" ? claims.sid : null;
  const sub = claims.sub ? String(claims.sub) : null;
  const { results } = await env.DB.prepare(
    `SELECT token, github_id FROM sessions WHERE sso_connection_id = ?1
       AND (?2 IS NULL OR sso_sid = ?2) AND (?3 IS NULL OR sso_subject = ?3)`
  ).bind(conn.id, sid, sub).all();
  const gone = results || [];
  if (gone.length) await env.DB.batch(gone.map((r) => env.DB.prepare("DELETE FROM sessions WHERE token = ?1").bind(r.token)));
  const who = gone[0] ? await getUserByGithubId(env.DB, gone[0].github_id).catch(() => null) : null;
  await audit(env, request, {
    orgId: conn.org_id, action: "sso.idp_signed_out", actor: { type: "system" }, entity: person(who) || undefined,
    details: { connection: conn.id, provider: conn.provider, by: sid ? "sid" : "sub", sessions_ended: gone.length },
  });
  return answer(200);
}

const GRANT_CHECK_MINUTES = 10;

/// Every little while, ask the provider about each SSO sign-in it gave us a
/// refresh token for. A person switched off, deleted or signed out there is
/// refused a new token (invalid_grant), and their session here ends. A
/// provider that cannot be reached leaves sessions alone until next time.
export async function checkSsoGrants(env, { now = Date.now(), limit = 50 } = {}) {
  const due = new Date(now - GRANT_CHECK_MINUTES * 60_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT token, github_id, sso_org_id, sso_connection_id, sso_refresh FROM sessions
      WHERE auth_method = 'sso' AND sso_refresh IS NOT NULL AND (sso_checked_at IS NULL OR sso_checked_at < ?1)
      ORDER BY sso_checked_at LIMIT ?2`
  ).bind(due, limit).all().catch(() => ({ results: [] }));
  const conns = new Map();
  let ended = 0;
  for (const s of results || []) {
    const stamp = new Date(now).toISOString();
    if (!conns.has(s.sso_connection_id)) {
      const conn = await env.DB.prepare("SELECT * FROM sso_connections WHERE id = ?1").bind(String(s.sso_connection_id || "")).first().catch(() => null);
      let discovery = null;
      let secret = null;
      if (conn) {
        discovery = await discover(conn.issuer).catch(() => null);
        secret = await openSecret(env, conn.client_secret).catch(() => null);
      }
      conns.set(s.sso_connection_id, { conn, discovery, secret });
    }
    const { conn, discovery, secret } = conns.get(s.sso_connection_id);
    const ending = async (reason) => {
      await env.DB.prepare("DELETE FROM sessions WHERE token = ?1").bind(s.token).run();
      ended += 1;
      const who = await getUserByGithubId(env.DB, s.github_id).catch(() => null);
      await audit(env, null, { orgId: s.sso_org_id, action: "sso.session_revoked", actor: { type: "system" }, entity: person(who) || undefined, details: { connection: s.sso_connection_id, reason } });
    };
    // The connection it came through is gone: so is the sign-in.
    if (!conn) { await ending("connection-removed"); continue; }
    const touch = (refresh = null) => env.DB.prepare("UPDATE sessions SET sso_checked_at = ?2, sso_refresh = COALESCE(?3, sso_refresh) WHERE token = ?1").bind(s.token, stamp, refresh).run();
    if (!discovery) { await touch(); continue; }
    let res; let body;
    try {
      const refreshToken = await openSecret(env, s.sso_refresh);
      if (!refreshToken) { await touch(); continue; }
      const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: conn.client_id, ...(secret ? { client_secret: secret } : {}) });
      res = await fetch(discovery.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form, signal: AbortSignal.timeout(10_000) });
      body = await res.json().catch(() => ({}));
    } catch {
      await touch();
      continue;
    }
    if (res.ok) {
      await touch(typeof body.refresh_token === "string" ? await sealSecret(env, body.refresh_token) : null);
    } else if (res.status >= 400 && res.status < 500 && body.error === "invalid_grant") {
      await ending("idp-refused");
    } else {
      await touch();
    }
  }
  await env.DB.prepare("DELETE FROM sso_logout_tokens WHERE expires_at < ?1").bind(new Date(now).toISOString()).run().catch(() => {});
  return { checked: (results || []).length, ended };
}

export async function handleSso(request, env, url) {
  const path = url.pathname;
  const bcl = path.match(/^\/sso\/oidc\/([A-Za-z0-9_-]{1,80})\/backchannel-logout$/);
  if (bcl && request.method === "POST") {
    const limited = await enforce(env, request, "sso");
    if (limited) return limited;
    return backchannelLogout(env, request, bcl[1]);
  }
  if (path === "/auth/discover" && request.method === "POST") {
    const limited = await enforce(env, request, "auth/discover");
    if (limited) return limited;
    const started = Date.now();
    const body = await request.json().catch(() => ({}));
    let answer = {};
    const email = String(body.email || "").trim().toLowerCase();
    const { verifiedDomainFor } = await import("./domains.js");
    const domain = await verifiedDomainFor(env.DB, email);
    if (domain) {
      const conn = await connectionFor(env.DB, domain.org_id, email);
      if (conn) {
        const org = await env.DB.prepare("SELECT name FROM orgs WHERE id = ?1").bind(domain.org_id).first();
        const policy = await policyOf(env.DB, domain.org_id);
        answer = { sso: { orgId: domain.org_id, connectionId: conn.id, provider: conn.provider, providerName: conn.name || PROVIDERS[conn.provider]?.name || "SSO", name: org?.name || domain.domain, enforced: policy.enforce } };
      }
    }
    // The same time either way, so the answer's speed does not list domains.
    const wait = 150 - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return json(answer);
  }
  if (path === "/sso/start" && request.method === "GET") {
    const limited = await enforce(env, request, "sso");
    if (limited) return limited;
    const client = ["web", "ios"].includes(url.searchParams.get("client")) ? url.searchParams.get("client") : "web";
    try {
      return redirect(await startUrl(env, url, url.searchParams.get("orgId") || "", { client, email: url.searchParams.get("email"), connectionId: url.searchParams.get("connection") }));
    } catch (err) {
      return redirect(back(env, client, { error: err?.message || String(err) }));
    }
  }
  if (path === "/sso/callback" && request.method === "GET") {
    const limited = await enforce(env, request, "sso");
    if (limited) return limited;
    return callback(env, request, url);
  }
  const samlPath = path.match(/^\/sso\/saml\/([A-Za-z0-9_-]{1,64})(\/metadata|\/acs)?$/);
  if (samlPath) {
    const limited = await enforce(env, request, "sso");
    if (limited) return limited;
    if (samlPath[2] === "/acs" && request.method === "POST") return samlAcs(env, request, url, samlPath[1]);
    if (samlPath[2] !== "/acs" && request.method === "GET") {
      const conn = await env.DB.prepare("SELECT id FROM sso_connections WHERE id = ?1 AND provider = 'saml'").bind(samlPath[1]).first().catch(() => null);
      if (!conn) return new Response("not found", { status: 404 });
      const base = baseOf(env, url);
      return new Response(spMetadata(spEntityId(base, conn.id), acsUrl(base, conn.id)), { headers: { "content-type": "application/samlmetadata+xml", "cache-control": "no-store" } });
    }
    return new Response("not found", { status: 404 });
  }
  if (path === "/sso/exchange" && request.method === "POST") {
    const limited = await enforce(env, request, "sso");
    if (limited) return limited;
    const body = await request.json().catch(() => ({}));
    const out = await exchange(env, { code: body.code, client: body.client });
    return out.error ? json({ message: out.error }, out.status) : json(out);
  }
  if (!path.startsWith("/orgs/sso")) return null;

  const session = await getSession(env.DB, request.headers.get("x-session-token"));
  if (!session) return json({ message: "Please sign in." }, 401);
  const body = request.method === "GET" || request.method === "DELETE" ? null : await request.json().catch(() => ({}));
  const orgId = body?.orgId || url.searchParams.get("orgId");
  if (!orgId) return json({ message: "orgId is required" }, 400);
  const gate = await memberGate(env, session, orgId);
  if (gate) return gate;
  const user = await getUserByGithubId(env.DB, session.github_id);
  const owner = await allowed(env.DB, orgId, session.github_id, "sso.manage");
  const base = baseOf(env, url);
  const all = async () => {
    const conns = await connectionsOf(env.DB, orgId);
    const policy = await policyOf(env.DB, orgId);
    return { connections: conns.map((c) => presentConnection(c, base)), enforce: policy.enforce, sso: presentSso(conns[0] || null, policy) };
  };
  if (path === "/orgs/sso" && request.method === "GET") {
    if (!(await allowed(env.DB, orgId, session.github_id, "audit.read"))) return json({ message: "Only an admin can see single sign-on." }, 403);
    return json({
      ...(await all()), canEdit: owner,
      providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name, issuer: p.issuer })),
      callback: callbackUrl(env, url), ready: Boolean(env.SSO_SECRET_KEY),
    });
  }
  if (!owner) {
    await audit(env, request, { orgId, action: "security.permission_denied", actor: person(user), entity: { type: "resource", id: "sso", name: "single sign-on" }, outcome: "denied" });
    return json({ message: "Only an owner can change single sign-on." }, 403);
  }
  const again = await reauthDenial(env, session, orgId, { owner: true });
  if (again) return json(again.body, again.status);
  const notify = async (subject, text) => {
    const { mailOwners } = await import("./owners.js");
    await mailOwners(env, orgId, { subject, text });
  };
  const nameOf = (c) => c.name || PROVIDERS[c.provider]?.name || "SSO";

  // Which connection a path is about: /orgs/sso/connections/:id…, or the
  // workspace's first one for the paths that predate there being several.
  const connPath = path.match(/^\/orgs\/sso\/connections(?:\/([^/]+))?(\/test|\/activate)?$/);
  const legacy = ["/orgs/sso", "/orgs/sso/test", "/orgs/sso/activate"].includes(path);
  if (!connPath && !legacy && path !== "/orgs/sso/enforce") return json({ message: "not found" }, 404);

  // Make or change a connection.
  if ((connPath && !connPath[1] && request.method === "POST") || (connPath?.[1] && !connPath[2] && request.method === "PUT") || (path === "/orgs/sso" && request.method === "PUT")) {
    const id = connPath?.[1] ? decodeURIComponent(connPath[1]) : path === "/orgs/sso" ? ((await ssoOf(env.DB, orgId))?.id || await primaryConnectionId(orgId)) : crypto.randomUUID();
    const current = await connectionOf(env.DB, orgId, id);
    if (connPath?.[1] && !current) return json({ message: "No such connection." }, 404);
    if (!current && (await connectionsOf(env.DB, orgId)).length >= 10) return json({ message: "A workspace has at most 10 connections." }, 400);
    const checked = await connectionFields(env, orgId, body || {}, current);
    if (checked.error) return json({ message: checked.error }, checked.status || 400);
    await saveConnection(env, orgId, id, checked.fields, { createdBy: session.github_id, retest: checked.retest, existing: current });
    const f = checked.fields;
    await audit(env, request, { orgId, action: "sso.configured", actor: person(user), details: { connection: id, provider: f.provider, issuer: f.issuer, client_id: f.client_id, allowed_domains: JSON.parse(f.allowed_domains), client_secret: f.provider === "saml" ? undefined : (checked.secretChanged ? "set" : "kept"), certificate: f.provider === "saml" ? "set" : undefined, session_hours: f.session_hours } });
    await notify("Single sign-on was changed", `${user?.name || "An owner"} ${current ? "changed" : "added"} a single sign-on connection for your workspace (${nameOf(f)}, ${f.issuer}).`);
    const saved = await connectionOf(env.DB, orgId, id);
    return json({ connection: presentConnection(saved, base), sso: presentSso(saved, await policyOf(env.DB, orgId)) }, current || path === "/orgs/sso" ? 200 : 201);
  }

  if (path === "/orgs/sso/enforce" && request.method === "PUT") {
    const conns = (await connectionsOf(env.DB, orgId)).filter((c) => c.status === "active");
    const on = body.enforce === true;
    if (on) {
      if (!conns.length) return json({ message: "Turn single sign-on on first." }, 400);
      // Whoever makes it required has just come through it themselves.
      const recent = session.auth_method === "sso" && session.sso_org_id === orgId && Date.now() - Date.parse(session.created_at) <= ENFORCE_WITHIN_MINUTES * 60_000;
      if (!recent) return json({ message: "Sign in with single sign-on in the last 10 minutes before making it required.", code: "sso-recent-required" }, 400);
      // Somebody has to be able to get in if the provider fails.
      let breakGlass = 0;
      for (const id of await ownersOf(env.DB, orgId)) {
        const email = (await env.DB.prepare("SELECT email FROM users WHERE github_id = ?1").bind(id).first())?.email;
        if (!conns.some((c) => covers(c, email))) breakGlass += 1;
      }
      const now = new Date().toISOString();
      await env.DB.prepare(`INSERT INTO org_sso_policy (org_id, enforce, enforce_since, updated_at) VALUES (?1, 1, ?2, ?2)
        ON CONFLICT(org_id) DO UPDATE SET enforce = 1, enforce_since = excluded.enforce_since, updated_at = excluded.updated_at`).bind(orgId, now).run();
      const ended = await endNonSsoSessions(env, orgId, conns);
      await audit(env, request, { orgId, action: "sso.enforced", actor: person(user), details: { sessions_ended: ended, break_glass_owners: breakGlass } });
      await notify("Single sign-on is now required", `${user?.name || "An owner"} made single sign-on required for your workspace. ${ended} sessions that did not use it were signed out.${breakGlass ? "" : " No owner has an address outside the SSO domains, so if the provider fails nobody can get in — consider adding a break-glass owner."}`);
      return json({ ...(await all()), ended, breakGlass });
    }
    await env.DB.prepare(`INSERT INTO org_sso_policy (org_id, enforce, enforce_since, updated_at) VALUES (?1, 0, NULL, ?2)
      ON CONFLICT(org_id) DO UPDATE SET enforce = 0, enforce_since = NULL, updated_at = excluded.updated_at`).bind(orgId, new Date().toISOString()).run();
    await audit(env, request, { orgId, action: "sso.enforcement_removed", actor: person(user) });
    await notify("Single sign-on is no longer required", `${user?.name || "An owner"} stopped requiring single sign-on for your workspace.`);
    return json(await all());
  }

  const current = connPath?.[1] ? await connectionOf(env.DB, orgId, decodeURIComponent(connPath[1])) : await ssoOf(env.DB, orgId);
  if (!current) return json({ message: legacy ? "Set up single sign-on first." : "No such connection." }, 404);
  const step = connPath?.[2] || (path === "/orgs/sso/test" ? "/test" : path === "/orgs/sso/activate" ? "/activate" : null);
  if (step === "/test" && request.method === "POST") {
    try {
      return json({ url: await startUrl(env, url, orgId, { client: "test", testerId: String(session.github_id), connectionId: current.id }) });
    } catch (err) { return json({ message: err?.message || String(err) }, 400); }
  }
  if (step === "/activate" && request.method === "POST") {
    if (!current.tested_at) return json({ message: "Sign in once with the test first." }, 400);
    await env.DB.prepare("UPDATE sso_connections SET status = 'active', updated_at = ?3 WHERE org_id = ?1 AND id = ?2").bind(orgId, current.id, new Date().toISOString()).run();
    await audit(env, request, { orgId, action: "sso.activated", actor: person(user), details: { connection: current.id, provider: current.provider } });
    const saved = await connectionOf(env.DB, orgId, current.id);
    return json({ connection: presentConnection(saved, base), sso: presentSso(saved, await policyOf(env.DB, orgId)) });
  }
  if (!step && request.method === "DELETE") {
    await env.DB.prepare("UPDATE sso_connections SET status = 'disabled', updated_at = ?3 WHERE org_id = ?1 AND id = ?2").bind(orgId, current.id, new Date().toISOString()).run();
    // With nothing left switched on, nothing can be required.
    const left = (await connectionsOf(env.DB, orgId)).filter((c) => c.status === "active");
    if (!left.length) await env.DB.prepare("UPDATE org_sso_policy SET enforce = 0, enforce_since = NULL, updated_at = ?2 WHERE org_id = ?1").bind(orgId, new Date().toISOString()).run();
    await audit(env, request, { orgId, action: "sso.disabled", actor: person(user), details: { connection: current.id, provider: current.provider } });
    await notify("Single sign-on was turned off", `${user?.name || "An owner"} turned off a single sign-on connection for your workspace (${nameOf(current)}).`);
    const saved = await connectionOf(env.DB, orgId, current.id);
    return json({ connection: presentConnection(saved, base), sso: presentSso(saved, await policyOf(env.DB, orgId)) });
  }
  return json({ message: "not found" }, 404);
}

export { auditEverywhere };
