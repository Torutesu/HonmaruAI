import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {CompanyApp} from './CompanyApp'

test('publishing an action must not cause later edits to save against an obsolete revision',async()=>{
 const draft='return 1',first={name:'report',version:1,draft,published:null},published={...first,version:2,published:draft,publishedVersion:2}
 const api:any={appActions:vi.fn().mockResolvedValueOnce({actions:[first]}).mockResolvedValue({actions:[published]}),appConnections:vi.fn().mockResolvedValue({connections:[]}),appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),actionChange:vi.fn().mockImplementation(async(_id:any,input:any)=>({saved:true,version:input.version+1}))}
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<CompanyApp app={{id:'a',version:1} as any} api={api} canManage reload={()=>{}}/>)})
 const button=(text:string)=>tree.root.findAllByType('button').find(b=>b.children.join('')===text)!
 act(()=>button('report · 下書き').props.onClick())
 await act(async()=>{button('処理を公開').props.onClick();await Promise.resolve();await Promise.resolve()})
 act(()=>tree.root.findByProps({'aria-label':'サーバー処理のコード'}).props.onChange({target:{value:'return 2'}}))
 await act(async()=>{button('処理の下書きを保存').props.onClick();await Promise.resolve()})
 expect(api.actionChange).toHaveBeenCalledWith('a',expect.objectContaining({action:'draft',version:2,code:'return 2'}))
 act(()=>tree.unmount())
})

test('an unexpected success revision is not adopted as the editing baseline',async()=>{
 const action={name:'report',version:1,draft:'return 1',published:null}
 const api:any={appActions:vi.fn().mockResolvedValue({actions:[action]}),appConnections:vi.fn().mockResolvedValue({connections:[]}),appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),actionChange:vi.fn().mockResolvedValue({saved:true,version:9})}
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<CompanyApp app={{id:'a',version:1} as any} api={api} canManage reload={()=>{}}/>)})
 const button=(text:string)=>tree.root.findAllByType('button').find(b=>b.children.join('')===text)!
 act(()=>button('report · 下書き').props.onClick())
 act(()=>tree.root.findByProps({'aria-label':'サーバー処理のコード'}).props.onChange({target:{value:'return 2'}}))
 await act(async()=>{button('処理の下書きを保存').props.onClick();await Promise.resolve()})
 expect(tree.root.findByProps({role:'alert'}).children.join('')).toContain('保存結果を確認できません')
 expect(tree.root.findByProps({'aria-label':'サーバー処理のコード'}).props.value).toBe('return 2')
 await act(async()=>{button('処理の下書きを保存').props.onClick();await Promise.resolve()})
 expect(api.actionChange).toHaveBeenLastCalledWith('a',expect.objectContaining({action:'draft',version:1}))
 act(()=>tree.unmount())
})

test('unpublishing keeps the revision current for later edits',async()=>{
 const first={name:'report',version:2,draft:'return 1',published:'return 1',publishedVersion:2},stopped={...first,version:3,published:null,publishedVersion:null}
 const api:any={appActions:vi.fn().mockResolvedValueOnce({actions:[first]}).mockResolvedValue({actions:[stopped]}),appConnections:vi.fn().mockResolvedValue({connections:[]}),appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),actionChange:vi.fn().mockImplementation(async(_id:any,input:any)=>({saved:true,version:input.version+1}))}
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<CompanyApp app={{id:'a',version:1} as any} api={api} canManage reload={()=>{}}/>)})
 const button=(text:string)=>tree.root.findAllByType('button').find(b=>b.children.join('')===text)!
 act(()=>button('report · 公開中').props.onClick())
 await act(async()=>{button('処理の公開を停止').props.onClick();await Promise.resolve();await Promise.resolve()})
 act(()=>tree.root.findByProps({'aria-label':'サーバー処理のコード'}).props.onChange({target:{value:'return 2'}}))
 await act(async()=>{button('処理の下書きを保存').props.onClick();await Promise.resolve()})
 expect(api.actionChange).toHaveBeenCalledWith('a',expect.objectContaining({action:'draft',version:3,code:'return 2'}))
 act(()=>tree.unmount())
})

test('edits entered while history is restoring are retained with the resulting revision',async()=>{
 const confirm=vi.fn(()=>true);vi.stubGlobal('window',{confirm})
 let finish!:(value:any)=>void;const pending=new Promise(resolve=>{finish=resolve})
 const first={name:'report',version:2,draft:'return 2',published:null},restored={...first,version:3,draft:'return 1'}
 const api:any={appActions:vi.fn().mockResolvedValueOnce({actions:[first]}).mockResolvedValue({actions:[restored]}),appConnections:vi.fn().mockResolvedValue({connections:[]}),appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),actionHistory:vi.fn().mockResolvedValue({versions:[{version:1,code:'return 1',createdAt:'2026-01-01'}]}),actionChange:vi.fn().mockImplementation(async(_id:any,input:any)=>input.action==='restore'?pending:{saved:true,version:input.version+1})}
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<CompanyApp app={{id:'a',version:1} as any} api={api} canManage reload={()=>{}}/>)})
 const button=(text:string)=>tree.root.findAllByType('button').find(b=>b.children.join('')===text)!
 act(()=>button('report · 下書き').props.onClick())
 await act(async()=>{tree.root.findByType('details').props.onToggle({currentTarget:{open:true}});await Promise.resolve()})
 act(()=>button('この版を下書きに復元').props.onClick())
 act(()=>tree.root.findByProps({'aria-label':'サーバー処理のコード'}).props.onChange({target:{value:'return "new edit"'}}))
 await act(async()=>{finish({saved:true,version:3});await pending;await Promise.resolve()})
 expect(tree.root.findByProps({'aria-label':'サーバー処理のコード'}).props.value).toBe('return "new edit"')
 expect(JSON.stringify(tree.toJSON())).toContain('復元中に入力したコードは保持')
 await act(async()=>{button('処理の下書きを保存').props.onClick();await Promise.resolve()})
 expect(api.actionChange).toHaveBeenCalledWith('a',expect.objectContaining({action:'draft',version:3,code:'return "new edit"'}))
 vi.unstubAllGlobals()
 act(()=>tree.unmount())
})

test('cancelling a history restore keeps the unsaved code and makes no write',async()=>{
 const confirm=vi.fn(()=>false);vi.stubGlobal('window',{confirm})
 const action={name:'report',version:2,draft:'return 2',published:null}
 const api:any={appActions:vi.fn().mockResolvedValue({actions:[action]}),appConnections:vi.fn().mockResolvedValue({connections:[]}),appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),actionHistory:vi.fn().mockResolvedValue({versions:[{version:1,code:'return 1',createdAt:'2026-01-01'}]}),actionChange:vi.fn()}
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<CompanyApp app={{id:'a',version:1} as any} api={api} canManage reload={()=>{}}/>)})
 const button=(text:string)=>tree.root.findAllByType('button').find(b=>b.children.join('')===text)!
 act(()=>button('report · 下書き').props.onClick())
 act(()=>tree.root.findByProps({'aria-label':'サーバー処理のコード'}).props.onChange({target:{value:'return "unsaved"'}}))
 await act(async()=>{tree.root.findByType('details').props.onToggle({currentTarget:{open:true}});await Promise.resolve()})
 act(()=>button('この版を下書きに復元').props.onClick())
 expect(confirm).toHaveBeenCalledWith(expect.stringContaining('現在の未保存コードも置き換わります'))
 expect(api.actionChange).not.toHaveBeenCalled()
 expect(tree.root.findByProps({'aria-label':'サーバー処理のコード'}).props.value).toBe('return "unsaved"')
 vi.unstubAllGlobals();act(()=>tree.unmount())
})
