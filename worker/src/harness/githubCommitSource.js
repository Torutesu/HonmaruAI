const API = 'https://api.github.com';
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const REF_PART = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_HTML_BYTES = 119800;

function safeRepoPart(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) && value !== '.' && value !== '..';
}

function safeBranch(value) {
  return typeof value === 'string' && value.length <= 240 && value.split('/').length <= 8
    && value.split('/').every(part => REF_PART.test(part) && part !== '.' && part !== '..')
    && !value.startsWith('/') && !value.endsWith('/') && !value.includes('//');
}

function tokenValue(token) {
  return typeof token === 'string' && token && token !== 'email-auth' ? token : null;
}

async function githubJson(token, path) {
  const response = await fetch(`${API}${path}`, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'HonmaruAI',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error('GitHub redirected a source request.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub source request failed (${response.status}).`);
  }
  return response.json();
}

async function currentBranchSha(token, owner, repo, branch) {
  const segments = branch.split('/').map(encodeURIComponent).join('/');
  const ref = await githubJson(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${segments}`);
  const sha = ref?.object?.sha;
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error('GitHub did not return a valid branch commit.');
  return sha.toLowerCase();
}

/// Imports one self-contained root index.html from the exact commit. The
/// caller's GitHub session remains server-side; the token is never returned.
export async function fetchGitHubCommitSource(sessionToken, input) {
  const token = tokenValue(sessionToken);
  if (!token) return { error: 'Sign in with the connected GitHub account to import a commit.', status: 403 };
  const owner = String(input?.owner || '').trim();
  const repo = String(input?.repo || '').trim();
  const branch = String(input?.branch || '').trim();
  const requestedSha = String(input?.commitSha || '').toLowerCase();
  if (!safeRepoPart(owner) || !safeRepoPart(repo) || !safeBranch(branch) || !SHA.test(requestedSha)) {
    return { error: 'Choose a GitHub repository, branch, and full commit SHA.', status: 400 };
  }
  try {
    const resolved = await currentBranchSha(token, owner, repo, branch);
    if (resolved !== requestedSha) return { error: 'The branch no longer points to this commit. Select the current commit and request a new review.', status: 409 };
    const commit = await githubJson(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${requestedSha}`);
    if (String(commit?.sha || '').toLowerCase() !== requestedSha) return { error: 'GitHub returned a different commit.', status: 409 };
    const query = new URLSearchParams({ ref: requestedSha });
    const file = await githubJson(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/index.html?${query}`);
    if (file?.type !== 'file' || file?.path !== 'index.html' || file?.encoding !== 'base64' || typeof file?.content !== 'string') {
      return { error: 'The pinned commit must contain a root index.html file.', status: 400 };
    }
    const encoded = file.content.replace(/\\s/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      return { error: 'GitHub returned invalid source content.', status: 502 };
    }
    const binary = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    if (binary.length !== Number(file.size) || binary.length > MAX_HTML_BYTES) {
      return { error: 'The root index.html exceeds the 119800-byte import limit.', status: 413 };
    }
    const html = new TextDecoder('utf-8', { fatal: true }).decode(binary);
    if (!html.trim() || html.length > MAX_HTML_BYTES) return { error: 'The pinned HTML source is empty or too large.', status: 400 };
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html));
    const sourceHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    // A branch can move after the first lookup. Check again after source fetch;
    // the returned bytes are still from the immutable commit SHA above.
    const latest = await currentBranchSha(token, owner, repo, branch);
    if (latest !== requestedSha) return { error: 'The branch moved while importing. Select its current commit and request a new review.', status: 409 };
    return {
      source: html,
      commit: { owner, repo, branch, sha: requestedSha, path: 'index.html', sourceHash },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'GitHub source could not be verified.', status: 502 };
  }
}

export async function verifyGitHubCommitRef(sessionToken, commit) {
  const token = tokenValue(sessionToken);
  if (!token) return { error: 'Sign in with the connected GitHub account to verify this commit.', status: 403 };
  if (!commit || !safeRepoPart(commit.owner) || !safeRepoPart(commit.repo) || !safeBranch(commit.branch) || !SHA.test(String(commit.sha || ''))) {
    return { error: 'The saved GitHub commit source is invalid.', status: 409 };
  }
  try {
    const sha = await currentBranchSha(token, commit.owner, commit.repo, commit.branch);
    if (sha !== String(commit.sha).toLowerCase()) return { error: 'The approved branch moved to a different commit. Import and review the new commit.', status: 409 };
    const pinned = await githubJson(token, `/repos/${encodeURIComponent(commit.owner)}/${encodeURIComponent(commit.repo)}/git/commits/${encodeURIComponent(commit.sha)}`);
    if (String(pinned?.sha || '').toLowerCase() !== String(commit.sha).toLowerCase()) return { error: 'The pinned GitHub commit could not be verified.', status: 409 };
    return { verified: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'GitHub commit could not be verified.', status: 502 };
  }
}
