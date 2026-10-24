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
