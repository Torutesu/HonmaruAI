import React from 'react'
import {act,create,type ReactTestRenderer} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {AppDataCell} from './AppDataCell'
import type {Column} from '../utils/harness'

vi.mock('../utils/i18n',()=>({useT:()=>(key:string,args?:Record<string,string>)=>key.replace('{field}',args?.field||'')}))

let tree:ReactTestRenderer
afterEach(()=>{if(tree)act(()=>tree.unmount())})
const column=(type:string,extra:Record<string,unknown>={})=>({id:'field',name:'Field',type,...extra} as Column)
const cell=(type='text',value:unknown='Before',onSave=vi.fn(),extra:Record<string,unknown>={})=><AppDataCell column={column(type,extra)} value={value} displayValue={String(value??'')} onSave={onSave}/>
const display=()=>tree.root.findByProps({className:'hx-cell-display'})
const edit=()=>{act(()=>display().props.onClick());return tree.root.findByProps({className:'hx-cell-editing'})}

test('shows plain text until click, then focuses the type-specific editor and commits text on blur',()=>{
 const onSave=vi.fn(),focus=vi.fn()
 act(()=>{tree=create(cell('text','Before',onSave),{createNodeMock:element=>element.props.className==='hx-cell-editing'?{querySelector:()=>({focus}),contains:()=>true,isConnected:true}:null})})
 expect(display().props.type).toBe('button')
 expect(tree.root.findAllByType('input')).toHaveLength(0)
 const root=edit(),input=tree.root.findByType('input')
 expect(input.props['aria-label']).toBe('Field');expect(focus).toHaveBeenCalledOnce()
 act(()=>input.props.onChange({target:{value:'After'}}))
 act(()=>input.props.onBlur())
 expect(onSave).toHaveBeenCalledWith('After')
 expect(tree.root.findAllByProps({className:'hx-cell-editing'})).toHaveLength(0)
})

test('Escape cancels a text draft even if unmount later blurs the editor',()=>{
 const onSave=vi.fn()
 act(()=>{tree=create(cell('text','Before',onSave))})
 const root=edit(),input=tree.root.findByType('input')
 const blur=input.props.onBlur
 act(()=>input.props.onChange({target:{value:'Discard me'}}))
 const event={key:'Escape',preventDefault:vi.fn(),stopPropagation:vi.fn()}
 act(()=>root.props.onKeyDownCapture(event))
 expect(event.preventDefault).toHaveBeenCalledOnce();expect(event.stopPropagation).toHaveBeenCalledOnce()
 act(()=>blur())
 expect(onSave).not.toHaveBeenCalled()
 expect(display().children).toContain('Before')
})

test.each([
 ['number','3.5',{},{target:{value:'4.5',validity:{badInput:false}}},'4.5'],
 ['select','open',{options:['open','closed']},{target:{value:'closed'}},'closed'],
 ['checkbox',false,{},{target:{checked:true}},true],
] as const)('%s editor remains accessible and saves its selected value',(_type,value,extra,event,expected)=>{
 const onSave=vi.fn()
 act(()=>{tree=create(cell(_type,value,onSave,extra))})
 edit()
 const control=tree.root.findAll(node=>node.type==='input'||node.type==='select')[0]
 expect(control.props['aria-label']).toBe('Field')
 act(()=>control.props.onChange(event))
 if(_type==='number')act(()=>tree.root.findByType('input').props.onBlur({currentTarget:{validity:{badInput:false}}}))
 else act(()=>tree.root.findAll(node=>node.type==='input'||node.type==='select')[0].props.onBlur())
 expect(onSave).toHaveBeenCalledWith(expected)
 expect(tree.root.findAllByProps({className:'hx-cell-editing'})).toHaveLength(0)
})

test.each([
 ['select','open',{options:['open','closed']},{target:{value:'closed'}}],
 ['checkbox',false,{}, {target:{checked:true}}],
 ['person','member-1',{members:[{ref:'member-1',name:'One'},{ref:'member-2',name:'Two'}]},{target:{value:'member-2'}}],
 ['relation','row-1',{targetEntity:'other',relationEntities:[{key:'other',table:{columns:[{id:'name',name:'Name',type:'text'}]},rows:[{id:'row-1',values:{name:'One'}},{id:'row-2',values:{name:'Two'}}]}]},{target:{value:'row-2'}}],
] as const)('Escape cancels a staged %s choice',(_type,value,extra,event)=>{
 const onSave=vi.fn()
 act(()=>{tree=create(<AppDataCell column={column(_type,extra)} value={value} displayValue={String(value)} onSave={onSave} members={'members' in extra?[...extra.members]:undefined} relationEntities={'relationEntities' in extra?extra.relationEntities as never:undefined}/>)})
 const root=edit(),control=tree.root.findAll(node=>node.type==='input'||node.type==='select')[0]
 act(()=>control.props.onChange(event))
 act(()=>root.props.onKeyDownCapture({key:'Escape',preventDefault:vi.fn(),stopPropagation:vi.fn()}))
 expect(onSave).not.toHaveBeenCalled()
 expect(display().children.join('')).toContain(String(value))
})

test('invalid numeric precision displays an error and does not save',()=>{
 const onSave=vi.fn()
 act(()=>{tree=create(cell('number','1.25',onSave))})
 edit()
 const input=tree.root.findByType('input')
 act(()=>input.props.onChange({target:{value:'9007199254740993'}}))
 act(()=>input.props.onBlur({currentTarget:{validity:{badInput:false}}}))
 expect(onSave).not.toHaveBeenCalled()
 expect(tree.root.findByProps({role:'alert'}).children.join('')).toContain('The value for Field cannot be saved')
 expect(tree.root.findByProps({className:'hx-cell-editing'})).toBeTruthy()
})

test('system columns render read-only and never enter an editor',()=>{
 const onSave=vi.fn()
 act(()=>{tree=create(<AppDataCell column={column('text')} value="row-1" displayValue="row-1" editable={false} onSave={onSave}/>)})
 expect(tree.root.findByProps({className:'hx-system-cell'}).children).toContain('row-1')
 expect(tree.root.findAllByType('button')).toHaveLength(0)
 expect(tree.root.findAllByType('input')).toHaveLength(0)
})
