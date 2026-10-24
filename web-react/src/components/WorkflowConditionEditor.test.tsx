import React,{useState} from 'react'
import {act,create,type ReactTestRenderer} from 'react-test-renderer'
import {afterEach,expect,test} from 'vitest'
import {WorkflowConditionEditor,blankCondition} from './WorkflowConditionEditor'
import type {WorkflowCondition} from '../utils/harness'
let tree:ReactTestRenderer
let current:WorkflowCondition
function Editor({initial=blankCondition()}:{initial?:WorkflowCondition}){const [value,setValue]=useState(initial);current=value;return <WorkflowConditionEditor value={value} onChange={setValue}/>}
afterEach(()=>{if(tree)act(()=>tree.unmount())})
const field=(label:string)=>tree.root.findByProps({'aria-label':label})
const change=(label:string,value:string)=>act(()=>field(label).props.onChange({target:{value}}))
test('edits numeric conditions without coercing an empty value into zero',()=>{
 act(()=>{tree=create(<Editor/>)})
 change('条件の項目','invoice.amount');change('条件の比較方法','gte');change('比較する値','12.5')
 expect(current).toEqual({path:['input','invoice','amount'],op:'gte',value:12.5})
 change('比較する値','');expect('value'in current&&current.value).toBe('')
})
test('wraps existing predicates without losing them and edits typed membership candidates',()=>{
 const predicate:WorkflowCondition={path:['row','status'],op:'eq',value:'open'}
 act(()=>{tree=create(<Editor initial={predicate}/>)})
 change('条件の組み合わせ','not');expect(current).toEqual({not:predicate})
 act(()=>tree.unmount());act(()=>{tree=create(<Editor initial={predicate}/>)})
 change('条件の比較方法','in');expect(current).toEqual({...predicate,op:'in',value:['open']})
 const add=tree.root.findAllByType('button').find(button=>button.props.children==='候補を追加')!
 act(()=>add.props.onClick());change('候補2の種類','boolean')
 expect(current).toEqual({...predicate,op:'in',value:['open',true]})
})
test('rejects an extra nesting level without replacing the existing expression',()=>{
 let nested=blankCondition();for(let i=0;i<8;i++)nested={not:nested}
 act(()=>{tree=create(<Editor initial={nested}/>)})
 const selectors=tree.root.findAllByProps({'aria-label':'条件の組み合わせ'})
 act(()=>selectors[selectors.length-1].props.onChange({target:{value:'not'}}))
 expect(current).toEqual(nested);expect(tree.root.findByProps({role:'alert'}).children.join('')).toContain('8段')
})
