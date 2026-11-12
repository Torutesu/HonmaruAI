// One way for the harness to ask the model something, paid for like every
// other call: from the asker's allowance, noted in the ledger. Returns null
// where there is no model or no allowance left — every caller has a
// model-free path.

import { completeWithTools } from "./modelToolLoop.js";
import { providerFor } from "../orgAI.js";
import { allowanceFor } from "../gate.js";
import { noteUsage, settleUsage } from "../ledger.js";
import { releaseWorkflowBudgetReservation, reserveWorkflowBudgetCall } from "./workflowUsage.js";

export async function completer(env, orgId, githubId, purpose, { maxTokens = 900, json = true, timeoutMs = 30000, usageContext = null, budgetContext = null, credentialSource } = {}) {
  const provider = await providerFor(env, orgId, undefined, {credentialSource}).catch(() => null);
  if (!provider) return null;
  const allowance = await allowanceFor(env, orgId, { githubId: String(githubId), credentialSource });
  if (!allowance.allowed) return null;
  let released = false;
  const release = async () => { if (!released) { released = true; await allowance.release().catch(() => {}); } };
  const complete = async (system, user, { tools = {}, fallbackSystem = system, authorize = null, recordUsage = null, requireTool = false, requiredToolNames = [] } = {}) => {
    let consumed = false;
    try {
      return await completeWithTools({provider, system, user, tools, fallbackSystem, maxTokens, json, timeoutMs, authorize, requireTool, requiredToolNames,
        beforeRequest:budgetContext?({model,inputTokens,outputTokens})=>reserveWorkflowBudgetCall(env.DB,{orgId,workflowId:usageContext?.workflowId,runId:budgetContext.runId,stepNumber:budgetContext.stepNumber,model,inputTokens,outputTokens,provider:provider.providerName||'OpenAI',byok:Boolean(provider.byok)}):null,
        onReservationDenied:reason=>budgetContext?.onDenied?.(reason),
        releaseReservation:id=>releaseWorkflowBudgetReservation(env.DB,id),
        onUsage: async (data,reservationId) => {
          noteUsage(provider, purpose, data, usageContext);
          if (!consumed && allowance.metered) { await allowance.consume(); consumed = true; }
          if (recordUsage) await recordUsage(data, {model:provider.model,provider:provider.providerName || "OpenAI",byok:Boolean(provider.byok),reservationId});
        },
        onInterrupted: recordUsage ? async reservationId => {
          // The provider may already have accepted the request. Count the
          // attempt against the local allowance and preserve unknown usage
          // for workflow budget safety instead of recording it as free.
          if (!consumed && allowance.metered) { await allowance.consume(); consumed = true; }
          if (recordUsage) await recordUsage({ model: provider.model, usage: {} }, {model:provider.model,provider:provider.providerName || "OpenAI",byok:Boolean(provider.byok),reservationId});
        } : null,
      });
    } finally {
      // A call that failed gives its place in the day back (gate.js).
      await release();
      await settleUsage(env.DB, provider, { orgId, githubId: String(githubId), ...(usageContext || {}) });
    }
  };
  complete.dispose = release;
  return complete;
}
