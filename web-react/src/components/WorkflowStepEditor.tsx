import React,{useEffect,useState} from 'react'
import {WorkflowProgramEditor} from './WorkflowProgramEditor'
import {WorkflowConditionEditor,blankCondition} from './WorkflowConditionEditor'
import {useT} from '../utils/i18n'
import {Icon} from './Icon'
import type {Step,StepType,Table,HarnessApi} from '../utils/harness'
export interface AgentFace {id:string;handle:string;name:string;emoji?:string|null}
const STEP_TYPES:StepType[]=['post','agent','connection','add_row','update_row','approval','followup']
const blankStep=(type:StepType):Step=>({type,...(type==='followup'?{minutes:1440}:{}),...(type==='connection'?{source:'notion',action:'search'}:{})})
function stepLabel(t: (k: string) => string, type: StepType) {
  return ({
    post: t('Post in a room'), agent: t('Ask an agent'), connection: t('Search a connection'), add_row: t('Add a row'),
    update_row: t('Change the row'), approval: t('Ask for approval'), followup: t('Follow up later'),
  } as Record<StepType, string>)[type]
}

export function StepEditor({ api, step, onChange, onRemove, tables, agents, triggerTable }: {
  api?:HarnessApi; step: Step; onChange: (s: Step) => void; onRemove: () => void; tables: Table[]; agents: AgentFace[]; triggerTable?: Table
}) {
  const t = useT()
  const [mcpConnections,setMcpConnections]=useState<NonNullable<Awaited<ReturnType<NonNullable<HarnessApi>['agentApps']>>['remoteMcpConnections']>>([])
  const [mcpBusy,setMcpBusy]=useState(false),[mcpError,setMcpError]=useState(''),[argsText,setArgsText]=useState(JSON.stringify(step.args||{},null,2))
  useEffect(()=>{setArgsText(JSON.stringify(step.args||{},null,2))},[step.args])
  useEffect(()=>{
    let live=true
    if(step.type!=='connection'||step.source!=='remote_mcp'||!step.agentId||!api){setMcpConnections([]);setMcpError('');setMcpBusy(false);return()=>{live=false}}
    setMcpBusy(true);setMcpError('')
    void api.agentApps(step.agentId).then(result=>{if(live)setMcpConnections(result.remoteMcpConnections||[])}).catch(error=>{if(live){setMcpConnections([]);setMcpError(error instanceof Error?error.message:String(error))}}).finally(()=>{if(live)setMcpBusy(false)})
    return()=>{live=false}
  },[api,step.agentId,step.source,step.type])
  const set = (patch: Partial<Step>) => onChange({ ...step, ...patch })
  const valueTable = step.type === 'add_row' ? tables.find((x) => x.id === step.tableId) : triggerTable
  if(step.type==='code')return <div className="hx-step">{api?<WorkflowProgramEditor api={api} step={step} onChange={onChange}/>:<pre className="hx-program-source">{step.code}</pre>}<button className="btn-text danger" onClick={onRemove}>{t('Remove step')}</button></div>
  return (
    <div className="hx-step">
      <div className="hx-step-head">
        <select value={step.type} onChange={(e) => onChange({...blankStep(e.target.value as StepType),...(step.when?{when:step.when}:{})})} aria-label={t('Step')}>
          {STEP_TYPES.map((s) => <option key={s} value={s}>{stepLabel(t, s)}</option>)}
        </select>
        <button className="btn-text danger" onClick={onRemove} aria-label={t('Remove step')}><Icon name="x" size={14} /></button>
      </div>
      <div className="hx-step-condition"><label><input type="checkbox" checked={Boolean(step.when)} onChange={event=>set({when:event.target.checked?blankCondition():undefined})}/> {t('Run only when the condition matches')}</label>{step.when&&<WorkflowConditionEditor columns={triggerTable?.columns} value={step.when} onChange={when=>set({when})}/>}</div>
      {(step.type === 'post' || step.type === 'followup') && (
        <input className="hx-cell-input" placeholder="#ops" value={(step.channel || '').replace(/^b:/, '#')} onChange={(e) => set({ channel: `b:${e.target.value.replace(/^#/, '')}` })} aria-label={t('Room')} />
      )}
      {(step.type === 'post' || step.type === 'followup') && (
        <textarea className="context-input" rows={2} placeholder={t('e.g. {{row.Client}} is overdue')} value={step.text || ''} onChange={(e) => set({ text: e.target.value })} aria-label={t('Text')} />
      )}
      {step.type === 'followup' && (
        <label className="hx-inline">{t('In')} <input type="number" min={1} max={129600} step={1} aria-label={t('Follow-up delay (minutes)')} className="hx-cell-input hx-num" value={step.minutes ?? 1440} onChange={(e) => set({ minutes: Number(e.target.value) })} /> {t('minutes')}</label>
      )}
      {step.type === 'agent' && (
        <>
          <select value={step.agentId || ''} onChange={(e) => set({ agentId: e.target.value })} aria-label={t('Agent')}>
            <option value="">{t('Choose an agent')}</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.emoji ? `${a.emoji} ` : ''}{a.name} (@{a.handle})</option>)}
          </select>
          <textarea className="context-input" rows={2} placeholder={t('What to ask it')} value={step.prompt || ''} onChange={(e) => set({ prompt: e.target.value })} aria-label={t('Prompt')} />
          <input className="hx-cell-input" placeholder={t('#room to post its answer (optional)')} value={(step.channel || '').replace(/^b:/, '#')} onChange={(e) => set({ channel: e.target.value ? `b:${e.target.value.replace(/^#/, '')}` : undefined })} aria-label={t('Room')} />
        </>
      )}
      {step.type === 'connection' && (
        <>
          <select value={step.agentId || ''} onChange={(e) => set({ agentId: e.target.value })} aria-label={t('Agent')}>
            <option value="">{t('Choose an agent')}</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.emoji ? `${a.emoji} ` : ''}{a.name} (@{a.handle})</option>)}
          </select>
          <select value={step.source || 'notion'} onChange={(e) => set(e.target.value==='remote_mcp'?{source:'remote_mcp',serverId:undefined,toolName:undefined,action:undefined,query:undefined,args:{}}:{source:e.target.value as 'notion'|'github', action: 'search',serverId:undefined,toolName:undefined,args:undefined})} aria-label={t('Connection')}>
            <option value="notion">Notion · {t('Search only')}</option>
            <option value="github">GitHub · {t('Search only')}</option>
            <option value="remote_mcp">{t('Remote MCP tool')}</option>
          </select>
          {step.source==='remote_mcp'?<>
            <select aria-label={t('Remote MCP connection')} value={step.serverId||''} disabled={mcpBusy} onChange={event=>{const serverId=event.target.value,server=mcpConnections.find(item=>item.serverId===serverId),tool=server?.tools?.find(item=>item.enabled);set({serverId,toolName:tool?.name,args:{}})}}>
              <option value="">{mcpBusy?t('Loading…'):t('Choose a Remote MCP connection')}</option>
              {mcpConnections.filter(server=>server.tools?.some(tool=>tool.enabled)).map(server=><option key={server.serverId} value={server.serverId}>{server.name}</option>)}
            </select>
            {step.serverId&&<select aria-label={t('Remote MCP tool')} value={step.toolName||''} onChange={event=>set({toolName:event.target.value,args:{}})}>
              <option value="">{t('Choose an enabled tool')}</option>
              {mcpConnections.find(server=>server.serverId===step.serverId)?.tools?.filter(tool=>tool.enabled).map(tool=><option key={tool.name} value={tool.name}>{tool.title}{tool.requiresApproval?` · ${t('approval required')}`:''}</option>)}
            </select>}
            {step.toolName&&<textarea className="context-input hx-workflow-mcp-arguments" rows={5} placeholder={'{}'} value={argsText} onChange={event=>{setArgsText(event.target.value);try{const parsed=JSON.parse(event.target.value);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))set({args:parsed})}catch{}}} aria-label={t('Remote MCP arguments (JSON)')} />}
            {mcpError&&<p role="alert" className="form-error">{mcpError}</p>}
            {!mcpBusy&&!mcpError&&step.agentId&&mcpConnections.every(server=>!server.tools?.some(tool=>tool.enabled))&&<div className="row-sub">{t('Grant this Agent the specific Remote MCP tool in its Connections tab before using it here.')}</div>}
            <div className="row-sub">{t('Calls only the selected tool. The Worker checks its schema and permission again before and after each request. Do not put credentials in the arguments.')}</div>{mcpConnections.find(server=>server.serverId===step.serverId)?.tools?.find(tool=>tool.name===step.toolName)?.requiresApproval&&<div className="form-note">{t('This tool can write to an external service. Add an Approval step immediately before it. The approver will see the tool name and rendered arguments.')}</div>}
          </>:<>
            <textarea className="context-input" rows={2} placeholder={t('Search query')} value={step.query || ''} onChange={(e) => set({ query: e.target.value, action: 'search' })} aria-label={t('Search query')} />
            <div className="row-sub">{t('Uses the selected Agent’s current connection grant. Read-only search; writes are not available.')}</div>
          </>}
        </>
      )}
      {step.type === 'add_row' && (
        <select value={step.tableId || ''} onChange={(e) => set({ tableId: e.target.value, values: {} })} aria-label={t('Table')}>
          <option value="">{t('Choose a table')}</option>
          {tables.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      )}
      {(step.type === 'add_row' || step.type === 'update_row') && valueTable && (
        <div className="hx-values">
          {valueTable.columns.map((c) => (
            <label key={c.id} className="hx-inline">
              <span>{c.name}</span>
              <input className="hx-cell-input" value={String(step.values?.[c.id] ?? '')} placeholder={c.type === 'select' ? (c.options || []).join(' / ') : ''} onChange={(e) => set({ values: { ...(step.values || {}), [c.id]: e.target.value } })} />
            </label>
          ))}
        </div>
      )}
      {step.type === 'update_row' && !valueTable && <div className="row-sub">{t('Changes the row that started the run: use a row trigger.')}</div>}
      {step.type === 'approval' && (
        <>
          <input className="hx-cell-input" placeholder={t('@who approves')} value={step.to ? `@${step.to}` : ''} onChange={(e) => set({ to: e.target.value.replace(/^@/, '') })} aria-label={t('Approver')} />
          <input className="hx-cell-input" placeholder={t('e.g. Send {{row.Client}} a reminder?')} value={step.title || ''} onChange={(e) => set({ title: e.target.value })} aria-label={t('Title')} />
          <textarea className="context-input" rows={2} placeholder={t('What they should know')} value={step.summary || ''} onChange={(e) => set({ summary: e.target.value })} aria-label={t('Summary')} />
        </>
      )}
    </div>
  )
}

