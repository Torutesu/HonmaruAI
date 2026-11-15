const API = 'https://api.github.com';
const APP_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/;
const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const MAX_HTML_BYTES = 120_000;
const MAX_BUNDLE_BYTES = 1_500_000;
const MAX_ASSETS = 50;
const MAX_RESPONSE_BYTES = 128_000;
const ASSET_TYPES = Object.freeze({
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', txt: 'text/plain',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf',
});

function error(message, status) { return { error: message, status }; }
function validRepoPart(value) { return typeof value === 'string' && REPO_PART.test(value) && value !== '.' && value !== '..'; }
function validSha(value) { return typeof value === 'string' && SHA.test(value); }
function branchPath(branch) { return branch.split('/').map(encodeURIComponent).join('/'); }
function repoRoot(owner, repo) { return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`; }
function safeEntryPath(value) {
  if (value === undefined) return 'index.html';
  if (typeof value !== 'string' || !value || value.length > 180 || value.startsWith('/') || value.includes('\\') || value.includes('\0') || value.includes('?') || value.includes('#') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  const parts = value.split('/');
  if (parts.length > 8 || parts.some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9_.@+-]{1,80}$/.test(part))) return null;
  return /\.html?$/i.test(parts.at(-1)) ? value : null;
}

function bytesFromBase64(value, maxBytes) {
  if (typeof value !== 'string') return null;
  if (value.length > Math.ceil(maxBytes / 3) * 4) return { tooLarge: true };
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  try { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); } catch { return null; }
}

function base64FromBytes(bytes) {
  let encoded = '';
  for (let offset = 0; offset < bytes.length; offset += 0x6000) {
    encoded += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x6000, bytes.length)));
  }
  return btoa(encoded);
}

function normalizeAsset(asset, maxBytes) {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset) || typeof asset.path !== 'string') return null;
  const path = asset.path;
  if (!path || path.length > 180 || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.includes('?') || path.includes('#') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  const parts = path.split('/');
  if (parts.length > 8 || parts.some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9_.@+-]{1,80}$/.test(part))) return null;
  const extension = parts.at(-1).split('.').at(-1).toLowerCase();
  const contentType = ASSET_TYPES[extension];
  if (!contentType) return null;

  let bytes;
  if (asset.encoding === 'base64') bytes = bytesFromBase64(asset.content, maxBytes);
  else if ((asset.encoding === undefined || asset.encoding === 'utf8') && typeof asset.content === 'string') {
    if (asset.content.length > maxBytes) return { tooLarge: true };
    bytes = new TextEncoder().encode(asset.content);
  }
  else return null;
  if (bytes?.tooLarge || bytes?.byteLength > maxBytes) return { tooLarge: true };
  if (!bytes) return null;
  return { path, contentType, bytes };
}

async function readJsonResponse(response, limit = MAX_RESPONSE_BYTES) {
  try {
    const length = Number(response.headers?.get?.('content-length') || 0);
    if (length > limit) {
      await response.body?.cancel?.();
      return null;
    }
    const reader = response.body?.getReader?.();
    if (!reader) return null;
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
    try { return JSON.parse(text); } catch { return null; }
  } catch {
    try { await response.body?.cancel?.(); } catch { /* ignore a failed cancellation */ }
    return null;
  }
}

async function githubRequest(token, path, method = 'GET', body) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'HonmaruAI',
        'x-github-api-version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, status: 502, data: null };
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel?.();
    return { ok: false, status: 502, data: null };
  }
  if (!response.ok) {
    await response.body?.cancel?.();
    return { ok: false, status: response.status, data: null };
  }
  const data = await readJsonResponse(response);
  return data ? { ok: true, status: response.status, data } : { ok: false, status: 502, data: null };
}

function normalizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
  const repo = typeof input.repo === 'string' ? input.repo.trim() : '';
  const appId = typeof input.appId === 'string' ? input.appId.trim() : '';
  if (!validRepoPart(owner) || !validRepoPart(repo) || !APP_ID.test(appId)) return null;
  if (typeof input.html !== 'string' || !input.html.trim() || input.html.includes('\0')) return null;
  if (input.html.length > MAX_HTML_BYTES) return { tooLarge: true };
  const htmlBytes = new TextEncoder().encode(input.html);
  if (htmlBytes.byteLength > MAX_HTML_BYTES) return { tooLarge: true };
  if (!Array.isArray(input.assets)) return null;
  if (input.assets.length > MAX_ASSETS) return { tooLarge: true };
  const assets = [];
  const seen = new Set();
  let totalBytes = htmlBytes.byteLength;
  for (const raw of input.assets) {
    const asset = normalizeAsset(raw, MAX_BUNDLE_BYTES - totalBytes);
    if (asset?.tooLarge) return { tooLarge: true };
    if (!asset) return null;
    const pathKey = asset.path.toLowerCase();
    if (seen.has(pathKey)) return null;
    seen.add(pathKey);
    totalBytes += asset.bytes.byteLength;
    if (totalBytes > MAX_BUNDLE_BYTES) return { tooLarge: true };
    assets.push(asset);
  }
  const entryPath = safeEntryPath(input.entryPath);
  if (!entryPath) return null;
  return { owner, repo, appId, entryPath, htmlBytes, assets, totalBytes };
}

function apiError(response, message = 'GitHub draft publishing failed.') {
  if (response.status === 401 || response.status === 403) return error('The connected GitHub account cannot write to this repository.', 403);
  if (response.status === 404) return error('The repository or Git branch could not be found.', 404);
  if (response.status === 409 || response.status === 422) return error('The Git branch changed concurrently. Reload the draft before publishing again.', 409);
  return error(message, response.status >= 400 && response.status < 500 ? response.status : 502);
}

async function resolveRef(token, root, branch) {
  return githubRequest(token, `${root}/git/ref/heads/${branchPath(branch)}`);
}

function normalizedBindingInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
  const repo = typeof input.repo === 'string' ? input.repo.trim() : '';
  const appId = typeof input.appId === 'string' ? input.appId.trim() : '';
  const entryPath = safeEntryPath(input.entryPath);
  if (!validRepoPart(owner) || !validRepoPart(repo) || !APP_ID.test(appId) || !entryPath) return null;
  return { owner, repo, appId, entryPath };
}

async function resolveBinding(token, input) {
  const root = repoRoot(input.owner, input.repo);
  const user = await githubRequest(token, '/user');
  if (!user.ok || !Number.isSafeInteger(user.data?.id) || typeof user.data?.login !== 'string') {
    return { error: apiError(user, 'The connected GitHub account could not be verified.') };
  }

  const response = await githubRequest(token, root);
  const data = response.data;
  const canonical = typeof data?.full_name === 'string' ? data.full_name : '';
  const parts = canonical.split('/');
  if (!response.ok || canonical.toLowerCase() !== `${input.owner}/${input.repo}`.toLowerCase()
    || parts.length !== 2 || !validRepoPart(parts[0]) || !validRepoPart(parts[1])
    || !data?.permissions || data.permissions.push !== true) {
    return { error: error('The connected GitHub account does not have push permission for this repository.', 403) };
  }

  const defaultBranch = data.default_branch;
  if (typeof defaultBranch !== 'string' || !defaultBranch || defaultBranch.length > 240
    || defaultBranch.split('/').some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]{1,100}$/.test(part))) {
    return { error: error('GitHub returned an invalid repository default branch.', 502) };
  }
  const branch = `honmaru/apps/${input.appId}/draft`;
  if (branch === defaultBranch) return { error: error('The generated draft branch cannot be the repository default branch.', 409) };
  return {
    binding: {
      owner: parts[0],
      repo: parts[1],
      appId: input.appId,
      entryPath: input.entryPath || 'index.html',
      repository: canonical,
      defaultBranch,
      branch,
      path: `${branch}/${input.entryPath || 'index.html'}`,
    },
  };
}

/**
 * Write a static app draft to the caller's GitHub repository. The only network
 * destination is GitHub's fixed API, and the generated ref/path cannot target
 * the repository's default branch or an arbitrary location.
 */
export async function writeGitHubAppDraft(sessionToken, input) {
  const token = typeof sessionToken === 'string' && sessionToken.trim() && sessionToken !== 'email-auth' ? sessionToken : null;
  if (!token) return error('Connect a GitHub account before writing an app draft.', 403);
  const normalized = normalizeInput(input);
  if (!normalized) return error('Provide a safe app ID, HTML, and allowlisted local assets.', 400);
  if (normalized.tooLarge) return error('The static app bundle exceeds the size limit.', 413);
  const hasExpectedSha = Object.hasOwn(input, 'expectedSha');
  if (hasExpectedSha && input.expectedSha !== null && !validSha(input.expectedSha)) return error('The expected draft revision is invalid.', 400);

  const { owner, repo, appId, entryPath, htmlBytes, assets, totalBytes } = normalized;
  const resolved = await resolveBinding(token, { owner, repo, appId, entryPath });
  if (resolved.error) return resolved.error;
  const binding = resolved.binding;
  const { branch, path: htmlPath, repository: canonical, defaultBranch } = binding;
  const basePath = branch;
  const root = repoRoot(binding.owner, binding.repo);

  const defaultRef = await resolveRef(token, root, defaultBranch);
  if (!defaultRef.ok || !validSha(defaultRef.data?.object?.sha)) return apiError(defaultRef, 'The repository default branch could not be read.');
  const defaultSha = defaultRef.data.object.sha.toLowerCase();
  const defaultCommit = await githubRequest(token, `${root}/git/commits/${encodeURIComponent(defaultSha)}`);
  if (!defaultCommit.ok || String(defaultCommit.data?.sha || '').toLowerCase() !== defaultSha || !validSha(defaultCommit.data?.tree?.sha)) return apiError(defaultCommit, 'The repository default branch commit could not be read.');

  const currentDraft = await resolveRef(token, root, branch);
  const draftExists = currentDraft.ok;
  if (!draftExists && currentDraft.status !== 404) return apiError(currentDraft);
  const parentSha = draftExists ? currentDraft.data?.object?.sha : defaultSha;
  if (!validSha(parentSha) || (draftExists && branch === defaultBranch)) return error('The generated draft branch is invalid.', 409);
  if (hasExpectedSha && (input.expectedSha === null ? draftExists : !draftExists || String(parentSha).toLowerCase() !== input.expectedSha.toLowerCase())) {
    return error('The draft branch changed. Reload the current draft before publishing again.', 409);
  }

  const files = [{ path: htmlPath, bytes: htmlBytes }, ...assets.map(asset => ({ path: `${basePath}/${asset.path}`, bytes: asset.bytes }))];
  let baseTreeSha = defaultCommit.data.tree.sha;
  if (draftExists) {
    const draftCommit = await githubRequest(token, `${root}/git/commits/${encodeURIComponent(parentSha)}`);
    if (!draftCommit.ok || String(draftCommit.data?.sha || '').toLowerCase() !== String(parentSha).toLowerCase() || !validSha(draftCommit.data?.tree?.sha)) {
      return apiError(draftCommit, 'The existing generated draft tree could not be read.');
    }
    baseTreeSha = draftCommit.data.tree.sha;
  }
  const tree = [];
  for (const file of files) {
    const blob = await githubRequest(token, `${root}/git/blobs`, 'POST', { content: base64FromBytes(file.bytes), encoding: 'base64' });
    if (!blob.ok || !validSha(blob.data?.sha)) return apiError(blob, 'A static app file could not be stored in GitHub.');
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.data.sha });
  }

  const createdTree = await githubRequest(token, `${root}/git/trees`, 'POST', { base_tree: baseTreeSha, tree });
  if (!createdTree.ok || !validSha(createdTree.data?.sha)) return apiError(createdTree, 'The static app draft tree could not be created.');
  const commit = await githubRequest(token, `${root}/git/commits`, 'POST', {
    message: `Update Honmaru app draft ${appId}`,
    tree: createdTree.data.sha,
    parents: [parentSha],
  });
  if (!commit.ok || !validSha(commit.data?.sha)) return apiError(commit, 'The static app draft commit could not be created.');

  const latestDefaultRef = await resolveRef(token, root, defaultBranch);
  if (!latestDefaultRef.ok || String(latestDefaultRef.data?.object?.sha || '').toLowerCase() !== defaultSha) return error('The repository default branch moved during draft publishing. Reload and try again.', 409);
  const latestRepository = await githubRequest(token, root);
  if (!latestRepository.ok || latestRepository.data?.permissions?.push !== true) return error('The connected GitHub account no longer has push permission for this repository.', 403);
  if (String(latestRepository.data?.full_name || '').toLowerCase() !== canonical.toLowerCase()
    || latestRepository.data?.default_branch !== defaultBranch
    || latestRepository.data?.default_branch === branch) {
    return error('The repository default branch changed during draft publishing. Reload and try again.', 409);
  }

  const result = draftExists
    ? await githubRequest(token, `${root}/git/refs/heads/${branchPath(branch)}`, 'PATCH', { sha: commit.data.sha, force: false })
    : await githubRequest(token, `${root}/git/refs`, 'POST', { ref: `refs/heads/${branch}`, sha: commit.data.sha });
  if (!result.ok) return apiError(result, 'GitHub did not accept the draft branch update.');

  return {
    ok: true,
    ...binding,
    commitSha: commit.data.sha.toLowerCase(),
    assetCount: assets.length,
    totalBytes,
  };
}

/** Verify repository ownership and push permission without creating Git data or refs. */
export async function inspectGitHubAppDraftRepository(sessionToken, input) {
  const token = typeof sessionToken === 'string' && sessionToken.trim() && sessionToken !== 'email-auth' ? sessionToken : null;
  if (!token) return error('Connect a GitHub account before selecting a repository.', 403);
  const normalized = normalizedBindingInput(input);
  if (!normalized) return error('Choose a repository and a safe app ID.', 400);
  const resolved = await resolveBinding(token, normalized);
  if (resolved.error) return resolved.error;
  const response = await resolveRef(token, repoRoot(resolved.binding.owner, resolved.binding.repo), resolved.binding.branch);
  if (!response.ok && response.status !== 404) return apiError(response, 'The existing generated draft branch could not be checked.');
  const currentDraftSha = response.ok ? String(response.data?.object?.sha || '').toLowerCase() : null;
  if (currentDraftSha !== null && !validSha(currentDraftSha)) return error('GitHub returned an invalid draft branch revision.', 502);
  return { ok: true, ...resolved.binding, currentDraftSha };
}
