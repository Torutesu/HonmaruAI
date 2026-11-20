import React,{useCallback,useEffect,useRef,useState} from 'react'
import type {App,AppConnection,AppEntity,Gateway,HarnessApi,Step} from '../utils/harness'
import {useT} from '../utils/i18n'
import {Icon} from './Icon'

export function WorkflowProgramEditor({api,step,onChange,sourceApps=[]}:{api:HarnessApi;step:Step;onChange:(step:Step)=>void;sourceApps?:Array<{app:Pick<App,'id'|'name'>;entities:AppEntity[]}>}) {
 const t=useT(),generation=useRef(0),connectionGeneration=useRef(0)
 const lineNumbers=useRef<HTMLPreElement>(null)
 const compileGeneration=useRef(0)
 const [nodes,setNodes]=useState<Gateway[]>([]),[agents,setAgents]=useState<Array<{id:string;handle:string;name:string;emoji?:string|null}>>([]),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const [compileState,setCompileState]=useState<{status:'idle'|'checking'|'ready'|'error'|'unavailable';diagnostics:Array<{line:number;column:number;message:string}>;output:string}>({status:'idle',diagnostics:[],output:''})
 const [connectionAppId,setConnectionAppId]=useState(step.sourceConnections?.[0]?.appId||step.sourceAppId||sourceApps[0]?.app.id||''),[connections,setConnections]=useState<AppConnection[]>([]),[connectionsBusy,setConnectionsBusy]=useState(false),[connectionsError,setConnectionsError]=useState('')
 const load=useCallback(async()=>{
  const token=++generation.current;setBusy(true);setError('')
  try{const [result,availableAgents]=await Promise.all([api.gateways(),api.workflowAgents()]);if(token===generation.current){setNodes(result.gateways.filter(node=>!node.revokedAt));setAgents(availableAgents.agents)}}
  catch(error){if(token===generation.current){setNodes([]);setError(error instanceof Error?error.message:String(error))}}
  finally{if(token===generation.current)setBusy(false)}
 },[api])
 useEffect(()=>{void load();return()=>{generation.current++}},[load])
 useEffect(()=>{
  const appId=connectionAppId,token=++connectionGeneration.current
  if(!appId){setConnections([]);setConnectionsError('');return()=>{connectionGeneration.current++}}
  if(typeof api.appConnections!=='function'){setConnections([]);setConnectionsBusy(false);setConnectionsError('');return()=>{connectionGeneration.current++}}
  setConnectionsBusy(true);setConnectionsError('')
  void api.appConnections(appId).then(result=>{if(token===connectionGeneration.current)setConnections(result.connections||[])}).catch(reason=>{if(token===connectionGeneration.current){setConnections([]);setConnectionsError(reason instanceof Error?reason.message:String(reason))}}).finally(()=>{if(token===connectionGeneration.current)setConnectionsBusy(false)})
  return()=>{connectionGeneration.current++}
 },[api,connectionAppId])
 const bytes=new TextEncoder().encode(step.code||'').length
 useEffect(()=>{
  const code=step.code||'',token=++compileGeneration.current
  if(!code.trim()||new TextEncoder().encode(code).length>48000){setCompileState({status:'idle',diagnostics:[],output:''});return()=>{compileGeneration.current++}}
  const timer=setTimeout(()=>{
   setCompileState(previous=>({...previous,status:'checking'}))
   void import('typescript').then(ts=>{
    const result=ts.transpileModule(code,{fileName:'workflow.ts',reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.Preserve,verbatimModuleSyntax:true}})
    if(token!==compileGeneration.current)return
    const diagnostics=(result.diagnostics||[]).filter(item=>item.category===ts.DiagnosticCategory.Error).map(item=>{
     const location=item.file&&item.start!==undefined?item.file.getLineAndCharacterOfPosition(item.start):null
     return {line:location?location.line+1:0,column:location?location.character+1:0,message:ts.flattenDiagnosticMessageText(item.messageText,'\n')}
    })
    setCompileState({status:diagnostics.length?'error':'ready',diagnostics,output:result.outputText})
   }).catch(()=>{if(token===compileGeneration.current)setCompileState({status:'unavailable',diagnostics:[],output:''})})
  },300)
  return()=>{clearTimeout(timer);compileGeneration.current++}
 },[step.code])
 const lineCount=(step.code||'').split('\n').length
 const selectedApp=sourceApps.find(choice=>choice.app.id===step.sourceAppId)
 const selectedSources=step.sourceTables??(step.sourceEntityId&&step.sourceTableId?[{entityId:step.sourceEntityId,tableId:step.sourceTableId}]:[])
 const selectedEntityIds=new Set(selectedSources.map(source=>source.entityId))
 const selectedAgentIds=new Set(step.sourceAgents??[])
 const selectedConnections=step.sourceConnections??[]
 const setConnection=(connection:AppConnection,checked:boolean)=>{
  const next=checked?[...selectedConnections.filter(item=>item.appId!==connectionAppId||item.name!==connection.name),{appId:connectionAppId,name:connection.name,ownerId:String(connection.ownerId||''),version:connection.version,method:connection.method}]:selectedConnections.filter(item=>item.appId!==connectionAppId||item.name!==connection.name)
  onChange({...step,sourceConnections:next.length?next:undefined})
 }
 const setSources=(entityIds:string[])=>{
  const entities=selectedApp?.entities.filter(entity=>entityIds.includes(entity.key))??[]
  if(!selectedApp||!entities.length){onChange({...step,sourceAppId:undefined,sourceEntityId:undefined,sourceTableId:undefined,sourceTables:undefined});return}
  const sources=entities.map(entity=>({entityId:entity.key,tableId:entity.table.id,...(selectedSources.find(source=>source.entityId===entity.key)?.write?{write:true}:{}),...(selectedSources.find(source=>source.entityId===entity.key)?.mutate?{mutate:true}:{})}))
  if(sources.length===1)onChange({...step,sourceAppId:selectedApp.app.id,sourceEntityId:sources[0].entityId,sourceTableId:sources[0].tableId,sourceTables:undefined})
  else onChange({...step,sourceAppId:selectedApp.app.id,sourceEntityId:undefined,sourceTableId:undefined,sourceTables:sources})
 }
 const setSourceWrite=(entityId:string,write:boolean)=>{
  if(!selectedApp)return
  const sources=selectedApp.entities.filter(item=>selectedEntityIds.has(item.key)).map(item=>({entityId:item.key,tableId:item.table.id,...(item.key===entityId?write?{write:true}:{ }:selectedSources.find(source=>source.entityId===item.key)?.write?{write:true}:{}),...(selectedSources.find(source=>source.entityId===item.key)?.mutate?{mutate:true}:{})}))
  onChange({...step,sourceEntityId:undefined,sourceTableId:undefined,sourceTables:sources})
 }
 const setSourceMutate=(entityId:string,mutate:boolean)=>{
  if(!selectedApp)return
  const sources=selectedApp.entities.filter(item=>selectedEntityIds.has(item.key)).map(item=>({entityId:item.key,tableId:item.table.id,...(selectedSources.find(source=>source.entityId===item.key)?.write?{write:true}:{}),...(item.key===entityId?mutate?{mutate:true}:{}:selectedSources.find(source=>source.entityId===item.key)?.mutate?{mutate:true}:{})}))
  onChange({...step,sourceEntityId:undefined,sourceTableId:undefined,sourceTables:sources})
 }
 return <section className="hx-program-editor">
  <div className="hx-program-toolbar"><strong><Icon name="code" size={16}/> {t('TypeScript program')}</strong><span>workflow.ts</span></div>
  <p className="row-sub">{t('Runs from the top of the file. Exported functions are not called automatically.')}</p>
  <label className="hx-inline">{t('Execution node')} <select aria-label={t('Execution node')} disabled={busy} value={step.gatewayId||''} onChange={event=>onChange({...step,gatewayId:event.target.value})}>
   <option value="">{t('Choose an execution node')}</option>
   {step.gatewayId&&!nodes.some(node=>node.id===step.gatewayId)&&<option value={step.gatewayId}>{t('Selected node unavailable')}</option>}
   {nodes.map(node=><option key={node.id} value={node.id}>{node.name}</option>)}
  </select><button className="btn-text" type="button" disabled={busy} onClick={()=>void load()}>{t('Refresh')}</button></label>
  {busy&&<p role="status">{t('Loading…')}</p>}
  {error&&<p className="form-error" role="alert">{error}</p>}
  {!busy&&!error&&!nodes.length&&<p className="row-sub">{t('Connect an execution node in Settings to run this program.')}</p>}
  <label className="hx-inline">{t('App/Table source')} <select aria-label={t('App/Table source')} value={step.sourceAppId||''} onChange={event=>{
   const choice=sourceApps.find(item=>item.app.id===event.target.value),entity=choice?.entities[0]
   onChange({...step,...(choice&&entity?{sourceAppId:choice.app.id,sourceEntityId:entity.key,sourceTableId:entity.table.id,sourceTables:undefined}:{sourceAppId:undefined,sourceEntityId:undefined,sourceTableId:undefined,sourceTables:undefined})})
  }}>
   <option value="">{t('No App/Table source')}</option>
   {step.sourceAppId&&!selectedApp&&<option value={step.sourceAppId}>{t('Selected App unavailable')}</option>}
   {sourceApps.map(choice=><option key={choice.app.id} value={choice.app.id}>{choice.app.name}</option>)}
  </select></label>
  {step.sourceAppId&&<fieldset className="hx-program-sources" aria-label={t('Authorized App entities')}>
   <legend>{t('Authorized App entities')}</legend>
   {selectedApp?.entities.map(entity=><div key={entity.key}><label><input type="checkbox" aria-label={`${t('Include entity')}: ${entity.table.name}`} checked={selectedEntityIds.has(entity.key)} disabled={!selectedEntityIds.has(entity.key)&&selectedEntityIds.size>=20} onChange={event=>setSources(event.target.checked?[...selectedEntityIds,entity.key]:[...selectedEntityIds].filter(key=>key!==entity.key))}/>{entity.table.name}</label>{selectedEntityIds.has(entity.key)&&<><label><input type="checkbox" aria-label={`${t('Allow row creation')}: ${entity.table.name}`} checked={selectedSources.find(source=>source.entityId===entity.key)?.write===true} onChange={event=>setSourceWrite(entity.key,event.target.checked)}/>{t('Allow row creation')}</label><label><input type="checkbox" aria-label={`${t('Allow row updates and deletes')}: ${entity.table.name}`} checked={selectedSources.find(source=>source.entityId===entity.key)?.mutate===true} onChange={event=>setSourceMutate(entity.key,event.target.checked)}/>{t('Allow row updates and deletes')}</label></>}</div>)}
   {!selectedApp&&selectedSources.map(source=><label key={source.entityId}><input type="checkbox" checked disabled readOnly/>{t('Selected entity unavailable')} · {source.entityId}</label>)}
   {selectedApp&&selectedSources.some(source=>!selectedApp.entities.some(entity=>entity.key===source.entityId))&&<p role="alert">{t('Some selected entities are unavailable. Repair the source before saving.')}</p>}
   {!selectedSources.length&&<p role="alert">{t('Choose at least one App entity.')}</p>}
  </fieldset>}
  <label className="hx-inline">{t('App connection source')} <select aria-label={t('App connection source')} value={connectionAppId} onChange={event=>setConnectionAppId(event.target.value)}>
   <option value="">{t('Choose an App')}</option>
   {connectionAppId&&!sourceApps.some(choice=>choice.app.id===connectionAppId)&&<option value={connectionAppId}>{t('Selected App unavailable')}</option>}
   {sourceApps.map(choice=><option key={choice.app.id} value={choice.app.id}>{choice.app.name}</option>)}
  </select></label>
  <fieldset className="hx-program-sources" aria-label={t('Authorized App connections')}>
   <legend>{t('Authorized App connections')}</legend>
   <p className="row-sub">{t('Bind existing App connections to this Workflow. The App owner keeps control of the URL and credentials.')}</p>
   {connectionsBusy&&<p role="status">{t('Loading connections…')}</p>}
   {connectionsError&&<p className="form-error" role="alert">{connectionsError}</p>}
   {!connectionsBusy&&!connectionsError&&connections.filter(item=>Number(item.enabled)===1).map(connection=>{
    const selected=selectedConnections.some(item=>item.appId===connectionAppId&&item.name===connection.name)
    const supported=connection.method==='GET'
    return <label key={`${connection.ownerId||''}:${connection.name}`}><input type="checkbox" aria-label={`${t('Include connection')}: ${connection.name}`} checked={selected} disabled={!supported||!selected&&selectedConnections.length>=20} onChange={event=>setConnection(connection,event.target.checked)}/>{connection.name} · {connection.method}{connection.ownerName?` · ${connection.ownerName}`:''}{!supported?` · ${t('Writes require a Workflow approval step and are not available in programs yet.')}`:''}</label>
   })}
   {!connectionsBusy&&!connectionsError&&!connections.some(item=>Number(item.enabled)===1)&&<p className="row-sub">{t('No enabled App connections are available.')}</p>}
   {selectedConnections.filter(item=>item.appId===connectionAppId).some(item=>!connections.some(connection=>connection.name===item.name&&String(connection.ownerId||'')===item.ownerId&&connection.version===item.version&&connection.method===item.method&&Number(connection.enabled)===1))&&<p role="alert">{t('A selected connection changed or is no longer available. Re-select it before saving.')}</p>}
  </fieldset>
  <fieldset className="hx-program-sources" aria-label={t('Authorized Agents')}>
   <legend>{t('Authorized Agents')}</legend>
   {agents.map(agent=><label key={agent.id}><input type="checkbox" checked={selectedAgentIds.has(agent.id)} disabled={!selectedAgentIds.has(agent.id)&&selectedAgentIds.size>=20} onChange={event=>{const ids=event.target.checked?[...selectedAgentIds,agent.id]:[...selectedAgentIds].filter(id=>id!==agent.id);onChange({...step,sourceAgents:ids.length?ids:undefined})}}/>{agent.emoji?`${agent.emoji} `:''}{agent.name} (@{agent.handle})</label>)}
   {step.sourceAgents?.some(id=>!agents.some(agent=>agent.id===id))&&<p role="alert">{t('Some selected Agents are unavailable. Repair the binding before saving.')}</p>}
   {!selectedAgentIds.size&&<p className="row-sub">{t('Choose Agents that this program may call with agent(prompt, { agentId, schema }).')}</p>}
  </fieldset>
  <p className="row-sub">{t('The table.query helper reads saved App entities. table.insert requires Allow row creation; table.update and table.delete require Allow row updates and deletes. All changes commit only after the program succeeds. No VM network or database access is enabled.')}</p>
  <p className="row-sub">{t('connection.request({appId, name, query}) sends bounded read-only requests through the selected App connection. The program never receives its URL or credential.')}</p>
  <div className="hx-program-code" style={{'--program-gutter':`${Math.max(2,String(lineCount).length)+2}ch`} as React.CSSProperties}>
   <div className="hx-program-gutter" aria-hidden="true"><pre ref={lineNumbers}>{Array.from({length:lineCount},(_,index)=>index+1).join('\n')}</pre></div>
   <textarea className="hx-program-source hx-program-input" aria-label={t('TypeScript source')} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" rows={18} value={step.code||''} onScroll={event=>{if(lineNumbers.current)lineNumbers.current.style.transform=`translateY(-${event.currentTarget.scrollTop}px)`}} onChange={event=>onChange({...step,code:event.target.value})}/>
  </div>
  <section className="hx-program-diagnostics" aria-label={t('Program syntax diagnostics')} aria-live="polite">
   {compileState.status==='checking'&&<p role="status">{t('Checking syntax…')}</p>}
   {compileState.status==='ready'&&<p role="status">{t('Syntax check passed. This is not a type check.')}</p>}
   {compileState.status==='unavailable'&&<p role="status">{t('The syntax checker could not load. Saving is still available.')}</p>}
   {compileState.status==='error'&&<div role="alert"><strong>{t('Fix syntax errors before running this program.')}</strong><ul>{compileState.diagnostics.slice(0,12).map((item,index)=><li key={`${item.line}:${item.column}:${index}`}>{item.line?t('Line {line}, column {column}',{line:item.line,column:item.column}):t('Program syntax error')}: {item.message}</li>)}</ul>{compileState.diagnostics.length>12&&<p>{t('Showing the first 12 errors.')}</p>}</div>}
   {compileState.status==='ready'&&<details><summary>{t('Show transpiled JavaScript')}</summary><p className="row-sub">{t('This preview removes TypeScript syntax only. It does not run the program or check types.')}</p><pre className="hx-program-transpiled"><code>{compileState.output}</code></pre></details>}
  </section>
  <div className="hx-program-toolbar"><span>{t('Saved state is available through @honmaru/workflow-sdk.')}</span><span>{t('Use parallel and pipeline for bounded batches; failed items return null and call onError.')}</span><span>{t('table.query reads, while insert, update, and delete are staged within the saved App/Table permissions.')}</span><span>{t('sendMessage(text) stages a report draft in run history; it never posts to a Room.')}</span><span>{t('Workflow programs can run for up to 15 minutes.')}</span><span>{bytes.toLocaleString()} / 48,000 B</span></div>
  {bytes>48000&&<p className="form-error" role="alert">{t('Program source exceeds 48 KB.')}</p>}
 </section>
}
