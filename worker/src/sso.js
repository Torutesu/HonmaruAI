// Signing in with the company's identity provider: OpenID Connect with
// Google Workspace, Okta, Microsoft Entra ID, or any OIDC provider.
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

export const PROVIDERS = {
  google: { name: "Google Workspace", issuer: "https://accounts.google.com" },
  okta: { name: "Okta", issuer: null },
  entra: { name: "Microsoft Entra ID", issuer: null },
  oidc: { name: "Single sign-on", issuer: null },
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
export async function verifyIdToken(token, { discovery, clientId, nonce, now = Date.now() }) {
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
  const c = jwt.payload;
  const seconds = Math.floor(now / 1000);
  if (String(c.iss || "").replace(/\/$/, "") !== String(discovery.issuer).replace(/\/$/, "")) throw new Error("The ID token is from a different issuer.");
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(clientId)) throw new Error("The ID token is for a different application.");
  if (!Number.isFinite(c.exp) || c.exp + SKEW_SECONDS < seconds) throw new Error("The ID token has expired.");
  if (Number.isFinite(c.iat) && c.iat - SKEW_SECONDS > seconds) throw new Error("The ID token was issued in the future.");
  if (c.nonce !== nonce) throw new Error("The ID token is not for this sign-in.");
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

// ---- The workspace's connection ----

export async function ssoOf(db, orgId) {
  return db.prepare("SELECT * FROM org_sso WHERE org_id = ?1").bind(orgId).first().catch(() => null);
}

export function presentSso(row) {
  if (!row) return null;
  return {
    provider: row.provider, issuer: row.issuer, clientId: row.client_id, clientSecret: row.client_secret ? "set" : null,
    allowedDomains: JSON.parse(row.allowed_domains || "[]"), hostedDomain: row.hosted_domain, tenantId: row.tenant_id,
    enforce: Boolean(row.enforce), sessionHours: row.session_hours, status: row.status,
    testedAt: row.tested_at, test: row.test_result ? JSON.parse(row.test_result) : null,
  };
}

/// Whether this workspace requires SSO of this person: its connection is on
/// and required, and their address is at one of its domains. An owner at
/// some other address — the break-glass owner — never is.
export async function ssoRequiredFor(db, orgId, githubId) {
  const sso = await ssoOf(db, orgId);
  if (!sso || sso.status !== "active" || !sso.enforce) return null;
  const user = await db.prepare("SELECT email FROM users WHERE github_id = ?1").bind(String(githubId)).first();
  const d = domainOf(user?.email);
  if (!d) return null;
  const domains = JSON.parse(sso.allowed_domains || "[]");
  return domains.some((x) => domainMatches(d, x)) ? sso : null;
}

/// The refusal for a session this workspace's SSO does not accept, or null.
export async function ssoDenial(env, session, orgId) {
  const sso = await ssoRequiredFor(env.DB, orgId, session.github_id);
  if (sso) {
    if (session.auth_method !== "sso" || session.sso_org_id !== orgId) {
      return { status: 403, body: { message: "Sign in with your company's single sign-on to open this workspace.", code: "sso-required", orgId, start: `/sso/start?orgId=${encodeURIComponent(orgId)}` } };
    }
  }
  // An SSO session lasts as long as the workspace says, used or not.
  if (session.auth_method === "sso" && session.sso_org_id === orgId) {
    const row = sso || await ssoOf(env.DB, orgId);
    const hours = row?.session_hours || 24;
    if (Date.now() - Date.parse(session.created_at || "") > hours * 3_600_000) {
      return { status: 401, body: { message: "Sign in with your company's single sign-on again.", code: "sso-reauth", orgId, start: `/sso/start?orgId=${encodeURIComponent(orgId)}` } };
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

function callbackUrl(env, url) {
  return `${String(env.SSO_CALLBACK_BASE || url.origin).replace(/\/$/, "")}/sso/callback`;
}

/// Where the provider's sign-in page is for this workspace, with a state
/// saved to check the answer against.
export async function startUrl(env, url, orgId, { client = "web", email = null, testerId = null } = {}) {
  const sso = await ssoOf(env.DB, orgId);
  if (!sso || (client !== "test" && sso.status !== "active")) throw new Error("Single sign-on is not on for this workspace.");
  const discovery = await discover(sso.issuer);
  const state = random(24);
  const nonce = random(24);
  const { verifier, challenge } = await pkce();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sso_states (state, org_id, nonce, code_verifier, return_to, tester_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  ).bind(state, orgId, nonce, verifier, client, testerId, new Date(now).toISOString(), new Date(now + STATE_MINUTES * 60_000).toISOString()).run();
  const q = new URLSearchParams({
    response_type: "code", client_id: sso.client_id, redirect_uri: callbackUrl(env, url), scope: "openid email profile",
    state, nonce, code_challenge: challenge, code_challenge_method: "S256",
  });
  if (sso.provider === "google" && sso.hosted_domain) q.set("hd", sso.hosted_domain);
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
async function accountFor(env, sso, identity) {
  const linked = await env.DB.prepare("SELECT user_github_id FROM sso_identities WHERE issuer = ?1 AND subject = ?2").bind(sso.issuer, identity.subject).first();
  if (linked) return { githubId: String(linked.user_github_id), linked: true };
  const byEmail = await env.DB.prepare("SELECT github_id, email_verified_at FROM users WHERE email = ?1").bind(identity.email).first();
  // The same address is the same person only where it was proved, or the
  // domain is the workspace's own (§6.3): an address somebody typed at
  // sign-up and never received mail at is not enough.
  const domainProved = await env.DB.prepare("SELECT 1 FROM org_domains WHERE org_id = ?1 AND domain = ?2 AND verified_at IS NOT NULL").bind(sso.org_id, domainOf(identity.email)).first()
    || JSON.parse(sso.allowed_domains || "[]").some((d) => domainMatches(domainOf(identity.email), d));
  if (byEmail && (byEmail.email_verified_at || domainProved)) return { githubId: String(byEmail.github_id), linked: false };
  if (byEmail) throw new Error("An account with this address exists but has not proved it. Sign in with an email code once, then try again.");
  const githubId = `sso:${sso.org_id}:${(await sha256Hex(`${sso.issuer}\u0000${identity.subject}`)).slice(0, 24)}`;
  await upsertUser(env.DB, { githubId, login: `u:${identity.email}`, name: identity.name || identity.email.split("@")[0], avatarUrl: null, locale: "en" });
  await env.DB.prepare("UPDATE users SET email = ?2 WHERE github_id = ?1").bind(githubId, identity.email).run();
  return { githubId, linked: false, created: true };
}

/// The provider's answer: checked, turned into a session, and handed back
/// by a one-time code.
export async function callback(env, request, url) {
  const state = url.searchParams.get("state") || "";
  const row = await env.DB.prepare("DELETE FROM sso_states WHERE state = ?1 RETURNING *").bind(state).first().catch(() => null);
  if (!row) return redirect(back(env, "web", { error: "This sign-in has expired. Start again." }));
  const client = row.return_to || "web";
  const fail = async (reason, orgId = row.org_id) => {
    await audit(env, request, { orgId, action: "auth.login_failed", actor: { type: "system" }, details: { method: "sso", reason: String(reason).slice(0, 200) }, outcome: "failure" });
    return redirect(back(env, client, { error: String(reason).slice(0, 300) }));
  };
  if (row.expires_at <= new Date().toISOString()) return fail("This sign-in has expired. Start again.");
  if (url.searchParams.get("error")) return fail(`Your identity provider refused: ${url.searchParams.get("error_description") || url.searchParams.get("error")}`);
  const sso = await ssoOf(env.DB, row.org_id);
  if (!sso) return fail("Single sign-on is not set up for this workspace.");
  let identity;
  try {
    const discovery = await discover(sso.issuer);
    const secret = await openSecret(env, sso.client_secret);
    const form = new URLSearchParams({
      grant_type: "authorization_code", code: url.searchParams.get("code") || "", redirect_uri: callbackUrl(env, url),
      client_id: sso.client_id, code_verifier: row.code_verifier, ...(secret ? { client_secret: secret } : {}),
    });
    const res = await fetch(discovery.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form, signal: AbortSignal.timeout(15_000) });
    const tokens = await res.json().catch(() => ({}));
    if (!res.ok || !tokens.id_token) throw new Error(`Your identity provider refused: ${tokens.error_description || tokens.error || res.status}`);
    const claims = await verifyIdToken(tokens.id_token, { discovery, clientId: sso.client_id, nonce: row.nonce });
    identity = identityOf(sso.provider, claims, sso);
  } catch (err) {
    return fail(err?.message || String(err));
  }

  // A test sign-in proves the connection and signs nobody in.
  if (client === "test") {
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE org_sso SET tested_at = ?2, test_result = ?3 WHERE org_id = ?1")
      .bind(row.org_id, now, JSON.stringify({ email: identity.email, subject: identity.subject, name: identity.name, at: now })).run();
    const tester = row.tester_id ? await getUserByGithubId(env.DB, row.tester_id).catch(() => null) : null;
    await audit(env, request, { orgId: row.org_id, action: "sso.tested", actor: person(tester) || { type: "system" } });
    return redirect(back(env, "test", { tested: "1" }));
  }

  let account;
  try { account = await accountFor(env, sso, identity); } catch (err) { return fail(err?.message || String(err)); }
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO sso_identities (org_id, issuer, subject, user_github_id, email, last_login_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(issuer, subject) DO UPDATE SET email = excluded.email, last_login_at = excluded.last_login_at`
  ).bind(sso.org_id, sso.issuer, identity.subject, account.githubId, identity.email, now).run();
  await env.DB.prepare("UPDATE users SET email = ?2, email_verified_at = COALESCE(email_verified_at, ?3) WHERE github_id = ?1").bind(account.githubId, identity.email, now).run();
  // Being in the company's identity provider is being in the company: in,
  // whatever the domain's join policy says.
  if (!(await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id = ?1 AND user_github_id = ?2").bind(sso.org_id, account.githubId).first())) {
    await upsertMembership(env.DB, sso.org_id, account.githubId, "member", "sso");
    const joiner = await getUserByGithubId(env.DB, account.githubId);
    await audit(env, request, { orgId: sso.org_id, action: "member.joined", actor: person(joiner), details: { via: "sso", role: "member" } });
  }
  const token = await createSession(env.DB, account.githubId, EMAIL_AUTH_TOKEN, { client: client === "ios" ? "ios" : "web" });
  await env.DB.prepare("UPDATE sessions SET auth_method = 'sso', sso_org_id = ?2 WHERE token = ?1").bind(token, sso.org_id).run();
  const { signedIn } = await import("./sessions.js");
  await signedIn(env, request, token, account.githubId, "sso");
  await env.DB.prepare("UPDATE sessions SET auth_method = 'sso', sso_org_id = ?2 WHERE token = ?1").bind(token, sso.org_id).run();
  const code = random(24);
  await env.DB.prepare("INSERT INTO sso_handoffs (code, token, org_id, client, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(await sha256Hex(code), token, sso.org_id, client, new Date(Date.now() + HANDOFF_SECONDS * 1000).toISOString()).run();
  return redirect(back(env, client, { code }));
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
async function endNonSsoSessions(env, orgId, sso) {
  const domains = JSON.parse(sso.allowed_domains || "[]");
  const { results } = await env.DB.prepare(
    `SELECT s.token, s.github_id, s.auth_method, s.sso_org_id, u.email FROM sessions s
       JOIN memberships m ON m.user_github_id = s.github_id AND m.org_id = ?1 JOIN users u ON u.github_id = s.github_id`
  ).bind(orgId).all();
  let ended = 0;
  for (const s of results || []) {
    if (!domains.some((d) => domainMatches(domainOf(s.email), d))) continue;
    if (s.auth_method === "sso" && s.sso_org_id === orgId) continue;
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?1").bind(s.token).run();
    ended += 1;
  }
  return ended;
}

/// POST /auth/discover · GET /sso/start · GET /sso/callback ·
/// POST /sso/exchange · GET/PUT/DELETE /orgs/sso · POST /orgs/sso/test ·
/// POST /orgs/sso/activate · PUT /orgs/sso/enforce
export async function handleSso(request, env, url) {
  const path = url.pathname;
  if (path === "/auth/discover" && request.method === "POST") {
    const limited = await enforce(env, request, "auth/discover");
    if (limited) return limited;
    const started = Date.now();
    const body = await request.json().catch(() => ({}));
    let answer = {};
    const { verifiedDomainFor } = await import("./domains.js");
    const domain = await verifiedDomainFor(env.DB, String(body.email || "").trim().toLowerCase());
    if (domain) {
      const sso = await ssoOf(env.DB, domain.org_id);
      if (sso?.status === "active" && JSON.parse(sso.allowed_domains || "[]").some((d) => domainMatches(domainOf(body.email), d))) {
        const org = await env.DB.prepare("SELECT name FROM orgs WHERE id = ?1").bind(domain.org_id).first();
        answer = { sso: { orgId: domain.org_id, provider: sso.provider, providerName: PROVIDERS[sso.provider]?.name || "SSO", name: org?.name || domain.domain, enforced: Boolean(sso.enforce) } };
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
      return redirect(await startUrl(env, url, url.searchParams.get("orgId") || "", { client, email: url.searchParams.get("email") }));
    } catch (err) {
      return redirect(back(env, client, { error: err?.message || String(err) }));
    }
  }
  if (path === "/sso/callback" && request.method === "GET") {
    const limited = await enforce(env, request, "sso");
    if (limited) return limited;
    return callback(env, request, url);
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
  if (path === "/orgs/sso" && request.method === "GET") {
    if (!(await allowed(env.DB, orgId, session.github_id, "audit.read"))) return json({ message: "Only an admin can see single sign-on." }, 403);
    return json({ sso: presentSso(await ssoOf(env.DB, orgId)), canEdit: owner, providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name, issuer: p.issuer })), callback: callbackUrl(env, url), ready: Boolean(env.SSO_SECRET_KEY) });
  }
  if (!owner) {
    await audit(env, request, { orgId, action: "security.permission_denied", actor: person(user), entity: { type: "resource", id: "sso", name: "single sign-on" }, outcome: "denied" });
    return json({ message: "Only an owner can change single sign-on." }, 403);
  }
  const again = await reauthDenial(env, session, orgId, { owner: true });
  if (again) return json(again.body, again.status);
  const current = await ssoOf(env.DB, orgId);
  const notify = async (subject, text) => {
    const { mailOwners } = await import("./owners.js");
    await mailOwners(env, orgId, { subject, text });
  };

  if (path === "/orgs/sso" && request.method === "PUT") {
    if (!env.SSO_SECRET_KEY) return json({ message: "Single sign-on is not set up on this deployment yet." }, 503);
    const provider = PROVIDERS[body.provider] ? body.provider : null;
    if (!provider) return json({ message: "Choose an identity provider." }, 400);
    const issuer = String(body.issuer || PROVIDERS[provider].issuer || "").trim().replace(/\/$/, "");
    const clientId = String(body.clientId || "").trim();
    if (!issuer || !clientId) return json({ message: "The issuer and client ID are required." }, 400);
    if (!body.clientSecret && !current?.client_secret) return json({ message: "The client secret is required." }, 400);
    const { results } = await env.DB.prepare("SELECT domain FROM org_domains WHERE org_id = ?1 AND verified_at IS NOT NULL").bind(orgId).all();
    const verified = (results || []).map((r) => r.domain);
    const domains = (Array.isArray(body.allowedDomains) ? body.allowedDomains : []).map((d) => String(d).trim().toLowerCase()).filter(Boolean);
    if (!domains.length || domains.some((d) => !verified.includes(d))) return json({ message: "Choose domains this workspace has verified." }, 400);
    try { await discover(issuer); } catch (err) { return json({ message: `Could not read the provider: ${err?.message || err}` }, 400); }
    const hours = body.sessionHours === undefined || body.sessionHours === null || body.sessionHours === "" ? 24 : Number(body.sessionHours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) return json({ message: "An SSO sign-in lasts from 1 to 720 hours." }, 400);
    const secret = body.clientSecret ? await sealSecret(env, String(body.clientSecret)) : current.client_secret;
    // A new provider or application has to be tested again.
    const retest = !current || current.issuer !== issuer || current.client_id !== clientId || Boolean(body.clientSecret);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO org_sso (org_id, provider, issuer, client_id, client_secret, allowed_domains, hosted_domain, tenant_id, session_hours, status, created_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'draft', ?10, ?11)
       ON CONFLICT(org_id) DO UPDATE SET provider = excluded.provider, issuer = excluded.issuer, client_id = excluded.client_id,
         client_secret = excluded.client_secret, allowed_domains = excluded.allowed_domains, hosted_domain = excluded.hosted_domain,
         tenant_id = excluded.tenant_id, session_hours = excluded.session_hours, updated_at = excluded.updated_at`
    ).bind(orgId, provider, issuer, clientId, secret, JSON.stringify(domains), body.hostedDomain || null, body.tenantId || null, hours, String(session.github_id), now).run();
    if (retest) await env.DB.prepare("UPDATE org_sso SET tested_at = NULL, test_result = NULL, status = CASE WHEN status = 'active' THEN 'testing' ELSE 'draft' END, enforce = 0 WHERE org_id = ?1").bind(orgId).run();
    await audit(env, request, { orgId, action: "sso.configured", actor: person(user), details: { provider, issuer, client_id: clientId, allowed_domains: domains, client_secret: body.clientSecret ? "set" : "kept", session_hours: hours } });
    await notify("Single sign-on was changed", `${user?.name || "An owner"} changed single sign-on for your workspace (${PROVIDERS[provider].name}, ${issuer}).`);
    return json({ sso: presentSso(await ssoOf(env.DB, orgId)) });
  }
  if (!current) return json({ message: "Set up single sign-on first." }, 404);
  if (path === "/orgs/sso/test" && request.method === "POST") {
    try {
      return json({ url: await startUrl(env, url, orgId, { client: "test", testerId: String(session.github_id) }) });
    } catch (err) { return json({ message: err?.message || String(err) }, 400); }
  }
  if (path === "/orgs/sso/activate" && request.method === "POST") {
    if (!current.tested_at) return json({ message: "Sign in once with the test first." }, 400);
    await env.DB.prepare("UPDATE org_sso SET status = 'active', updated_at = ?2 WHERE org_id = ?1").bind(orgId, new Date().toISOString()).run();
    await audit(env, request, { orgId, action: "sso.activated", actor: person(user) });
    return json({ sso: presentSso(await ssoOf(env.DB, orgId)) });
  }
  if (path === "/orgs/sso/enforce" && request.method === "PUT") {
    const on = body.enforce === true;
    if (on) {
      if (current.status !== "active") return json({ message: "Turn single sign-on on first." }, 400);
      // Whoever makes it required has just come through it themselves.
      const recent = session.auth_method === "sso" && session.sso_org_id === orgId && Date.now() - Date.parse(session.created_at) <= ENFORCE_WITHIN_MINUTES * 60_000;
      if (!recent) return json({ message: "Sign in with single sign-on in the last 10 minutes before making it required.", code: "sso-recent-required" }, 400);
      // Somebody has to be able to get in if the provider fails.
      const owners = await ownersOf(env.DB, orgId);
      const domains = JSON.parse(current.allowed_domains || "[]");
      let breakGlass = 0;
      for (const id of owners) {
        const email = (await env.DB.prepare("SELECT email FROM users WHERE github_id = ?1").bind(id).first())?.email;
        if (!domains.some((d) => domainMatches(domainOf(email), d))) breakGlass += 1;
      }
      await env.DB.prepare("UPDATE org_sso SET enforce = 1, enforce_since = ?2, updated_at = ?2 WHERE org_id = ?1").bind(orgId, new Date().toISOString()).run();
      const ended = await endNonSsoSessions(env, orgId, current);
      await audit(env, request, { orgId, action: "sso.enforced", actor: person(user), details: { sessions_ended: ended, break_glass_owners: breakGlass } });
      await notify("Single sign-on is now required", `${user?.name || "An owner"} made single sign-on required for your workspace. ${ended} sessions that did not use it were signed out.${breakGlass ? "" : " No owner has an address outside the SSO domains, so if the provider fails nobody can get in — consider adding a break-glass owner."}`);
      return json({ sso: presentSso(await ssoOf(env.DB, orgId)), ended, breakGlass });
    }
    await env.DB.prepare("UPDATE org_sso SET enforce = 0, enforce_since = NULL, updated_at = ?2 WHERE org_id = ?1").bind(orgId, new Date().toISOString()).run();
    await audit(env, request, { orgId, action: "sso.enforcement_removed", actor: person(user) });
    await notify("Single sign-on is no longer required", `${user?.name || "An owner"} stopped requiring single sign-on for your workspace.`);
    return json({ sso: presentSso(await ssoOf(env.DB, orgId)) });
  }
  if (path === "/orgs/sso" && request.method === "DELETE") {
    await env.DB.prepare("UPDATE org_sso SET status = 'disabled', enforce = 0, enforce_since = NULL, updated_at = ?2 WHERE org_id = ?1").bind(orgId, new Date().toISOString()).run();
    await audit(env, request, { orgId, action: "sso.disabled", actor: person(user) });
    await notify("Single sign-on was turned off", `${user?.name || "An owner"} turned off single sign-on for your workspace.`);
    return json({ sso: presentSso(await ssoOf(env.DB, orgId)) });
  }
  return json({ message: "not found" }, 404);
}

export { auditEverywhere };
