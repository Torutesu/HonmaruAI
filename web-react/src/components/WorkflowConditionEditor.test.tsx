import React,{useState} from 'react'
import {act,create,type ReactTestRenderer} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {WorkflowConditionEditor,blankCondition} from './WorkflowConditionEditor'
import {changeLocale,localeReady} from '../utils/i18n'
import type {WorkflowCondition} from '../utils/harness'
let tree:ReactTestRenderer
let current:WorkflowCondition
function Editor({initial=blankCondition()}:{initial?:WorkflowCondition}){const [value,setValue]=useState(initial);current=value;return <WorkflowConditionEditor value={value} onChange={setValue}/>}
afterEach(()=>{if(tree)act(()=>tree.unmount())})
const field=(label:string)=>tree.root.findByProps({'aria-label':label})
const change=(label:string,value:string)=>act(()=>field(label).props.onChange({target:{value}}))
test('edits numeric conditions without coercing an empty value into zero',()=>{
 act(()=>{tree=create(<Editor/>)})
 change("Condition field",'invoice.amount');change("Condition comparison",'gte');change("Comparison value",'12.5')
 expect(current).toEqual({path:['input','invoice','amount'],op:'gte',value:12.5})
 change("Comparison value",'');expect('value'in current&&current.value).toBe('')
})
test('wraps existing predicates without losing them and edits typed membership candidates',()=>{
 const predicate:WorkflowCondition={path:['row','status'],op:'eq',value:'open'}
 act(()=>{tree=create(<Editor initial={predicate}/>)})
 change("Condition combination",'not');expect(current).toEqual({not:predicate})
 act(()=>tree.unmount());act(()=>{tree=create(<Editor initial={predicate}/>)})
 change("Condition comparison",'in');expect(current).toEqual({...predicate,op:'in',value:['open']})
 const add=tree.root.findAllByType('button').find(button=>button.props.children==="Add a candidate")!
 act(()=>add.props.onClick());change('Type of Candidate 2','boolean')
 expect(current).toEqual({...predicate,op:'in',value:['open',true]})
})
test('rejects an extra nesting level without replacing the existing expression',()=>{
 let nested=blankCondition();for(let i=0;i<8;i++)nested={not:nested}
 act(()=>{tree=create(<Editor initial={nested}/>)})
 const selectors=tree.root.findAllByProps({'aria-label':"Condition combination"})
 act(()=>selectors[selectors.length-1].props.onChange({target:{value:'not'}}))
 expect(current).toEqual(nested);expect(tree.root.findByProps({role:'alert'}).children.join('')).toContain('8 nesting')
})

test('selects stable column IDs for current and previous record conditions, including nested groups',()=>{
 const initial:WorkflowCondition={all:[{path:['row','old.name'],op:'eq',value:'open'}]}
 let selected=initial as WorkflowCondition
 const columns=[{id:'col_status',name:'Status.v2',type:'text' as const}]
 act(()=>{tree=create(<WorkflowConditionEditor value={initial} columns={columns} onChange={value=>{selected=value}}/>)})
 change("Record column",'col_status')
 expect(selected).toEqual({all:[{path:['row','col_status'],op:'eq',value:'open'}]})
 act(()=>tree.update(<WorkflowConditionEditor value={{path:['before','col_status'],op:'eq',value:'open'}} columns={columns} onChange={value=>{selected=value}}/>))
 expect(field("Record column").props.value).toBe('col_status')
 change("Record column",'col_status')
 expect(selected).toEqual({path:['before','col_status'],op:'eq',value:'open'})
})

test('changes condition labels with the application locale',async()=>{
 const storage=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key)||null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)})
 try {
  await act(async()=>{changeLocale('ja');await localeReady();tree=create(<Editor/>)})
  expect(field('条件の組み合わせ')).toBeTruthy()
  act(()=>changeLocale('en'))
  expect(field('Condition combination')).toBeTruthy()
 } finally {act(()=>changeLocale('en'));vi.unstubAllGlobals()}
})
