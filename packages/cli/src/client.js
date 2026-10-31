const TOKEN_RE = /^hm_[0-9a-f]{64}$/;

export function mcpEndpoint(apiUrl) {
  if (typeof apiUrl !== "string" || !apiUrl.trim()) {
    throw new Error("Set HONMARU_API_URL to your Honmaru API origin.");
  }

  let base;
  try {
    base = new URL(apiUrl);
  } catch {
    throw new Error("HONMARU_API_URL must be a valid HTTPS URL.");
  }

  const localHttp = base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !localHttp) || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("Use an HTTPS origin without credentials, path, query, or fragment (HTTP is allowed only on localhost).");
  }
  return new URL("/mcp", base);
}

function responseMessage(response) {
  if (response.status === 401) return "The token is invalid, expired, revoked, or no longer has workspace access.";
  if (response.status === 403) return "The workspace policy denied this token. Check its scopes and sign-in requirements.";
  if (response.status === 429) return "The workspace rate limit was reached. Try again later.";
  return `Honmaru API returned HTTP ${response.status}.`;
}

export function createMcpClient({ apiUrl, token, fetcher = fetch, timeoutMs = 15_000 }) {
  const endpoint = mcpEndpoint(apiUrl);
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    throw new Error("Set HONMARU_API_TOKEN to an active Honmaru agent token (hm_ followed by 64 hexadecimal characters).");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("timeoutMs must be an integer between 1 and 120000.");
  }

  let requestId = 0;
  async function request(method, params) {
    let response;
    try {
      response = await fetcher(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, ...(params ? { params } : {}) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new Error(`The request timed out after ${timeoutMs} ms.`);
      }
      throw new Error("Could not reach the Honmaru API. Check HONMARU_API_URL and your network connection.");
    }

    if (!response.ok) throw new Error(responseMessage(response));
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Honmaru returned an unreadable response.");
    }
    if (!payload || payload.jsonrpc !== "2.0" || payload.id !== requestId) {
      throw new Error("Honmaru returned an invalid JSON-RPC response.");
    }
    if (payload.error) {
      throw new Error(`Honmaru MCP error ${payload.error.code}: ${payload.error.message || "Request failed."}`);
    }
    if (!payload.result || typeof payload.result !== "object") {
      throw new Error("Honmaru returned an empty MCP result.");
    }
    if (payload.result.isError) {
      const detail = payload.result.content?.find((item) => item.type === "text")?.text;
      throw new Error(detail || "The workspace tool failed.");
    }
    return payload.result;
  }

  return {
    listTools: async () => {
      const result = await request("tools/list");
      if (!Array.isArray(result.tools)) throw new Error("Honmaru returned an invalid tool list.");
      return result.tools;
    },
    callTool: async (name, args = {}) => {
      if (typeof name !== "string" || !name.trim()) throw new Error("A tool name is required.");
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be a JSON object.");
      return request("tools/call", { name: name.trim(), arguments: args });
    },
  };
}
