import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {StepEditor} from './WorkflowStepEditor'
test('follow-up editing retains minute precision and preserves the other step fields',()=>{
 let tree:any;const onChange=vi.fn();const step={type:'followup' as const,minutes:90,channel:'b:ops',text:'Check again'}
 act(()=>{tree=create(<StepEditor step={step} onChange={onChange} onRemove={()=>{}} tables={[]} agents={[]}/>)})
 const delay=tree.root.findAllByType('input').find((input:any)=>input.props.type==='number')
 expect(delay.props.value).toBe(90)
 act(()=>delay.props.onChange({target:{value:'15'}}))
 expect(onChange).toHaveBeenCalledWith({...step,minutes:15})
 act(()=>tree.unmount())
})

test('changing the action preserves its execution condition and discards obsolete action fields',()=>{
 const when={path:['input','amount'],op:'gt' as const,value:100};const onChange=vi.fn();let tree:any
 act(()=>{tree=create(<StepEditor step={{type:'post',channel:'b:ops',text:'Review',when}} onChange={onChange} onRemove={()=>{}} tables={[]} agents={[]}/>)})
 const select=tree.root.findAllByType('select').find((node:any)=>node.props.value==='post')
 act(()=>select.props.onChange({target:{value:'approval'}}));expect(onChange).toHaveBeenCalledWith({type:'approval',when})
 act(()=>tree.unmount())
})

test('connection actions include native read-only searches and explicitly granted Remote MCP tools',()=>{
 const onChange=vi.fn();let tree:any
 act(()=>{tree=create(<StepEditor step={{type:'connection',agentId:'a1',source:'notion',action:'search',query:'policy'}} onChange={onChange} onRemove={()=>{}} tables={[]} agents={[{id:'a1',handle:'policy',name:'Policy Agent'}]}/>)})
 const selects=tree.root.findAllByType('select')
 expect(selects.some((node:any)=>node.props['aria-label']==='Agent')).toBe(true)
 const connection=selects.find((node:any)=>node.props['aria-label']==='Connection')
 expect(connection.findAllByType('option').map((node:any)=>node.props.value)).toEqual(['notion','github','remote_mcp'])
 expect(tree.root.findAllByType('textarea').some((node:any)=>node.props['aria-label']==='Search query')).toBe(true)
 act(()=>tree.unmount())
})

test('Remote MCP Workflow steps choose an Agent-granted tool and store JSON arguments',async()=>{
 const onChange=vi.fn();const api:any={agentApps:vi.fn().mockResolvedValue({remoteMcpConnections:[{serverId:'mcp-1',name:'Knowledge',available:true,enabled:false,readOnlyToolCount:1,tools:[{name:'search_policy',title:'Search policy',description:'Search the approved policy source.',enabled:true}]}]})};let tree:any,step:any={type:'connection',source:'remote_mcp',agentId:'a1',args:{}}
 const renderEditor=()=> <StepEditor api={api} step={step} onChange={next=>{step=next;onChange(next)}} onRemove={()=>{}} tables={[]} agents={[{id:'a1',handle:'policy',name:'Policy Agent'}]}/>
 await act(async()=>{tree=create(renderEditor())})
 expect(api.agentApps).toHaveBeenCalledWith('a1')
 const connection=()=>tree.root.findByProps({'aria-label':'Remote MCP connection'})
 act(()=>connection().props.onChange({target:{value:'mcp-1'}}))
 act(()=>tree.update(renderEditor()))
 const tool=()=>tree.root.findByProps({'aria-label':'Remote MCP tool'})
 act(()=>tool().props.onChange({target:{value:'search_policy'}}))
 act(()=>tree.update(renderEditor()))
 const argumentsInput=()=>tree.root.findByProps({'aria-label':'Remote MCP arguments (JSON)'})
 act(()=>argumentsInput().props.onChange({target:{value:'{"query":"{{input.query}}"}'}}))
 expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({serverId:'mcp-1',toolName:'search_policy',args:{query:'{{input.query}}'}}))
 act(()=>tree.unmount())
})

test('app automation program editing uses the source editor without converting to a form step',async()=>{
 const step={type:'code' as const,code:'console.log("saved");',gatewayId:'mini'};
 const onChange=vi.fn(),api:any={gateways:vi.fn().mockResolvedValue({gateways:[{id:'mini',name:'Mac mini',revokedAt:null}]})};let tree:any;
 await act(async()=>{tree=create(<StepEditor api={api} step={step} onChange={onChange} onRemove={()=>{}} tables={[]} agents={[]}/>)});
 const source=tree.root.findByType('textarea');expect(source.props.value).toBe(step.code);
 act(()=>source.props.onChange({target:{value:'console.log("edited");'}}));
 expect(onChange).toHaveBeenCalledWith({...step,code:'console.log("edited");'});
 expect(tree.root.findAllByType('option').some((option:any)=>option.props.value==='post')).toBe(false);
 act(()=>tree.unmount());
});

test.each(['add_row','update_row'] as const)('%s displays zero and false without changing saved value types', type => {
 const table = {id:'tasks',name:'Tasks',columns:[{id:'quantity',name:'Quantity',type:'number'},{id:'approved',name:'Approved',type:'checkbox'},{id:'note',name:'Note',type:'text'}]} as any
 const step = {type,tableId:'tasks',values:{quantity:0,approved:false,note:'旧'}}
 const onChange=vi.fn();let tree:any
 act(()=>{tree=create(<StepEditor step={step} onChange={onChange} onRemove={()=>{}} tables={[table]} agents={[]} triggerTable={table}/> )})
 const valueFor=(label:string)=>tree.root.findAllByType('label').find((entry:any)=>entry.findAllByType('span').some((span:any)=>span.children.includes(label))).findByType('input')
 expect(valueFor('Quantity').props.value).toBe('0')
 expect(valueFor('Approved').props.value).toBe('false')
 act(()=>valueFor('Note').props.onChange({target:{value:'日本語の更新'}}))
 expect(onChange).toHaveBeenLastCalledWith({...step,values:{quantity:0,approved:false,note:'日本語の更新'}})
 act(()=>valueFor('Approved').props.onChange({target:{value:'true'}}))
 expect(onChange).toHaveBeenLastCalledWith({...step,values:{quantity:0,approved:'true',note:'旧'}})
 act(()=>tree.unmount())
})
