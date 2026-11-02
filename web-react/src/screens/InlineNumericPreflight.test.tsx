import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {AppView} from './Harness'
vi.mock('../utils/appPins',()=>({useAppPins:()=>({pins:[],toggle:vi.fn(),loaded:true})}))
vi.mock('../utils/i18n',()=>({useT:()=>(text:string,vars?:Record<string,string|number>)=>text.replace(/\{(\w+)\}/g,(_m,key)=>String(vars?.[key]??''))}))
afterEach(()=>vi.unstubAllGlobals())

async function renderView(){
 vi.stubGlobal('location',{hash:'#/apps'});vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn(),visibilityState:'visible'})
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({mode:'harness'})})))
 const row={id:'r',values:{amount:1,title:'Original'},updatedAt:'2026-01-01T00:00:00Z'},view={id:'main',type:'table',name:'All',rows:[row]}
 const api:any={app:vi.fn().mockResolvedValue({app:{id:'tasks',name:'Tasks',description:'',icon:'grid',tableId:'tasks',template:null,version:1,createdBy:'owner',channels:[],definition:{views:[view]}},table:{id:'tasks',name:'Tasks',columns:[{id:'amount',name:'Amount',type:'number'},{id:'title',name:'Title',type:'text'}]},rows:[row],views:[view],canCustomize:true}),personalViews:vi.fn().mockResolvedValue({revision:0,activeView:'main',views:[],computed:[],layouts:{}}),conversation:vi.fn().mockResolvedValue({messages:[],hasMore:false,annotations:[]}),conversationNotifications:vi.fn().mockResolvedValue({items:[]}),updateRow:vi.fn().mockResolvedValue({})}
 let tree:ReturnType<typeof create>;await act(async()=>{tree=create(<AppView httpBase="https://api.example" orgId="team:one" sessionToken="one" onClose={()=>{}} api={api} appId="tasks" onBack={()=>{}} initialSection="data"/>);await new Promise(resolve=>setTimeout(resolve,0))})
 return {tree:tree!,api,row}
}

test('inline number warns and retains an unsafe value; a corrected value saves',async()=>{
 const {tree,api,row}=await renderView(),input=()=>tree.root.findByProps({'aria-label':'Amount'})
 act(()=>input().props.onChange({target:{value:'9007199254740993'}}));act(()=>input().props.onBlur({currentTarget:{validity:{badInput:false}}}))
 expect(api.updateRow).not.toHaveBeenCalled();expect(input().props.value).toBe('9007199254740993');expect(input().props['aria-invalid']).toBe(true);expect(tree.root.findByProps({role:'alert'})).toBeTruthy()
 act(()=>input().props.onChange({target:{value:'0.1'}}));await act(async()=>{input().props.onBlur({currentTarget:{validity:{badInput:false}}});await new Promise(resolve=>setTimeout(resolve,0))})
 expect(api.updateRow).toHaveBeenCalledWith('tasks','r',{amount:'0.1'},row.updatedAt);act(()=>tree.unmount())
})

test('incomplete number does not clear a stored value, while an explicit empty field can',async()=>{
 const {tree,api,row}=await renderView(),input=()=>tree.root.findByProps({'aria-label':'Amount'})
 act(()=>input().props.onChange({target:{value:''}}));act(()=>input().props.onBlur({currentTarget:{validity:{badInput:true}}}))
 expect(api.updateRow).not.toHaveBeenCalled();expect(input().props['aria-invalid']).toBe(true)
 await act(async()=>{input().props.onBlur({currentTarget:{validity:{badInput:false}}});await new Promise(resolve=>setTimeout(resolve,0))})
 expect(api.updateRow).toHaveBeenCalledWith('tasks','r',{amount:''},row.updatedAt);act(()=>tree.unmount())
})

test('IME enter does not blur a number field, while ordinary enter does',async()=>{
 const {tree}=await renderView(),input=()=>tree.root.findByProps({'aria-label':'Amount'}),blur=vi.fn()
 act(()=>input().props.onKeyDown({key:'Enter',nativeEvent:{isComposing:true},target:{blur}}));act(()=>input().props.onKeyDown({key:'Enter',nativeEvent:{keyCode:229},target:{blur}}));expect(blur).not.toHaveBeenCalled()
 act(()=>input().props.onKeyDown({key:'Enter',nativeEvent:{},target:{blur}}));expect(blur).toHaveBeenCalledOnce();act(()=>tree.unmount())
})

test('numeric editor keeps its identity and draft across parent renders',async()=>{
 const {tree,api}=await renderView(),original=tree.root.findByProps({'aria-label':'Amount'})
 act(()=>original.props.onChange({target:{value:'9007199254740993'}}))
 act(()=>tree.update(<AppView httpBase="https://api.example" orgId="team:one" sessionToken="one" onClose={()=>{}} api={api} appId="tasks" onBack={()=>{}} initialSection="data"/>))
 const current=tree.root.findByProps({'aria-label':'Amount'})
 expect(current).toBe(original);expect(current.props.value).toBe('9007199254740993')
 act(()=>current.props.onBlur({currentTarget:{validity:{badInput:false}}}))
 expect(api.updateRow).not.toHaveBeenCalled();expect(current.props['aria-invalid']).toBe(true)
 act(()=>tree.unmount())
})

test('changing a column type does not change hook order and preserves non-numeric saves',async()=>{
 const {tree,api,row}=await renderView()
 const original=await api.app.mock.results[0].value
 api.app.mockResolvedValue({...original,table:{...original.table,columns:[{id:'amount',name:'Amount',type:'text'},original.table.columns[1]]}})
 await act(async()=>{tree.root.findByProps({'aria-label':'データを更新'}).props.onClick();await new Promise(resolve=>setTimeout(resolve,0))})
 const input=()=>tree.root.findByProps({'aria-label':'Amount'})
 expect(input().props.type).toBe('text')
 act(()=>input().props.onChange({target:{value:'abc'}}))
 await act(async()=>{input().props.onBlur();await new Promise(resolve=>setTimeout(resolve,0))})
 expect(api.updateRow).toHaveBeenCalledWith('tasks','r',{amount:'abc'},row.updatedAt)
 act(()=>tree.unmount())
})
