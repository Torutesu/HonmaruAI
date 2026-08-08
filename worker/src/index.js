import { routeInstruction } from "./routing.js";
import { toolManifest } from "./agui/tools.js";

function providerConfig(env) {
  if (env.OPENAI_API_KEY) {
    return {
      providerName: "OpenAI",
      endpoint: "https://api.openai.com/v1/chat/completions",
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || "gpt-4o-mini",
    };
  }
  if (env.OPENROUTER_API_KEY) {
    return {
      providerName: "OpenRouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL || "inclusionai/ling-3.0-flash:free",
      appName: "TikTok for Work",
      appUrl: "https://tiktokforwork.dev",
    };
  }
  return undefined; // keyword fallback
}

export class OrgRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    return new Response("relay stub", { status: 200 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        ok: true,
        orgId: "core-team",
        githubOAuth: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
        aiRouting: Boolean(env.OPENAI_API_KEY),
        aiModel: env.OPENAI_MODEL || "gpt-4o-mini",
      });
    }
    if (url.pathname === "/agui/tools" && request.method === "GET") {
      return json(toolManifest());
    }
    if (url.pathname === "/ai/route" && request.method === "POST") {
      const body = await request.json();
      const result = await routeInstruction({
        text: body.text,
        sender: body.sender,
        organization: body.organization,
        priorityOverride: body.priorityOverride,
        readerLanguage: body.readerLanguage,
        openRouter: providerConfig(env),
      });
      return json(result);
    }
    return new Response("not found", { status: 404 });
  },
};

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
