import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {AutomationTriggerEditor,type TriggerAppOption} from './AutomationTriggerEditor'
test('changing trigger kinds clears incompatible old configuration',()=>{
 const onChange=vi.fn();let tree:any
 act(()=>{tree=create(<AutomationTriggerEditor trigger={{type:'row',tableId:'old',on:'changed',where:{status:['Done']}}} tables={[]} onChange={onChange}/>)})
 act(()=>tree.root.findAllByType('select')[0].props.onChange({target:{value:'manual'}}))
 expect(onChange).toHaveBeenLastCalledWith({type:'manual'});act(()=>tree.unmount())
})
test('weekly schedules include an explicit weekday and retain timezone and time',()=>{
 const onChange=vi.fn();let tree:any
 act(()=>{tree=create(<AutomationTriggerEditor trigger={{type:'schedule',cadence:'daily',hour:14,minute:25,timezone:'Asia/Tokyo'}} tables={[]} onChange={onChange}/>)})
 act(()=>tree.root.findAllByType('select')[2].props.onChange({target:{value:'weekly'}}))
 expect(onChange).toHaveBeenLastCalledWith({type:'schedule',cadence:'weekly',weekday:1,hour:14,minute:25,timezone:'Asia/Tokyo'});act(()=>tree.unmount())
})
test('calendar, cron, interval and one-time schedules switch to explicit trigger shapes',()=>{
 const onChange=vi.fn();let tree:any
 act(()=>{tree=create(<AutomationTriggerEditor trigger={{type:'schedule',cadence:'daily',hour:14,minute:25,timezone:'Asia/Tokyo'}} tables={[]} onChange={onChange}/> )})
 const selects=tree.root.findAllByType('select')
 act(()=>selects[1].props.onChange({target:{value:'cron'}}))
 expect(onChange).toHaveBeenLastCalledWith({type:'schedule',kind:'cron',expr:'0 9 * * 1-5',timezone:'Asia/Tokyo'})
 act(()=>tree.update(<AutomationTriggerEditor trigger={{type:'schedule',kind:'every',everyMs:1800000}} tables={[]} onChange={onChange}/>))
 expect(tree.root.findAllByType('input').some((input:any)=>input.props['aria-label']==='Interval in minutes')).toBe(true)
 act(()=>tree.update(<AutomationTriggerEditor trigger={{type:'schedule',kind:'at',at:'2026-10-27T00:00:00.000Z'}} tables={[]} onChange={onChange}/>))
 expect(tree.root.findAllByType('input').some((input:any)=>input.props['aria-label']==='Run at')).toBe(true)
 act(()=>tree.unmount())
})
test('changing the row table clears filters and watched columns for the previous table',()=>{
 const onChange=vi.fn();let tree:any
 act(()=>{tree=create(<AutomationTriggerEditor trigger={{type:'row',tableId:'old',column:'status',on:'changed',where:{status:['Done']}}} tables={[{id:'new',name:'New',columns:[]}]} onChange={onChange}/>)})
 act(()=>tree.root.findAllByType('select')[1].props.onChange({target:{value:'new'}}))
 expect(onChange).toHaveBeenLastCalledWith({type:'row',tableId:'new',on:'changed'});act(()=>tree.unmount())
})
test('delete events clear value filters and hide field based controls',()=>{
 const onChange=vi.fn();let tree:any
 act(()=>{tree=create(<AutomationTriggerEditor trigger={{type:'row',tableId:'table',column:'status',on:'changed',where:{status:['Done']}}} tables={[{id:'table',name:'Records',columns:[{id:'status',name:'Status',type:'select',options:['Done']}]}]} onChange={onChange}/>)})
 act(()=>tree.root.findAllByType('select')[2].props.onChange({target:{value:'deleted'}}))
 expect(onChange).toHaveBeenLastCalledWith({type:'row',tableId:'table',column:undefined,on:'deleted',where:undefined})
 act(()=>tree.update(<AutomationTriggerEditor trigger={{type:'row',tableId:'table',on:'deleted'}} tables={[{id:'table',name:'Records',columns:[{id:'status',name:'Status',type:'select',options:['Done']}]}]} onChange={onChange}/>))
 expect(tree.root.findAllByType('select')).toHaveLength(3)
 expect(tree.root.findAllByType('fieldset')).toHaveLength(0)
 act(()=>tree.unmount())
})
test('app record trigger selects app entities and exposes typed event filters',()=>{
 const onChange=vi.fn();let tree:any
 const apps:TriggerAppOption[]=[{app:{id:'app_1',name:'Invoices'},entities:[{key:'primary',table:{id:'table_1',name:'Invoices',columns:[{id:'status',name:'Status',type:'select',options:['Open','Paid']},{id:'amount',name:'Amount',type:'number'},{id:'enabled',name:'Enabled',type:'checkbox'}]}}]}]
 act(()=>{tree=create(<AutomationTriggerEditor trigger={{type:'manual'}} tables={[]} apps={apps} onChange={onChange}/>)})
 act(()=>tree.root.findAllByType('select')[0].props.onChange({target:{value:'app_record_change'}}))
 expect(onChange).toHaveBeenLastCalledWith({type:'app_record_change',appId:'app_1',entityId:'primary',events:['insert','update']})
 act(()=>tree.update(<AutomationTriggerEditor trigger={{type:'app_record_change',appId:'app_1',entityId:'primary',events:['update']}} tables={[]} apps={apps} onChange={onChange}/>))
 expect(tree.root.findAllByType('fieldset')).toHaveLength(4)
 expect(tree.root.findAllByType('select')).toHaveLength(4)
 act(()=>tree.update(<AutomationTriggerEditor trigger={{type:'app_record_change',appId:'app_1',entityId:'primary',events:['update'],when:{where:{enabled:false}}}} tables={[]} apps={apps} onChange={onChange}/>))
 expect(tree.root.findAllByType('select').at(-1)?.props.value).toBe('false')
 act(()=>tree.root.findAllByType('select').at(-1)?.props.onChange({target:{value:'true'}}))
 expect(onChange).toHaveBeenLastCalledWith({type:'app_record_change',appId:'app_1',entityId:'primary',events:['update'],when:{where:{enabled:true}}})
 act(()=>tree.unmount())
})
