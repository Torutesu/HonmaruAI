import { isMember, upsertUser, upsertMembership, upsertAgent, getUserByGithubId } from "./db.js";
import { roleName } from "./org.js";

const GH = "https://api.github.com";

function headers(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "tiktokforwork",
    "x-github-api-version": "2022-11-28",
  };
}

/// Whether this session may act inside `orgId`, and the login it acts as.
///
/// Returns `{ ok, login }`. `ok:false` means the socket or request must be
/// refused; there is no third answer.
///
/// The membership table is the fast path, but it cannot be the only one. It is
/// written when someone loads the org graph, and the client connects its socket
/// *before* it loads the graph — so a first sign-in would be refused by a check
/// that trusted the table alone. Rather than reorder the client (and still be
/// wrong for someone added to the repo a minute ago), a miss falls through to
/// GitHub, which is the authority anyway, and the answer is cached as a row.
///
/// Write access is what makes someone a member here. A public repository hands
/// `pull` to the entire internet, and `GET /repos` cannot tell a read-only
/// collaborator apart from a stranger — so `pull` alone would make every public
/// repository a joinable organization.
export async function authorizeOrgAccess(env, session, orgId) {
  const known = await getUserByGithubId(env.DB, session.github_id);
  if (known?.login && (await isMember(env.DB, orgId, session.github_id))) {
    return { ok: true, login: known.login };
  }

  const [owner, repo, ...rest] = String(orgId).split("/");
  // Anything that is not "owner/repo" has no authority to appeal to. The legacy
  // "core-team" org id lands here, which is the point: it is not a real org.
  if (!owner || !repo || rest.length) return { ok: false, login: null };

  let permissions;
  try {
    const res = await fetch(`${GH}/repos/${owner}/${repo}`, {
      headers: headers(session.github_access_token),
    });
    if (!res.ok) return { ok: false, login: null };
    permissions = (await res.json())?.permissions || {};
  } catch {
    return { ok: false, login: null };
  }
  if (!(permissions.push || permissions.admin || permissions.maintain || permissions.triage)) {
    return { ok: false, login: null };
  }

  let login = known?.login || null;
  let avatarUrl = known?.avatar_url || null;
  let name = known?.name || null;
  if (!login) {
    try {
      const res = await fetch(`${GH}/user`, { headers: headers(session.github_access_token) });
      if (!res.ok) return { ok: false, login: null };
      const me = await res.json();
      login = me.login;
      avatarUrl = me.avatar_url;
      name = me.name;
    } catch {
      return { ok: false, login: null };
    }
  }
  if (!login) return { ok: false, login: null };

  await upsertUser(env.DB, { githubId: session.github_id, login, name, avatarUrl, locale: known?.locale || "en" });
  await upsertMembership(env.DB, orgId, session.github_id, roleName(permissions));
  await upsertAgent(env.DB, orgId, session.github_id, `${login}'s AI`);
  return { ok: true, login };
}
