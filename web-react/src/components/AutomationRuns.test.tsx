import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {AutomationRuns} from './AutomationRuns'
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
 await act(async()=>tree.root.findByType('button').props.onClick())
 await act(async()=>tree.root.findByType('button').props.onClick())
 expect(JSON.stringify(tree.toJSON())).not.toContain('実行ID: ');expect(JSON.stringify(tree.toJSON())).toContain('Access changed')
 await act(async()=>tree.root.findByType('button').props.onClick())
 expect(JSON.stringify(tree.toJSON())).toContain('まだ実行されていません。');act(()=>tree.unmount())
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
 expect(tree.root.findByType('button').props.disabled).toBe(true)
 await act(async()=>resolveNew({runs:[{id:'current-new',startedAt:'2026-10-24T00:00:00Z',status:'done',log:[]}]}))
 expect(JSON.stringify(tree.toJSON())).toContain('current-new')
 expect(tree.root.findByType('button').props.disabled).toBe(false)
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
 await act(async()=>tree.root.findByType('button').props.onClick())
 expect(tree.root.findByType('span').props.title).toContain('承認待ち時間を含む')
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
  await act(async()=>tree.root.findByType('button').props.onClick())
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
 expect(JSON.stringify(tree.toJSON())).toContain('3回連続の失敗')
 const resume=tree.root.findAllByType('button').find((b:any)=>b.children.includes('確認して再開'))
 await act(async()=>resume.props.onClick())
 expect(resumeWorkflow).toHaveBeenCalledWith('wf','seen')
 expect(JSON.stringify(tree.toJSON())).not.toContain('3回連続の失敗')
 act(()=>tree.unmount())
})
test('embedded history never offers a resume action to a reader',async()=>{
 const workflow=vi.fn().mockResolvedValue({runs:[],workflow:{safety:{generation:'seen',paused_at:'now'}},canEdit:false});let tree:any
 act(()=>{tree=create(<AutomationRuns workflowId="wf" api={{workflow}as any}/>)})
 await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
 expect(JSON.stringify(tree.toJSON())).toContain('3回連続の失敗')
 expect(tree.root.findAllByType('button')).toHaveLength(1)
 act(()=>tree.unmount())
})
