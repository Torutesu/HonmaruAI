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
test('select conditions match complete scalar values and remain editable',()=>{
 const onChange=vi.fn();let tree:any
 const apps:TriggerAppOption[]=[{app:{id:'app_1',name:'Tasks'},entities:[{key:'primary',table:{id:'table_1',name:'Tasks',columns:[{id:'status',name:'Status',type:'select',options:['A','AB']}]}}]}]
 const trigger={type:'app_record_change' as const,appId:'app_1',entityId:'primary',events:['update' as const],when:{where:{status:'AB'}}}
 act(()=>{tree=create(<AutomationTriggerEditor trigger={trigger} tables={[]} apps={apps} onChange={onChange}/>)})
 const choices=tree.root.findAllByType('fieldset')[1].findAllByType('input')
 expect(choices.map((input:any)=>input.props.checked)).toEqual([false,true])
 act(()=>choices[0].props.onChange({target:{checked:true}}))
 expect(onChange).toHaveBeenLastCalledWith({...trigger,when:{where:{status:['AB','A']}}})
 act(()=>tree.update(<AutomationTriggerEditor trigger={{...trigger,when:{where:{status:['AB','A']}}}} tables={[]} apps={apps} onChange={onChange}/>))
 const selected=tree.root.findAllByType('fieldset')[1].findAllByType('input')
 expect(selected.map((input:any)=>input.props.checked)).toEqual([true,true])
 act(()=>selected[0].props.onChange({target:{checked:false}}))
 expect(onChange).toHaveBeenLastCalledWith({...trigger,when:{where:{status:['AB']}}})
 act(()=>tree.update(<AutomationTriggerEditor trigger={{...trigger,when:{where:{status:42}}}} tables={[]} apps={apps} onChange={onChange}/>))
 expect(tree.root.findAllByType('fieldset')[1].props.disabled).toBe(true)
 act(()=>tree.unmount())
})
test('app conditions preserve name aliases and refuse ambiguous duplicate keys',()=>{
 const onChange=vi.fn();let tree:any
 const apps:TriggerAppOption[]=[{app:{id:'app_1',name:'Tasks'},entities:[{key:'primary',table:{id:'table_1',name:'Tasks',columns:[{id:'status_id',name:'Status',type:'select',options:['A','AB']},{id:'note',name:'Note',type:'text'}]}}]}]
 const trigger={type:'app_record_change' as const,appId:'app_1',entityId:'primary',events:['update' as const],when:{where:{sTaTuS:'AB',note:'keep'}}}
 act(()=>{tree=create(<AutomationTriggerEditor trigger={trigger} tables={[]} apps={apps} onChange={onChange}/>)})
 const choices=tree.root.findAllByType('fieldset')[1].findAllByType('input')
 expect(choices.map((input:any)=>input.props.checked)).toEqual([false,true])
 act(()=>choices[0].props.onChange({target:{checked:true}}))
 expect(onChange).toHaveBeenLastCalledWith({...trigger,when:{where:{sTaTuS:['AB','A'],note:'keep'}}})
 act(()=>tree.update(<AutomationTriggerEditor trigger={{...trigger,when:{where:{sTaTuS:'AB',status_id:'A',note:'keep'}}}} tables={[]} apps={apps} onChange={onChange}/>))
 expect(tree.root.findAllByType('fieldset')[1].props.disabled).toBe(true)
 expect(tree.root.findAllByType('fieldset')[1].findAllByType('input')).toHaveLength(0)
 act(()=>tree.root.findByProps({'aria-label':'status_idの条件を削除'}).props.onClick())
 expect(onChange).toHaveBeenLastCalledWith({...trigger,when:{where:{sTaTuS:'AB',note:'keep'}}})
 act(()=>tree.unmount())
})
test('conditions the controls cannot represent are preserved rather than shown as unrestricted',()=>{
 const onChange=vi.fn();let tree:any
 const apps:TriggerAppOption[]=[{app:{id:'app_1',name:'Tasks'},entities:[{key:'primary',table:{id:'table_1',name:'Tasks',columns:[{id:'status',name:'Status',type:'select',options:['A']},{id:'due',name:'Due',type:'date'},{id:'enabled',name:'Enabled',type:'checkbox'}]}}]}]
 const trigger={type:'app_record_change' as const,appId:'app_1',entityId:'primary',events:['update' as const],when:{where:{status:[],due:'2026-02-30',enabled:null}}}
 act(()=>{tree=create(<AutomationTriggerEditor trigger={trigger} tables={[]} apps={apps} onChange={onChange}/>)})
 expect(tree.root.findAllByType('fieldset').slice(1).map((field:any)=>field.props.disabled)).toEqual([true,true,true])
 expect(onChange).not.toHaveBeenCalled()
 act(()=>tree.unmount())
})
test('new condition keys follow the server column resolution when names overlap IDs',()=>{
 const onChange=vi.fn();let tree:any
 const apps:TriggerAppOption[]=[{app:{id:'app_1',name:'Tasks'},entities:[{key:'primary',table:{id:'table_1',name:'Tasks',columns:[{id:'first',name:'later',type:'select',options:['A']},{id:'later',name:'Second',type:'select',options:['B']}]}}]}]
 const trigger={type:'app_record_change' as const,appId:'app_1',entityId:'primary',events:['update' as const],when:{where:{later:'A'}}}
 act(()=>{tree=create(<AutomationTriggerEditor trigger={trigger} tables={[]} apps={apps} onChange={onChange}/>)})
 const fields=tree.root.findAllByType('fieldset')
 expect(fields[1].findByType('input').props.checked).toBe(true)
 act(()=>fields[2].findByType('input').props.onChange({target:{checked:true}}))
 expect(onChange).toHaveBeenLastCalledWith({...trigger,when:{where:{later:'A',Second:['B']}}})
 const ambiguous:TriggerAppOption[]=[{app:{id:'app_1',name:'Tasks'},entities:[{key:'primary',table:{id:'table_1',name:'Tasks',columns:[{id:'Second',name:'later',type:'select',options:['A']},{id:'later',name:'Second',type:'select',options:['B']}]}}]}]
 act(()=>tree.update(<AutomationTriggerEditor trigger={trigger} tables={[]} apps={ambiguous} onChange={onChange}/>))
 expect(tree.root.findAllByType('fieldset')[2].props.disabled).toBe(true)
 act(()=>tree.unmount())
})
test('column IDs matching object prototype names can be edited safely',()=>{
 const onChange=vi.fn();let tree:any
 const apps:TriggerAppOption[]=[{app:{id:'app_1',name:'Tasks'},entities:[{key:'primary',table:{id:'table_1',name:'Tasks',columns:[{id:'constructor',name:'Constructor',type:'select',options:['A']},{id:'note',name:'Note',type:'text'}]}}]}]
 const trigger={type:'app_record_change' as const,appId:'app_1',entityId:'primary',events:['update' as const],when:{where:{note:'keep'}}}
 act(()=>{tree=create(<AutomationTriggerEditor trigger={trigger} tables={[]} apps={apps} onChange={onChange}/>)})
 const field=tree.root.findAllByType('fieldset')[1]
 expect(field.props.disabled).toBe(false)
 act(()=>field.findByType('input').props.onChange({target:{checked:true}}))
 expect(onChange).toHaveBeenLastCalledWith({...trigger,when:{where:{note:'keep',constructor:['A']}}})
 act(()=>tree.unmount())
})
test('unknown condition keys are reported and preserved when another condition changes',()=>{
 const onChange=vi.fn();let tree:any
 const apps:TriggerAppOption[]=[{app:{id:'app_1',name:'Tasks'},entities:[{key:'primary',table:{id:'table_1',name:'Tasks',columns:[{id:'status',name:'Status',type:'select',options:['A']}]}}]}]
 const trigger={type:'app_record_change' as const,appId:'app_1',entityId:'primary',events:['update' as const],when:{where:{removed_field:'kept'}}}
 act(()=>{tree=create(<AutomationTriggerEditor trigger={trigger} tables={[]} apps={apps} onChange={onChange}/>)})
 expect(JSON.stringify(tree.toJSON())).toContain('removed_field')
 act(()=>tree.root.findAllByType('fieldset')[1].findByType('input').props.onChange({target:{checked:true}}))
 expect(onChange).toHaveBeenLastCalledWith({...trigger,when:{where:{removed_field:'kept',status:['A']}}})
 act(()=>tree.root.findByProps({'aria-label':'removed_fieldの条件を削除'}).props.onClick())
 expect(onChange).toHaveBeenLastCalledWith({...trigger,when:undefined})
 act(()=>tree.unmount())
})
test('row trigger conditions support scalar aliases without dropping other conditions',()=>{
 const onChange=vi.fn();let tree:any
 const tables=[{id:'table',name:'Tasks',columns:[{id:'status_id',name:'Status',type:'select' as const,options:['A','AB']},{id:'amount',name:'Amount',type:'number' as const}]}]
 const trigger={type:'row' as const,tableId:'table',on:'changed' as const,column:'sTaTuS',where:{sTaTuS:'AB',amount:2}}
 act(()=>{tree=create(<AutomationTriggerEditor trigger={trigger as any} tables={tables} onChange={onChange}/>)})
 const choices=tree.root.findAllByType('fieldset')[0].findAllByType('input')
 expect(choices.map((input:any)=>input.props.checked)).toEqual([false,true])
 expect(tree.root.findAllByType('select')[3].props.value).toBe('status_id')
 expect(JSON.stringify(tree.toJSON())).toContain('amount')
 act(()=>choices[0].props.onChange({target:{checked:true}}))
 expect(onChange).toHaveBeenLastCalledWith({...trigger,where:{sTaTuS:['AB','A'],amount:2}})
 act(()=>tree.unmount())
})
test('temporarily selecting delete restores the original row filters when switching back',()=>{
 const onChange=vi.fn();let tree:any
 const tables=[{id:'table',name:'Tasks',columns:[{id:'status',name:'Status',type:'select' as const,options:['Open']}]}]
 const trigger={type:'row' as const,tableId:'table',on:'changed' as const,column:'status',where:{status:['Open']}}
 act(()=>{tree=create(<AutomationTriggerEditor trigger={trigger} tables={tables} onChange={onChange}/>)})
 act(()=>tree.root.findAllByType('select')[2].props.onChange({target:{value:'deleted'}}))
 expect(onChange).toHaveBeenLastCalledWith({...trigger,on:'deleted',where:undefined,column:undefined})
 act(()=>tree.update(<AutomationTriggerEditor trigger={{...trigger,on:'deleted',where:undefined,column:undefined}} tables={tables} onChange={onChange}/>))
 act(()=>tree.root.findAllByType('select')[2].props.onChange({target:{value:'changed'}}))
 expect(onChange).toHaveBeenLastCalledWith(trigger)
 act(()=>tree.unmount())
})
