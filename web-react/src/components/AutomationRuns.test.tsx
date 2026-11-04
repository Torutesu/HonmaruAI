import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {changeLocale,localeReady,t} from '../utils/i18n'
import {AutomationRuns} from './AutomationRuns'
const refresh=(tree:any)=>tree.root.findAllByType('button').find((button:any)=>button.props['aria-pressed']===undefined)
test('execution history loads on demand and exposes failed step details',async()=>{
 const workflow=vi.fn().mockResolvedValue({runs:[{id:'run',startedAt:'2026-10-24T00:00:00Z',status:'failed',log:[{step:1,status:'failed',error:'Permission revoked'}]}]});let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow}as any}/>)})
 expect(workflow).not.toHaveBeenCalled()
 await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
 expect(workflow).toHaveBeenCalledWith('wf');expect(JSON.stringify(tree.toJSON())).toContain('Permission revoked')
 act(()=>tree.unmount())
})
test('failed refresh removes stale results and offers a retry',async()=>{
 const workflow=vi.fn().mockResolvedValueOnce({runs:[{id:'old',startedAt:'2026-10-24T00:00:00Z',status:'done',log:[]}]}).mockRejectedValueOnce(new Error('Access changed')).mockResolvedValue({runs:[]});let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow}as any}/>)})
 await act(async()=>refresh(tree).props.onClick())
 await act(async()=>refresh(tree).props.onClick())
 expect(JSON.stringify(tree.toJSON())).not.toContain('old');expect(JSON.stringify(tree.toJSON())).toContain('Access changed')
 await act(async()=>refresh(tree).props.onClick())
 expect(JSON.stringify(tree.toJSON())).toContain(t('No runs yet.'));act(()=>tree.unmount())
})

test('switching workflows clears previous history and ignores an outstanding old response',async()=>{
 let resolveOld:any,resolveNew:any
 const workflow=vi.fn().mockImplementation((id:string)=>new Promise(resolve=>{if(id==='old')resolveOld=resolve;else resolveNew=resolve}))
 const api={workflow}as any;let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="old" api={api}/>)})
 await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
 act(()=>tree.update(<AutomationRuns workflowId="new" api={api}/>))
 expect(workflow.mock.calls.map(c=>c[0])).toEqual(['old','new'])
 await act(async()=>resolveOld({runs:[{id:'private-old',startedAt:'2026-10-24T00:00:00Z',status:'done',log:[]}]}))
 expect(JSON.stringify(tree.toJSON())).not.toContain('private-old')
 expect(refresh(tree).props.disabled).toBe(true)
 await act(async()=>resolveNew({runs:[{id:'current-new',startedAt:'2026-10-24T00:00:00Z',status:'done',log:[]}]}))
 expect(JSON.stringify(tree.toJSON())).toContain('current-new')
 expect(refresh(tree).props.disabled).toBe(false)
 act(()=>tree.unmount())
})

test('changing API identity clears loaded results and reloads an open history',async()=>{
 const oldApi={workflow:vi.fn().mockResolvedValue({runs:[{id:'old-account',startedAt:'2026-10-24T00:00:00Z',status:'done',log:[]}]})}as any
 const nextApi={workflow:vi.fn().mockResolvedValue({runs:[]})}as any;let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" api={oldApi}/>)})
 await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
 expect(JSON.stringify(tree.toJSON())).toContain('old-account')
 await act(async()=>tree.update(<AutomationRuns workflowId="wf" api={nextApi}/>))
 expect(nextApi.workflow).toHaveBeenCalledWith('wf')
 expect(JSON.stringify(tree.toJSON())).not.toContain('old-account')
 act(()=>tree.unmount())
})

test('completed run shows elapsed time but waiting and invalid times do not claim a duration',async()=>{
 const {runDuration}=await import('./AutomationRuns')
 const base={status:'done',startedAt:'2026-10-24T00:00:00Z',finishedAt:'2026-10-24T00:01:30Z'}
 expect(runDuration(base)).toMatch(/1.*30/)
 expect(runDuration({...base,finishedAt:'2026-10-24T02:15:00Z'})).toMatch(/2.*15/)
 expect(runDuration({...base,finishedAt:'2026-10-24T00:00:00.200Z'})).toContain('0.2')
 for(const status of ['waiting','running','unknown']) expect(runDuration({...base,status})).toBeNull()
 expect(runDuration({...base,finishedAt:null})).toBeNull()
 expect(runDuration({...base,startedAt:'invalid'})).toBeNull()
 expect(runDuration({...base,finishedAt:'2026-10-23T23:59:59Z'})).toBeNull()
 const workflow=vi.fn().mockResolvedValue({runs:[{...base,id:'timed',log:[]}]});let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow}as any}/>)})
 await act(async()=>refresh(tree).props.onClick())
 expect(tree.root.findByType('span').props.title).toBe(t('Elapsed time, including approval waits'))
 act(()=>tree.unmount())
})

test('open active history refreshes, then stops after completion or close',async()=>{
 vi.useFakeTimers();let tree:any
 try {
  const active={id:'active',startedAt:'2026-10-24T00:00:00Z',status:'waiting',log:[]}
  const workflow=vi.fn().mockResolvedValueOnce({runs:[active]}).mockResolvedValue({runs:[{...active,status:'done'}]})
  act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow}as any}/>)})
  await act(async()=>tree.root.findAllByType('details')[0].props.onToggle({currentTarget:{open:true}}))
  await act(async()=>{await vi.advanceTimersByTimeAsync(10000)})
  expect(workflow).toHaveBeenCalledTimes(2)
  await act(async()=>{await vi.advanceTimersByTimeAsync(30000)})
  expect(workflow).toHaveBeenCalledTimes(2)
  workflow.mockResolvedValue({runs:[active]})
  await act(async()=>refresh(tree).props.onClick())
  act(()=>tree.root.findAllByType('details')[0].props.onToggle({currentTarget:{open:false}}))
  await act(async()=>{await vi.advanceTimersByTimeAsync(30000)})
  expect(workflow).toHaveBeenCalledTimes(3)
 } finally {if(tree)act(()=>tree.unmount());vi.useRealTimers()}
})

test('automatic history refresh stops on failure and unmount clears scheduled work',async()=>{
 vi.useFakeTimers();let tree:any
 try {
  const workflow=vi.fn().mockResolvedValueOnce({runs:[{id:'active',startedAt:'2026-10-24T00:00:00Z',status:'running',log:[]}]}).mockRejectedValue(new Error('Offline'))
  act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow}as any}/>)})
  await act(async()=>tree.root.findAllByType('details')[0].props.onToggle({currentTarget:{open:true}}))
  await act(async()=>{await vi.advanceTimersByTimeAsync(10000)})
  expect(workflow).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(tree.toJSON())).toContain('Offline')
  await act(async()=>{await vi.advanceTimersByTimeAsync(30000)})
  expect(workflow).toHaveBeenCalledTimes(2)
  act(()=>tree.unmount());tree=null
  expect(vi.getTimerCount()).toBe(0)
 } finally {if(tree)act(()=>tree.unmount());vi.useRealTimers()}
})

test('embedded app history presents a safety pause and resumes with its observed generation',async()=>{
 const safety={generation:'seen',failure_streak:3,paused_at:'now',pause_reason:'consecutive_failures'}
 const workflow=vi.fn().mockResolvedValueOnce({runs:[],workflow:{safety},canEdit:true}).mockResolvedValue({runs:[],workflow:{safety:{...safety,paused_at:null}},canEdit:true})
 const resumeWorkflow=vi.fn().mockResolvedValue({});let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow,resumeWorkflow}as any}/>)})
 await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
 expect(JSON.stringify(tree.toJSON())).toContain(t('Paused after three consecutive failures'))
 const resume=tree.root.findAllByType('button').find((b:any)=>b.children.includes(t('Resume after review')))
 await act(async()=>resume.props.onClick())
 expect(resumeWorkflow).toHaveBeenCalledWith('wf','seen')
 expect(JSON.stringify(tree.toJSON())).not.toContain(t('Paused after three consecutive failures'))
 act(()=>tree.unmount())
})
test('embedded history never offers a resume action to a reader',async()=>{
 const workflow=vi.fn().mockResolvedValue({runs:[],workflow:{safety:{generation:'seen',paused_at:'now'}},canEdit:false});let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow}as any}/>)})
 await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
 expect(JSON.stringify(tree.toJSON())).toContain(t('Paused after three consecutive failures'))
 expect(tree.root.findAllByType('button')).toHaveLength(1)
 act(()=>tree.unmount())
})

test('execution history groups runs by the start date',async()=>{
 const workflow=vi.fn().mockResolvedValue({runs:[
  {id:'newer-a',startedAt:'2026-10-24T12:00:00Z',status:'done',log:[]},
  {id:'newer-b',startedAt:'2026-10-24T08:00:00Z',status:'failed',log:[]},
  {id:'older',startedAt:'2026-10-22T23:00:00Z',status:'done',log:[]},
 ]});let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow}as any}/>)})
 await act(async()=>refresh(tree).props.onClick())
 expect(tree.root.findAllByProps({className:'hx-run-day'})).toHaveLength(2)
 expect(tree.root.findAllByType('h4')).toHaveLength(2)
 expect(JSON.stringify(tree.toJSON())).toContain('newer-a')
 expect(JSON.stringify(tree.toJSON())).toContain('newer-b')
 expect(JSON.stringify(tree.toJSON())).toContain('older')
 act(()=>tree.unmount())
})

test('failed-only filter shows matching runs and a clear empty state',async()=>{
 const workflow=vi.fn().mockResolvedValue({runs:[
  {id:'good-run',startedAt:'2026-10-24T12:00:00Z',status:'done',log:[]},
  {id:'bad-run',startedAt:'2026-10-22T12:00:00Z',status:'failed',log:[]},
 ]});let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow}as any}/>)})
 await act(async()=>refresh(tree).props.onClick())
 const filter=()=>tree.root.findAllByType('button').find((button:any)=>button.props['aria-pressed']!==undefined)
 await act(async()=>filter().props.onClick())
 expect(filter().props['aria-pressed']).toBe(true)
 expect(JSON.stringify(tree.toJSON())).toContain('bad-run')
 expect(JSON.stringify(tree.toJSON())).not.toContain('good-run')
 await act(async()=>filter().props.onClick())
 expect(filter().props['aria-pressed']).toBe(false)
 expect(JSON.stringify(tree.toJSON())).toContain('good-run')
 const onlyGood=vi.fn().mockResolvedValue({runs:[{id:'good-only',startedAt:'2026-10-24T12:00:00Z',status:'done',log:[]}]})
 act(()=>tree.update(<AutomationRuns workflowId="next" api={{workflow:onlyGood}as any}/>))
 await act(async()=>refresh(tree).props.onClick())
 await act(async()=>filter().props.onClick())
 expect(JSON.stringify(tree.toJSON())).toContain(t('No failed runs.'))
 act(()=>tree.unmount())
})

test('execution history distinguishes verified revisions from unknown provenance',async()=>{
 const workflow=vi.fn().mockResolvedValue({runs:[
  {id:'versioned',startedAt:'2026-10-24T12:00:00Z',status:'done',definitionRevision:4,definitionSnapshotAvailable:true,log:[]},
  {id:'unmatched',startedAt:'2026-10-24T11:00:00Z',status:'done',definitionRevision:null,definitionSnapshotAvailable:true,log:[]},
  {id:'no-snapshot',startedAt:'2026-10-24T10:00:00Z',status:'done',definitionRevision:null,definitionSnapshotAvailable:false,log:[]},
 ]});let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow}as any}/>)})
 await act(async()=>refresh(tree).props.onClick())
 const rendered=JSON.stringify(tree.toJSON())
 expect(rendered).toContain(t('Version {version}',{version:4}))
 expect(rendered).toContain(t('Version not recorded'))
 expect(rendered).toContain(t('Original definition snapshot unavailable'))
 act(()=>tree.unmount())
})


test.each([
 ['en','consecutive_failures','Paused after three consecutive failures','Review the failed runs below before resuming. Held events will not replay automatically.','Resume after review'],
 ['ja','consecutive_failures','3回連続の失敗により自動停止しました','下の実行履歴で失敗内容を確認してから再開してください。保留イベントは自動再生されません。','確認して再開'],
 ['en','budget_daily','Paused by run budget','This workflow can run on its next trigger after its run budget window resets or the limit is raised.',null],
 ['ja','budget_daily','実行回数の上限で停止中','実行上限の期間が更新されるか上限が引き上げられると、次のトリガーから再開できます。',null],
 ['en','budget_ai_24h','Paused by estimated AI usage budget','This workflow can run on its next trigger after its AI usage budget window resets or the limit is raised.',null],
 ['ja','budget_ai_24h','AI使用量の概算上限で停止中','AI使用量の上限期間が更新されるか上限が引き上げられると、次のトリガーから再開できます。',null],
 ['en','budget_ai_unpriced','Paused by estimated AI usage budget','AI usage could not be priced. This workflow can resume after the unpriced usage leaves its rolling window or the limit is changed.',null],
 ['ja','budget_ai_unpriced','AI使用量の概算上限で停止中','AI使用量の単価を判定できませんでした。単価不明の記録が直近期間から外れるか、上限設定を変更すると次のトリガーから再開します。',null],
])('safety pause is localized in %s for %s',async(locale,reason,title,description,resumeLabel)=>{
 const storage=new Map<string,string>()
 vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key)||null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)})
 const safety={generation:'observed',paused_at:'now',pause_reason:reason}
 const workflow=vi.fn().mockResolvedValue({runs:[],workflow:{safety},canEdit:true})
 const resumeWorkflow=vi.fn().mockResolvedValue({})
 let tree:any
 try {
  await act(async()=>{changeLocale(locale);await localeReady();tree=create(<AutomationRuns workflowId="wf" api={{workflow,resumeWorkflow}as any}/>)})
  await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
  const status=tree.root.findAllByProps({role:'status'}).find((node:any)=>node.type==='section')
  expect(status.findByType('strong').children.join('')).toBe(title)
  expect(status.findByType('p').children.join('')).toBe(description)
  const buttons=status.findAllByType('button')
  if(resumeLabel){expect(buttons).toHaveLength(1);expect(buttons[0].children.join('')).toBe(resumeLabel);await act(async()=>buttons[0].props.onClick());expect(resumeWorkflow).toHaveBeenCalledWith('wf','observed')}
  else {expect(buttons).toHaveLength(0);expect(resumeWorkflow).not.toHaveBeenCalled()}
 } finally {if(tree)act(()=>tree.unmount());changeLocale('en');vi.unstubAllGlobals()}
})

test('a reader never gets the localized resume action',async()=>{
 const storage=new Map<string,string>()
 vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key)||null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)})
 let tree:any
 try {
  await act(async()=>{changeLocale('ja');await localeReady();tree=create(<AutomationRuns workflowId="wf" api={{workflow:vi.fn().mockResolvedValue({runs:[],workflow:{safety:{generation:'seen',paused_at:'now',pause_reason:'consecutive_failures'}},canEdit:false})}as any}/>)})
  await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
  const status=tree.root.findAllByProps({role:'status'}).find((node:any)=>node.type==='section')
  expect(status.findByType('strong').children.join('')).toBe('3回連続の失敗により自動停止しました')
  expect(status.findAllByType('button')).toHaveLength(0)
 } finally {if(tree)act(()=>tree.unmount());changeLocale('en');vi.unstubAllGlobals()}
})
