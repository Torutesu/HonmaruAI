import React from 'react'
import {act,create} from 'react-test-renderer'
import {test,expect,vi,afterEach} from 'vitest'
import {PersonalViewControls} from './PersonalViewControls'
import type {PersonalViews} from '../utils/harness'
afterEach(()=>vi.unstubAllGlobals())
test('column order and width save together and rejected drafts remain editable',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
 const save=vi.fn().mockRejectedValue(new Error('Conflict'));let tree:ReturnType<typeof create>
 act(()=>{tree=create(<PersonalViewControls view={{id:'v',name:'All',type:'table'}} columns={[{id:'a',name:'名前',type:'text'},{id:'b',name:'状態',type:'text'}]} state={{revision:3,views:[],computed:[],layouts:{v:{order:[],widths:{},wrapText:true}}}} save={save} onSelect={vi.fn()} onSettings={vi.fn()}/>)})
 const button=(text:string)=>tree!.root.findAllByType('button').find(b=>b.children.includes(text))!
 act(()=>button('フィールド').props.onClick())
 expect(tree!.root.findByProps({'aria-label':'名前を非表示'}).props.disabled).toBe(true)
 act(()=>tree!.root.findByProps({'aria-label':'状態を非表示'}).props.onClick())
 expect(tree!.root.findByProps({'aria-label':'状態を表示'}).props['aria-pressed']).toBe(false)
 act(()=>tree!.root.findByProps({'aria-label':'状態を左へ'}).props.onClick())
 act(()=>tree!.root.findByProps({'aria-label':'名前の列幅'}).props.onChange({target:{value:''}}))
 expect(tree!.root.findByProps({'aria-label':'名前の列幅'}).props.value).toBe(0)
 expect(button('保存').props.disabled).toBe(true)
 expect(tree!.root.findByProps({role:'alert'}).children).toContain('列幅は80〜600pxで入力してください。')
 act(()=>tree!.root.findByProps({'aria-label':'名前の列幅'}).props.onChange({target:{value:'320'}}))
 await act(async()=>{button('保存').props.onClick();await Promise.resolve()})
 expect(save.mock.calls[0][0].layouts.v).toEqual({wrapText:true,order:['b','a','$row.id','$row.createdAt','$row.updatedAt'],widths:{a:320},hidden:['$row.id','$row.createdAt','$row.updatedAt','b']})
 expect(tree!.root.findByProps({role:'alert'}).children).toContain('Conflict')
 expect(tree!.root.findByProps({'aria-label':'名前の列幅'}).props.value).toBe(320)
 const stopPropagation=vi.fn();act(()=>tree!.root.findByProps({className:'hx-view-controls'}).props.onKeyDown({key:'Escape',stopPropagation}));expect(stopPropagation).toHaveBeenCalledOnce();expect(tree!.root.findAllByProps({role:'dialog'})).toHaveLength(0)
 act(()=>tree!.unmount())
})

test('system visibility saves and reset restores hidden metadata defaults',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
 const save=vi.fn().mockResolvedValue(undefined);let tree:ReturnType<typeof create>
 act(()=>{tree=create(<PersonalViewControls view={{id:'v',name:'All',type:'table'}} columns={[{id:'name',name:'名前',type:'text'}]} state={{revision:0,views:[],computed:[],layouts:{}}} save={save} onSelect={vi.fn()} onSettings={vi.fn()}/>)})
 const button=(text:string)=>tree!.root.findAllByType('button').find(b=>b.children.includes(text))!
 act(()=>button('フィールド').props.onClick())
 expect(tree!.root.findByProps({'aria-label':'IDを表示'}).props['aria-pressed']).toBe(false)
 act(()=>tree!.root.findByProps({'aria-label':'IDを表示'}).props.onClick())
 await act(async()=>{button('保存').props.onClick();await Promise.resolve()})
 expect(save.mock.calls[0][0].layouts.v.hidden).toEqual(['$row.createdAt','$row.updatedAt'])
 act(()=>button('フィールド').props.onClick());act(()=>button('リセット').props.onClick())
 expect(tree!.root.findByProps({'aria-label':'IDを表示'}).props['aria-pressed']).toBe(false)
 await act(async()=>{button('保存').props.onClick();await Promise.resolve()})
 expect(save.mock.calls[1][0].layouts.v.hidden).toEqual(['$row.id','$row.createdAt','$row.updatedAt'])
 act(()=>tree!.unmount())
})

test('a personal view can be removed without changing records or other views',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
 const view={id:'personal_one',name:'My view',type:'table' as const}
 const other={id:'personal_two',name:'Other',type:'table' as const}
 const state:PersonalViews={revision:7,activeView:view.id,views:[view,other],computed:[view,other],layouts:{[view.id]:{order:['name'],widths:{name:220}},[other.id]:{order:['name'],widths:{name:180}},shared:{order:['name'],widths:{}}}}
 const save=vi.fn().mockResolvedValue(undefined);let tree:ReturnType<typeof create>
 act(()=>{tree=create(<PersonalViewControls control="view" view={view} columns={[{id:'name',name:'名前',type:'text'}]} state={state} save={save} onSelect={vi.fn()} onSettings={vi.fn()}/>)})
 const button=(text:string)=>tree!.root.findAllByType('button').find(b=>b.children.includes(text))!
 act(()=>tree!.root.findByProps({'aria-label':'新しいビュー / 編集'}).props.onClick())
 act(()=>button('個人ビューを削除').props.onClick())
 expect(save).not.toHaveBeenCalled()
 expect(JSON.stringify(tree!.toJSON())).toContain('レコードや共有ビューは削除されません')
 act(()=>button('キャンセル').props.onClick())
 expect(save).not.toHaveBeenCalled()
 act(()=>button('個人ビューを削除').props.onClick())
 await act(async()=>{button('削除する').props.onClick();await Promise.resolve()})
 expect(save).toHaveBeenCalledOnce()
 const saved=save.mock.calls[0][0]
 expect(saved.activeView).toBeUndefined()
 expect(saved.views).toEqual([other])
 expect(saved.layouts).toEqual({[other.id]:state.layouts[other.id],shared:state.layouts.shared})
 expect(tree!.root.findAllByProps({role:'dialog'})).toHaveLength(0)
 act(()=>tree!.unmount())
})

test('a deletion conflict keeps the personal view and confirmation visible',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
 const view={id:'personal_one',name:'My view',type:'table' as const}
 const save=vi.fn().mockRejectedValue(new Error('別の端末で更新されています。再読み込みしてください。'));let tree:ReturnType<typeof create>
 act(()=>{tree=create(<PersonalViewControls control="view" view={view} columns={[{id:'name',name:'名前',type:'text'}]} state={{revision:1,activeView:view.id,views:[view],computed:[view],layouts:{}}} save={save} onSelect={vi.fn()} onSettings={vi.fn()}/>)})
 const button=(text:string)=>tree!.root.findAllByType('button').find(b=>b.children.includes(text))!
 act(()=>tree!.root.findByProps({'aria-label':'新しいビュー / 編集'}).props.onClick())
 act(()=>button('個人ビューを削除').props.onClick())
 await act(async()=>{button('削除する').props.onClick();await Promise.resolve()})
 expect(tree!.root.findByProps({role:'alert'}).children).toContain('別の端末で更新されています。再読み込みしてください。')
 expect(button('削除する')).toBeTruthy()
 act(()=>tree!.unmount())
})

test('the personal-view limit explains how to make room without offering to delete a shared view',()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
 const shared={id:'all',name:'All',type:'table' as const}
 const views=Array.from({length:12},(_,i)=>({id:`personal_${i}`,name:`View ${i}`,type:'table' as const}))
 let tree:ReturnType<typeof create>
 act(()=>{tree=create(<PersonalViewControls control="view" view={shared} columns={[{id:'name',name:'名前',type:'text'}]} state={{revision:1,activeView:'all',views,computed:views,layouts:{}}} save={vi.fn()} onSelect={vi.fn()} onSettings={vi.fn()}/>)})
 act(()=>tree!.root.findByProps({'aria-label':'新しいビュー'}).props.onClick())
 expect(tree!.root.findByProps({role:'status'}).children.join('')).toContain('個人ビューは12件まで')
 expect(tree!.root.findAllByType('button').find(b=>b.children.includes('個人ビューを作成'))?.props.disabled).toBe(true)
 expect(tree!.root.findAllByType('button').some(b=>b.children.includes('個人ビューを削除'))).toBe(false)
 act(()=>tree!.unmount())
})
