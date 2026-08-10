// The only place that speaks Composio's HTTP API.
const BASE = "https://backend.composio.dev/api/v3";

export async function executeTool(apiKey, slug, userId, args) {
  const res = await fetch(`${BASE}/tools/execute/${slug}`, {
    method: "POST",
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
