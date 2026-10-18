// One way for the harness to ask the model something, paid for like every
// other call: from the asker's allowance, noted in the ledger. Returns null
// where there is no model or no allowance left — every caller has a
// model-free path.

import { providerFor } from "../orgAI.js";
import { allowanceFor } from "../gate.js";
import { noteUsage, settleUsage } from "../ledger.js";

export async function completer(env, orgId, githubId, purpose, { maxTokens = 900, json = true } = {}) {
  const provider = await providerFor(env, orgId).catch(() => null);
  if (!provider) return null;
  const allowance = await allowanceFor(env, orgId, { githubId: String(githubId) });
  if (!allowance.allowed) return null;
  return async (system, user) => {
    try {
      const res = await fetch(provider.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: provider.model, temperature: 0.2, max_tokens: maxTokens,
          ...(json ? { response_format: { type: "json_object" } } : {}),
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      noteUsage(provider, purpose, data);
      if (allowance.metered) await allowance.consume();
      return data?.choices?.[0]?.message?.content ?? null;
    } finally {
      // A call that failed gives its place in the day back (gate.js).
      await allowance.release().catch(() => {});
      await settleUsage(env.DB, provider, { orgId, githubId: String(githubId) });
    }
  };
}
