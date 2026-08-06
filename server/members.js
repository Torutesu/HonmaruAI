/** @typedef {{ id: string, name: string, role: string, githubUsername: string|null, managerID: string|null }} Member */

/**
 * The organization starts with its founding members. Everyone else is added
 * from the app at runtime — nothing here is fixture data.
 * @type {Member[]}
 */
export const DEFAULT_MEMBERS = [
  {
    id: "user-toru",
    name: "Toru",
    role: "CEO",
    githubUsername: null,
    managerID: null,
  },
  {
    id: "user-gota",
    name: "Gota",
    role: "PM",
    githubUsername: null,
    managerID: "user-toru",
  },
];

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Builds a stable, human-readable id from a name, avoiding collisions with
 * members already on the roster.
 * @param {string} name
 * @param {Member[]} roster
 */
export function nextMemberID(name, roster) {
  const base = slugify(name) || "member";
  const taken = new Set(roster.map((member) => member.id));

  let candidate = `user-${base}`;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `user-${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * Coerces untrusted client input into a member record.
 * @returns {Member}
 */
export function normalizeMember(input) {
  const text = (value, max) => {
    const trimmed = String(value ?? "").trim();
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
  };

  const id = text(input?.id, 64);
  const githubUsername = text(input?.githubUsername, 64);
  const managerID = text(input?.managerID, 64);

  return {
    id: id || "",
    name: text(input?.name, 64),
    role: text(input?.role, 64) || "Member",
    githubUsername: githubUsername || null,
    managerID: managerID || null,
  };
}
