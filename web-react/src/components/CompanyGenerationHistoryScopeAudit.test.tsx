import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {CompanyApp} from './CompanyApp'

test('late action history from another app must not appear in the current app',async()=>{
 let finish!:(value:any)=>void;const history=new Promise(resolve=>{finish=resolve})
 const action={name:'report',version:1,draft:'return 1',published:null}
 const api:any={appActions:vi.fn().mockResolvedValue({actions:[action]}),appConnections:vi.fn().mockResolvedValue({connections:[]}),appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),actionHistory:vi.fn(()=>history)}
 const render=(id:string)=><CompanyApp app={{id,version:1} as any} api={api} canManage reload={()=>{}}/>
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(render('a'))})
 const button=(text:string)=>tree.root.findAllByType('button').find(b=>b.children.join('')===text)!
 act(()=>button('report · 下書き').props.onClick())
 act(()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
 await act(async()=>{tree.update(render('b'));await Promise.resolve()})
 act(()=>button('report · 下書き').props.onClick())
 await act(async()=>{finish({versions:[{version:1,code:'private a history',createdAt:'2026-01-01'}]});await history})
 expect(JSON.stringify(tree.toJSON())).not.toContain('private a history')
 act(()=>tree.unmount())
})

test('late history of one action must not appear under another selected action',async()=>{
 let finish!:(value:any)=>void;const history=new Promise(resolve=>{finish=resolve})
 const actions=[{name:'alpha',version:1,draft:'return 1',published:null},{name:'beta',version:1,draft:'return 2',published:null}]
 const api:any={appActions:vi.fn().mockResolvedValue({actions}),appConnections:vi.fn().mockResolvedValue({connections:[]}),appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),actionHistory:vi.fn(()=>history)}
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<CompanyApp app={{id:'a',version:1} as any} api={api} canManage reload={()=>{}}/>)})
 const button=(text:string)=>tree.root.findAllByType('button').find(b=>b.children.join('')===text)!
 act(()=>button('alpha · 下書き').props.onClick())
 act(()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
 act(()=>button('beta · 下書き').props.onClick())
 await act(async()=>{finish({versions:[{version:1,code:'alpha history',createdAt:'2026-01-01'}]});await history})
 expect(tree.root.findByProps({placeholder:'calculate_total'}).props.value).toBe('beta')
 expect(JSON.stringify(tree.toJSON())).not.toContain('alpha history')
 act(()=>tree.unmount())
})

test('late old history cannot replace a newer action history',async()=>{
 let finishOld!:(value:any)=>void;const oldHistory=new Promise(resolve=>{finishOld=resolve})
 const actions=[{name:'alpha',version:1,draft:'return 1',published:null},{name:'beta',version:1,draft:'return 2',published:null}]
 const api:any={appActions:vi.fn().mockResolvedValue({actions}),appConnections:vi.fn().mockResolvedValue({connections:[]}),appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),actionHistory:vi.fn((_id:string,name:string)=>name==='alpha'?oldHistory:Promise.resolve({versions:[{version:1,code:'beta history',createdAt:'2026-02-01'}]}))}
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<CompanyApp app={{id:'a',version:1} as any} api={api} canManage reload={()=>{}}/>)})
 const button=(text:string)=>tree.root.findAllByType('button').find(b=>b.children.join('')===text)!
 act(()=>button('alpha · 下書き').props.onClick());act(()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
 act(()=>button('beta · 下書き').props.onClick());await act(async()=>{tree.root.findByType('details').props.onToggle({currentTarget:{open:true}});await Promise.resolve()})
 expect(JSON.stringify(tree.toJSON())).toContain('beta history')
 await act(async()=>{finishOld({versions:[{version:1,code:'alpha history',createdAt:'2026-01-01'}]});await oldHistory})
 expect(JSON.stringify(tree.toJSON())).toContain('beta history');expect(JSON.stringify(tree.toJSON())).not.toContain('alpha history')
 act(()=>tree.unmount())
})

test('history selection A to B to A rejects the first A response',async()=>{
 let finishOld!:(value:any)=>void;const oldHistory=new Promise(resolve=>{finishOld=resolve})
 const actions=[{name:'alpha',version:1,draft:'return 1',published:null},{name:'beta',version:1,draft:'return 2',published:null}]
 const api:any={appActions:vi.fn().mockResolvedValue({actions}),appConnections:vi.fn().mockResolvedValue({connections:[]}),appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),actionHistory:vi.fn().mockReturnValueOnce(oldHistory).mockResolvedValueOnce({versions:[{version:2,code:'new alpha',createdAt:'2026-02-01'}]})}
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<CompanyApp app={{id:'a',version:1} as any} api={api} canManage reload={()=>{}}/>)})
 const button=(text:string)=>tree.root.findAllByType('button').find(b=>b.children.join('')===text)!
 act(()=>button('alpha · 下書き').props.onClick());act(()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
 act(()=>button('beta · 下書き').props.onClick());act(()=>button('alpha · 下書き').props.onClick())
 await act(async()=>{tree.root.findByType('details').props.onToggle({currentTarget:{open:true}});await Promise.resolve()})
 await act(async()=>{finishOld({versions:[{version:1,code:'old alpha',createdAt:'2026-01-01'}]});await oldHistory})
 expect(JSON.stringify(tree.toJSON())).toContain('new alpha');expect(JSON.stringify(tree.toJSON())).not.toContain('old alpha')
 act(()=>tree.unmount())
})
