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

test('natural-language generation adds an editable proposal without publishing it',async()=>{
 const generateAppAutomation=vi.fn().mockResolvedValue({automation:{key:'generated',...definition,enabled:false}})
 const {tree,api}=await setup({generateAppAutomation})
 await act(async()=>tree.root.findByType('form').findByType('textarea').props.onChange({target:{value:'毎週月曜日に確認する'}}))
 await act(async()=>tree.root.findByType('form').props.onSubmit({preventDefault(){}}))
 expect(generateAppAutomation).toHaveBeenCalledWith('app','毎週月曜日に確認する',expect.any(String))
 const {AutomationTriggerEditor}=await import('./AutomationTriggerEditor')
 expect(tree.root.findAllByType(AutomationTriggerEditor)).toHaveLength(2)
 expect(api.releaseAppAutomations).not.toHaveBeenCalled();act(()=>tree.unmount())
})

test('step order changes only in the draft and preserves every step value',async()=>{
 const second={type:'post',channel:'b:ops',text:'Second step'}
 const source={...state,draft:{version:1,items:[{key:'review',...definition,steps:[...definition.steps,second]}]}}
 const {tree,api}=await setup({appAutomations:vi.fn().mockResolvedValue(source)})
 const {StepEditor}=await import('./WorkflowStepEditor')
 const move=tree.root.findAllByType('button').find(b=>b.props['aria-label']==='2番目のステップを上へ')!
 await act(async()=>move.props.onClick())
 expect(tree.root.findAllByType(StepEditor).map(e=>e.props.step)).toEqual([second,definition.steps[0]])
 expect(source.draft.items[0].steps).toEqual([...definition.steps,second])
 expect(api.releaseAppAutomations).not.toHaveBeenCalled();act(()=>tree.unmount())
})

test('an external app version update preserves an unsaved automation draft',async()=>{
 const {tree,api}=await setup()
 const name=tree.root.findAllByType('input').find(i=>i.props.value==='Review')!
 await act(async()=>name.props.onChange({target:{value:'Unsaved local edit'}}))
 const calls=api.appAutomations.mock.calls.length
 await act(async()=>tree.update(<AppAutomations app={{id:'app',version:3,definition:{}}as any} api={api as any} reload={()=>{}}/>))
 expect(api.appAutomations.mock.calls.length).toBe(calls)
 expect(tree.root.findAllByType('input').some(i=>i.props.value==='Unsaved local edit')).toBe(true)
 expect(JSON.stringify(tree.toJSON())).toContain('未保存の下書きは保持しています')
 act(()=>tree.unmount())
})
