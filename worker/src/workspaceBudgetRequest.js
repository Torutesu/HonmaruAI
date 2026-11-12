import { reserveWorkspaceAIBudgetCall, releaseWorkspaceAIBudgetReservation } from "./workspaceAIBudget.js";
import { webSearchCostMicros } from "./ledger.js";

// Responses web search is billed per built-in tool call as well as for the
// model tokens it adds. Keep deployment-key searches bounded so the shared
// pause budget can reserve a known upper count before dispatch.
const MAX_BUDGETED_WEB_SEARCH_CALLS = 4;
// Search-result input is not present in the request body. This deliberately
// conservative token allowance is a rolling-budget estimate, not a quote.
const WEB_SEARCH_CONTEXT_TOKENS_PER_CALL = 16_000;

const estimateTokens = (value) => {
  const serialized = typeof value === "string" ? value : JSON.stringify(value ?? "");
  // No tokenizer ships with the Worker. One input token per UTF-8 byte is a
  // conservative upper bound for byte-level tokenizers and avoids charging a
  // short JSON/CJK request as if it were ordinary English prose.
  return Math.max(1, new TextEncoder().encode(serialized).length);
};

/// Deployment-key request path used by direct provider routes. A reservation
/// is made before the provider sees the prompt; existing route code still
/// records purpose/tokens with noteUsage and settles it with settleUsage.
export async function requestWithWorkspaceBudget(provider, input, init = {}) {
  const db = provider?.workspaceBudgetDb;
  const orgId = provider?.workspaceBudgetOrgId;
  if (!provider || !db || !orgId) return fetch(input, init);

  provider.workspaceBudgetRequest = true;
  const parsedBody = typeof init.body === "string" ? (() => { try { return JSON.parse(init.body); } catch { return null; } })() : null;
  const body = parsedBody;
  let requestInit = init;
  const searchTools = Array.isArray(body?.tools) ? body.tools.filter((tool) => tool?.type === "web_search" || tool?.type === "web_search_preview") : [];
  const hasWebSearch = searchTools.length > 0;
  const searchToolType = searchTools.some((tool) => tool.type === 'web_search_preview') ? 'web_search_preview' : 'web_search';
  const searchCalls = hasWebSearch && !provider.byok ? (() => {
    const requested = body.max_tool_calls;
    return Number.isSafeInteger(requested) && requested > 0
      ? Math.min(requested, MAX_BUDGETED_WEB_SEARCH_CALLS)
      : MAX_BUDGETED_WEB_SEARCH_CALLS;
  })() : 0;
  const previousId = typeof body?.previous_response_id === "string" && body.previous_response_id;
  const previousContextTokens = previousId
    ? Math.max(0, Number(provider.workspaceBudgetContextTokens) || 48_000)
    : 0;
  const searchContextTokens = searchCalls * WEB_SEARCH_CONTEXT_TOKENS_PER_CALL;
  const inputTokens = body ? estimateTokens(body) + previousContextTokens + searchContextTokens : null;
  const rawOutputTokens = body?.max_tokens ?? body?.max_completion_tokens ?? body?.max_output_tokens;
  const outputTokens = Number(rawOutputTokens);
  const reservation = provider.byok ? { allowed: true, reservationId: null }
    : await reserveWorkspaceAIBudgetCall(db, {
      orgId,
      model: body?.model || provider.model,
      inputTokens,
      outputTokens: rawOutputTokens !== undefined && rawOutputTokens !== null
        && Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? outputTokens : 2048,
      additionalMicros: hasWebSearch && !provider.byok
        ? webSearchCostMicros(body?.model || provider.model, searchCalls, searchToolType)
        : 0,
    });

  if (!reservation.allowed) {
    const status = reservation.reason === "workspace_ai_budget_unavailable" ? 503 : 429;
    return new Response(JSON.stringify({
      error: reservation.reason,
      message: reservation.reason === "workspace_ai_budget_unavailable"
        ? "The workspace AI usage limit could not be checked. Try again shortly."
        : "The workspace's estimated AI usage limit has been reached.",
      ...(reservation.budget ? { budget: reservation.budget } : {}),
    }), { status, headers: { "content-type": "application/json" } });
  }

  const reservationId = reservation.reservationId || null;
  // Do not constrain uncapped or BYOK research. When the pause budget is
  // active, this also makes the reserved search-call upper bound real at the
  // provider boundary; max_tool_calls applies to built-in tools only.
  if (reservationId && hasWebSearch && !provider.byok) {
    requestInit = { ...init, body: JSON.stringify({ ...body, max_tool_calls: searchCalls }) };
  }
  try {
    const response = await fetch(input, requestInit);
    if (!response.ok) {
      // Explicit validation/auth rejections cannot be billed. Timeouts,
      // throttling and server errors may have been accepted upstream; keep
      // their reservation so expiry moves it to unknown instead of free.
      if (reservationId && response.status !== 408 && response.status !== 429 && response.status < 500) {
        await releaseWorkspaceAIBudgetReservation(db, reservationId);
      }
      return response;
    }
    if (response.ok && typeof response.json === "function") {
      const parse = response.json.bind(response);
      Object.defineProperty(response, "json", { configurable: true, value: async () => {
        const data = await parse();
        if (hasWebSearch && data && typeof data === 'object') {
          Object.defineProperty(data, '__honmaruWebSearchToolType', { value: searchToolType, configurable: true });
        }
        if (reservationId && data && typeof data === "object") {
          Object.defineProperty(data, "__honmaruWorkspaceReservationId", { value: reservationId, configurable: true });
        }
        if (typeof data?.id === "string" && data.id && body) {
          const usage = data.usage || {};
          const reportedInput = Number(usage.input_tokens ?? usage.prompt_tokens);
          const reportedOutput = Number(usage.output_tokens ?? usage.completion_tokens);
          const outputEstimate = Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? outputTokens : 2048;
          const contextEstimate = previousContextTokens + estimateTokens(body) + searchContextTokens +
            (Number.isFinite(reportedOutput) && reportedOutput >= 0 ? reportedOutput : outputEstimate);
          provider.workspaceBudgetContextTokens = Math.max(
            Number(provider.workspaceBudgetContextTokens) || 0,
            Number.isFinite(reportedInput) && reportedInput >= 0 ? reportedInput : 0,
            contextEstimate,
          );
        }
        return data;
      } });
    }
    return response;
  } catch (error) {
    // A thrown fetch may be a lost response after the provider accepted it.
    // Leave the hold to expire into unknown usage and block another paid call.
    throw error;
  }
}
