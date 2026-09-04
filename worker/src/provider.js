/// Which model to call, and with what key.
///
/// This existed twice — once in the HTTP router, once in the cron — and the
/// copies had already drifted: only one of them sent OpenRouter the attribution
/// headers it asks for. A third caller was about to make it three.
///
/// A user's own key is never stored on our side. It arrives on the request and
/// is used for that request only, so it is passed in rather than read here.
/// Never log it.
export function providerConfig(env, userKey) {
  const openaiKey = userKey || env.OPENAI_API_KEY;
  if (openaiKey) {
    return {
      providerName: "OpenAI",
      endpoint: "https://api.openai.com/v1/chat/completions",
      apiKey: openaiKey,
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
  return undefined;
}
