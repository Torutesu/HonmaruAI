// The only place that speaks Composio's HTTP API.
const BASE = "https://backend.composio.dev/api/v3";

export async function executeTool(apiKey, slug, userId, args) {
  const res = await fetch(`${BASE}/tools/execute/${slug}`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ user_id: userId, arguments: args }),
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
    signal: AbortSignal.timeout(30_000),
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ user_id: userId, auth_config_id: authConfigId }),
  });
  if (!res.ok) throw new Error(`Composio link ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function listConnectedAccounts(apiKey, userId) {
  const res = await fetch(`${BASE}/connected_accounts?user_ids=${encodeURIComponent(userId)}`, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Composio accounts ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return body.items || body.data || [];
}
