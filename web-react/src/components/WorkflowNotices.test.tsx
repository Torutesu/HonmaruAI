import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {WorkflowNotices} from './WorkflowNotices'
vi.mock('../utils/i18n',()=>({useT:()=>((text:string)=>text)}))
const notice={workflowId:'wf',generation:'gen',runId:'run',createdAt:'2026-10-24T00:00:00Z',readAt:null,name:'Billing',paused:true}
test('notifications open the workflow without marking read, explicit acknowledgement uses the notice identity',async()=>{
 const api={workflowNotices:vi.fn().mockResolvedValueOnce({items:[notice]}).mockResolvedValue({items:[{...notice,readAt:'now'}]}),readWorkflowNotice:vi.fn().mockResolvedValue({ok:true})}as any
 const onOpen=vi.fn();let tree:any
 await act(async()=>{tree=create(<WorkflowNotices api={api} onOpen={onOpen}/>)})
 const button=(text:string)=>tree.root.findAllByType('button').find((b:any)=>b.children.includes(text))
 act(()=>button('Review workflow').props.onClick())
 expect(onOpen).toHaveBeenCalledWith('wf');expect(api.readWorkflowNotice).not.toHaveBeenCalled()
 await act(async()=>button('Mark as read').props.onClick())
 expect(api.readWorkflowNotice).toHaveBeenCalledWith('wf','gen')
 expect(button('Mark as read')).toBeUndefined();act(()=>tree.unmount())
})
test('switching accounts discards delayed notices, and a failed refresh clears old details',async()=>{
 let resolve:any;const oldApi={workflowNotices:vi.fn().mockReturnValue(new Promise(r=>resolve=r))}as any
 const nextApi={workflowNotices:vi.fn().mockResolvedValueOnce({items:[{...notice,name:'Current'}]}).mockRejectedValue(new Error('Revoked'))}as any
 let tree:any;const onOpen=vi.fn()
 await act(async()=>{tree=create(<WorkflowNotices api={oldApi} onOpen={onOpen}/>)})
 await act(async()=>tree.update(<WorkflowNotices api={nextApi} onOpen={onOpen}/>))
 await act(async()=>resolve({items:[notice]}))
 expect(JSON.stringify(tree.toJSON())).toContain('Current');expect(JSON.stringify(tree.toJSON())).not.toContain('Billing')
 await act(async()=>tree.root.findAllByType('button').find((b:any)=>b.children.includes('Refresh notifications')).props.onClick())
 expect(JSON.stringify(tree.toJSON())).toContain('Revoked');expect(JSON.stringify(tree.toJSON())).not.toContain('Current')
 act(()=>tree.unmount())
})
