import { sessionByKey } from '../db.js';
import { policyDenial } from '../policy.js';
import { domainOf, domainMatches } from '../domains.js';
import { ipAllowed } from '../orgKeys.js';
import { currentIp } from '../requestContext.js';

// Exact policy values used by SSO and network authorization. This deliberately
// includes all connections and verified domains, so additions, removals and
// changes to ordering invalidate a previously checked policy. No secrets or
// bearer tokens are included. The three SQL arguments are trusted placeholders.
export const skillPolicyFingerprint = (org, user, token) => `json_object(
  'network', (SELECT json_object('enforce',g.ip_enforce,'allowlist',g.ip_allowlist) FROM org_governance g WHERE g.org_id=${org}),
  'ssoPolicy', (SELECT json_object('enforce',p.enforce) FROM org_sso_policy p WHERE p.org_id=${org}),
  'legacy', (SELECT json_object('enforce',l.enforce,'status',l.status,'domains',l.allowed_domains,'hours',l.session_hours,'updated',l.updated_at) FROM org_sso l WHERE l.org_id=${org}),
  'connections', (SELECT json_group_array(json_object('id',x.id,'status',x.status,'domains',x.allowed_domains,'hours',x.session_hours,'created',x.created_at))
    FROM (SELECT id,status,allowed_domains,session_hours,created_at FROM sso_connections WHERE org_id=${org} ORDER BY created_at,id) x),
  'domains', (SELECT json_group_array(json_object('domain',x.domain,'verified',x.verified_at))
    FROM (SELECT domain,verified_at FROM org_domains WHERE org_id=${org} ORDER BY domain) x),
  'email', (SELECT email FROM users WHERE github_id=${user}),
  'session', (SELECT json_object('created',s.created_at,'auth',s.auth_method,'ssoOrg',s.sso_org_id,'ssoConnection',s.sso_connection_id)
    FROM sessions s WHERE s.token=${token} AND s.github_id=${user}))`;

const unpack = value => typeof value === 'string' ? JSON.parse(value) : value;

// Evaluate the exact values from one SQLite snapshot, not separate live SSO
// reads which could observe an intermediate policy during an ABA change.
// Reuse the product's domain and CIDR matching rules, then compare this same
// fingerprint in the write or delivery SQL.
function evaluateSnapshot(fingerprint, orgId) {
  const state = JSON.parse(fingerprint);
  const legacy = unpack(state.legacy);
  const network = unpack(state.network);
  const policy = unpack(state.ssoPolicy);
  const session = unpack(state.session);
  const connections = unpack(state.connections) || [];
  const domains = unpack(state.domains) || [];
  if (legacy || !session || !Array.isArray(connections) || !Array.isArray(domains)) return { allowed: false };
  const ip = currentIp();
  if (ip && network?.enforce && !ipAllowed(ip, JSON.parse(network.allowlist || '[]'))) return { allowed: false };
  const verified = new Set(domains.filter(row => row.verified !== null).map(row => row.domain));
  const emailDomain = domainOf(state.email);
  const required = policy?.enforce && emailDomain && connections.find(connection => connection.status === 'active'
    && JSON.parse(connection.domains || '[]').some(domain => verified.has(domain) && domainMatches(emailDomain, domain)));
  if (required && (session.auth !== 'sso' || session.ssoOrg !== orgId)) return { allowed: false };
  let ssoDeadline = null;
  if (session.auth === 'sso' && session.ssoOrg === orgId) {
    const connection = connections.find(item => item.id === session.ssoConnection) || required || connections[0] || null;
    const created = Date.parse(session.created || '');
    const deadline = created + (connection?.hours || 24) * 3600000;
    if (Number.isFinite(deadline)) {
      if (Date.now() > deadline) return { allowed: false };
      ssoDeadline = deadline;
    }
  }
  return { allowed: true, ssoDeadline };
}

export async function currentSkillPolicy(env, orgId, userId, sessionKey) {
  if (!sessionKey) return { allowed: false };
  const read = async () => (await env.DB.prepare(`SELECT ${skillPolicyFingerprint('?1', '?2', '?3')} AS fingerprint`)
    .bind(orgId, String(userId), sessionKey).first())?.fingerprint;
  let fingerprint = await read();
  if (!fingerprint) return { allowed: false };
  const session = await sessionByKey(env.DB, sessionKey);
  if (!session || String(session.github_id) !== String(userId)) return { allowed: false };
  const denied = await policyDenial(env, session, orgId, { fresh: true });
  if (denied) return { allowed: false };
  // The existing policy check migrates legacy SSO configuration. Evaluate a
  // new single snapshot after that migration; do not make a valid first use
  // fail merely because the old-format row existed at the first read.
  if (unpack(JSON.parse(fingerprint).legacy)) fingerprint = await read();
  if (!fingerprint) return { allowed: false };
  const snapshot = evaluateSnapshot(fingerprint, orgId);
  if (!snapshot.allowed) return snapshot;
  return { allowed: true, fingerprint, ssoDeadline: snapshot.ssoDeadline };
}

// Date.now() in policy.js has millisecond precision and uses a strict `>`.
export const skillSsoDeadline = param => `(${param} IS NULL OR (CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))<=${param})`;
