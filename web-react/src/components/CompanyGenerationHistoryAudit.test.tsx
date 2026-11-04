import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {CompanyApp} from './CompanyApp'

test('opening history during generation does not silently omit history',async()=>{
 let finish!:(value:any)=>void
 const generation=new Promise(resolve=>{finish=resolve})
 const action={name:'report',version:1,draft:'return 1',published:null}
 const api:any={appActions:vi.fn().mockResolvedValue({actions:[action]}),appConnections:vi.fn().mockResolvedValue({connections:[]}),appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),actionHistory:vi.fn().mockResolvedValue({versions:[{version:1,code:'return 1',createdAt:'2026-01-01'}]}),actionChange:vi.fn(()=>generation)}
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<CompanyApp app={{id:'a',version:1} as any} api={api} canManage reload={()=>{}}/>)})
 const button=(text:string)=>tree.root.findAllByType('button').find(b=>b.children.join('')===text)!
 act(()=>button('report · 下書き').props.onClick())
 act(()=>tree.root.findByProps({placeholder:'例：入力された売上明細から税抜合計と消費税を計算する'}).props.onChange({target:{value:'Rewrite'}}))
 act(()=>tree.root.findByType('form').props.onSubmit({preventDefault(){}}))
 act(()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}))
 await act(async()=>{finish({name:'report',code:'return 2'});await generation})
 expect(api.actionHistory).toHaveBeenCalledOnce()
 expect(JSON.stringify(tree.toJSON())).toContain('2026-01-01')
 act(()=>tree.unmount())
})
