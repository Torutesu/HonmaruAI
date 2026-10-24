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
