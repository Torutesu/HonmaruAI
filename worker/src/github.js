// Thin GitHub REST wrapper. Uses the collaborator's/session's access token.
const GH = "https://api.github.com";
const HEADERS = (token) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "user-agent": "tiktokforwork",
  "x-github-api-version": "2022-11-28",
});

// Ten pages is a thousand collaborators — far past any team this product is
// for, and a bound so one repository cannot make this request run forever.
const MAX_PAGES = 10;

/// Every collaborator on a repository, following GitHub's pagination.
///
/// A single `per_page=100` request silently truncated at a hundred people: past
/// that, someone removed from the repository was never seen to be missing, so
/// their membership was never withdrawn.
export async function fetchCollaborators(token, owner, repo) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await fetch(
      `${GH}/repos/${owner}/${repo}/collaborators?per_page=100&page=${page}`,
      { headers: HEADERS(token), signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub collaborators ${res.status}: ${body.slice(0, 200)}`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}
