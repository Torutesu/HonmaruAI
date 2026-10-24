import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {AppAutomations} from './AppAutomations'
const definition={name:'Review',enabled:true,trigger:{type:'manual'},steps:[{type:'post',channel:'b:general',text:'Review'}]}
const state={version:2,revision:2,draft:{version:1,items:[{key:'review',...definition}]},published:{version:1,items:[]},plan:[{key:'review',workflowId:'wf',status:'drifted',declared:definition,published:definition,live:{...definition,name:'Independent edit'}}]}
async function setup(overrides={}) {
 const api={appAutomations:vi.fn().mockResolvedValue(state),workflows:vi.fn().mockResolvedValue({workflows:[]}),releaseAppAutomations:vi.fn().mockResolvedValue({saved:true}),...overrides}
 let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppAutomations app={{id:'app',version:2,definition:{}}as any} api={api as any} reload={()=>{}}/>)})
 const button=(text:string)=>tree!.root.findAllByType('button').find(b=>b.children.join('')===text)!
 return {tree:tree!,api,button}
}
test('drift publication requires explicit review and sends the exact observed definition',async()=>{
 const {tree,api,button}=await setup();expect(button('確認した内容を公開').props.disabled).toBe(true)
 const review=tree.root.findAllByType('input').filter(e=>e.props.type==='checkbox').at(-1)!
 await act(async()=>review.props.onChange({target:{checked:true}}))
 expect(button('確認した内容を公開').props.disabled).toBe(false)
 await act(async()=>button('確認した内容を公開').props.onClick())
 expect(api.releaseAppAutomations).toHaveBeenCalledWith('app',expect.objectContaining({reviewed:[{key:'review',workflowId:'wf',action:'replace',live:state.plan[0].live}]}))
 act(()=>tree.unmount())
})
test('state-only fallback retains stop while disabling publication',async()=>{
 const appAutomations=vi.fn().mockRejectedValueOnce(new Error('Live definition inaccessible')).mockResolvedValue({...state,plan:undefined})
 const {tree,api,button}=await setup({appAutomations})
 expect(appAutomations).toHaveBeenCalledWith('app',true);expect(button('確認した内容を公開').props.disabled).toBe(true)
 await act(async()=>button('自動化を停止').props.onClick())
 expect(api.releaseAppAutomations).toHaveBeenCalledWith('app',expect.objectContaining({action:'unpublish',reviewed:[]}))
 act(()=>tree.unmount())
})
test('retrying an uncertain release reuses the request identity',async()=>{
 const releaseAppAutomations=vi.fn().mockRejectedValueOnce(new Error('Network disconnected')).mockResolvedValue({saved:true})
 const {tree,button}=await setup({releaseAppAutomations})
 await act(async()=>button('自動化を停止').props.onClick())
 await act(async()=>button('自動化を停止').props.onClick())
 expect(releaseAppAutomations.mock.calls[0][1].requestId).toBe(releaseAppAutomations.mock.calls[1][1].requestId)
 act(()=>tree.unmount())
})

test('editing a step changes only the draft and blocks publication until saved',async()=>{
 const {StepEditor}=await import('./WorkflowStepEditor')
 const {tree,api,button}=await setup()
 const editor=tree.root.findByType(StepEditor)
 await act(async()=>editor.props.onChange({type:'post',channel:'b:ops',text:'Updated draft'}))
 expect(tree.root.findByType(StepEditor).props.step.text).toBe('Updated draft')
 expect(button('下書きを保存').props.disabled).toBe(false)
 expect(button('確認した内容を公開').props.disabled).toBe(true)
 expect(api.releaseAppAutomations).not.toHaveBeenCalled()
 act(()=>tree.unmount())
})

test('new app automation starts disabled and remains a local draft',async()=>{
 const {tree,api}=await setup()
 const add=tree.root.findAllByType('button').find(b=>b.children.includes(' 自動化を作成'))!
 await act(async()=>add.props.onClick())
 const {AutomationTriggerEditor}=await import('./AutomationTriggerEditor')
 expect(tree.root.findAllByType(AutomationTriggerEditor)).toHaveLength(2)
 const names=tree.root.findAllByType('input').filter(i=>i.props.value==='新しい自動化');expect(names).toHaveLength(1)
 expect(api.releaseAppAutomations).not.toHaveBeenCalled();act(()=>tree.unmount())
})
