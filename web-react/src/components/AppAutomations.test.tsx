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

test('saving a delete trigger does not restore filters from the previous editing session',async()=>{
 const {AutomationTriggerEditor}=await import('./AutomationTriggerEditor')
 const row={type:'row',tableId:'table',on:'changed',column:'status',where:{status:['Open']}}
 const initial={...state,draft:{version:1,items:[{key:'review',...definition,trigger:row}]}}
 const saved={...initial,revision:3,draft:{version:1,items:[{...initial.draft.items[0],trigger:{type:'row',tableId:'table',on:'deleted'}}]}}
 const appAutomations=vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(saved)
 const saveAppAutomations=vi.fn().mockResolvedValue({saved:true})
 const tables=vi.fn().mockResolvedValue({tables:[{id:'table',name:'Tasks',columns:[{id:'status',name:'Status',type:'select',options:['Open']}]}]})
 const {tree,button}=await setup({appAutomations,saveAppAutomations,tables})
 const editor=()=>tree.root.findByType(AutomationTriggerEditor)
 await act(async()=>editor().findAllByType('select')[2].props.onChange({target:{value:'deleted'}}))
 expect(JSON.stringify(tree.toJSON())).toContain('下書きで条件が解除されています')
 await act(async()=>button('下書きを保存').props.onClick())
 expect(saveAppAutomations).toHaveBeenCalled()
 expect(editor().props.trigger.on).toBe('deleted')
 await act(async()=>editor().findAllByType('select')[2].props.onChange({target:{value:'changed'}}))
 expect(editor().props.trigger.where).toBeUndefined()
 expect(editor().props.trigger.column).toBeUndefined()
 expect(JSON.stringify(tree.toJSON())).toContain('以前の条件は復元されていません')
 await act(async()=>editor().findAllByType('select')[2].props.onChange({target:{value:'added'}}))
 await act(async()=>editor().findAllByType('select')[2].props.onChange({target:{value:'deleted'}}))
 await act(async()=>editor().findAllByType('select')[2].props.onChange({target:{value:'changed'}}))
 expect(JSON.stringify(tree.toJSON())).toContain('以前の条件は復元されていません')
 act(()=>tree.unmount())
})
test.each(['save','refresh'] as const)('a failed %s does not revive filters after submitting a delete trigger',async failure=>{
 const {AutomationTriggerEditor}=await import('./AutomationTriggerEditor')
 const row={type:'row',tableId:'table',on:'changed',column:'status',where:{status:['Open']}}
 const initial={...state,draft:{version:1,items:[{key:'review',...definition,trigger:row}]}}
 const appAutomations=vi.fn().mockResolvedValueOnce(initial).mockRejectedValue(new Error('offline'))
 const saveAppAutomations=failure==='save'?vi.fn().mockRejectedValue(new Error('offline')):vi.fn().mockResolvedValue({saved:true})
 const tables=vi.fn().mockResolvedValue({tables:[{id:'table',name:'Tasks',columns:[{id:'status',name:'Status',type:'select',options:['Open']}]}]})
 const {tree,button}=await setup({appAutomations,saveAppAutomations,tables})
 const editor=()=>tree.root.findByType(AutomationTriggerEditor)
 await act(async()=>editor().findAllByType('select')[2].props.onChange({target:{value:'deleted'}}))
 await act(async()=>button('下書きを保存').props.onClick())
 expect(saveAppAutomations).toHaveBeenCalled()
 expect(editor().props.trigger.on).toBe('deleted')
 expect(JSON.stringify(tree.toJSON())).toContain('下書きで条件が解除されています')
 await act(async()=>editor().findAllByType('select')[2].props.onChange({target:{value:'changed'}}))
 expect(editor().props.trigger.where).toBeUndefined()
 expect(editor().props.trigger.column).toBeUndefined()
 expect(JSON.stringify(tree.toJSON())).toContain('以前の条件は復元されていません')
 act(()=>tree.unmount())
})
test.each(['where','column'] as const)('warns before publishing after a saved %s condition was removed',async removed=>{
 const {AutomationTriggerEditor}=await import('./AutomationTriggerEditor')
 const row={type:'row',tableId:'table',on:'changed',column:'status',where:{status:['Open']}}
 const changed=removed==='where'?{...row,where:undefined}:{...row,column:undefined}
 const live={...definition,trigger:row}
 const declared={...definition,trigger:changed}
 const initial={...state,draft:{version:1,items:[{key:'review',...live}]},plan:[{key:'review',workflowId:'wf',status:'unchanged',declared:live,published:live,live}]}
 const saved={...initial,revision:3,draft:{version:1,items:[{key:'review',...declared}]},plan:[{key:'review',workflowId:'wf',status:'changed',declared,published:live,live}]}
 const appAutomations=vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(saved)
 const saveAppAutomations=vi.fn().mockResolvedValue({saved:true})
 const tables=vi.fn().mockResolvedValue({tables:[{id:'table',name:'Tasks',columns:[{id:'status',name:'Status',type:'select',options:['Open']}]}]})
 const {tree,button}=await setup({appAutomations,saveAppAutomations,tables})
 const editor=()=>tree.root.findByType(AutomationTriggerEditor)
 if(removed==='where')await act(async()=>editor().findAllByType('fieldset')[0].findByType('input').props.onChange({target:{checked:false}}))
 else await act(async()=>editor().findAllByType('select')[3].props.onChange({target:{value:''}}))
 expect(JSON.stringify(tree.toJSON())).toContain('下書きで条件が解除されています')
 await act(async()=>button('下書きを保存').props.onClick())
 expect(JSON.stringify(tree.toJSON())).toContain('公開中の処理から条件または監視列が解除されています')
 act(()=>tree.unmount())
})
test('rewriting an equivalent name alias does not falsely warn about a removed condition',async()=>{
 const {AutomationTriggerEditor}=await import('./AutomationTriggerEditor')
 const row={type:'row',tableId:'table',on:'changed',where:{Status:'Open'}}
 const source={...state,draft:{version:1,items:[{key:'review',...definition,trigger:row}]},plan:[]}
 const tables=vi.fn().mockResolvedValue({tables:[{id:'table',name:'Tasks',columns:[{id:'status',name:'Status',type:'select',options:['Open']}]}]})
 const {tree}=await setup({appAutomations:vi.fn().mockResolvedValue(source),tables})
 const editor=()=>tree.root.findByType(AutomationTriggerEditor)
 const choice=()=>editor().findAllByType('fieldset')[0].findByType('input')
 await act(async()=>choice().props.onChange({target:{checked:false}}))
 expect(JSON.stringify(tree.toJSON())).toContain('下書きで条件が解除されています')
 await act(async()=>choice().props.onChange({target:{checked:true}}))
 expect(editor().props.trigger.where).toEqual({status:['Open']})
 expect(JSON.stringify(tree.toJSON())).not.toContain('下書きで条件が解除されています')
 act(()=>tree.unmount())
})
test('removing one of two aliases on the same field still warns',async()=>{
 const {AutomationTriggerEditor}=await import('./AutomationTriggerEditor')
 const row={type:'row',tableId:'table',on:'changed',where:{Status:'Open',status:['Open']}}
 const source={...state,draft:{version:1,items:[{key:'review',...definition,trigger:row}]},plan:[]}
 const tables=vi.fn().mockResolvedValue({tables:[{id:'table',name:'Tasks',columns:[{id:'status',name:'Status',type:'select',options:['Open']}]}]})
 const {tree}=await setup({appAutomations:vi.fn().mockResolvedValue(source),tables})
 const editor=tree.root.findByType(AutomationTriggerEditor)
 await act(async()=>editor.findByProps({'aria-label':'Statusの条件を削除'}).props.onClick())
 expect(JSON.stringify(tree.toJSON())).toContain('下書きで条件が解除されています')
 act(()=>tree.unmount())
})
