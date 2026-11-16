import React, {useEffect, useState} from 'react'
import type {ChannelMessage} from '../types/card'
import {isTemp} from '../utils/pendingSend'
import {useT} from '../utils/i18n'
import {getLocale} from '../utils/locale'
import {formatDate} from '../utils/dateFormat'
import {Icon} from './Icon'
import {AgentRunStop} from './AgentRunStop'
import {AgentAvatar, type AgentLook} from './AgentAvatar'
import {formatElapsedDuration} from '../utils/runDuration'

type Api = {httpBase: string; orgId: string; sessionToken: string}
type AgentFace = AgentLook & {id: string; name: string; handle: string}
type Assignment = {id: string; generation: number; status: string; startedAt?: string; updatedAt?: string; providerStopStatus?: string; canStop?: boolean; agent: AgentFace; hops: {id: string; from: AgentFace; to: AgentFace; at: string}[]}
type HelperRun = {id:string; title:string; status:string; startedAt:string; finishedAt?:string; elapsedMs?:number; result?:{result:string;sources:{title:string;url:string}[]}}
type ExecutionEvent = {type:string;at:number;agent?:string;tool?:string;elapsedMs?:number}
type Run = {rowId: string; status: string; answered: number; version?: number; assignments?: Assignment[]; subagents?:HelperRun[];events?:ExecutionEvent[]}
const activeStatus = (status: string) => ['pending_delivery', 'queued', 'running', 'pending'].includes(status)
const activeRun = (run: Run) => activeStatus(run.status) || Boolean(run.assignments?.some(assignment => activeStatus(assignment.status))) || Boolean(run.subagents?.some(helper=>activeStatus(helper.status)))
const faceValid = (face: AgentFace) => face && typeof face.id === 'string' && typeof face.name === 'string' && typeof face.handle === 'string'
function assignmentsFrom(value: unknown): Assignment[] {
  if (!Array.isArray(value)) return []
  return value.filter(assignment => assignment && typeof assignment.id === 'string' && Number.isSafeInteger(assignment.generation) && assignment.generation >= 0 && assignment.generation <= 8 && ['pending','running','finished','failed','cancelled','interrupted'].includes(assignment.status) && faceValid(assignment.agent)).slice(0, 20).map(assignment => ({...assignment,
    ...(typeof assignment.startedAt==='string'&&assignment.startedAt.length<=64?{startedAt:assignment.startedAt}:{}),
    ...(typeof assignment.updatedAt==='string'&&assignment.updatedAt.length<=64?{updatedAt:assignment.updatedAt}:{}),
    hops: (Array.isArray(assignment.hops) ? assignment.hops : []).filter((hop: Assignment['hops'][number]) => hop && typeof hop.id === 'string' && faceValid(hop.from) && faceValid(hop.to) && typeof hop.at === 'string').slice(0, 8),
  }))
}
function RunFace({agent}: {agent: AgentFace}) {
  const look = {emoji: typeof agent.emoji === 'string' ? agent.emoji : null, avatarUrl: typeof agent.avatarUrl === 'string' ? agent.avatarUrl : null}
  return look.emoji || look.avatarUrl ? <AgentAvatar agent={look} className="slk-run-avatar"/> : <span className="slk-run-avatar" aria-hidden="true"><Icon name="bot" size={14}/></span>
}
function handoffTime(at: string): string {
  const options = {dateStyle: 'medium', timeStyle: 'short'} as const
  try { return formatDate(new Date(at), getLocale(), options) }
  catch { return formatDate(new Date(at), 'en', options) }
}
const labels: Record<string, string> = {
  pending: 'Agent handoff awaiting delivery', pending_delivery: 'Agent queue acknowledgement pending', queued: 'Agent execution queued', running: 'Agent execution running',
  finished: 'Agent processing ended', failed: 'Agent execution failed',
  interrupted: 'Agent execution interrupted; outcome unconfirmed',
  cancelled: 'Agent execution stopped after access changed', no_agents: 'No eligible agent to run',
}
const helperLabels: Record<string,string> = {queued:'Helper waiting',running:'Helper running',completed:'Helper completed',failed:'Helper failed',interrupted:'Helper interrupted'}
const eventLabels:Record<string,string>={run_started:'Run started',agent_started:'{agent} started',tool_started:'{agent} started {tool}',tool_finished:'{tool} completed',tool_failed:'{tool} failed',tool_interrupted:'{tool} interrupted',agent_finished:'{agent} finished',agent_failed:'{agent} failed',agent_cancelled:'{agent} stopped',run_finished:'Run finished',run_failed:'Run failed',run_cancelled:'Run stopped',run_interrupted:'Run interrupted'}
function eventsFrom(value:unknown):ExecutionEvent[]{
  if(!Array.isArray(value))return []
  return value.filter((event):event is ExecutionEvent=>Boolean(event&&typeof event==='object'&&eventLabels[(event as ExecutionEvent).type]&&Number.isSafeInteger((event as ExecutionEvent).at))).slice(-80).map(event=>({...event,agent:typeof event.agent==='string'?event.agent.slice(0,120):undefined,tool:typeof event.tool==='string'?event.tool.slice(0,80):undefined}))
}
function helpersFrom(value:unknown):HelperRun[] {
  if(!Array.isArray(value))return []
  return value.filter((child):child is HelperRun=>Boolean(child&&typeof child==='object'&&typeof child.id==='string'&&typeof child.title==='string'&&helperLabels[(child as HelperRun).status]&&typeof child.startedAt==='string')).slice(0,40).map(child=>({...child,title:child.title.slice(0,120),...(child.result&&typeof child.result.result==='string'?{result:{result:child.result.result.slice(0,2400),sources:Array.isArray(child.result.sources)?child.result.sources.slice(0,5).filter(source=>source&&typeof source.title==='string'&&typeof source.url==='string'&&/^https?:\/\//.test(source.url)).map(source=>({title:source.title.slice(0,120),url:source.url.slice(0,1000)})):[]}}:{})}))
}

function stoppedAssignmentLabel(providerStopStatus?: string): string {
  if (providerStopStatus === 'unsupported') return 'Stopped in Honmaru; provider may still be running'
  if (providerStopStatus && providerStopStatus !== 'no_remote_run') return 'Stopped in Honmaru; provider stop is unconfirmed'
  return 'Agent execution cancelled'
}

export function AgentRunStatus({api, channel, messages}: {api: Api; channel: string; messages: ChannelMessage[]}) {
  const t = useT()
  const sources = [...new Map(messages.filter(m => m.kind === 'message' && !m.deleted && !isTemp(m)).map(m => [m.id, m])).values()].slice(-20)
  const ids = JSON.stringify(sources.map(m => m.id))
  const scope = JSON.stringify([api.httpBase, api.orgId, api.sessionToken, channel, ids])
  const [refresh, setRefresh] = useState(0)
  const [state, setState] = useState<{scope: string; runs: Run[]; unavailable: boolean}>({scope, runs: [], unavailable: false})
  useEffect(() => {
    const rowIds: string[] = JSON.parse(ids)
    if (!rowIds.length) return
    let stopped = false, busy = false, attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    const read = async () => {
      if (stopped || busy || document.visibilityState === 'hidden') return
      clearTimeout(timer)
      busy = true
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 10000)
      const query = new URLSearchParams({orgId: api.orgId, channel})
      rowIds.forEach(id => query.append('messageId', id))
      let again = false
      try {
        const response = await fetch(`${api.httpBase}/channels/agent-runs?${query}`, {headers: {'x-session-token': api.sessionToken}, signal: controller.signal})
        if (!response.ok) throw new Error('unavailable')
        const result = await response.json()
        if (!Array.isArray(result.results)) throw new Error('unavailable')
        const runs: Run[] = result.results.filter((run: Run) => run && rowIds.includes(run.rowId)).map((run: Run) => ({...run, assignments: assignmentsFrom(run.assignments),subagents:helpersFrom(run.subagents),events:eventsFrom(run.events)})).filter((run: Run) => labels[run.status] || run.assignments?.length || run.subagents?.length || run.events?.length)
        if (!stopped) setState({scope, runs, unavailable: result.available === false})
        attempts++
        again = runs.some(activeRun) || (attempts < 3 && (result.available === false || runs.length < rowIds.length))
      } catch {
        if (!stopped) setState({scope, runs: [], unavailable: true})
        again = ++attempts < 3
      } finally {
        clearTimeout(timeout)
        busy = false
        if (!stopped && again) timer = setTimeout(() => void read(), 5000)
      }
    }
    const resume = () => {attempts = 0; void read()}
    void read()
    window.addEventListener('focus', resume)
    window.addEventListener('honmaru:resync', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      stopped = true; clearTimeout(timer); controller?.abort()
      window.removeEventListener('focus', resume)
      window.removeEventListener('honmaru:resync', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [scope, ids, api.httpBase, api.orgId, api.sessionToken, channel, refresh])
  if (state.scope !== scope || (!state.runs.length && !state.unavailable)) return null
  if (state.unavailable && !state.runs.length) return <p className="slk-run-unavailable">{t('Agent execution status unavailable')}</p>
  const active = state.runs.filter(activeRun).length
  return <details className="slk-agent-runs">
    <summary><span className="slk-run-disclosure"><Icon name="chevron-right" size={12}/></span><Icon name="bot" size={14}/>{t('Agent execution')}{active > 0 && <span className="slk-run-active" role="status">{t('{count} active', {count: active})}</span>}</summary>
    {state.unavailable && <p className="slk-run-unavailable" role="status">{t('Some execution status is unavailable. Saved assignment status is shown below.')}</p>}
    <ul>{state.runs.map(run => <li key={run.rowId}>
      <span className="slk-run-source" title={sources.find(m => m.id === run.rowId)?.body}>{sources.find(m => m.id === run.rowId)?.body.slice(0, 100) || t('Message')}</span>
      {!run.assignments?.length && <span>{t(labels[run.status])}</span>}
      {Boolean(run.events?.length) && <ol className="slk-run-timeline" aria-label={t('Execution timeline')}>{run.events!.map((event,index)=><li key={`${event.at}-${index}`} className={`slk-run-event slk-run-event-${event.type}`}><span>{t(eventLabels[event.type],{agent:event.agent||t('Agent'),tool:event.tool||t('tool')})}</span>{Number.isFinite(event.elapsedMs)&&event.elapsedMs!>0&&<span className="slk-run-duration">{t('Execution took {duration}',{duration:formatElapsedDuration(new Date(0).toISOString(),new Date(event.elapsedMs!).toISOString(),getLocale())||`${Math.round(event.elapsedMs!/1000)}s`})}</span>}<time dateTime={new Date(event.at).toISOString()}>{handoffTime(new Date(event.at).toISOString())}</time></li>)}</ol>}
      {Boolean(run.assignments?.length) && <div className="slk-run-assignments">{run.assignments!.map(assignment => <div className="slk-run-assignment" key={assignment.id}>
        <div className="slk-run-assignee"><RunFace agent={assignment.agent}/><span className="slk-run-agent-name" title={`@${assignment.agent.handle}`}>{assignment.agent.name || t('Agent')}</span><span className="slk-run-assignment-status">{t(assignment.status === 'cancelled' ? stoppedAssignmentLabel(assignment.providerStopStatus) : labels[assignment.status])}</span>{assignment.startedAt&&(()=>{const active=activeStatus(assignment.status),endedAt=active?null:assignment.updatedAt||null,duration=(active||endedAt)?formatElapsedDuration(assignment.startedAt,endedAt,getLocale()):null;return duration===null?null:<span className="slk-run-duration">{t(active?'Running for {duration}':'Execution took {duration}',{duration})}</span>})()}</div>
        {assignment.status === 'cancelled' && (() => {
          const outcome = assignment.providerStopStatus
          if (!outcome || outcome === 'no_remote_run') return null
          const message = outcome === 'unsupported' ? 'This provider does not support stop requests. Check the run in its app.' : outcome === 'requested' ? 'Provider cancellation requested' : outcome === 'requesting' || outcome === 'pending' ? 'Provider cancellation is being confirmed' : outcome === 'already_finished' ? 'Provider run already finished' : 'Provider cancellation could not be confirmed'
          return <span className={`slk-run-provider-stop slk-run-provider-stop-${outcome === 'requested' || outcome === 'requesting' || outcome === 'pending' || outcome === 'already_finished' ? 'ok' : 'warning'}`} role={outcome === 'requested' || outcome === 'requesting' || outcome === 'pending' || outcome === 'already_finished' ? 'status' : 'alert'}>{t(message)}</span>
        })()}
        {assignment.canStop === true && activeStatus(assignment.status) && <AgentRunStop key={`${scope}:${assignment.id}:${assignment.generation}`} api={api} channel={channel} rowId={run.rowId} assignmentId={assignment.id} generation={assignment.generation} onStopped={() => setRefresh(value => value + 1)}/>}
        {assignment.status === 'cancelled' && ['failed','partial','unavailable','pending','requesting'].includes(assignment.providerStopStatus || '') && <AgentRunStop key={`${scope}:${assignment.id}:${assignment.generation}:provider-retry`} retry api={api} channel={channel} rowId={run.rowId} assignmentId={assignment.id} generation={assignment.generation} onStopped={() => setRefresh(value => value + 1)}/>}
        {assignment.hops.length > 0 && <details className="slk-run-handoffs"><summary><span className="slk-handoff-disclosure"><Icon name="chevron-right" size={12}/></span>{t('Handoff history ({count})', {count: assignment.hops.length})}</summary><ol>{assignment.hops.map(hop => <li key={hop.id}><span className="slk-run-hop-agents"><span title={`@${hop.from.handle}`}><RunFace agent={hop.from}/>{hop.from.name || t('Agent')}</span><span aria-hidden="true">→</span><span title={`@${hop.to.handle}`}><RunFace agent={hop.to}/>{hop.to.name || t('Agent')}</span></span>{Number.isFinite(Date.parse(hop.at)) && <time dateTime={hop.at}>{handoffTime(hop.at)}</time>}</li>)}</ol></details>}
      </div>)}</div>}
      {Boolean(run.subagents?.length) && <details className="slk-run-subagents"><summary>{t('Private helper runs ({count})',{count:run.subagents!.length})}</summary><ul>{run.subagents!.map(helper=><li key={helper.id}><div className="slk-run-helper-heading"><strong>{helper.title}</strong><span>{t(helperLabels[helper.status])}</span>{helper.finishedAt&&<span className="slk-run-duration">{t('Execution took {duration}',{duration:formatElapsedDuration(helper.startedAt,helper.finishedAt,getLocale())||'—'})}</span>}</div>{helper.result&&<p className="slk-run-helper-result">{helper.result.result}</p>}{helper.result?.sources.map(source=><a className="slk-run-helper-source" key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title||source.url}</a>)}</li>)}</ul></details>}
    </li>)}</ul>
    {state.runs.some(run => run.assignments?.some(assignment => assignment.canStop && activeStatus(assignment.status))) && <p>{t('Stopping prevents further work. External operations already started may still finish.')}</p>}
    <p>{t('Processing ended does not confirm that the task or external actions succeeded.')}</p>
  </details>
}
