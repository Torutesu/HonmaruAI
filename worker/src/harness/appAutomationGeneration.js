import {workflowFromPrompt} from './workflowGeneration.js';
import {normalizeAppAutomations} from './appAutomationDefinition.js';

// Generation proposes one disabled declaration. No draft, workflow, secret
// or release is written until the editor explicitly saves/publishes it.
export async function appAutomationFromPrompt(db,orgId,by,options) {
 const result=await workflowFromPrompt(db,orgId,by,options);
 if(result.error)return result;
 const normalized=normalizeAppAutomations({version:1,items:[{...result.workflow,key:`auto_${crypto.randomUUID().replaceAll('-','').slice(0,16)}`,enabled:false}]});
 if(normalized.error)return normalized;
 return {automation:normalized.automations.items[0],source:'model'};
}
