import { randomUUID } from "node:crypto";

// Seed org — mirrors the app's demo roster so the two-simulator demo
// works with zero setup. Replaced by persisted data once members are added.
export const DEFAULT_ORG = {
  users: [
    { id: "user-alice", name: "Alice", role: "Product Manager", teamID: "team-core", githubUsername: "alice", language: "en" },
    { id: "user-bob", name: "Bob", role: "Engineer", teamID: "team-core", githubUsername: "bob", language: "en" },
    { id: "user-carol", name: "Carol", role: "Designer", teamID: "team-core", githubUsername: "carol", language: "en" },
    { id: "user-dana", name: "Dana", role: "Engineering Lead", teamID: "team-core", githubUsername: "dana", language: "en" },
  ],
  nodes: [
    { id: "user-alice", kind: "person", label: "Alice · Product" },
    { id: "user-bob", kind: "person", label: "Bob · Engineering" },
    { id: "user-carol", kind: "person", label: "Carol · Design" },
    { id: "user-dana", kind: "person", label: "Dana · Eng Lead" },
    { id: "agent-alice", kind: "agent", label: "Alice's AI" },
    { id: "agent-bob", kind: "agent", label: "Bob's AI" },
    { id: "agent-carol", kind: "agent", label: "Carol's AI" },
    { id: "agent-dana", kind: "agent", label: "Dana's AI" },
    { id: "team-core", kind: "team", label: "Core Team" },
    { id: "team-design", kind: "team", label: "Design Team" },
    { id: "team-engineering", kind: "team", label: "Engineering" },
    { id: "team-product", kind: "team", label: "Product" },
    { id: "project-onboarding", kind: "project", label: "Onboarding v2" },
  ],
  edges: [
    { id: "e1", fromID: "user-alice", toID: "team-core", kind: "memberOf" },
    { id: "e2", fromID: "user-bob", toID: "team-core", kind: "memberOf" },
    { id: "e3", fromID: "user-carol", toID: "team-core", kind: "memberOf" },
    { id: "e4", fromID: "user-dana", toID: "team-core", kind: "memberOf" },
    { id: "e13", fromID: "user-carol", toID: "team-design", kind: "memberOf" },
    { id: "e14", fromID: "user-bob", toID: "team-engineering", kind: "memberOf" },
    { id: "e15", fromID: "user-dana", toID: "team-engineering", kind: "memberOf" },
    { id: "e16", fromID: "user-alice", toID: "team-product", kind: "memberOf" },
    { id: "e5", fromID: "user-alice", toID: "user-bob", kind: "manages" },
    { id: "e6", fromID: "user-dana", toID: "user-bob", kind: "manages" },
    { id: "e7", fromID: "user-alice", toID: "project-onboarding", kind: "canApprove" },
    { id: "e8", fromID: "user-dana", toID: "project-onboarding", kind: "canApprove" },
    { id: "e9", fromID: "agent-alice", toID: "user-alice", kind: "assignedTo" },
    { id: "e10", fromID: "agent-bob", toID: "user-bob", kind: "assignedTo" },
    { id: "e11", fromID: "agent-carol", toID: "user-carol", kind: "assignedTo" },
    { id: "e12", fromID: "agent-dana", toID: "user-dana", kind: "assignedTo" },
  ],
};

// Coarse role buckets that drive keyword routing for any role string.
export function roleBucket(role) {
  const lower = String(role || "").toLowerCase();
  if (/design|ux|ui/.test(lower)) return "design";
  if (/(lead|head|principal|staff|architect|cto)/.test(lower) && /eng|tech|develop/.test(lower)) {
    return "engineering-lead";
  }
  if (/engineer|developer|swe|backend|frontend|devops|sre/.test(lower)) return "engineering";
  if (/product|\bpm\b/.test(lower)) return "product";
  return "general";
}

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

function isValidOrg(data) {
  return (
    data &&
    Array.isArray(data.users) &&
    data.users.length > 0 &&
    Array.isArray(data.nodes) &&
    Array.isArray(data.edges)
  );
}

export function createOrgStore(initial) {
  const state = isValidOrg(initial) ? initial : structuredClone(DEFAULT_ORG);

  return {
    snapshot() {
      return { users: state.users, nodes: state.nodes, edges: state.edges };
    },

    serialize() {
      return { users: state.users, nodes: state.nodes, edges: state.edges };
    },

    users() {
      return state.users;
    },

    userIDs() {
      return state.users.map((user) => user.id);
    },

    findUser(userID) {
      return state.users.find((user) => user.id === userID) || null;
    },

    userName(userID) {
      return this.findUser(userID)?.name || userID;
    },

    findByGitHub(login) {
      const lower = String(login || "").toLowerCase();
      if (!lower) return null;
      return (
        state.users.find((user) => (user.githubUsername || "").toLowerCase() === lower) || null
      );
    },

    teams() {
      return state.nodes.filter((node) => node.kind === "team");
    },

    teamMembers(teamID) {
      const memberIDs = new Set(
        state.edges
          .filter((edge) => edge.toID === teamID && edge.kind === "memberOf")
          .map((edge) => edge.fromID)
      );
      return state.users.filter((user) => memberIDs.has(user.id));
    },

    managerOf(userID) {
      const edge = state.edges.find(
        (item) => item.toID === userID && item.kind === "manages"
      );
      return edge ? this.findUser(edge.fromID) : null;
    },

    /**
     * Autopilot is stored per person because it is a delegation of authority,
     * not a workspace setting. Only the fields we understand are kept.
     */
    setAutopilot(userID, settings) {
      const user = this.findUser(userID);
      if (!user || !settings || typeof settings !== "object") return null;

      const next = { ...(user.autopilot || {}) };
      if (typeof settings.enabled === "boolean") next.enabled = settings.enabled;
      if (Number.isFinite(Number(settings.holdMinutes))) {
        next.holdMinutes = Number(settings.holdMinutes);
      }
      if (typeof settings.maxPriority === "string") next.maxPriority = settings.maxPriority;
      if (Array.isArray(settings.actions)) next.actions = settings.actions;

      user.autopilot = next;
      return user;
    },

    setLanguage(userID, language) {
      const user = this.findUser(userID);
      if (!user) return false;
      const cleaned = String(language || "").trim().slice(0, 30);
      if (!cleaned) return false;
      user.language = cleaned;
      return true;
    },

    addMember({ name, role, team, githubUsername, language }) {
      const cleanedName = String(name || "").trim().slice(0, 60);
      const cleanedRole = String(role || "").trim().slice(0, 60);
      if (!cleanedName || !cleanedRole) return null;

      let slug = slugify(cleanedName);
      if (!slug) return null;
      if (state.users.some((user) => user.id === `user-${slug}`)) {
        slug = `${slug}-${randomUUID().slice(0, 4)}`;
      }
      const userID = `user-${slug}`;

      // Resolve or create the team node.
      let teamNode = null;
      const teamName = String(team || "").trim();
      if (teamName) {
        const lower = teamName.toLowerCase();
        teamNode =
          this.teams().find((node) => node.label.toLowerCase().includes(lower)) || null;
        if (!teamNode) {
          teamNode = { id: `team-${slugify(teamName)}`, kind: "team", label: teamName };
          state.nodes.push(teamNode);
        }
      }

      const user = {
        id: userID,
        name: cleanedName,
        role: cleanedRole,
        teamID: teamNode?.id || "team-core",
        githubUsername: String(githubUsername || "").trim() || undefined,
        language: String(language || "").trim().slice(0, 30) || "en",
      };
      state.users.push(user);

      state.nodes.push({ id: userID, kind: "person", label: `${cleanedName} · ${cleanedRole}` });
      state.nodes.push({ id: `agent-${slug}`, kind: "agent", label: `${cleanedName}'s AI` });

      state.edges.push({
        id: `edge-${randomUUID().slice(0, 8)}`,
        fromID: userID,
        toID: "team-core",
        kind: "memberOf",
      });
      if (teamNode && teamNode.id !== "team-core") {
        state.edges.push({
          id: `edge-${randomUUID().slice(0, 8)}`,
          fromID: userID,
          toID: teamNode.id,
          kind: "memberOf",
        });
      }
      state.edges.push({
        id: `edge-${randomUUID().slice(0, 8)}`,
        fromID: `agent-${slug}`,
        toID: userID,
        kind: "assignedTo",
      });

      return user;
    },
  };
}
