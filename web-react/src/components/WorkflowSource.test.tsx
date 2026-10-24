import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {WorkflowSource} from './WorkflowSource'
vi.mock('../utils/i18n',()=>({useT:()=>((s:string)=>s)}))
const root={id:'root',channel:'b:ops',body:'Create the invoice automation',createdAt:'2026-10-24T00:00:00Z'}
test('source selection previews the thread and only binds after explicit selection and save',async()=>{
 const api={workflowSource:vi.fn().mockResolvedValue({source:null,canBind:true,candidates:[root],nextCursor:null}),bindWorkflowSource:vi.fn().mockResolvedValue({source:{...root,threadId:root.id},canBind:false,candidates:[],nextCursor:null})}as any
 let tree:any;act(()=>{tree=create(<WorkflowSource api={api} workflowId="wf"/>)})
 await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
 const save=()=>tree.root.findAllByType('button').find((b:any)=>b.children.includes('Use selected thread'))
 expect(save().props.disabled).toBe(true)
 act(()=>tree.root.findByType('input').props.onChange())
 expect(api.bindWorkflowSource).not.toHaveBeenCalled()
 await act(async()=>save().props.onClick())
 expect(api.bindWorkflowSource).toHaveBeenCalledWith('wf','root')
 expect(JSON.stringify(tree.toJSON())).toContain('Failure notices are sent to this thread.')
 act(()=>tree.unmount())
})
test('older pages append candidates and viewers cannot select',async()=>{
 const api={workflowSource:vi.fn().mockResolvedValueOnce({source:null,canBind:true,candidates:[root],nextCursor:20}).mockResolvedValueOnce({source:null,canBind:true,candidates:[{...root,id:'older'}],nextCursor:null}).mockResolvedValue({source:null,canBind:false,candidates:[],nextCursor:null})}as any
 let tree:any;act(()=>{tree=create(<WorkflowSource api={api} workflowId="wf"/>)})
 await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
 await act(async()=>tree.root.findAllByType('button').find((b:any)=>b.children.includes('Load older threads')).props.onClick())
 expect(api.workflowSource).toHaveBeenLastCalledWith('wf',20)
 expect(tree.root.findAllByType('input')).toHaveLength(2)
 await act(async()=>tree.root.findAllByType('button').find((b:any)=>b.children.includes('Refresh')).props.onClick())
 expect(tree.root.findAllByType('input')).toHaveLength(0)
 expect(JSON.stringify(tree.toJSON())).toContain('Only the creator')
 act(()=>tree.unmount())
})

test('an expanded source picker reloads on workflow changes and ignores the old response',async()=>{
 let resolveOld:any
 const api={workflowSource:vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve})).mockResolvedValue({source:null,canBind:true,candidates:[{...root,id:'new',body:'New workflow source'}],nextCursor:null})}as any
 let tree:any;act(()=>{tree=create(<WorkflowSource api={api} workflowId="old"/>)})
 act(()=>{tree.root.findByType('details').props.onToggle({currentTarget:{open:true}})})
 await act(async()=>{tree.update(<WorkflowSource api={api} workflowId="new"/>)})
 expect(api.workflowSource).toHaveBeenLastCalledWith('new',undefined)
 await act(async()=>{resolveOld({source:null,canBind:true,candidates:[root],nextCursor:null})})
 expect(JSON.stringify(tree.toJSON())).toContain('New workflow source')
 expect(JSON.stringify(tree.toJSON())).not.toContain('Create the invoice automation')
 act(()=>tree.unmount())
})
