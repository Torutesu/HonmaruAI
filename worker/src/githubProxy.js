// GitHub, reached through us rather than from the device.
//
// The token exchange used to hand the app the GitHub access token itself. It
// carries `repo` scope — every repository the person can reach, code included —
// and there is no narrower OAuth scope that grants issues alone, so the app was
// holding a credential far larger than anything it does with it, on a device,
// for as long as the install lasted.
//
// It stays on the server now. What the app can reach is this list, which is
// exactly what it calls: identify yourself, list your repositories, look at one,
// and open or update an issue on it. A stolen session can do those six things.
// It cannot read the person's source.
//
// This is not the whole fix. `repo` is still the scope we ask GitHub for,
// because OAuth Apps have no issues-only scope — narrowing that means becoming
// a GitHub App, which is a migration, not a patch.

const GH = "https://api.github.com";

// Path patterns are matched against the segments after `/github`. `:seg` is one
// segment and never contains a slash, so no pattern can be widened by a crafted
// repository name.
const ALLOWED = [
  { method: "GET", pattern: ["user"] },
  { method: "GET", pattern: ["user", "repos"], query: ["per_page", "sort", "page"] },
  { method: "GET", pattern: ["repos", ":owner", ":repo"] },
  { method: "GET", pattern: ["repos", ":owner", ":repo", "issues", ":number"] },
  { method: "POST", pattern: ["repos", ":owner", ":repo", "issues"] },
  { method: "PATCH", pattern: ["repos", ":owner", ":repo", "issues", ":number"] },
];

function matches(pattern, segments) {
  if (pattern.length !== segments.length) return false;
  return pattern.every((p, i) => (p.startsWith(":") ? segments[i].length > 0 : p === segments[i]));
}

/// A dot-segment is not a repository name.
///
/// `:owner` and `:repo` match any non-empty segment, and `encodeURIComponent`
/// leaves ".." exactly as it found it — so `/github/repos/../gists` would build
/// `https://api.github.com/repos/../gists`, which `new URL()` then *normalises*
/// to `/gists`. That is the six-call allowlist escaped, with a `repo`-scoped
/// token, into the person's private gists and issues.
///
/// It is not reachable today: `index.js` reaches this through
/// `new URL(request.url)`, and the URL parser collapses every dot-segment form
/// — `..`, `%2E%2E`, `%2e.` — before `pathname` is ever read. That is an
/// invariant of the caller, though, not of this file, and the promise at the
/// top of this one is too load-bearing to rest on it.
function isSafeSegment(segment) {
  return segment !== "." && segment !== "..";
}

function allow(method, segments) {
  return ALLOWED.find((rule) => rule.method === method && matches(rule.pattern, segments)) || null;
}

/// Forward one call to GitHub as the person whose session this is.
///
/// Returns GitHub's status and body largely as they came, so the app's existing
/// error handling still reads them. Request headers are not forwarded: the app
/// does not get to choose what we send GitHub on its behalf.
export async function proxyGitHub(request, env, url, session) {
  const segments = url.pathname.replace(/^\/github\/?/, "").split("/").filter(Boolean);
  const rule = segments.every(isSafeSegment) ? allow(request.method, segments) : null;
  if (!rule) {
    return new Response(JSON.stringify({ message: "That GitHub call is not available here." }), {
      status: 404, headers: { "content-type": "application/json" },
    });
  }

  const target = new URL(`${GH}/${segments.map(encodeURIComponent).join("/")}`);
  // Only the parameters the rule names. Anything else the caller appended is
  // dropped rather than passed through to GitHub.
  for (const key of rule.query || []) {
    const value = url.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }

  const headers = {
    authorization: `Bearer ${session.github_access_token}`,
    accept: "application/vnd.github+json",
    "user-agent": "tiktokforwork",
    "x-github-api-version": "2022-11-28",
  };
  let body;
  if (request.method === "POST" || request.method === "PATCH") {
    try {
      body = JSON.stringify(await request.json());
    } catch {
      return new Response(JSON.stringify({ message: "Unreadable request body." }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }
    headers["content-type"] = "application/json";
  }

  const res = await fetch(target, { method: request.method, headers, body });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") || "application/json" },
  });
}
