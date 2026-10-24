import {parseRoute,hashForWorkflow} from './route'
// Recognize only the canonical in-app workflow link, not arbitrary relative
// URLs or external hosts. The destination still checks workspace/resource ACLs.
export function parseWorkflowLink(text:string):{id:string;orgId:string;label:string;href:string}|null{
 const match=/^\[((?:\\.|[^\]\\\n]){1,240})\]\((#\/workflows\/[\w%-]{1,240}\/[\w%.-]{1,600})\)$/.exec(text)
 if(!match)return null
 const route=parseRoute(match[2])
 if(!route.workflowId||!route.workflowOrg)return null
 return {id:route.workflowId,orgId:route.workflowOrg,label:match[1].replace(/\\(.)/g,'$1'),href:hashForWorkflow(route.workflowId,route.workflowOrg)}
}
