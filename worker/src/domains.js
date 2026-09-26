// A company's domain, proved by DNS, and the people who sign in with it.
//
// docs/sso-and-domain-join.md §4–5. An owner adds a domain and puts a TXT
// record on it; once the record is seen, anyone who signs in with a checked
// address at that domain is let in (`auto`) or can ask to be (`request`).
// The record is looked for again every day: a domain that loses it stops
// letting people in, so a company that is sold cannot keep adding strangers.

import { getSession, getUserByGithubId, upsertMembership } from "./db.js";
import { audit, person } from "./audit.js";
import { allowed } from "./permissions.js";
import { memberGate, reauthDenial } from "./policy.js";
import { memberRef } from "./team.js";

/// Addresses anyone can get: never a company's domain.
export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.jp", "ymail.com", "outlook.com", "outlook.jp", "hotmail.com", "hotmail.co.jp",
  "live.com", "live.jp", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.de",
  "mail.com", "yandex.com", "zoho.com", "docomo.ne.jp", "ezweb.ne.jp", "au.com", "softbank.ne.jp", "i.softbank.jp", "nifty.com", "biglobe.ne.jp",
  "qq.com", "163.com", "126.com", "naver.com", "hey.com", "fastmail.com", "tutanota.com", "web.de", "orange.fr", "free.fr", "laposte.net", "libero.it",
  "example.com",
]);
const POLICIES = ["off", "request", "auto"];
const LOST_AFTER_FAILURES = 3;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-session-token, x-ai-key",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "cache-control": "no-store", "content-type": "application/json", ...CORS } });
}

/// A domain as it is compared: lowercase, no trailing dot, punycode.
export function normalizeDomain(input) {
  let d = String(input || "").trim().toLowerCase().replace(/\.$/, "");
  if (!d || d.length > 253 || d.includes("/") || d.includes("@") || !d.includes(".")) return null;
  try { d = new URL(`http://${d}`).hostname; } catch { return null; }
  if (!/^[a-z0-9.-]+$/.test(d) || d.split(".").some((l) => !l || l.length > 63 || l.startsWith("-") || l.endsWith("-"))) return null;
  return d;
}

/// The domain of an address, normalized.
export function domainOf(email) {
  const at = String(email || "").lastIndexOf("@");
  return at > 0 ? normalizeDomain(String(email).slice(at + 1)) : null;
}

/// Whether `candidate` is `domain` or a subdomain of it — never merely a
/// name that ends in the same letters.
export function domainMatches(candidate, domain) {
  const c = normalizeDomain(candidate);
  const d = normalizeDomain(domain);
  return Boolean(c && d && (c === d || c.endsWith(`.${d}`)));
}

function base32(bytes) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0; let value = 0; let out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/// The TXT records on a name, by DNS over HTTPS.
export async function txtRecords(name) {
  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`DNS lookup failed (${res.status})`);
  const data = await res.json();
  return (data.Answer || []).filter((a) => a.type === 16).map((a) => String(a.data || "").replace(/^"|"$/g, "").replace(/"\s*"/g, ""));
}

export async function listDomains(db, orgId) {
  const { results } = await db.prepare("SELECT * FROM org_domains WHERE org_id = ?1 ORDER BY created_at").bind(orgId).all();
  return (results || []).map((r) => ({
    domain: r.domain,
    verified: Boolean(r.verified_at),
    verifiedAt: r.verified_at,
    txtName: r.domain,
    txtValue: `honmaru-verify=${r.verify_token}`,
    joinPolicy: r.join_policy,
    joinRole: r.join_role,
    joinChannels: r.join_channels ? JSON.parse(r.join_channels) : [],
    lastCheckedAt: r.last_checked_at,
  }));
}

/// Look for the record; mark the domain proved when it is there.
export async function verifyDomain(env, orgId, domain) {
  const row = await env.DB.prepare("SELECT * FROM org_domains WHERE domain = ?1 AND org_id = ?2").bind(domain, orgId).first();
  if (!row) return { error: "That domain is not on this workspace.", status: 404 };
  let found;
  try { found = await txtRecords(domain); } catch (err) { return { error: String(err?.message || err), status: 502 }; }
  const now = new Date().toISOString();
  const want = `honmaru-verify=${row.verify_token}`;
  if (!found.includes(want)) {
    await env.DB.prepare("UPDATE org_domains SET last_checked_at = ?2 WHERE domain = ?1").bind(domain, now).run();
    return { error: "The record is not there yet. DNS can take a few minutes to update.", status: 409, found };
  }
  await env.DB.prepare("UPDATE org_domains SET verified_at = COALESCE(verified_at, ?2), last_checked_at = ?2, fail_count = 0 WHERE domain = ?1").bind(domain, now).run();
  return { verified: true, first: !row.verified_at };
}

/// Every day: every proved domain looked at again. Three misses in a row and
/// it is no longer proved — nobody joins by it, and its owners are told.
export async function recheckDomains(env, { limit = 50 } = {}) {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT domain, org_id, verify_token, fail_count FROM org_domains WHERE verified_at IS NOT NULL AND (last_checked_at IS NULL OR last_checked_at < ?1) LIMIT ?2"
  ).bind(dayAgo, limit).all();
  const lost = [];
  for (const r of results || []) {
    const now = new Date().toISOString();
    let present = false;
    try { present = (await txtRecords(r.domain)).includes(`honmaru-verify=${r.verify_token}`); } catch { continue; }
    if (present) {
      await env.DB.prepare("UPDATE org_domains SET last_checked_at = ?2, fail_count = 0 WHERE domain = ?1").bind(r.domain, now).run();
      continue;
    }
    const fails = Number(r.fail_count || 0) + 1;
    if (fails < LOST_AFTER_FAILURES) {
      await env.DB.prepare("UPDATE org_domains SET last_checked_at = ?2, fail_count = ?3 WHERE domain = ?1").bind(r.domain, now, fails).run();
      continue;
    }
    await env.DB.prepare("UPDATE org_domains SET verified_at = NULL, last_checked_at = ?2, fail_count = ?3 WHERE domain = ?1").bind(r.domain, now, fails).run();
    await audit(env, null, { orgId: r.org_id, action: "domain.verification_lost", actor: { type: "system" }, entity: { type: "domain", id: r.domain, name: r.domain } });
    const { mailOwners } = await import("./owners.js");
    await mailOwners(env, r.org_id, {
      subject: `${r.domain} is no longer verified`,
      text: `The TXT record that proves ${r.domain} belongs to your workspace has been missing for three days. Nobody joins by this domain, and SSO is no longer required for it, until the record is back and you verify it again in Tools → Domains & SSO.`,
    });
    lost.push(r.domain);
  }
  return lost;
}

/// The proved domain an address belongs to, with its workspace and policy.
export async function verifiedDomainFor(db, email) {
  const d = domainOf(email);
  if (!d) return null;
  // The domain itself or any parent of it (sales.example.co.jp → example.co.jp).
  const labels = d.split(".");
  const candidates = labels.slice(0, -1).map((_, i) => labels.slice(i).join("."));
  for (const c of candidates) {
    const row = await db.prepare("SELECT * FROM org_domains WHERE domain = ?1 AND verified_at IS NOT NULL").bind(c).first();
    if (row) return row;
  }
  return null;
}

/// After a sign-in with an address that was checked (an email code, SSO):
/// the workspace that owns its domain lets them in, or offers to.
export async function domainJoin(env, githubId, { via = "domain" } = {}) {
  const user = await env.DB.prepare("SELECT email, email_verified_at, login FROM users WHERE github_id = ?1").bind(String(githubId)).first();
  if (!user?.email || !user.email_verified_at) return null;
  const row = await verifiedDomainFor(env.DB, user.email);
  if (!row || row.join_policy !== "auto") return null;
  const already = await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id = ?1 AND user_github_id = ?2").bind(row.org_id, String(githubId)).first();
  if (already) return null;
  await upsertMembership(env.DB, row.org_id, githubId, row.join_role === "guest" ? "guest" : "member", via);
  const channels = row.join_channels ? JSON.parse(row.join_channels) : [];
  if (channels.length && user.login) {
    const { addMembers } = await import("./access.js");
    for (const slug of channels) {
      const priv = await env.DB.prepare("SELECT private FROM businesses WHERE org_id = ?1 AND slug = ?2").bind(row.org_id, slug).first();
      if (priv?.private || row.join_role === "guest") await addMembers(env.DB, { orgId: row.org_id, key: `b:${slug}`, logins: [user.login], addedBy: null });
    }
  }
  const joiner = await getUserByGithubId(env.DB, githubId);
  await audit(env, null, { orgId: row.org_id, action: "member.joined", actor: person(joiner), details: { role: row.join_role, via } });
  return { orgId: row.org_id };
}

/// The workspaces this person could ask to join by their address.
export async function joinableFor(db, githubId) {
  const user = await db.prepare("SELECT email, email_verified_at FROM users WHERE github_id = ?1").bind(String(githubId)).first();
  if (!user?.email || !user.email_verified_at) return [];
  const row = await verifiedDomainFor(db, user.email);
  if (!row || row.join_policy !== "request") return [];
  if (await db.prepare("SELECT 1 FROM memberships WHERE org_id = ?1 AND user_github_id = ?2").bind(row.org_id, String(githubId)).first()) return [];
  const org = await db.prepare("SELECT name FROM orgs WHERE id = ?1").bind(row.org_id).first();
  const asked = await db.prepare("SELECT outcome FROM join_requests WHERE org_id = ?1 AND user_github_id = ?2").bind(row.org_id, String(githubId)).first();
  return [{ orgId: row.org_id, name: org?.name || row.domain, domain: row.domain, requested: Boolean(asked && !asked.outcome), declined: asked?.outcome === "declined" }];
}

/// /orgs/domains, /orgs/domains/verify, /orgs/join-requests, /orgs/joinable
export async function handleDomains(request, env, url) {
  const path = url.pathname;
  if (!["/orgs/domains", "/orgs/domains/verify", "/orgs/join-requests", "/orgs/join-requests/ask", "/orgs/joinable"].includes(path)) return null;
  const session = await getSession(env.DB, request.headers.get("x-session-token"));
  if (!session) return json({ message: "Please sign in." }, 401);
  const user = await getUserByGithubId(env.DB, session.github_id);

  // Someone at the domain, asking to come in.
  if (path === "/orgs/joinable" && request.method === "GET") {
    return json({ workspaces: await joinableFor(env.DB, session.github_id) });
  }
  const body = request.method === "GET" ? null : await request.json().catch(() => ({}));
  const orgId = request.method === "GET" ? url.searchParams.get("orgId") : body?.orgId;
  if (!orgId) return json({ message: "orgId is required" }, 400);

  if (path === "/orgs/join-requests/ask" && request.method === "POST") {
    const offered = (await joinableFor(env.DB, session.github_id)).find((w) => w.orgId === orgId);
    if (!offered) return json({ message: "Your address does not let you ask to join this workspace." }, 403);
    await env.DB.prepare(
      `INSERT INTO join_requests (org_id, user_github_id, email, requested_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(org_id, user_github_id) DO UPDATE SET requested_at = excluded.requested_at, decided_by = NULL, decided_at = NULL, outcome = NULL`
    ).bind(orgId, String(session.github_id), user?.email || "", new Date().toISOString()).run();
    await audit(env, request, { orgId, action: "member.join_requested", actor: person(user) });
    const { mailOwners } = await import("./owners.js");
    await mailOwners(env, orgId, { subject: `${user?.name || "Someone"} asked to join`, text: `${user?.name || "Someone"} signed in with your company's address and asked to join. Approve or decline on the team screen.` });
    return json({ ok: true });
  }

  const gate = await memberGate(env, session, orgId);
  if (gate) return gate;

  if (path === "/orgs/join-requests") {
    if (!(await allowed(env.DB, orgId, session.github_id, "join_request.decide"))) return json({ message: "Only an admin can decide who joins." }, 403);
    if (request.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT j.user_github_id, j.requested_at, u.name, u.login FROM join_requests j LEFT JOIN users u ON u.github_id = j.user_github_id
          WHERE j.org_id = ?1 AND j.outcome IS NULL ORDER BY j.requested_at`
      ).bind(orgId).all();
      const out = [];
      for (const r of results || []) out.push({ ref: await memberRef(orgId, String(r.user_github_id)), name: r.name || r.login, requestedAt: r.requested_at });
      return json({ requests: out });
    }
    if (request.method === "POST") {
      const { results } = await env.DB.prepare("SELECT user_github_id, role, via FROM join_requests WHERE org_id = ?1 AND outcome IS NULL").bind(orgId).all();
      let target = null; let asked = null;
      for (const r of results || []) if ((await memberRef(orgId, String(r.user_github_id))) === body.ref) { target = String(r.user_github_id); asked = r; }
      if (!target) return json({ message: "No such request." }, 404);
      const approve = body.approve === true;
      await env.DB.prepare("UPDATE join_requests SET outcome = ?3, decided_by = ?4, decided_at = ?5 WHERE org_id = ?1 AND user_github_id = ?2")
        .bind(orgId, target, approve ? "approved" : "declined", String(session.github_id), new Date().toISOString()).run();
      const joiner = await getUserByGithubId(env.DB, target);
      if (approve) {
        // By an invitation held for approval: the role it offered (never
        // above member); otherwise the domain's.
        const domain = asked?.via === "invite" ? null : await verifiedDomainFor(env.DB, joiner?.email);
        const role = asked?.via === "invite" ? (asked.role === "guest" ? "guest" : "member") : (domain?.join_role === "guest" ? "guest" : "member");
        const via = asked?.via === "invite" ? "invite" : "domain";
        await upsertMembership(env.DB, orgId, target, role, via);
        await audit(env, request, { orgId, action: "member.joined", actor: person(joiner), details: { via, approved: true, role } });
      }
      await audit(env, request, { orgId, action: approve ? "member.join_approved" : "member.join_declined", actor: person(user), entity: person(joiner) });
      return json({ ok: true, approved: approve });
    }
  }

  // The domains themselves: owners only, with a recent sign-in.
  if (path === "/orgs/domains" && request.method === "GET") {
    if (!(await allowed(env.DB, orgId, session.github_id, "audit.read"))) return json({ message: "Only an admin can see the workspace's domains." }, 403);
    return json({ domains: await listDomains(env.DB, orgId), canEdit: await allowed(env.DB, orgId, session.github_id, "domain.manage") });
  }
  if (!(await allowed(env.DB, orgId, session.github_id, "domain.manage"))) {
    await audit(env, request, { orgId, action: "security.permission_denied", actor: person(user), entity: { type: "resource", id: "domains", name: "the workspace's domains" }, outcome: "denied" });
    return json({ message: "Only an owner can change the workspace's domains." }, 403);
  }
  const again = await reauthDenial(env, session, orgId, { owner: true });
  if (again) return json(again.body, again.status);
  const domain = normalizeDomain(body?.domain);
  if (!domain) return json({ message: "That is not a domain." }, 400);
  const entity = { type: "domain", id: domain, name: domain };

  if (path === "/orgs/domains" && request.method === "POST") {
    if (FREE_MAIL_DOMAINS.has(domain)) return json({ message: "Anyone can have an address there, so it cannot be a company's domain." }, 400);
    // Your own address has to be at it: nobody claims somebody else's company.
    if (!domainMatches(domainOf(user?.email), domain)) return json({ message: "You can add only the domain of the address you signed in with." }, 400);
    const taken = await env.DB.prepare("SELECT org_id, verified_at FROM org_domains WHERE domain = ?1").bind(domain).first();
    if (taken && taken.org_id !== orgId && taken.verified_at) return json({ message: "Another workspace has already verified that domain." }, 409);
    const token = base32(crypto.getRandomValues(new Uint8Array(20)));
    // An unverified claim elsewhere does not block this one: whoever proves it first has it.
    await env.DB.prepare(
      `INSERT INTO org_domains (domain, org_id, verify_token, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(domain) DO UPDATE SET org_id = excluded.org_id, verify_token = excluded.verify_token, created_by = excluded.created_by,
         created_at = excluded.created_at, verified_at = NULL, join_policy = 'off' WHERE org_domains.verified_at IS NULL`
    ).bind(domain, orgId, token, String(session.github_id), new Date().toISOString()).run();
    await audit(env, request, { orgId, action: "domain.added", actor: person(user), entity });
    return json({ domain, txtName: domain, txtValue: `honmaru-verify=${token}` }, 201);
  }
  if (path === "/orgs/domains/verify" && request.method === "POST") {
    const out = await verifyDomain(env, orgId, domain);
    if (out.error) return json({ message: out.error, found: out.found }, out.status);
    if (out.first) await audit(env, request, { orgId, action: "domain.verified", actor: person(user), entity });
    return json({ verified: true, domains: await listDomains(env.DB, orgId) });
  }
  if (path === "/orgs/domains" && request.method === "PUT") {
    const row = await env.DB.prepare("SELECT * FROM org_domains WHERE domain = ?1 AND org_id = ?2").bind(domain, orgId).first();
    if (!row) return json({ message: "That domain is not on this workspace." }, 404);
    const policy = POLICIES.includes(body.joinPolicy) ? body.joinPolicy : row.join_policy;
    const role = body.joinRole === "guest" ? "guest" : body.joinRole === "member" ? "member" : row.join_role;
    if (policy !== "off" && !row.verified_at) return json({ message: "Verify the domain before letting people join by it." }, 400);
    const { channelsOf } = await import("./auth.js");
    const channels = Array.isArray(body.joinChannels) ? await channelsOf(env.DB, orgId, body.joinChannels, session.github_id) : (row.join_channels ? JSON.parse(row.join_channels) : []);
    if (role === "guest" && policy !== "off" && !channels.length) return json({ message: "Choose the channels a guest joins." }, 400);
    await env.DB.prepare("UPDATE org_domains SET join_policy = ?2, join_role = ?3, join_channels = ?4 WHERE domain = ?1")
      .bind(domain, policy, role, channels.length ? JSON.stringify(channels) : null).run();
    await audit(env, request, { orgId, action: "domain.join_policy_changed", actor: person(user), entity, details: { join_policy: policy, join_role: role, join_channels: channels } });
    return json({ domains: await listDomains(env.DB, orgId) });
  }
  if (path === "/orgs/domains" && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM org_domains WHERE domain = ?1 AND org_id = ?2").bind(domain, orgId).run();
    await audit(env, request, { orgId, action: "domain.removed", actor: person(user), entity });
    return json({ domains: await listDomains(env.DB, orgId) });
  }
  return json({ message: "not found" }, 404);
}
