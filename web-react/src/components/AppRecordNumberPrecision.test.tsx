import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {AppRecordDialog} from './AppRecordDialog'
vi.mock('./Dialog',()=>({Dialog:({children,footer}:any)=><div>{children}{footer}</div>}))
afterEach(()=>vi.unstubAllGlobals())
const column={id:'amount',name:'Amount',type:'number' as const}
const submit=(tree:ReturnType<typeof create>)=>tree.root.findByType('form').props.onSubmit({preventDefault:vi.fn()})

test.each(['9007199254740993','1000000000000000100','1e23','1e-324','1.0000000000000001'])('blocks changed decimal %s and preserves the draft until corrected',async text=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
 const save=vi.fn().mockResolvedValue(undefined),onClose=vi.fn();let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRecordDialog appName="Tasks" columns={[column]} record={{id:'r',values:{amount:1},updatedAt:'2026-01-02'}} save={save} onClose={onClose}/>)});
 act(()=>tree!.root.findByType('input').props.onChange({target:{value:text}}));await act(async()=>{await submit(tree!)})
 expect(save).not.toHaveBeenCalled();expect(onClose).not.toHaveBeenCalled();expect(tree!.root.findByType('input').props.value).toBe(text);expect(tree!.root.findByProps({role:'alert'})).toBeTruthy()
 act(()=>tree!.root.findByType('input').props.onChange({target:{value:'0.1'}}));await act(async()=>{await submit(tree!)})
 expect(save).toHaveBeenCalledWith({amount:0.1});expect(onClose).toHaveBeenCalledOnce();act(()=>tree!.unmount())
})

test.each(['0.1','1.00','1e3','1e20','9007199254740992','-0'])('submits display-equivalent numeric input %s',async text=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});const save=vi.fn().mockResolvedValue(undefined);let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRecordDialog appName="Tasks" columns={[column]} save={save} onClose={()=>{}}/>)});
 act(()=>tree!.root.findByType('input').props.onChange({target:{value:text}}));await act(async()=>{await submit(tree!)})
 expect(save).toHaveBeenCalledWith({amount:Number(text)});act(()=>tree!.unmount())
})

test('does not block an unchanged previously stored number when another field is saved',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});const save=vi.fn().mockResolvedValue(undefined);let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRecordDialog appName="Tasks" columns={[{id:'title',name:'Title',type:'text'},column]} record={{id:'r',values:{title:'Old',amount:Number('1000000000000000100')},updatedAt:'2026-01-02'}} save={save} onClose={()=>{}}/>)});
 act(()=>tree!.root.findByType('textarea').props.onChange({target:{value:'New'}}));await act(async()=>{await submit(tree!)})
 expect(save).toHaveBeenCalledWith({title:'New'});act(()=>tree!.unmount())
})

test('warns when the displayed decimal of an imprecise stored integer is explicitly re-entered',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});const save=vi.fn();let tree:ReturnType<typeof create>
 const displayed='1000000000000000100',original=Number(displayed)
 act(()=>{tree=create(<AppRecordDialog appName="Tasks" columns={[column]} record={{id:'r',values:{amount:original},updatedAt:'2026-01-02'}} save={save} onClose={()=>{}}/>)});
 expect(tree!.root.findByType('input').props.value).toBe(displayed)
 act(()=>tree!.root.findByType('input').props.onChange({target:{value:displayed}}));await act(async()=>{await submit(tree!)})
 expect(save).not.toHaveBeenCalled();expect(tree!.root.findByProps({role:'alert'})).toBeTruthy();expect(tree!.root.findByType('input').props.value).toBe(displayed);act(()=>tree!.unmount())
})
