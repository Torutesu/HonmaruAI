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
