// What the AI costs, call by call.
//
// The daily allowance counts calls; nothing counted tokens, and tokens are
// what the bill is. Every model call the Worker makes notes its usage on
// the provider it was made with, and the route that owns the request
// settles those notes into `ai_calls` — org, purpose, model, tokens, and
// the dollars at list price. Insights reads it back, so "what does the AI
// cost this team" is a number on a screen and not a guess from a bill.

/// List prices, USD per million tokens, input then output. Unknown models
/// fall back to the cheapest tier we run, so a new model name never makes
/// the ledger claim zero.
export const PRICES = {
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4o": [2.5, 10],
  "gpt-4.1-mini": [0.4, 1.6],
  "gpt-4.1-nano": [0.1, 0.4],
  "gpt-4.1": [2, 8],
  "gpt-5-mini": [0.25, 2],
  "gpt-5-nano": [0.05, 0.4],
  "jev-latest": [0.042, 0],
};
const DEFAULT_PRICE = [0.15, 0.6];

export function priceOf(model) {
  const key = String(model || "").toLowerCase();
  if (PRICES[key]) return PRICES[key];
  const family = Object.keys(PRICES).find((k) => key.startsWith(k));
  return family ? PRICES[family] : DEFAULT_PRICE;
}

/// Dollars for one call. Jev's output is free; OpenAI's is not.
export function costOf(model, { input = 0, output = 0 } = {}) {
  const [inPrice, outPrice] = priceOf(model);
  return (Number(input) || 0) * inPrice / 1e6 + (Number(output) || 0) * outPrice / 1e6;
}

/// Note a chat-completions answer on the provider it came from. Providers
/// made by `providerConfig` carry a `usage` list; anything else is ignored,
/// so a test's bare `{ endpoint, apiKey, model }` still works.
export function noteUsage(provider, purpose, data, context = null) {
  if (!provider || !Array.isArray(provider.usage)) return;
  const u = data?.usage || {};
  const input = Number(u.prompt_tokens ?? u.input_tokens) || 0;
  const output = Number(u.completion_tokens ?? u.output_tokens) || 0;
  const model = data?.model || provider.model || "unknown";
  provider.usage.push({ purpose, provider: provider.providerName || "OpenAI", model, input, output, usd: costOf(model, { input, output }), ...(context ? { context } : {}) });
}

/// Searches the model ran with the hosted web search tool, which OpenAI
/// bills per call on top of the tokens: $10 per thousand for a reasoning
/// model, $25 for the others. One entry per response that searched.
export function noteSearches(provider, purpose, model, count, context = null) {
  if (!provider || !Array.isArray(provider.usage) || !(count > 0)) return;
  const each = /^(gpt-5|gpt-6|o\d)/i.test(String(model || "")) ? 0.01 : 0.025;
  provider.usage.push({ purpose, provider: provider.providerName || "OpenAI", model: "web_search", input: 0, output: 0, usd: Math.round(count * each * 1e6) / 1e6, ...(context ? { context } : {}) });
}

/// A System One answer, in the same list.
export function jevEntry(purpose, usage, model = "jev-latest") {
  const input = Number(usage?.input_tokens) || 0;
  const output = Number(usage?.output_tokens) || 0;
  return { purpose, provider: "jev", model, input, output, usd: costOf(model, { input, output }) };
}

/// Write the notes down and clear them. `extra` carries entries that were
/// not made through the provider (System One's). Never throws: a ledger
/// that cannot be written is not a reason to fail the decision it counts.
export async function settleUsage(db, provider, { orgId, githubId, byok = false, roomSlug = null, agentId = null, workflowId = null, appId = null } = {}, extra = [], workspaceReservationId = null) {
  const entries = [...(Array.isArray(provider?.usage) ? provider.usage.splice(0) : []), ...extra.filter(Boolean)];
  if (!db || !orgId || entries.length === 0) return 0;
  // Whose bill: a person's own key (the caller says so) or the workspace's
  // (the provider says so). Either way, not ours.
  byok = byok || Boolean(provider?.byok);
  const now = new Date().toISOString();
  try {
    const stmt = db.prepare(
      `INSERT INTO ai_calls (org_id, user_github_id, purpose, provider, model, input_tokens, output_tokens, usd, byok, created_at, room_slug, agent_id, workflow_id, app_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
    );
    const safeContext = (value, limit) => typeof value === "string" && value.trim() && value.length <= limit ? value.trim() : null;
    const statements = entries.map((e) => {
      const context = e.context || {};
      return stmt.bind(
        orgId, githubId ? String(githubId) : null, e.purpose, e.provider, e.model,
        e.input, e.output, e.usd, byok || e.byok ? 1 : 0, now,
        safeContext(context.roomSlug ?? roomSlug, 200), safeContext(context.agentId ?? agentId, 128),
        safeContext(context.workflowId ?? workflowId, 128), safeContext(context.appId ?? appId, 128),
      );
    });
    if (workspaceReservationId) statements.push(db.prepare(`UPDATE hx_workspace_ai_budget_reservations
      SET status='settled',settled_at=?1 WHERE id=?2 AND org_id=?3 AND status IN ('held','unknown')`)
      .bind(now, workspaceReservationId, orgId));
    await db.batch(statements);
  } catch (err) {
    console.error("ai ledger write failed", err?.message || err);
  }
  return entries.length;
}

/// The team's AI spend since a date: totals, by purpose, by provider, and
/// how much of the routing System One settled without a language model.
export async function aiSpend(db, orgId, since, { dailyDays = 0, now = Date.now(), includeMembers = false, includeAutomations = false, includeRooms = false, includeAgents = false, includeApps = false } = {}) {
  const days = Math.max(0, Math.min(180, Math.floor(Number(dailyDays) || 0)));
  const today = new Date(now);
  const lastDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const firstDay = lastDay - Math.max(0, days - 1) * 86400000;
  const start = days > 0 ? new Date(firstDay).toISOString() : since;
  const end = new Date(now).toISOString();
  const { results } = await db
    .prepare(
      `SELECT purpose, provider, byok, COUNT(*) AS calls,
              SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(usd) AS usd
         FROM ai_calls WHERE org_id = ?1 AND created_at >= ?2 AND created_at <= ?3
        GROUP BY purpose, provider, byok`
    )
    .bind(orgId, start, end)
    .all();
  const rows = results || [];
  const total = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, byokCalls: 0, byokUsd: 0 };
  const byPurpose = new Map();
  const byProvider = new Map();
  let jevRoutes = 0;
  let llmRoutes = 0;
  for (const r of rows) {
    const calls = Number(r.calls) || 0;
    const usd = Number(r.usd) || 0;
    total.calls += calls;
    total.inputTokens += Number(r.input_tokens) || 0;
    total.outputTokens += Number(r.output_tokens) || 0;
    total.usd += usd;
    if (Number(r.byok)) { total.byokCalls += calls; total.byokUsd += usd; }
    const p = byPurpose.get(r.purpose) || { purpose: r.purpose, calls: 0, usd: 0 };
    p.calls += calls; p.usd += usd; byPurpose.set(r.purpose, p);
    const v = byProvider.get(r.provider) || { provider: r.provider, calls: 0, usd: 0 };
    v.calls += calls; v.usd += usd; byProvider.set(r.provider, v);
    if (r.purpose === "route") {
      if (r.provider === "jev") jevRoutes += calls; else llmRoutes += calls;
    }
  }
  const round = (n) => Math.round(n * 1e8) / 1e8;
  let daily = [];
  if (days > 0) {
    // Match the UTC day buckets Kylon shows in its usage chart. Keep empty
    // days so quiet workspaces do not look more active than they were.
    const { results: dayRows } = await db.prepare(
      `SELECT substr(created_at,1,10) AS day, COUNT(*) AS calls,
              SUM(CASE WHEN byok=0 THEN MAX(0,usd) ELSE 0 END) AS our_usd,
              SUM(CASE WHEN byok!=0 THEN MAX(0,usd) ELSE 0 END) AS byok_usd
         FROM ai_calls WHERE org_id=?1 AND created_at>=?2 AND created_at<=?3
        GROUP BY substr(created_at,1,10)`
    ).bind(orgId, start, end).all();
    const byDay = new Map((dayRows || []).map((row) => [row.day, row]));
    daily = Array.from({ length: days }, (_, index) => {
      const day = new Date(firstDay + index * 86400000).toISOString().slice(0, 10);
      const row = byDay.get(day);
      const ourUsd = Number(row?.our_usd) || 0;
      const byokUsd = Number(row?.byok_usd) || 0;
      return { day, calls: Number(row?.calls) || 0, ourUsd: round(ourUsd), byokUsd: round(byokUsd), usd: round(ourUsd + byokUsd) };
    });
  }
  let byMember;
  if (includeMembers) {
    const { results: memberRows } = await db.prepare(
      `SELECT c.user_github_id AS userId,u.login,u.name,
              COUNT(*) AS calls,SUM(c.input_tokens) AS input_tokens,
              SUM(c.output_tokens) AS output_tokens,SUM(MAX(0,c.usd)) AS usd
         FROM ai_calls c LEFT JOIN users u ON u.github_id=c.user_github_id
        WHERE c.org_id=?1 AND c.created_at>=?2 AND c.created_at<=?3 AND c.byok=0
        GROUP BY c.user_github_id
        ORDER BY SUM(MAX(0,c.usd)) DESC,COALESCE(u.login,c.user_github_id,'') COLLATE NOCASE
        LIMIT 500`
    ).bind(orgId, start, end).all();
    byMember = (memberRows || []).map((row) => ({
      userId: row.userId == null ? null : String(row.userId),
      login: row.login || null,
      name: row.name || row.login || null,
      calls: Number(row.calls) || 0,
      inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      usd: round(Number(row.usd) || 0),
    }));
  }
  let byRoom;
  if (includeRooms) {
    const { results: roomRows } = await db.prepare(
      `SELECT c.room_slug AS roomSlug,b.name,
              COUNT(*) AS calls,SUM(c.input_tokens) AS input_tokens,
              SUM(c.output_tokens) AS output_tokens,SUM(MAX(0,c.usd)) AS usd
         FROM ai_calls c LEFT JOIN businesses b ON b.org_id=c.org_id AND b.slug=c.room_slug
        WHERE c.org_id=?1 AND c.created_at>=?2 AND c.created_at<=?3 AND c.byok=0 AND c.room_slug IS NOT NULL
        GROUP BY c.room_slug,b.name
        ORDER BY SUM(MAX(0,c.usd)) DESC,COALESCE(b.name,c.room_slug) COLLATE NOCASE
        LIMIT 500`
    ).bind(orgId, start, end).all();
    byRoom = (roomRows || []).map((row) => ({
      roomSlug: String(row.roomSlug), name: row.name || null,
      calls: Number(row.calls) || 0, inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0, usd: round(Number(row.usd) || 0),
    }));
  }
  let byAgent;
  if (includeAgents) {
    const { results: agentRows } = await db.prepare(
      `SELECT c.agent_id AS agentId,a.name,
              COUNT(*) AS calls,SUM(c.input_tokens) AS input_tokens,
              SUM(c.output_tokens) AS output_tokens,SUM(MAX(0,c.usd)) AS usd
         FROM ai_calls c LEFT JOIN custom_agents a ON a.org_id=c.org_id AND a.id=c.agent_id
        WHERE c.org_id=?1 AND c.created_at>=?2 AND c.created_at<=?3 AND c.byok=0 AND c.agent_id IS NOT NULL
        GROUP BY c.agent_id,a.name
        ORDER BY SUM(MAX(0,c.usd)) DESC,COALESCE(a.name,c.agent_id) COLLATE NOCASE
        LIMIT 500`
    ).bind(orgId, start, end).all();
    byAgent = (agentRows || []).map((row) => ({
      agentId: String(row.agentId), name: row.agentId === "__assistant__" ? "Honmaru AI" : (row.name || null),
      calls: Number(row.calls) || 0, inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0, usd: round(Number(row.usd) || 0),
    }));
  }
  let byApp;
  if (includeApps) {
    const { results: appRows } = await db.prepare(
      `SELECT c.app_id AS appId,a.name,
              COUNT(*) AS calls,SUM(c.input_tokens) AS input_tokens,
              SUM(c.output_tokens) AS output_tokens,SUM(MAX(0,c.usd)) AS usd
         FROM ai_calls c LEFT JOIN hx_apps a ON a.org_id=c.org_id AND a.id=c.app_id
        WHERE c.org_id=?1 AND c.created_at>=?2 AND c.created_at<=?3 AND c.byok=0 AND c.app_id IS NOT NULL
        GROUP BY c.app_id,a.name
        ORDER BY SUM(MAX(0,c.usd)) DESC,COALESCE(a.name,c.app_id) COLLATE NOCASE
        LIMIT 500`
    ).bind(orgId, start, end).all();
    byApp = (appRows || []).map((row) => ({
      appId: String(row.appId), name: row.name || null,
      calls: Number(row.calls) || 0, inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0, usd: round(Number(row.usd) || 0),
    }));
  }
  let byAutomation;
  if (includeAutomations) {
    const { results: automationRows } = await db.prepare(
      `SELECT u.workflow_id AS workflowId,w.name,
              COUNT(*) AS calls,SUM(COALESCE(u.input_tokens,0)) AS input_tokens,
              SUM(COALESCE(u.output_tokens,0)) AS output_tokens,
              SUM(CASE WHEN u.estimated_micros IS NULL THEN 1 ELSE 0 END) AS unpriced_calls,
              SUM(CASE WHEN u.estimated_micros IS NULL THEN 0 ELSE MAX(0,u.estimated_micros) END) AS estimated_micros
         FROM hx_workflow_usage u LEFT JOIN hx_workflows w
           ON w.org_id=u.org_id AND w.id=u.workflow_id
        WHERE u.org_id=?1 AND u.created_at>=?2 AND u.created_at<=?3 AND u.byok=0
        GROUP BY u.workflow_id,w.name
        ORDER BY estimated_micros DESC,COALESCE(w.name,u.workflow_id) COLLATE NOCASE
        LIMIT 500`
    ).bind(orgId, start, end).all();
    byAutomation = (automationRows || []).map((row) => ({
      workflowId: String(row.workflowId),
      name: row.name || null,
      calls: Number(row.calls) || 0,
      inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      unpricedCalls: Number(row.unpriced_calls) || 0,
      usd: round((Number(row.estimated_micros) || 0) / 1_000_000),
    }));
  }
  return {
    calls: total.calls,
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    usd: round(total.usd),
    // What the team paid for on our key, as opposed to on their own.
    ourUsd: round(total.usd - total.byokUsd),
    byokCalls: total.byokCalls,
    byPurpose: [...byPurpose.values()].map((p) => ({ ...p, usd: round(p.usd) })).sort((a, b) => b.usd - a.usd),
    byProvider: [...byProvider.values()].map((p) => ({ ...p, usd: round(p.usd) })).sort((a, b) => b.usd - a.usd),
    ...(days > 0 ? { days, daily } : {}),
    ...(includeMembers ? { byMember } : {}),
    ...(includeRooms ? { byRoom } : {}),
    ...(includeAgents ? { byAgent } : {}),
    ...(includeApps ? { byApp } : {}),
    ...(includeAutomations ? { byAutomation } : {}),
    // Of the routing decisions that cost anything, the share System One
    // took without a language model. Null until there was any routing.
    jevShare: jevRoutes + llmRoutes ? round(jevRoutes / (jevRoutes + llmRoutes)) : null,
  };
}
