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
