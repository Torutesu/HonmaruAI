import React, {useEffect, useRef, useState} from 'react'
import {Icon} from './Icon'
import {StepEditor, type AgentFace} from './WorkflowStepEditor'
import {AutomationTriggerEditor} from './AutomationTriggerEditor'
import {AutomationRuns} from './AutomationRuns'
import {AutomationSummary} from './AutomationSummary'
import type {App, AppAutomationState, AutomationBundle, HarnessApi, Workflow, Table} from '../utils/harness'

const statusLabels = {added:'追加',changed:'変更',unchanged:'変更なし',removed:'公開停止',retired:'停止済み',drifted:'別の画面で変更あり',missing:'処理が削除されています'}
export function AppAutomations({app,api,reload}:{app:App;api:HarnessApi;reload:()=>unknown}) {
  const [prompt,setPrompt]=useState('')
  const [state,setState]=useState<AppAutomationState|null>(null)
  const [draft,setDraft]=useState<AutomationBundle>({version:1,items:[]})
  const [tables,setTables]=useState<Table[]>([]),[agents,setAgents]=useState<AgentFace[]>([])
  const [choices,setChoices]=useState<Workflow[]>([]),[selected,setSelected]=useState('')
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const [checked,setChecked]=useState<string[]>([]),[includeSource,setIncludeSource]=useState(false)
  const pending=useRef<{fingerprint:string;requestId:string}|null>(null)
  const generation=useRef(0)
  const refresh=async()=>{
    const current=++generation.current
    let result:AppAutomationState,warning=''
    try {result=await api.appAutomations(app.id)} catch(e) {result=await api.appAutomations(app.id,true);warning=e instanceof Error?e.message:String(e)}
    if(current!==generation.current)return
    setState(result);setDraft(result.draft);setChecked([]);setError(warning)
  }
  useEffect(()=>{void refresh().catch(e=>setError(String(e)));void api.tables?.().then(r=>setTables(r.tables)).catch(()=>{});void api.workflowAgents?.().then(r=>setAgents(r.agents)).catch(()=>{});void api.workflows().then(r=>setChoices(r.workflows)).catch(()=>{});return()=>{generation.current++}},[app.id,app.version,api])
  const moveStep=(key:string,index:number,direction:number)=>{
    setDraft(current=>({...current,items:current.items.map(item=>{
      if(item.key!==key || index+direction<0 || index+direction>=item.steps.length)return item
      const steps=[...item.steps];[steps[index],steps[index+direction]]=[steps[index+direction],steps[index]]
      return {...item,steps}
    })}))
    setNotice('実行順序を変更しました。ステップ番号を参照する入力がある場合は、参照先も確認してください。')
  }
  const dirty=state && JSON.stringify(draft)!==JSON.stringify(state.draft)
  const conflicts=state?.plan?.filter(item=>item.status==='drifted'||item.status==='missing')||[]
  const canPublish=state && state.revision>0 && state.plan && !dirty && conflicts.every(item=>checked.includes(item.key) && item.workflowId && (item.status!=='missing'||item.declared))
  const run=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');setNotice('');try{await fn()}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
  const release=async(action:'publish'|'unpublish')=>{
    if(!state)return
    const body={action,version:state.version,revision:state.revision,includeSource:action==='publish'&&includeSource,reviewed:action==='publish'?conflicts.map(item=>({key:item.key,workflowId:item.workflowId,action:item.status==='missing'?'recreate':'replace',live:item.live})):[]}
    const fingerprint=JSON.stringify(body)
    if(pending.current?.fingerprint!==fingerprint)pending.current={fingerprint,requestId:crypto.randomUUID()}
    await api.releaseAppAutomations(app.id,{...body,requestId:pending.current.requestId})
    pending.current=null;await refresh();await reload();setNotice(action==='publish'?'確認した自動化を公開しました。':'自動化の公開を停止しました。')
  }
  return <section className="hx-app-automations" aria-label="アプリの自動化">
    <header><h3><Icon name="workflow" size={18}/> 自動化</h3><span>{state?.published?'公開中':'下書き'}</span></header>
    <p>下書きを保存して変更内容を確認し、このアプリと一緒に運用する処理を公開します。</p>
    {error&&<p role="alert" className="form-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {!state?<button disabled={busy} onClick={()=>void run(refresh)}>再読み込み</button>:<>
      <form onSubmit={e=>{e.preventDefault();void run(async()=>{const result=await api.generateAppAutomation(app.id,prompt,Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC');setDraft({...draft,items:[...draft.items,result.automation]});setPrompt('');setNotice('生成した下書きを確認して保存してください。まだ実行されません。')})}}><label>作りたい自動化<textarea value={prompt} maxLength={4000} disabled={busy} onChange={e=>setPrompt(e.target.value)} placeholder="例：毎週月曜日の9時に、担当エージェントへ売上データの確認を依頼する"/></label><button className="pill-btn" disabled={busy||!prompt.trim()||draft.items.length>=12}>自動化を生成</button></form>
      <div className="hx-actions"><select aria-label="コピーするワークフロー" value={selected} onChange={e=>setSelected(e.target.value)}><option value="">ワークフローから下書きを作成</option>{choices.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select><button className="pill-btn quiet" disabled={busy||!selected||draft.items.length>=12} onClick={()=>{const w=choices.find(w=>w.id===selected);if(w)setDraft({...draft,items:[...draft.items,{key:`auto_${crypto.randomUUID().replaceAll('-','').slice(0,16)}`,name:w.name,enabled:false,trigger:w.trigger,steps:w.steps}]});setSelected('')}}>下書きに追加</button></div>
      <button className="pill-btn quiet" disabled={busy||draft.items.length>=12} onClick={()=>setDraft({...draft,items:[...draft.items,{key:`auto_${crypto.randomUUID().replaceAll('-','').slice(0,16)}`,name:'新しい自動化',enabled:false,trigger:{type:'manual'},steps:[{type:'post'}]}]})}><Icon name="plus" size={14}/> 自動化を作成</button>
      {draft.items.length===0&&<p>自動化はまだありません。新しく作成するか、既存ワークフローから処理をコピーできます。</p>}
      {draft.items.map(item=><div className="hx-step" key={item.key}><label>名前<input value={item.name} maxLength={80} disabled={busy} onChange={e=>setDraft({...draft,items:draft.items.map(v=>v.key===item.key?{...v,name:e.target.value}:v)})}/></label><label><input type="checkbox" checked={item.enabled} disabled={busy} onChange={e=>setDraft({...draft,items:draft.items.map(v=>v.key===item.key?{...v,enabled:e.target.checked}:v)})}/>公開後に有効化</label><p>{item.trigger.type==='schedule'?'スケジュール':item.trigger.type==='row'?'データ変更':item.trigger.type==='webhook'?'Webhook':'手動実行'} · {item.steps.length}ステップ</p><details><summary>実行条件・ステップを編集</summary><fieldset disabled={busy}><AutomationTriggerEditor trigger={item.trigger} tables={tables} onChange={trigger=>setDraft({...draft,items:draft.items.map(v=>v.key===item.key?{...v,trigger}:v)})}/>{item.steps.map((step,index)=><div key={index}><div className="hx-actions"><button type="button" className="pill-btn quiet" disabled={busy||index===0} aria-label={`${index+1}番目のステップを上へ`} onClick={()=>moveStep(item.key,index,-1)}><Icon name="arrow-up" size={14}/></button><button type="button" className="pill-btn quiet" disabled={busy||index===item.steps.length-1} aria-label={`${index+1}番目のステップを下へ`} onClick={()=>moveStep(item.key,index,1)}><Icon name="arrow-down" size={14}/></button></div><StepEditor step={step} tables={tables} agents={agents} triggerTable={tables.find(t=>t.id===item.trigger.tableId)} onChange={step=>setDraft({...draft,items:draft.items.map(v=>v.key===item.key?{...v,steps:v.steps.map((s,i)=>i===index?step:s)}:v)})} onRemove={()=>setDraft({...draft,items:draft.items.map(v=>v.key===item.key?{...v,steps:v.steps.filter((_,i)=>i!==index)}:v)})}/></div>) }<button className="pill-btn quiet" onClick={()=>setDraft({...draft,items:draft.items.map(v=>v.key===item.key?{...v,steps:[...v.steps,{type:'post'}]}:v)})}>ステップを追加</button></fieldset></details><button className="pill-btn quiet" disabled={busy} onClick={()=>setDraft({...draft,items:draft.items.filter(v=>v.key!==item.key)})}>下書きから外す</button></div>)}
      <button className="pill-btn" disabled={busy||!dirty} onClick={()=>void run(async()=>{await api.saveAppAutomations(app.id,state.version,state.revision,draft);await refresh();setNotice('下書きを保存しました。公開中の処理は変わりません。')})}>下書きを保存</button>
      <h4>公開する変更</h4>{dirty?<p>下書きを保存すると、公開中の処理との差分を確認できます。</p>:state.plan?.map(item=><details key={item.key}><summary>{item.declared?.name||item.published?.name||item.key} · {statusLabels[item.status]}</summary><div className="hx-automation-diff"><div><strong>現在</strong><AutomationSummary definition={item.live} tables={tables} agents={agents}/></div><div><strong>公開後</strong><AutomationSummary definition={item.declared} tables={tables} agents={agents}/></div></div>{item.workflowId&&item.status!=='missing'&&<AutomationRuns key={item.workflowId} workflowId={item.workflowId} api={api}/>} {conflicts.includes(item)&&<label><input type="checkbox" disabled={busy} checked={checked.includes(item.key)} onChange={e=>setChecked(e.target.checked?[...checked,item.key]:checked.filter(k=>k!==item.key))}/>{item.status==='missing'?'この処理を復旧する':'現在の変更を確認し、アプリの定義で置き換える'}</label>}</details>)}
      {app.definition.custom&&<label><input type="checkbox" checked={includeSource} disabled={busy} onChange={e=>setIncludeSource(e.target.checked)}/>保存済みのアプリ画面も同時に公開する</label>}
      <div className="hx-actions"><button className="pill-btn" disabled={busy||!canPublish} onClick={()=>void run(()=>release('publish'))}>確認した内容を公開</button>{state.published&&<button className="pill-btn quiet" disabled={busy} onClick={()=>void run(()=>release('unpublish'))}>自動化を停止</button>}</div>
    </>}
  </section>
}
