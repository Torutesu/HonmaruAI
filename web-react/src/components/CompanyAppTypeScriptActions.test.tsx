import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {CompanyApp} from './CompanyApp'

test('a TypeScript server action keeps its language when the draft is saved and restored from history',async()=>{
 const source='export default async function(input: unknown): Promise<unknown> { return input; }'
 let saved=false
 const action={name:'typed_action',version:1,draft:source,language:'typescript',published:null,publishedLanguage:'typescript',publishedVersion:null}
 const api:any={appActions:vi.fn().mockImplementation(async()=>({actions:saved?[action]:[]})),appConnections:vi.fn().mockResolvedValue({connections:[]}),appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),actionChange:vi.fn().mockImplementation(async(_id:any,input:any)=>{saved=true;return {saved:true,version:input.version+1}}),actionHistory:vi.fn().mockResolvedValue({versions:[{version:1,code:source,language:'typescript',createdAt:'2026-11-14'}]})}
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<CompanyApp app={{id:'typed-app',version:1} as any} api={api} canManage reload={()=>{}}/>)});
 act(()=>tree.root.findByProps({placeholder:'calculate_total'}).props.onChange({target:{value:'typed_action'}}))
 act(()=>tree.root.findByProps({'aria-label':'Execution language'}).props.onChange({target:{value:'typescript'}}))
 act(()=>tree.root.findByProps({'aria-label':'サーバー処理のコード'}).props.onChange({target:{value:source}}))
 const button=(text:string)=>tree.root.findAllByType('button').find(b=>b.children.join('')===text)!
 await act(async()=>{button('処理の下書きを保存').props.onClick();await Promise.resolve();await Promise.resolve()})
 expect(api.actionChange).toHaveBeenCalledWith('typed-app',expect.objectContaining({action:'draft',name:'typed_action',version:0,language:'typescript',code:source}))
 expect(tree.root.findByProps({'aria-label':'Execution language'}).props.value).toBe('typescript')
 act(()=>button('typed_action · 下書き').props.onClick())
 await act(async()=>{tree.root.findByType('details').props.onToggle({currentTarget:{open:true}});await Promise.resolve()})
 expect(tree.toJSON()).toBeTruthy()
 act(()=>tree.unmount())
})
