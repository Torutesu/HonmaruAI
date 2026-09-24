// The only place that speaks Composio's HTTP API.
const BASE = "https://backend.composio.dev/api/v3";
// A tool execution can legitimately walk an inbox; the cap is on hanging,
// not on work — a stuck upstream must not hold the request forever.
const UPSTREAM_TIMEOUT_MS = 30_000;

export async function executeTool(apiKey, slug, userId, args) {
  const res = await fetch(`${BASE}/tools/execute/${slug}`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ user_id: userId, arguments: args }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Composio ${slug} ${res.status}: ${body.slice(0, 200)}`);
  }
  const payload = await res.json();
  if (payload && payload.successful === false) {
    throw new Error(`Composio ${slug} failed: ${String(payload.error).slice(0, 200)}`);
  }
  return payload;
}

export async function createConnectLink(apiKey, userId, authConfigId) {
  const res = await fetch(`${BASE}/connected_accounts/link`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ user_id: userId, auth_config_id: authConfigId }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Composio link ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function listConnectedAccounts(apiKey, userId) {
  const res = await fetch(`${BASE}/connected_accounts?user_ids=${encodeURIComponent(userId)}`, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Composio accounts ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return body.items || body.data || [];
}

/// An auth config for a toolkit on Composio's own OAuth credentials — the
/// thing a connect link needs, made once per deployment for the tools that
/// ship without one. Returns the new config's id.
export async function createManagedAuthConfig(apiKey, toolkitSlug, name) {
  const res = await fetch(`${BASE}/auth_configs`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ toolkit: { slug: toolkitSlug }, auth_config: { type: "use_composio_managed_auth", name } }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Composio auth config ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return body?.auth_config?.id || body?.id || null;
}
