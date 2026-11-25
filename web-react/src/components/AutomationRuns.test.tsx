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
test('execution history shows a structured effect receipt without copying payload data into it',async()=>{
 const workflow=vi.fn().mockResolvedValue({runs:[{id:'run-receipt',startedAt:'2026-10-24T00:00:00Z',status:'done',log:[{step:1,type:'post',status:'ok',output:'Private message body',effectReceipt:{operation:'post',effect:'external',target:'conversation',outcome:'completed'}}]}]});let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow}as any}/>)})
 await act(async()=>refresh(tree).props.onClick())
 const text=JSON.stringify(tree.toJSON())
 expect(text).toContain(t('Effect receipt'));expect(text).toContain(t('External action'));expect(text).toContain(t('Conversation'));expect(text).toContain(t('Completed'));expect(text).toContain('Private message body')
 act(()=>tree.unmount())
})
test('execution history shows body-free receipts for ordered external Workflow writes',async()=>{
 const workflow=vi.fn().mockResolvedValue({runs:[{id:'run-external-writes',startedAt:'2026-10-24T00:00:00Z',status:'failed',log:[{step:1,type:'code',status:'failed',error:'External request did not complete.',externalWrites:[{appId:'app-private',name:'billing_api',method:'POST',operationId:'create-invoice',status:'sent'},{appId:'app-private',name:'billing_api',method:'POST',operationId:'send-invoice',status:'unknown'},{appId:'app-private',name:'billing_api',method:'POST',operationId:'notify-customer',status:'not_sent'}]}]}]});let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow}as any}/>)})
 await act(async()=>refresh(tree).props.onClick())
 const text=JSON.stringify(tree.toJSON())
 expect(text).toContain(t('External write receipts'))
 expect(text).toContain('create-invoice');expect(text).toContain('send-invoice');expect(text).toContain('notify-customer')
 expect(text).toContain(t('Sent'));expect(text).toContain(t('Outcome unknown'));expect(text).toContain(t('Not sent'))
 expect(text).toContain(t('Request bodies and credentials are not retained in these receipts.'))
 expect(text).not.toContain('app-private');expect(text).not.toContain('private-body');expect(text).not.toContain('access_token')
 act(()=>tree.unmount())
})
test('execution history exposes only the sanitized input template in a collapsed details section',async()=>{
 const workflow=vi.fn().mockResolvedValue({runs:[{id:'run-input',startedAt:'2026-10-24T00:00:00Z',status:'done',log:[{step:1,type:'post',status:'ok',inputPreview:{mode:'template',input:{text:'Hello {{input.customer}}'},note:'Runtime record, message, and connection values are not retained.'}}]}]});let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow}as any}/>)})
 await act(async()=>refresh(tree).props.onClick())
 const preview=tree.root.findAllByType('details').find((details:any)=>details.props.className==='hx-run-input-preview')
 expect(preview.props.open).toBeUndefined()
 const rendered=JSON.stringify(tree.toJSON())
 expect(rendered).toContain(t('Post in a room'))
 expect(rendered).toContain(t('Input template'))
 expect(rendered).toContain('{{input.customer}}')
 expect(rendered).toContain(t('Runtime record, message, and connection values are not retained.'))
 expect(rendered).not.toContain('runtime-secret-value')
 act(()=>tree.unmount())
})
test('execution history explains when the sanitized input preview was omitted',async()=>{
 const workflow=vi.fn().mockResolvedValue({runs:[{id:'run-input-omitted',startedAt:'2026-10-24T00:00:00Z',status:'done',log:[{step:2,type:'post',status:'ok',inputPreview:{mode:'template',omitted:true,reason:'run_limit'}}]}]});let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow}as any}/>)})
 await act(async()=>refresh(tree).props.onClick())
 const rendered=JSON.stringify(tree.toJSON())
 expect(rendered).toContain(t('Preview omitted because the run trace size limit was reached.'))
 expect(rendered).not.toContain('undefined')
 act(()=>tree.unmount())
})
test('failed App automation runs link back to their source chat only when it is still accessible',async()=>{
 const workflow=vi.fn().mockResolvedValue({runs:[{id:'failed',startedAt:'2026-10-24T00:00:00Z',status:'failed',log:[]}]})
 const workflowSource=vi.fn().mockResolvedValue({source:{threadId:'source-thread',channel:'b:ops'}});let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" orgId="org-1" api={{workflow,workflowSource}as any}/>)})
 await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
 expect(workflowSource).toHaveBeenCalledWith('wf',undefined,false)
 expect(tree.root.findAllByType('a').map((link:any)=>link.props.href)).toContain('#/t/source-thread/org-1')
 act(()=>tree.unmount())
 const inaccessible={workflow:vi.fn().mockResolvedValue({runs:[{id:'failed',startedAt:'2026-10-24T00:00:00Z',status:'failed',log:[]}]}),workflowSource:vi.fn().mockResolvedValue({source:null})}
 act(()=>{tree=create(<AutomationRuns workflowId="wf" orgId="org-1" api={inaccessible as any}/>)})
 await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
 expect(tree.root.findAllByType('a')).toHaveLength(0)
 act(()=>tree.unmount())
})
test('embedded automation history displays the shared seven-day overview',async()=>{
 const workflow=vi.fn().mockResolvedValue({runs:[],summary:{windowStart:'2026-10-17T00:00:00Z',windowEnd:'2026-10-24T00:00:00Z',timezone:'UTC',windowHours:168,runCount:12,failedCount:2,completedDurationCount:10,typicalDurationMs:90000,usage:{trackedRuns:8,calls:5,inputTokens:100,outputTokens:50,unknownCalls:1,unpricedCalls:1,estimatedMicros:12345},truncated:false}});let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow}as any}/>)})
 await act(async()=>tree.root.findByType('button').props.onClick())
 const text=JSON.stringify(tree.toJSON())
 expect(text).toContain(t('Last 7 days'))
 expect(text).toContain(t('Typical duration'))
 expect(text).toContain(t('Estimated AI usage'))
 expect(text).toContain(t('{count} failed runs',{count:'2'}))
 expect(text).toContain(t('Provider-reported token estimate only. This is not provider credits or an invoice; unpriced and unreported usage is excluded.'))
 expect(text).toContain(t('{count} unpriced calls',{count:'1'}))
 expect(text).toContain(t('{count} calls with unknown token usage',{count:'1'}))
 act(()=>tree.unmount())
})
test('execution history shows the workspace-resolved run actor',async()=>{
 const workflow=vi.fn().mockResolvedValue({runs:[{id:'run-actor',startedAt:'2026-10-24T00:00:00Z',status:'done',startedByName:'Mika',log:[]}]});let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow}as any}/>)})
 await act(async()=>refresh(tree).props.onClick())
 const rendered=JSON.stringify(tree.toJSON())
 expect(rendered).toContain(t('Run by'))
 expect(rendered).toContain('Mika')
 act(()=>tree.unmount())
})
test('execution history displays staged workflow message drafts without treating them as posted replies',async()=>{
 const workflow=vi.fn().mockResolvedValue({runs:[{id:'run-draft',startedAt:'2026-10-24T00:00:00Z',status:'done',log:[{step:1,type:'code',status:'done',output:'diagnostic output',messages:[{text:'The review is ready.',mention:['mika','toru']}]}]}]});let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow}as any}/>)})
 await act(async()=>refresh(tree).props.onClick())
 const text=JSON.stringify(tree.toJSON())
 expect(text).toContain(t('Draft messages'))
 expect(text).toContain('The review is ready.')
 expect(text).toContain('mika, toru')
 expect(text).toContain('diagnostic output')
 act(()=>tree.unmount())
})
test('run history shows resolved authorization actor names but never raw actor IDs',async()=>{
 const workflow=vi.fn().mockResolvedValue({runs:[{id:'run-auth',startedAt:'2026-10-24T00:00:00Z',status:'failed',log:[{step:1,type:'post',status:'failed',at:'2026-10-24T00:00:01Z',authorization:[{actorName:'Mika',actorId:'9302',resourceType:'conversation',resourceId:'b:ops',outcome:'denied',checkedAt:'2026-10-24T00:00:01Z'},{actorId:'unresolved-user',resourceType:'member',resourceId:'9301',outcome:'allowed',checkedAt:'2026-10-24T00:00:02Z'}]}]}]});let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow}as any}/>)});
 await act(async()=>refresh(tree).props.onClick())
 const text=JSON.stringify(tree.toJSON())
 expect(text).toContain(t('Access checks'))
 expect(text).toContain(t('Actor'))
 expect(text).toContain('Mika')
 expect(text).not.toContain('9302')
 expect(text).not.toContain('unresolved-user')
 expect(text).toContain(t('Conversation resource'))
 expect(text).toContain('9301')
 expect(text).toContain(t('Denied'))
 expect(text).toContain('2026-10-24T00:00:01Z')
 expect(text).not.toContain('prompt')
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
 expect(tree.root.findAllByType('button')).toHaveLength(2)
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

test('execution history appends keyset pages and the failed filter restarts at the first page',async()=>{
 const first={runs:[{id:'new-run',startedAt:'2026-10-24T12:00:00Z',status:'done',log:[]}],hasMore:true,nextCursor:'cursor-one'}
 const older={runs:[{id:'older-run',startedAt:'2026-10-22T12:00:00Z',status:'failed',log:[]}],hasMore:false,nextCursor:null}
 const failed={runs:[{id:'failed-first',startedAt:'2026-10-24T11:00:00Z',status:'failed',log:[]}],hasMore:false,nextCursor:null}
 const api={workflow:vi.fn().mockResolvedValue({runs:[]}),workflowRunsPage:vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(older).mockResolvedValueOnce(failed)};let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" api={api as any}/>)})
 await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
 expect(JSON.stringify(tree.toJSON())).toContain('new-run')
 const olderButton=()=>tree.root.findAllByType('button').find((button:any)=>button.children.includes(t('Load older runs')))
 await act(async()=>olderButton().props.onClick())
 expect(api.workflowRunsPage).toHaveBeenNthCalledWith(2,'wf',{limit:50,cursor:'cursor-one'})
 expect(JSON.stringify(tree.toJSON())).toContain('older-run')
 const filter=()=>tree.root.findAllByType('button').find((button:any)=>button.props['aria-pressed']!==undefined)
 await act(async()=>filter().props.onClick())
 expect(api.workflowRunsPage).toHaveBeenNthCalledWith(3,'wf',{limit:50,status:'failed'})
 expect(JSON.stringify(tree.toJSON())).toContain('failed-first')
 expect(JSON.stringify(tree.toJSON())).not.toContain('new-run')
 act(()=>tree.unmount())
})

test('failed run history can load older matching runs after a filtered page',async()=>{
 const workflow=vi.fn().mockResolvedValue({runs:[]})
 const workflowRunsPage=vi.fn().mockResolvedValueOnce({runs:[],hasMore:false,nextCursor:null}).mockResolvedValueOnce({runs:[{id:'failed-one',startedAt:'2026-10-24T12:00:00Z',status:'failed',log:[]}],hasMore:true,nextCursor:'failed-cursor'}).mockResolvedValueOnce({runs:[{id:'failed-two',startedAt:'2026-10-23T12:00:00Z',status:'failed',log:[]}],hasMore:false,nextCursor:null})
 let tree:any;act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow,workflowRunsPage}as any}/>)})
 await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
 const filter=()=>tree.root.findAllByType('button').find((button:any)=>button.props['aria-pressed']!==undefined)
 await act(async()=>filter().props.onClick())
 expect(JSON.stringify(tree.toJSON())).toContain('failed-one')
 const older=()=>tree.root.findAllByType('button').find((button:any)=>button.children.includes(t('Load older runs')))
 await act(async()=>older().props.onClick())
 expect(workflowRunsPage).toHaveBeenLastCalledWith('wf',{limit:50,cursor:'failed-cursor',status:'failed'})
 expect(JSON.stringify(tree.toJSON())).toContain('failed-one')
 expect(JSON.stringify(tree.toJSON())).toContain('failed-two')
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
 ['en','budget_daily','Paused by run budget','Review the usage windows and budget settings. This workflow can run on its next trigger when all budget conditions are clear.',null],
 ['ja','budget_daily','実行回数の上限で停止中','使用量の対象期間と上限設定を確認してください。すべての上限の停止条件が解消すると、次のトリガーから実行できます。',null],
 ['en','budget_ai_24h','Paused by estimated AI usage budget','Review the usage windows and budget settings. This workflow can run on its next trigger when all budget conditions are clear.',null],
 ['ja','budget_ai_24h','AI使用量の概算上限で停止中','使用量の対象期間と上限設定を確認してください。すべての上限の停止条件が解消すると、次のトリガーから実行できます。',null],
 ['en','budget_ai_unpriced','Paused by estimated AI usage budget','Some AI usage could not be priced. Review the usage windows and budget settings. This workflow can run on its next trigger when all budget conditions are clear.',null],
 ['ja','budget_ai_unpriced','AI使用量の概算上限で停止中','AI使用量の一部の単価を判定できませんでした。使用量の対象期間と上限設定を確認してください。すべての上限の停止条件が解消すると、次のトリガーから実行できます。',null],
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

test('workflow makers can inspect queued payloads and explicitly replay selected webhook events',async()=>{
 const held={count:2,oldestExpiry:'2026-10-25T00:00:00Z',pageOffset:0,previousOffset:null,nextOffset:null,events:[
  {id:'held-one',receivedAt:'2026-10-24T00:00:00Z',expiresAt:'2026-10-31T00:00:00Z'},
  {id:'held-two',receivedAt:'2026-10-24T01:00:00Z',expiresAt:'2026-10-31T01:00:00Z'},
 ]}
 const api={workflow:vi.fn().mockResolvedValue({workflow:{trigger:{type:'webhook'}},runs:[],canEdit:true,held}),heldWorkflowEvent:vi.fn().mockResolvedValue({event:{id:'held-one',receivedAt:held.events[0].receivedAt,expiresAt:held.events[0].expiresAt,input:{order:'42',private:'payload-secret'}}}),replayWorkflowEvents:vi.fn().mockResolvedValue({runs:[{eventId:'held-one',runId:'run-new',status:'running'}],skipped:0}),discardWorkflowEvents:vi.fn()};let tree:any
 vi.stubGlobal('confirm',vi.fn(()=>true))
 try{
  act(()=>{tree=create(<AutomationRuns workflowId="wf" api={api as any}/>)})
  await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
  let rendered=JSON.stringify(tree.toJSON())
  expect(rendered).toContain(t('Held webhook events'))
  expect(rendered).toContain('held-one')
  expect(rendered).not.toContain('payload-secret')
  const review=()=>tree.root.findAllByType('button').find((button:any)=>button.children.includes(t('Review payload')))
  await act(async()=>review().props.onClick())
  expect(api.heldWorkflowEvent).toHaveBeenCalledWith('wf','held-one')
  expect(JSON.stringify(tree.toJSON())).toContain('payload-secret')
  const checkbox=tree.root.findAllByType('input').find((input:any)=>input.props.type==='checkbox')
  act(()=>checkbox.props.onChange())
  const replay=tree.root.findAllByType('button').find((button:any)=>button.children.includes(t('Replay selected')))
  await act(async()=>replay.props.onClick())
  expect(api.replayWorkflowEvents).toHaveBeenCalledWith('wf',['held-one'])
  expect(JSON.stringify(tree.toJSON())).toContain(t('Started {count} held event(s); {skipped} were skipped.',{count:1,skipped:0}))
 }finally{if(tree)act(()=>tree.unmount());vi.unstubAllGlobals()}
})

test('held webhook discard requires confirmation and is hidden from readers',async()=>{
 const held={count:1,oldestExpiry:null,pageOffset:0,previousOffset:null,nextOffset:null,events:[{id:'held-delete',receivedAt:'2026-10-24T00:00:00Z',expiresAt:'2026-10-31T00:00:00Z'}]}
 const api={workflow:vi.fn().mockResolvedValue({workflow:{trigger:{type:'webhook'}},runs:[],canEdit:true,held}),heldWorkflowEvent:vi.fn(),replayWorkflowEvents:vi.fn(),discardWorkflowEvents:vi.fn().mockResolvedValue({discarded:1})};let tree:any
 const confirm=vi.fn(()=>false);vi.stubGlobal('confirm',confirm)
 try{
  act(()=>{tree=create(<AutomationRuns workflowId="wf" api={api as any}/>)})
  await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
  let checkbox=tree.root.findByType('input');act(()=>checkbox.props.onChange())
  let discard=tree.root.findAllByType('button').find((button:any)=>button.children.includes(t('Discard selected')))
  await act(async()=>discard.props.onClick())
  expect(confirm).toHaveBeenCalled();expect(api.discardWorkflowEvents).not.toHaveBeenCalled()
  act(()=>tree.update(<AutomationRuns workflowId="wf" api={{workflow:vi.fn().mockResolvedValue({workflow:{trigger:{type:'webhook'}},runs:[],canEdit:false,held:undefined})}as any}/>))
  await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
  expect(JSON.stringify(tree.toJSON())).not.toContain('held-delete')
  expect(JSON.stringify(tree.toJSON())).not.toContain(t('Held webhook events'))
 }finally{if(tree)act(()=>tree.unmount());vi.unstubAllGlobals()}
})

test('held webhook queue pages forward the requested offset to the workflow API',async()=>{
 const first={count:30,oldestExpiry:'2026-10-25T00:00:00Z',pageOffset:0,previousOffset:null,nextOffset:25,events:[{id:'page-one',receivedAt:'2026-10-24T00:00:00Z',expiresAt:'2026-10-31T00:00:00Z'}]}
 const second={...first,pageOffset:25,previousOffset:0,nextOffset:null,events:[{id:'page-two',receivedAt:'2026-10-24T00:25:00Z',expiresAt:'2026-10-31T00:25:00Z'}]}
 const workflow=vi.fn().mockResolvedValueOnce({workflow:{trigger:{type:'webhook'}},runs:[],canEdit:true,held:first}).mockResolvedValue({workflow:{trigger:{type:'webhook'}},runs:[],canEdit:true,held:second});let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow}as any}/>)})
 await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
 expect(JSON.stringify(tree.toJSON())).toContain('page-one')
 const next=tree.root.findAllByType('button').find((button:any)=>button.children.includes(t('Next')))
 await act(async()=>next.props.onClick())
 expect(workflow).toHaveBeenLastCalledWith('wf',25)
 expect(JSON.stringify(tree.toJSON())).toContain('page-two')
 expect(JSON.stringify(tree.toJSON())).not.toContain('page-one')
 act(()=>tree.unmount())
})
