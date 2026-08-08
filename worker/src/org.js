// Maps GitHub repo collaborators into the OrganizationGraph the iOS app consumes.
// Member id = GitHub login. Agent id = `agent-<login>`. Team id = `team-<repo>`.

export function roleName(permissions = {}) {
  if (permissions.admin) return "Admin";
  if (permissions.maintain) return "Maintainer";
  if (permissions.push) return "Engineer";
  if (permissions.triage) return "Triager";
  return "Member";
}

export function isApprover(permissions = {}) {
  return Boolean(permissions.admin || permissions.maintain);
}

export function buildOrgGraph(collaborators, { owner, repo }) {
  const teamId = `team-${repo}`;
  const teamLabel = `${owner}/${repo}`;
  const users = [];
  const nodes = [{ id: teamId, kind: "team", label: teamLabel }];
  const edges = [];

  for (const c of collaborators) {
    const role = roleName(c.permissions);
    users.push({
      id: c.login, name: c.login, role,
      teamID: teamId, githubUsername: c.login, language: "en",
    });
    nodes.push({ id: c.login, kind: "person", label: `${c.login} · ${role}` });
    nodes.push({ id: `agent-${c.login}`, kind: "agent", label: `${c.login}'s AI` });
    edges.push({ id: `e-mem-${c.login}`, fromID: c.login, toID: teamId, kind: "memberOf" });
    edges.push({ id: `e-agent-${c.login}`, fromID: `agent-${c.login}`, toID: c.login, kind: "assignedTo" });
    if (isApprover(c.permissions)) {
      edges.push({ id: `e-appr-${c.login}`, fromID: c.login, toID: teamId, kind: "canApprove" });
    }
  }
  return { users, nodes, edges };
}
