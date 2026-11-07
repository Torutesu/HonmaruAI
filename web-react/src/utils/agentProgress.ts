export type AgentProgress = {
  kind: 'reply'|'thinking'|'tool'|'plan'
  title: string
  status?: 'pending'|'in_progress'|'completed'|'failed'
  steps?: Array<{title:string;status:'pending'|'in_progress'|'completed'}>
}

export function agentProgressLabel(activity:AgentProgress|undefined,name:string):{key:string;values:Record<string,string|number>} {
  if(!activity)return {key:'{name} is writing…',values:{name}}
  if(activity.kind==='tool') {
    const key=activity.status==='completed'?'Finished {tool}':activity.status==='failed'?'Could not finish {tool}':activity.status==='pending'?'Starting {tool}':'Using {tool}'
    return {key,values:{tool:activity.title}}
  }
  if(activity.kind==='plan')return {key:'Working through a plan',values:{}}
  if(activity.kind==='thinking')return {key:'Thinking…',values:{}}
  return {key:'Writing a reply…',values:{}}
}
