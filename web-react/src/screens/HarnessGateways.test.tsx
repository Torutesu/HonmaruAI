import React from 'react'
import {act,create} from 'react-test-renderer'
import {test,expect,vi} from 'vitest'
import HarnessGateways from './HarnessGateways'
const state=vi.hoisted(()=>({api:null as any}))
vi.mock('./HarnessShared',async original=>({...await original<any>(),useApi:()=>state.api}))
vi.mock('../utils/i18n',()=>({useT:()=> (s:string)=>s}))
test('language switching retains both drafts and submits the selected language',async()=>{
 state.api={gateways:vi.fn().mockResolvedValue({gateways:[{id:'node',name:'Mac'}],canManage:false}),gatewayJobs:vi.fn().mockResolvedValue({jobs:[]}),execute:vi.fn().mockResolvedValue({job:{id:'job'}})}
 let tree:any
 await act(async()=>{tree=create(<HarnessGateways httpBase="https://example.test" orgId="org" sessionToken="session" onClose={()=>{}}/>)})
 const selects=()=>tree.root.findAllByType('select')
 const code=()=>tree.root.findAllByType('textarea')[0]
 await act(async()=>{code().props.onChange({target:{value:'return 17'}})})
 await act(async()=>{selects()[1].props.onChange({target:{value:'typescript'}})})
 expect(code().props.value).toContain('export default')
 await act(async()=>{code().props.onChange({target:{value:'export default (input: number) => input+1'}})})
 await act(async()=>{selects()[1].props.onChange({target:{value:'javascript'}})})
 expect(code().props.value).toBe('return 17')
 await act(async()=>{selects()[1].props.onChange({target:{value:'typescript'}});selects()[0].props.onChange({target:{value:'node'}})})
 await act(async()=>{tree.root.findAllByType('button').find((b:any)=>b.children.includes('Run')).props.onClick()})
 expect(state.api.execute).toHaveBeenCalledWith('node','export default (input: number) => input+1',21,expect.any(String),'typescript')
 act(()=>tree.unmount())
});
