import React from 'react'
import {act,create} from 'react-test-renderer'
import {test,expect,vi,afterEach} from 'vitest'
import {PersonalViewControls} from './PersonalViewControls'
afterEach(()=>vi.unstubAllGlobals())
test('column order and width save together and rejected drafts remain editable',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
 const save=vi.fn().mockRejectedValue(new Error('Conflict'));let tree:ReturnType<typeof create>
 act(()=>{tree=create(<PersonalViewControls view={{id:'v',name:'All',type:'table'}} columns={[{id:'a',name:'名前',type:'text'},{id:'b',name:'状態',type:'text'}]} state={{revision:3,views:[],computed:[],layouts:{}}} save={save} onSelect={vi.fn()} onSettings={vi.fn()}/>)})
 const button=(text:string)=>tree!.root.findAllByType('button').find(b=>b.children.includes(text))!
 act(()=>button('フィールド').props.onClick())
 act(()=>tree!.root.findByProps({'aria-label':'状態を左へ'}).props.onClick())
 act(()=>tree!.root.findByProps({'aria-label':'名前の列幅'}).props.onChange({target:{value:''}}))
 expect(tree!.root.findByProps({'aria-label':'名前の列幅'}).props.value).toBe(0)
 expect(button('保存').props.disabled).toBe(true)
 expect(tree!.root.findByProps({role:'alert'}).children).toContain('列幅は80〜600pxで入力してください。')
 act(()=>tree!.root.findByProps({'aria-label':'名前の列幅'}).props.onChange({target:{value:'320'}}))
 await act(async()=>{button('保存').props.onClick();await Promise.resolve()})
 expect(save.mock.calls[0][0].layouts.v).toEqual({order:['b','a'],widths:{a:320}})
 expect(tree!.root.findByProps({role:'alert'}).children).toContain('Conflict')
 expect(tree!.root.findByProps({'aria-label':'名前の列幅'}).props.value).toBe(320)
 const stopPropagation=vi.fn();act(()=>tree!.root.findByProps({className:'hx-view-controls'}).props.onKeyDown({key:'Escape',stopPropagation}));expect(stopPropagation).toHaveBeenCalledOnce();expect(tree!.root.findAllByProps({role:'dialog'})).toHaveLength(0)
 act(()=>tree!.unmount())
})
