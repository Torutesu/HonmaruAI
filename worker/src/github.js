// Thin GitHub REST wrapper. Uses the collaborator's/session's access token.
const GH = "https://api.github.com";
const HEADERS = (token) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "user-agent": "tiktokforwork",
  "x-github-api-version": "2022-11-28",
});

export async function fetchCollaborators(token, owner, repo) {
  const res = await fetch(
    `${GH}/repos/${owner}/${repo}/collaborators?per_page=100`,
    { headers: HEADERS(token) }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub collaborators ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}
