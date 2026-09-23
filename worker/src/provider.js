// Which model answers, and where. One answer for every caller: the router,
// the triage, the scheduled sync and the card localizer used to each keep a
// copy of this, and two copies of a config is one that is wrong.
//
// A user's own key is never stored on our side — it arrives per request and is
// used for that request only. Never log it.
export function providerConfig(env, userKey) {
  const openaiKey = userKey || env.OPENAI_API_KEY;
  if (openaiKey) {
    return {
      providerName: "OpenAI",
      endpoint: "https://api.openai.com/v1/chat/completions",
      apiKey: openaiKey,
      // The default is the cheapest model that still calls tools reliably.
      // OPENAI_MODEL swaps it per deployment: gpt-4.1-nano is a third of the
      // price and fine for triage and translation; gpt-4.1-mini writes
      // better cards at nearly three times the cost. Prices in ledger.js.
      model: env.OPENAI_MODEL || "gpt-4o-mini",
      // Whose bill: their key, their money. The ledger records it either way.
      byok: Boolean(userKey),
      // Every call made with this provider notes its tokens here (ledger.js);
      // the route that owns the request settles them into ai_calls.
      usage: [],
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
      byok: false,
      usage: [],
    };
  }
  return undefined;
}
