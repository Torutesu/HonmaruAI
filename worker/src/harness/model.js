// One way for the harness to ask the model something, paid for like every
// other call: from the asker's allowance, noted in the ledger. Returns null
// where there is no model or no allowance left — every caller has a
// model-free path.

import { completeWithTools } from "./modelToolLoop.js";
import { providerFor } from "../orgAI.js";
import { allowanceFor } from "../gate.js";
import { noteUsage, settleUsage } from "../ledger.js";

export async function completer(env, orgId, githubId, purpose, { maxTokens = 900, json = true, timeoutMs = 30000 } = {}) {
  const provider = await providerFor(env, orgId).catch(() => null);
  if (!provider) return null;
  const allowance = await allowanceFor(env, orgId, { githubId: String(githubId) });
  if (!allowance.allowed) return null;
  return async (system, user, { tools = {}, fallbackSystem = system, authorize = null, recordUsage = null, requireTool = false, requiredToolNames = [] } = {}) => {
    let consumed = false;
    try {
      return await completeWithTools({provider, system, user, tools, fallbackSystem, maxTokens, json, timeoutMs, authorize, requireTool, requiredToolNames,
        onUsage: async data => {
          noteUsage(provider, purpose, data);
          if (!consumed && allowance.metered) { await allowance.consume(); consumed = true; }
          if (recordUsage) await recordUsage(data, {model:provider.model,provider:provider.providerName || "OpenAI",byok:Boolean(provider.byok)});
        },
      });
    } finally {
      // A call that failed gives its place in the day back (gate.js).
      await allowance.release().catch(() => {});
      await settleUsage(env.DB, provider, { orgId, githubId: String(githubId) });
    }
  };
}
