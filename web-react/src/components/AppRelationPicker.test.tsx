import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {AppRelationPicker} from './AppRelationPicker'

afterEach(()=>vi.unstubAllGlobals())
const column={id:'link',name:'Related',type:'relation' as const,targetEntity:'records'}
const targetColumn={id:'name',name:'Name',type:'text' as const}
const rows=Array.from({length:100},(_,i)=>({id:`row-${i}`,values:{name:`Record ${i}`},updatedAt:'2026-01-01T00:00:00Z'}))
const key=(key:string,composing=false)=>({key,nativeEvent:{isComposing:composing},preventDefault:vi.fn()})

test('keyboard navigation exposes the active record and survives changing results',()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
 vi.stubGlobal('window',{innerWidth:1280,innerHeight:800,addEventListener:vi.fn(),removeEventListener:vi.fn()})
 const onChange=vi.fn();let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRelationPicker column={column} value={null} rows={rows} targetColumn={targetColumn} onChange={onChange}/>)})
 act(()=>tree!.root.findByProps({'aria-label':'Related'}).props.onClick())
 const input=()=>tree!.root.findByProps({'aria-label':'Relatedを検索'})
 const active=()=>tree!.root.findAllByProps({role:'option'}).find(option=>option.props.id===input().props['aria-activedescendant'])
 expect(active()?.findByType('span').children).toContain('Record 0')
 act(()=>input().props.onKeyDown(key('End')));expect(active()?.findByType('span').children).toContain('Record 99')
 act(()=>input().props.onKeyDown({key:'Home',nativeEvent:{isComposing:false,keyCode:229},preventDefault:vi.fn()}));expect(active()?.findByType('span').children).toContain('Record 99')
 act(()=>input().props.onKeyDown(key('ArrowDown')));expect(active()?.findByType('span').children.join('')).toBe('Relatedなし')
 act(()=>input().props.onKeyDown(key('ArrowDown')));expect(active()?.findByType('span').children).toContain('Record 0')
 act(()=>input().props.onKeyDown(key('Enter',true)));expect(onChange).not.toHaveBeenCalled()
 act(()=>input().props.onChange({target:{value:'Record 50'}}));expect(active()?.findByType('span').children).toContain('Record 50')
 act(()=>input().props.onChange({target:{value:'does not exist'}}));expect(input().props['aria-activedescendant']).toBeUndefined()
 act(()=>input().props.onKeyDown(key('Enter')));expect(onChange).not.toHaveBeenCalled()
 act(()=>input().props.onChange({target:{value:'Record 50'}}));act(()=>input().props.onKeyDown(key('Enter')))
 expect(onChange).toHaveBeenCalledWith('row-50');act(()=>tree!.unmount())
})

test('a missing single relation can be cleared with the keyboard',()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
 vi.stubGlobal('window',{innerWidth:1280,innerHeight:800,addEventListener:vi.fn(),removeEventListener:vi.fn()})
 const onChange=vi.fn();let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRelationPicker column={column} value="deleted-row" rows={rows} targetColumn={targetColumn} onChange={onChange}/>)})
 act(()=>tree!.root.findByProps({'aria-label':'Related'}).props.onClick())
 const input=tree!.root.findByProps({'aria-label':'Relatedを検索'})
 act(()=>input.props.onKeyDown(key('Home')))
 const clear=tree!.root.findAllByProps({role:'option'}).find(option=>option.props.id===input.props['aria-activedescendant'])
 expect(clear?.findByType('span').children.join('')).toBe('Relatedなし')
 act(()=>input.props.onKeyDown(key('Enter')));expect(onChange).toHaveBeenCalledWith(null);act(()=>tree!.unmount())
})

test('a removed option is not selected when the list changes while open',()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
 vi.stubGlobal('window',{innerWidth:1280,innerHeight:800,addEventListener:vi.fn(),removeEventListener:vi.fn()})
 const onChange=vi.fn();let tree:ReturnType<typeof create>
 const render=(current:typeof rows)=><AppRelationPicker column={column} value={null} rows={current} targetColumn={targetColumn} onChange={onChange}/>
 act(()=>{tree=create(render(rows))});act(()=>tree!.root.findByProps({'aria-label':'Related'}).props.onClick())
 act(()=>tree!.root.findByProps({'aria-label':'Relatedを検索'}).props.onKeyDown(key('End')))
 act(()=>tree!.update(render(rows.slice(0,1))))
 const input=tree!.root.findByProps({'aria-label':'Relatedを検索'})
 const active=tree!.root.findAllByProps({role:'option'}).find(option=>option.props.id===input.props['aria-activedescendant'])
 expect(active?.findByType('span').children).toContain('Record 0')
 act(()=>input.props.onKeyDown(key('Enter')));expect(onChange).toHaveBeenCalledWith('row-0');act(()=>tree!.unmount())
})
