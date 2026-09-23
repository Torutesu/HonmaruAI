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
export function noteUsage(provider, purpose, data) {
  if (!provider || !Array.isArray(provider.usage)) return;
  const u = data?.usage || {};
  const input = Number(u.prompt_tokens ?? u.input_tokens) || 0;
  const output = Number(u.completion_tokens ?? u.output_tokens) || 0;
  const model = data?.model || provider.model || "unknown";
  provider.usage.push({ purpose, provider: provider.providerName || "OpenAI", model, input, output, usd: costOf(model, { input, output }) });
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
export async function settleUsage(db, provider, { orgId, githubId, byok = false } = {}, extra = []) {
  const entries = [...(Array.isArray(provider?.usage) ? provider.usage.splice(0) : []), ...extra.filter(Boolean)];
  if (!db || !orgId || entries.length === 0) return 0;
  const now = new Date().toISOString();
  try {
    const stmt = db.prepare(
      `INSERT INTO ai_calls (org_id, user_github_id, purpose, provider, model, input_tokens, output_tokens, usd, byok, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
    );
    await db.batch(entries.map((e) => stmt.bind(
      orgId, githubId ? String(githubId) : null, e.purpose, e.provider, e.model,
      e.input, e.output, e.usd, byok || e.byok ? 1 : 0, now,
    )));
  } catch (err) {
    console.error("ai ledger write failed", err?.message || err);
  }
  return entries.length;
}

/// The team's AI spend since a date: totals, by purpose, by provider, and
/// how much of the routing System One settled without a language model.
export async function aiSpend(db, orgId, since) {
  const { results } = await db
    .prepare(
      `SELECT purpose, provider, byok, COUNT(*) AS calls,
              SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(usd) AS usd
         FROM ai_calls WHERE org_id = ?1 AND created_at >= ?2
        GROUP BY purpose, provider, byok`
    )
    .bind(orgId, since)
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
    // Of the routing decisions that cost anything, the share System One
    // took without a language model. Null until there was any routing.
    jevShare: jevRoutes + llmRoutes ? round(jevRoutes / (jevRoutes + llmRoutes)) : null,
  };
}
