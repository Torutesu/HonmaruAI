// Simple email/password auth helpers. Passwords are hashed with PBKDF2 (built
// into the Workers runtime — no external dependency). This is intentionally
// simple; stronger token handling is a later concern.

import { createSession, upsertUser, upsertMembership, primaryOrgId } from "./db.js";
import { credentialLocked, credentialFailed } from "./ratelimit.js";

const ENC = new TextEncoder();

// How long an invite stays redeemable.
// Three days. An invitation is a link somebody opens this week, not a
// standing door: a leaked one is closed by the calendar before anyone has
// to notice it.
const INVITE_TTL_DAYS = 3;
/// How many people one link can let in while it lives: in effect, anyone it
/// is shared with, bounded so a leaked link is not a door forever.
export const LINK_MAX_USES = 500;
/// A "one person" invitation — the emailed kind — is forwarded too, and the
/// second person it reached was told it had expired. Now none is made that
/// way, and one already made lets in whoever it reaches while it lives,
/// like any link. A count someone asked for (more than one) still holds.
const openLink = (row) => Number(row.max_uses) === 1;

/// The code inside whatever was pasted: a bare code, the link the app
/// hands out (`…#/join/<code>`), or a code with spaces around it. A person
/// forwards a link; the endpoints read the code out of it.
export function inviteCodeFrom(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const inLink = raw.match(/join\/([0-9a-fA-F]{32})/);
  if (inLink) return inLink[1].toLowerCase();
  const bare = raw.match(/^([0-9a-fA-F]{32})$/);
  return bare ? bare[1].toLowerCase() : raw;
}

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
// A guest ranks below everyone: in only the channels they were let into
// (access.js), and able to invite nobody.
export const ROLE_RANK = new Map([
  ["guest", -1],
  ["member", 0], ["designer", 0], ["engineer", 0],
  ["triager", 1], ["maintainer", 2], ["admin", 3],
  // Holds the workspace: its security, its keys, its existence
  // (permissions.js). There is always at least one.
  ["owner", 4],
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
export const MAX_NAME_CHARS = 120;
export const MAX_EMAIL_CHARS = 254;

/// `emailProved`: the caller has just seen the address answer (an emailed
/// code, Apple), so the account starts proved and the invite's rules see it so.
export async function signup(env, { email, password, name, inviteCode, locale, passwordless, emailProved }) {
  if (!validEmail(email) || email.length > MAX_EMAIL_CHARS) return { error: "Please enter a valid email." };
  // The name lands on every card this account creates, in every member's
  // join snapshot, and in `/members`. Text, and not a page of it.
  if (name !== undefined && name !== null && typeof name !== "string") {
    return { error: "Name must be text." };
  }
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
  const displayName = (name || "").trim().slice(0, MAX_NAME_CHARS) || normalizedEmail.split("@")[0];

  await upsertUser(env.DB, { githubId: userId, login, name: displayName, avatarUrl: null, locale: locale || undefined });
  await env.DB
    .prepare("UPDATE users SET email = ?1, password_hash = ?2, password_salt = ?3, email_verified_at = ?5 WHERE github_id = ?4")
    .bind(normalizedEmail, hash, salt, userId, emailProved ? new Date().toISOString() : null)
    .run();

  // A caller-supplied orgId is not authorization. Signup may only place a user
  // in an org a valid invite names, or in a fresh org of their own. Trusting
  // body.orgId let anyone write a membership row for a private org, and
  // authorizeOrgAccess treats that row as proof of access.
  //
  // An invite here answers to the same rule as one redeemed later
  // (acceptInvite → inviteGate): a workspace that takes only its company's
  // addresses, or wants an admin to approve, gets that from a sign-up too.
  // It used to be spent with no gate at all, so a forwarded link let anyone
  // straight in. Settled once the account exists, because the gate reads it.
  //
  // A code that does not work, or that the gate holds back, never refuses the
  // sign-up: the emailed six digits have already been spent by the time this
  // runs. They get a workspace of their own, `inviteError` (or
  // `invitePending`) says what did not happen, and You → Join a team takes
  // another attempt at it.
  let org;
  let joinRole = "member";
  let inviteError;
  let invitePending;
  let joinedBy = null;
  if (inviteCode?.trim()) {
    const invite = await readInvite(env.DB, inviteCode.trim());
    if (!invite) {
      inviteError = "That invitation is not valid, or it has expired.";
    } else {
      const role = String(invite.role || "member").toLowerCase();
      const { inviteGate } = await import("./governance.js");
      const gate = await inviteGate(env, invite.org_id, userId, role);
      if (gate.error) inviteError = gate.error;
      else if (gate.pending) {
        await askToJoin(env, invite.org_id, userId, gate.email, role);
        invitePending = { orgId: invite.org_id, role };
      } else if (await spendInvite(env.DB, inviteCode.trim())) {
        org = invite.org_id;
        joinRole = role;
        joinedBy = invite;
      } else {
        inviteError = "That invitation is not valid, or it has expired.";
      }
    }
  }
  if (!org) {
    // Their own org. Derived from the user id so no one else can claim it, but
    // hashed: this id travels in the socket's query string, and a URL is the
    // classic place an address ends up somewhere it was never meant to be.
    org = `personal:${(await sha256Hex(userId)).slice(0, 24)}`;
    joinRole = "owner";
  }

  await upsertMembership(env.DB, org, userId, joinRole, joinedBy ? "invite" : "created");
  // Joined by an invitation that names channels: introduced there.
  if (joinedBy?.channels) {
    const { introduce } = await import("./welcome.js");
    await introduce(env, { orgId: org, channels: JSON.parse(joinedBy.channels), githubId: userId, invitedBy: joinedBy.created_by })
      .catch((err) => console.error("welcome failed", err?.message || err));
  }
  if (joinedBy) await joinedByInvite(env, org, userId, joinRole);
  const token = await createSession(env.DB, userId, EMAIL_AUTH_TOKEN);
  return { token, userId, login, orgId: org, ...(inviteError ? { inviteError } : {}), ...(invitePending ? { invitePending } : {}) };
}

// Log in: look up by email, verify the password, return a session token.
export const PASSWORD_LOCKED = "Too many wrong passwords for this account. Try again in an hour, or sign in with a code sent to your email.";

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

  // Per account, whatever address the guesses come from. The code sent to
  // the address still works: a guesser cannot lock its owner out of that.
  if (await credentialLocked(env, `pw:${row.github_id}`)) return { error: PASSWORD_LOCKED, status: 429 };
  const attempt = await hashPassword(password, row.password_salt);
  if (!safeEqual(attempt, row.password_hash)) {
    await credentialFailed(env, `pw:${row.github_id}`);
    return { error: "Invalid email or password." };
  }

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
/// Somebody new came in by an invitation: said the way every other way in
/// says it (audit "member.joined"), which is what tells every open screen
/// the team changed, puts "joined" in the first channel and opens the AI's
/// welcome DM. Every door an invitation opens goes through here.
async function joinedByInvite(env, orgId, githubId, role) {
  try {
    const user = await env.DB.prepare("SELECT login, name FROM users WHERE github_id = ?1").bind(String(githubId)).first();
    if (!user) return;
    const { audit, person } = await import("./audit.js");
    await audit(env, null, { orgId, action: "member.joined", actor: person(user), details: { role, via: "invite" } });
  } catch (err) {
    console.error("join announce failed", err?.message || err);
  }
}

async function readInvite(db, code) {
  const row = await db
    .prepare("SELECT org_id, role, expires_at, max_uses, uses, created_by, channels FROM invites WHERE code = ?1")
    .bind(inviteCodeFrom(code))
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
    .prepare(`UPDATE invites SET uses = uses + 1 WHERE code = ?1
                AND (uses < max_uses OR (max_uses = 1 AND uses < ?2))`)
    .bind(inviteCodeFrom(code), LINK_MAX_USES)
    .run();
  return Boolean(meta?.changes);
}

/// The slugs asked for that are channels of this team, in the order asked
/// — a private one only if the person inviting is in it, since joining by
/// the invitation brings the newcomer into it.
export async function channelsOf(db, orgId, asked, inviterGithubId = null) {
  if (!Array.isArray(asked) || !asked.length) return [];
  const inviter = inviterGithubId ? await db.prepare("SELECT login FROM users WHERE github_id = ?1").bind(String(inviterGithubId)).first().catch(() => null) : null;
  const { results } = await db.prepare(
    `SELECT b.slug FROM businesses b WHERE b.org_id = ?1 AND (b.private = 0 OR EXISTS (
       SELECT 1 FROM conversation_members c WHERE c.org_id = ?1 AND c.channel = 'b:' || b.slug AND c.login = ?2))`
  ).bind(orgId, inviter?.login || null).all();
  const known = new Set((results || []).map((r) => r.slug));
  return [...new Set(asked.filter((s) => typeof s === "string" && known.has(s)))].slice(0, 50);
}

export async function createInvite(env, { orgId, createdBy, role, uses, channels }) {
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
  // A workspace from before owners existed gets one before anyone is asked
  // whether they are it.
  const { ensureOwner } = await import("./permissions.js");
  await ensureOwner(env.DB, orgId);
  const callerRole = String(
    (await env.DB
      .prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
      .bind(orgId, createdBy)
      .first())?.role || "member"
  ).toLowerCase();
  if (callerRole === "guest") return { error: "A guest cannot invite anyone." };
  // An owner is made from the team screen, by an owner, not by a link that
  // whoever holds it can redeem.
  if (requested === "owner") return { error: "An owner is added from the team screen, not by invitation." };
  if (ROLE_RANK.get(requested) > (ROLE_RANK.get(callerRole) ?? 0)) {
    return { error: "You cannot invite someone above your own role." };
  }
  // Admins are the owners' to choose (permissions.js, member.invite_admin).
  if (requested === "admin" && callerRole !== "owner" && !String(orgId).includes("/")) {
    return { error: "Only an owner can invite an admin." };
  }
  const inviteRole = requested;
  // Invites expire. A code that works forever is a permanent unaudited way in,
  // and the only way to close it would be deleting the row by hand.
  // A link is for whoever it is posted to: a team shares one in a group
  // chat and everyone in it joins, for the three days it lives. It was one
  // person by default, and the second person to open a shared link was
  // told it had expired. A count still applies when one is asked for — an
  // emailed invite is one person's, and asks for one.
  const asked = parseInt(uses, 10);
  // One is never a limit: a link is forwarded. Two or more is kept.
  const maxUses = Number.isFinite(asked) && asked > 1 ? Math.min(asked, LINK_MAX_USES) : LINK_MAX_USES;
  const now = new Date();
  const expires = new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  // The non-secret name for this code, written now rather than derived on
  // every read: cancelling one by reference otherwise means reading every
  // invite in the workspace and hashing each until one matches.
  const ref = (await sha256Hex(code)).slice(0, 16);
  // Where they are introduced when they join: only channels this team has.
  const introduce = await channelsOf(env.DB, orgId, channels, createdBy);
  // A guest sees only the channels they are let into, so they need one.
  if (requested === "guest" && !introduce.length) return { error: "Choose the channels a guest can see." };
  await env.DB
    .prepare("INSERT INTO invites (code, org_id, created_by, role, created_at, expires_at, max_uses, ref, channels) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
    .bind(code, orgId, createdBy, inviteRole, now.toISOString(), expires.toISOString(), maxUses, ref, introduce.length ? JSON.stringify(introduce) : null)
    .run();
  return { code, orgId, role: inviteRole, expiresAt: expires.toISOString(), maxUses, ref, link: inviteLink(env, code), channels: introduce };
}

/// The code as a link the web client opens: signed out, it lands on sign-up
/// with the code filled in; signed in, it joins. Only where the deployment
/// knows its own web address — the phone has no link to open otherwise.
export function inviteLink(env, code) {
  if (!env.APP_WEB_URL || !code) return null;
  try {
    const url = new URL(env.APP_WEB_URL);
    url.hash = `#/join/${code}`;
    return url.toString();
  } catch {
    return null;
  }
}

/// What a code opens, for the person holding it, before they spend it: the
/// team's name, who made the code, the role it grants. Nothing an outsider
/// could not learn by redeeming it, and the code is the credential — an
/// unknown, expired or spent one answers with nothing at all.
export async function peekInvite(env, code) {
  if (!code || typeof code !== "string") return null;
  const row = await env.DB
    .prepare(
      `SELECT i.org_id, i.role, i.expires_at, i.max_uses, i.uses, i.created_at,
              (SELECT o.name FROM orgs o WHERE o.id = i.org_id) AS team,
              COALESCE(u.name, u.login, i.created_by) AS inviter
         FROM invites i
         LEFT JOIN users u ON u.github_id = i.created_by
        WHERE i.code = ?1`
    )
    .bind(inviteCodeFrom(code))
    .first();
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
  if (Number(row.uses) >= Number(row.max_uses) && !(openLink(row) && Number(row.uses) < LINK_MAX_USES)) return null;
  return {
    orgId: row.org_id,
    team: row.team || null,
    inviter: row.inviter || null,
    role: row.role || "member",
    expiresAt: row.expires_at || null,
  };
}

/// Someone has just proved this address: by an emailed code, or through the
/// identity provider or directory of the company whose domain it is. An
/// account that only claimed the address, never proving it, loses its hold:
///
/// - an email account (the address is its login) stays, for the person who
///   proved it, but every session it has ends and its password goes. Whoever
///   registered it first may not have been them, and a password set by
///   someone else, or a session they kept, would be a way back in.
/// - any other account (GitHub, SSO, SCIM) that typed the address in stops
///   naming it.
///
/// Returns the account that now answers to the address, or null for none.
/// Without this, registering newhire@corp.example before the real person
/// arrived was enough to be handed their sign-in, their company's SSO link
/// and their SCIM provisioning.
///
/// `orgId`: the workspace whose identity provider or directory proved it. An
/// account at the address that is already one of its members is linked as it
/// is: the workspace let it in already, so linking gives it nothing new.
export async function settleProvedAddress(env, email, { orgId } = {}) {
  if (orgId) {
    const member = await env.DB.prepare(
      "SELECT u.github_id FROM users u JOIN memberships m ON m.user_github_id = u.github_id AND m.org_id = ?2 WHERE u.email = ?1"
    ).bind(email, orgId).first();
    if (member) return { githubId: String(member.github_id) };
  }
  const row = await env.DB.prepare("SELECT github_id, email_verified_at FROM users WHERE email = ?1").bind(email).first();
  if (!row) return null;
  const id = String(row.github_id);
  if (row.email_verified_at) return { githubId: id };
  if (id.startsWith("email:")) {
    await env.DB.prepare("UPDATE users SET password_hash = NULL, password_salt = NULL WHERE github_id = ?1").bind(id).run();
    const { endSessions } = await import("./sessions.js");
    await endSessions(env.DB, id);
    return { githubId: id, reclaimed: true };
  }
  await env.DB.prepare("UPDATE users SET email = NULL WHERE github_id = ?1 AND email_verified_at IS NULL").bind(id).run();
  return null;
}

/// An invitation the workspace wants an admin to approve: kept for them.
async function askToJoin(env, orgId, userId, email, role) {
  await env.DB.prepare(
    `INSERT INTO join_requests (org_id, user_github_id, email, requested_at, role, via) VALUES (?1, ?2, ?3, ?4, ?5, 'invite')
     ON CONFLICT(org_id, user_github_id) DO UPDATE SET requested_at = excluded.requested_at, role = excluded.role, via = 'invite', decided_by = NULL, decided_at = NULL, outcome = NULL`
  ).bind(orgId, String(userId), email || "", new Date().toISOString(), role).run();
}

// Redeem an invite code: look it up, add the user to that org.
export async function acceptInvite(env, { code, userId }) {
  if (!code || !userId) return { error: "Missing code." };
  // One message for unknown, expired and spent: distinguishing them tells a
  // guesser which of their guesses was once real.
  const row = await readInvite(env.DB, code.trim());
  if (!row) return { error: "That invitation is not valid, or it has expired." };
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
  // Someone new, under the workspace's rule for who may be invited: in; not
  // at all; or once an admin says yes (the invitation is kept for them).
  if (!existing) {
    const { inviteGate } = await import("./governance.js");
    const gate = await inviteGate(env, row.org_id, userId, offered);
    if (gate.error) return { error: gate.error, orgId: row.org_id };
    if (gate.pending) {
      await askToJoin(env, row.org_id, userId, gate.email, offered);
      return { orgId: row.org_id, pending: true, role: offered };
    }
  }
  if (!existing || keep !== held) {
    if (!(await spendInvite(env.DB, code.trim()))) {
      return { error: "That invitation is not valid, or it has expired." };
    }
    await upsertMembership(env.DB, row.org_id, userId, keep, "invite");
    // Somebody new: said in the channels the invite named.
    if (!existing && row.channels) {
      const { introduce } = await import("./welcome.js");
      await introduce(env, { orgId: row.org_id, channels: JSON.parse(row.channels), githubId: userId, invitedBy: row.created_by })
        .catch((err) => console.error("welcome failed", err?.message || err));
    }
    if (!existing) await joinedByInvite(env, row.org_id, userId, keep);
  }
  return { orgId: row.org_id, joined: !existing, role: existing && keep === held ? held : keep };
}