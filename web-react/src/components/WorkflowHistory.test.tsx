import React from 'react'
import {act,create} from 'react-test-renderer'
import {test,expect,vi} from 'vitest'
import {WorkflowHistory} from './WorkflowHistory'
vi.mock('../utils/i18n',()=>({useT:()=> (s:string)=>s,t:(s:string)=>s}))
const definition={name:'Old name',enabled:false,trigger:{type:'manual'},steps:[],createdBy:'owner'}
const version=(revision:number,name:string)=>({revision,recordedAt:'2026-10-25T00:00:00Z',definition:{...definition,name}})
test('lazy history loading compares versions and paginates without resetting selection',async()=>{
 const api:any={workflowRevisions:vi.fn().mockResolvedValueOnce({items:[version(3,'New name'),version(2,'Old name')],nextCursor:2}).mockResolvedValueOnce({items:[version(1,'First name')],nextCursor:null})}
 let tree:any
 await act(async()=>{tree=create(<WorkflowHistory api={api} workflowId="wf"/> )})
 expect(api.workflowRevisions).not.toHaveBeenCalled()
 await act(async()=>{tree.root.findByType('details').props.onToggle({currentTarget:{open:true}})})
 expect(JSON.stringify(tree.toJSON())).toContain('Old name')
 expect(JSON.stringify(tree.toJSON())).toContain('New name')
 await act(async()=>{tree.root.findAllByType('button').find((b:any)=>b.children.includes('Load older versions')).props.onClick()})
 expect(api.workflowRevisions).toHaveBeenLastCalledWith('wf',2)
 expect(tree.root.findByProps({'aria-label':'Compare from'}).props.value).toBe(2)
 await act(async()=>{tree.root.findByProps({'aria-label':'Compare from'}).props.onChange({target:{value:'1'}})})
 expect(JSON.stringify(tree.toJSON())).toContain('First name')
 act(()=>tree.unmount())
})
test('a failed refresh removes cached history and permits retry',async()=>{
 const api:any={workflowRevisions:vi.fn().mockResolvedValueOnce({items:[version(1,'Private name')],nextCursor:null}).mockRejectedValueOnce(new Error('Access removed')).mockResolvedValueOnce({items:[],nextCursor:null})}
 let tree:any
 await act(async()=>{tree=create(<WorkflowHistory api={api} workflowId="wf"/>)})
 await act(async()=>{tree.root.findByType('details').props.onToggle({currentTarget:{open:true}})})
 const refresh=()=>tree.root.findAllByType('button').find((b:any)=>b.children.includes('Refresh')).props.onClick()
 await act(async()=>{refresh()})
 expect(tree.root.findAllByType('select')).toHaveLength(0)
 expect(JSON.stringify(tree.toJSON())).toContain('Access removed')
 await act(async()=>{refresh()})
 expect(JSON.stringify(tree.toJSON())).toContain('No accessible versions on this page.')
 act(()=>tree.unmount())
})

test('changed steps show readable conditions and resolve current table labels',async()=>{
 const old={...version(1,'Workflow'),definition:{...definition,steps:[{type:'add_row',tableId:'table',values:{amount:'100'},when:{path:['row','amount'],op:'gte',value:100}}]}}
 const latest={...version(2,'Workflow'),definition:{...old.definition,trigger:{type:'schedule',cadence:'daily',hour:9,minute:30,timezone:'UTC'},steps:[{...old.definition.steps[0],values:{amount:'200'}}]}}
 const api:any={workflowRevisions:vi.fn().mockResolvedValue({items:[latest,old],nextCursor:null})}
 let tree:any
 await act(async()=>{tree=create(<WorkflowHistory api={api} workflowId="wf" tables={[{id:'table',name:'Orders',columns:[{id:'amount',name:'Amount',type:'number'}]}]}/> )})
 await act(async()=>{tree.root.findByType('details').props.onToggle({currentTarget:{open:true}})})
 const rendered=JSON.stringify(tree.toJSON())
 expect(rendered).toContain('Add a row')
 expect(rendered).toContain('Orders')
 expect(rendered).toContain('Amount')
 expect(rendered).toContain('09:30 UTC')
 expect(rendered).toContain('≥ 100')
 expect(tree.root.findAllByType('pre')).toHaveLength(0)
 act(()=>tree.unmount())
})
