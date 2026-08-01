// Thin GitHub passthrough for the web client. The browser never holds a
// GitHub token — it calls the relay, the relay uses the session's token and
// the session's selected repository.

const API = "https://api.github.com";

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "TikTokForWork-Relay/1.0",
    "Content-Type": "application/json",
  };
}

export class GitHubProxyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function call(token, path, { method = "GET", body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: headers(token),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new GitHubProxyError(
      response.status,
      data.message || `GitHub request failed (${response.status}).`
    );
  }
  return data;
}

export function listRepositories(token) {
  return call(token, "/user/repos?per_page=100&sort=updated").then((repos) =>
    (Array.isArray(repos) ? repos : []).map((repo) => ({
      id: repo.id,
      fullName: repo.full_name,
      htmlURL: repo.html_url,
      isPrivate: repo.private,
    }))
  );
}

export function getViewer(token) {
  return call(token, "/user");
}

/** Assert the session owns a repository before touching issues. */
function requireRepository(repository) {
  if (!repository) {
    throw new GitHubProxyError(400, "No repository selected for this session.");
  }
  return repository;
}

export function createIssue(token, repository, { title, body, labels }) {
  return call(token, `/repos/${requireRepository(repository)}/issues`, {
    method: "POST",
    body: { title, body, ...(labels?.length ? { labels } : {}) },
  }).then((issue) => ({ number: issue.number, url: issue.html_url, state: issue.state }));
}

export function updateIssue(token, repository, number, { title, body, state }) {
  return call(token, `/repos/${requireRepository(repository)}/issues/${number}`, {
    method: "PATCH",
    body: {
      ...(title ? { title } : {}),
      ...(body ? { body } : {}),
      ...(state ? { state } : {}),
    },
  }).then((issue) => ({ number: issue.number, url: issue.html_url, state: issue.state }));
}

export function getIssue(token, repository, number) {
  return call(
    token,
    `/repos/${requireRepository(repository)}/issues/${number}`
  ).then((issue) => ({ number: issue.number, url: issue.html_url, state: issue.state }));
}
