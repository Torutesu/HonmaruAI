import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {CompanyApp} from './CompanyApp'

const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>{resolve=r});return {promise,resolve}}
const button=(tree:ReturnType<typeof create>,text:string)=>tree.root.findAllByType('button').find(b=>b.children.join('')===text)!
test('action generation never replaces later edits without a decision',async()=>{
 const pending=deferred(),api:any={appActions:vi.fn().mockResolvedValue({actions:[]}),appConnections:vi.fn().mockResolvedValue({connections:[]}),appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),actionChange:vi.fn(()=>pending.promise)}
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<CompanyApp app={{id:'a'} as any} api={api} canManage reload={()=>{}}/>)})
 act(()=>tree.root.findByProps({placeholder:'例：入力された売上明細から税抜合計と消費税を計算する'}).props.onChange({target:{value:'calculate'}}))
 act(()=>tree.root.findByType('form').props.onSubmit({preventDefault(){}}))
 act(()=>tree.root.findByProps({'aria-label':'サーバー処理のコード'}).props.onChange({target:{value:'const mine = true'}}))
 await act(async()=>{pending.resolve({name:'generated',code:'return 123'});await pending.promise})
 expect(tree.root.findByProps({'aria-label':'サーバー処理のコード'}).props.value).toBe('const mine = true')
 expect(tree.root.findByProps({'aria-label':'生成されたサーバー処理'}).props.value).toBe('return 123')
 act(()=>tree.unmount())
})

test('unchanged generation applies directly; changed and reverted input requires explicit adoption',async()=>{
 const first=deferred(),second=deferred(),confirm=vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
 vi.stubGlobal('window',{confirm})
 const api:any={appActions:vi.fn().mockResolvedValue({actions:[]}),appConnections:vi.fn().mockResolvedValue({connections:[]}),appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),actionChange:vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)}
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<CompanyApp app={{id:'a',version:1} as any} api={api} canManage reload={()=>{}}/>)})
 const prompt=()=>tree.root.findByProps({placeholder:'例：入力された売上明細から税抜合計と消費税を計算する'})
 const code=()=>tree.root.findByProps({'aria-label':'サーバー処理のコード'})
 const submit=()=>act(()=>tree.root.findByType('form').props.onSubmit({preventDefault(){}}))
 act(()=>prompt().props.onChange({target:{value:'first'}}));submit()
 await act(async()=>{first.resolve({name:'one',code:'return 1'});await first.promise})
 expect(code().props.value).toBe('return 1')
 act(()=>prompt().props.onChange({target:{value:'second'}}));submit()
 act(()=>code().props.onChange({target:{value:'return 2'}}));act(()=>code().props.onChange({target:{value:'return 1'}}))
 await act(async()=>{second.resolve({name:'two',code:'return 3'});await second.promise})
 expect(code().props.value).toBe('return 1');expect(tree.root.findByProps({'aria-label':'サーバー処理の生成時の依頼'}).props.value).toBe('second')
 act(()=>button(tree,'生成結果を採用').props.onClick());expect(code().props.value).toBe('return 1')
 act(()=>button(tree,'生成結果を採用').props.onClick());expect(code().props.value).toBe('return 3')
 vi.unstubAllGlobals();act(()=>tree.unmount())
})

test('invalid generated results do not replace existing code',async()=>{
 const api:any={appActions:vi.fn().mockResolvedValue({actions:[]}),appConnections:vi.fn().mockResolvedValue({connections:[]}),appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),actionChange:vi.fn().mockResolvedValue({name:'bad',code:''})}
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<CompanyApp app={{id:'a',version:1} as any} api={api} canManage reload={()=>{}}/>)})
 act(()=>tree.root.findByProps({'aria-label':'サーバー処理のコード'}).props.onChange({target:{value:'Keep me'}}))
 act(()=>tree.root.findByProps({placeholder:'例：入力された売上明細から税抜合計と消費税を計算する'}).props.onChange({target:{value:'generate'}}))
 await act(async()=>{tree.root.findByType('form').props.onSubmit({preventDefault(){}});await Promise.resolve()})
 expect(tree.root.findByProps({'aria-label':'サーバー処理のコード'}).props.value).toBe('Keep me')
 expect(tree.root.findByProps({role:'alert'}).children.join('')).toContain('現在の入力は保持')
 act(()=>tree.unmount())
})

test('a changed app version is reviewed and old app results cannot overwrite the new app',async()=>{
 const first=deferred(),old=deferred(),api:any={appActions:vi.fn().mockResolvedValue({actions:[]}),appConnections:vi.fn().mockResolvedValue({connections:[]}),appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),actionChange:vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(old.promise)}
 const render=(id:string,version:number)=><CompanyApp app={{id,version} as any} api={api} canManage reload={()=>{}}/>
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(render('a',1))})
 const prompt=()=>tree.root.findByProps({placeholder:'例：入力された売上明細から税抜合計と消費税を計算する'})
 const code=()=>tree.root.findByProps({'aria-label':'サーバー処理のコード'})
 const submit=()=>act(()=>tree.root.findByType('form').props.onSubmit({preventDefault(){}}))
 act(()=>prompt().props.onChange({target:{value:'first'}}));submit();act(()=>tree.update(render('a',2)))
 await act(async()=>{first.resolve({name:'one',code:'return 1'});await first.promise})
 expect(code().props.value).toBe('');expect(JSON.stringify(tree.toJSON())).toContain('生成時からアプリの状態が変更')
 act(()=>button(tree,'生成結果を破棄し現在の入力を残す').props.onClick())
 act(()=>prompt().props.onChange({target:{value:'old'}}));submit()
 await act(async()=>{tree.update(render('b',1));await Promise.resolve()})
 act(()=>code().props.onChange({target:{value:'new app edit'}}))
 await act(async()=>{old.resolve({name:'old',code:'return 5'});await old.promise})
 expect(code().props.value).toBe('new app edit');expect(tree.root.findAllByProps({'aria-label':'生成されたサーバー処理'})).toHaveLength(0)
 act(()=>tree.unmount())
})
