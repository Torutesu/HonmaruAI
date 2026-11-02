import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {AppView} from './Harness'
vi.mock('../components/Dialog',()=>({Dialog:({children,footer,title}:any)=><div role="dialog" aria-label={title}>{children}{footer}</div>}))
vi.mock('../utils/i18n',()=>({useT:()=>(text:string,values?:Record<string,unknown>)=>text.replace(/\{(\w+)\}/g,(match,key)=>values?.[key]==null?match:String(values[key]))}))
vi.mock('../utils/appPins',()=>({useAppPins:()=>({pins:[],toggle:vi.fn()})}))
afterEach(()=>vi.unstubAllGlobals())
test('row icon asks for confirmation before deleting the captured table, id and version',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn(),visibilityState:'visible'});vi.stubGlobal('location',{hash:'#/apps'})
 const row={id:'row-a',values:{title:'Alpha'},updatedAt:'2026-01-01T00:00:00.000Z'},view={id:'main',type:'table',name:'All',rows:[row]}
 const api:any={app:vi.fn().mockResolvedValue({app:{id:'tasks',name:'Tasks',description:'',icon:'grid',tableId:'table-a',version:1,createdBy:'owner',channels:[],definition:{views:[view]}},table:{id:'table-a',name:'Tasks',columns:[{id:'title',name:'Title',type:'text'}]},rows:[row],views:[view],canCustomize:true}),personalViews:vi.fn().mockResolvedValue({revision:0,activeView:'main',views:[],computed:[],layouts:{}}),conversation:vi.fn().mockResolvedValue({messages:[],hasMore:false,annotations:[]}),conversationNotifications:vi.fn().mockResolvedValue({items:[]}),deleteRow:vi.fn().mockResolvedValue({deleted:true})};let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppView httpBase="https://api.invalid" orgId="team:a" sessionToken="fixture" api={api} appId="tasks" initialSection="data" onClose={()=>{}} onBack={()=>{}}/>);await new Promise(resolve=>setTimeout(resolve,0))})
 act(()=>tree!.root.findByProps({'aria-label':'Delete row'}).props.onClick());expect(api.deleteRow).not.toHaveBeenCalled();expect(tree!.root.findByProps({role:'dialog'}).props['aria-label']).toBe('Delete row')
 await act(async()=>{tree!.root.findAllByType('button').find(button=>button.props.className==='dlg-btn danger')!.props.onClick();await Promise.resolve()});expect(api.deleteRow).toHaveBeenCalledWith('table-a','row-a','2026-01-01T00:00:00.000Z');act(()=>tree!.unmount())
})
test('a delayed deletion result cannot refresh or dismiss a different app scope',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn(),visibilityState:'visible'});vi.stubGlobal('location',{hash:'#/apps'})
 let finish!:(value:{deleted:boolean})=>void;const row={id:'row-a',values:{title:'Alpha'},updatedAt:'2026-01-01T00:00:00.000Z'},view={id:'main',type:'table',name:'All',rows:[row]}
 const makeApi=(id:string):any=>({app:vi.fn().mockResolvedValue({app:{id,name:id,description:'',icon:'grid',tableId:`table-${id}`,version:1,createdBy:'owner',channels:[],definition:{views:[view]}},table:{id:`table-${id}`,name:id,columns:[{id:'title',name:'Title',type:'text'}]},rows:[row],views:[view],canCustomize:true}),personalViews:vi.fn().mockResolvedValue({revision:0,activeView:'main',views:[],computed:[],layouts:{}}),conversation:vi.fn().mockResolvedValue({messages:[],hasMore:false,annotations:[]}),conversationNotifications:vi.fn().mockResolvedValue({items:[]}),deleteRow:vi.fn()})
 const first=makeApi('first'),second=makeApi('second');first.deleteRow.mockImplementation(()=>new Promise(resolve=>{finish=resolve}));let tree:ReturnType<typeof create>
 const render=(api:any,id:string)=><AppView httpBase="https://api.invalid" orgId="team:a" sessionToken="fixture" api={api} appId={id} initialSection="data" onClose={()=>{}} onBack={()=>{}}/>
 await act(async()=>{tree=create(render(first,'first'));await new Promise(resolve=>setTimeout(resolve,0))});act(()=>tree!.root.findByProps({'aria-label':'Delete row'}).props.onClick());act(()=>tree!.root.findAllByType('button').find(button=>button.props.className==='dlg-btn danger')!.props.onClick())
 await act(async()=>{tree!.update(render(second,'second'));await new Promise(resolve=>setTimeout(resolve,0))});expect(tree!.root.findAllByProps({role:'dialog'})).toHaveLength(0);const before=second.app.mock.calls.length
 await act(async()=>{finish({deleted:true});await Promise.resolve()});expect(second.app).toHaveBeenCalledTimes(before);expect(second.deleteRow).not.toHaveBeenCalled();act(()=>tree!.unmount())
})
test('an unconfirmed delete remains blocked after reopening and a failed refresh, until an explicit refresh succeeds',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn(),visibilityState:'visible'});vi.stubGlobal('location',{hash:'#/apps'})
 const row={id:'row-a',values:{title:'Alpha'},updatedAt:'2026-01-01T00:00:00.000Z'},view={id:'main',type:'table',name:'All',rows:[row]}
 const api:any={app:vi.fn().mockResolvedValue({app:{id:'tasks',name:'Tasks',description:'',icon:'grid',tableId:'table-a',version:1,createdBy:'owner',channels:[],definition:{views:[view]}},table:{id:'table-a',name:'Tasks',columns:[{id:'title',name:'Title',type:'text'}]},rows:[row],views:[view],canCustomize:true}),personalViews:vi.fn().mockResolvedValue({revision:0,activeView:'main',views:[],computed:[],layouts:{}}),conversation:vi.fn().mockResolvedValue({messages:[],hasMore:false,annotations:[]}),conversationNotifications:vi.fn().mockResolvedValue({items:[]}),deleteRow:vi.fn().mockRejectedValue(new Error('connection lost'))};let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppView httpBase="https://api.invalid" orgId="team:a" sessionToken="fixture" api={api} appId="tasks" initialSection="data" onClose={()=>{}} onBack={()=>{}}/>);await new Promise(resolve=>setTimeout(resolve,0))})
 const open=()=>tree!.root.findByProps({'aria-label':'Delete row'}).props.onClick(),confirm=()=>tree!.root.findAllByType('button').find(button=>button.props.className==='dlg-btn danger')!,cancel=()=>tree!.root.findAllByType('button').find(button=>button.props.className==='dlg-btn')!
 act(open);await act(async()=>{confirm().props.onClick();await Promise.resolve()});expect(api.deleteRow).toHaveBeenCalledOnce();act(()=>cancel().props.onClick());act(open);expect(confirm().props.disabled).toBe(true);expect(tree!.root.findAllByProps({role:'alert'})).toHaveLength(1)
 act(()=>cancel().props.onClick());api.app.mockRejectedValueOnce(new Error('refresh failed'));await act(async()=>{tree!.root.findByProps({'aria-label':'データを更新'}).props.onClick();await new Promise(resolve=>setTimeout(resolve,0))});act(open);expect(confirm().props.disabled).toBe(true)
 act(()=>cancel().props.onClick());await act(async()=>{tree!.root.findByProps({'aria-label':'データを更新'}).props.onClick();await new Promise(resolve=>setTimeout(resolve,0))});act(open);expect(confirm().props.disabled).toBe(false);expect(api.deleteRow).toHaveBeenCalledOnce();act(()=>tree!.unmount())
})
test('a refresh started before a failed delete cannot clear its later uncertain state',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn(),visibilityState:'visible'});vi.stubGlobal('location',{hash:'#/apps'})
 const row={id:'row-a',values:{title:'Alpha'},updatedAt:'2026-01-01T00:00:00.000Z'},view={id:'main',type:'table',name:'All',rows:[row]}
 const snapshot={app:{id:'tasks',name:'Tasks',description:'',icon:'grid',tableId:'table-a',version:1,createdBy:'owner',channels:[],definition:{views:[view]}},table:{id:'table-a',name:'Tasks',columns:[{id:'title',name:'Title',type:'text'}]},rows:[row],views:[view],canCustomize:true}
 let finish!:(value:typeof snapshot)=>void;const api:any={app:vi.fn().mockResolvedValue(snapshot),personalViews:vi.fn().mockResolvedValue({revision:0,activeView:'main',views:[],computed:[],layouts:{}}),conversation:vi.fn().mockResolvedValue({messages:[],hasMore:false,annotations:[]}),conversationNotifications:vi.fn().mockResolvedValue({items:[]}),deleteRow:vi.fn().mockRejectedValue(new Error('connection lost'))};let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppView httpBase="https://api.invalid" orgId="team:a" sessionToken="fixture" api={api} appId="tasks" initialSection="data" onClose={()=>{}} onBack={()=>{}}/>);await new Promise(resolve=>setTimeout(resolve,0))})
 api.app.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));act(()=>tree!.root.findByProps({'aria-label':'データを更新'}).props.onClick())
 act(()=>tree!.root.findByProps({'aria-label':'Delete row'}).props.onClick());await act(async()=>{tree!.root.findAllByType('button').find(button=>button.props.className==='dlg-btn danger')!.props.onClick();await Promise.resolve()});expect(api.deleteRow).toHaveBeenCalledOnce()
 act(()=>tree!.root.findAllByType('button').find(button=>button.props.className==='dlg-btn')!.props.onClick());await act(async()=>{finish(snapshot);await new Promise(resolve=>setTimeout(resolve,0))})
 act(()=>tree!.root.findByProps({'aria-label':'Delete row'}).props.onClick());expect(tree!.root.findAllByType('button').find(button=>button.props.className==='dlg-btn danger')!.props.disabled).toBe(true);act(()=>tree!.unmount())
})
