import React from 'react'
import {act,create} from 'react-test-renderer'
import {test,expect,vi,beforeEach,afterEach} from 'vitest'
import HarnessGateways from './HarnessGateways'
import {HarnessApiError} from '../utils/harness'
const state=vi.hoisted(()=>({api:null as any,locale:'en'}))
vi.mock('./HarnessShared',async original=>({...await original<any>(),useApi:()=>state.api}))
vi.mock('../utils/i18n',()=>({useT:()=> (s:string,vars?:Record<string,string>)=>Object.entries(vars||{}).reduce((text,[key,value])=>text.replace(`{${key}}`,value),s)}))
vi.mock('../utils/locale',()=>({getLocale:()=>state.locale}))
beforeEach(()=>vi.stubGlobal('window',{setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval}))
afterEach(()=>vi.unstubAllGlobals())
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

test('shows contact time without calling a node online, including absent, old and invalid dates',async()=>{
 const old=Date.UTC(2020,0,2,3,4,5)
 state.api={gateways:vi.fn().mockResolvedValue({gateways:[
  {id:'never',name:'New Mac',lastSeenAt:null,revokedAt:null},
  {id:'old',name:'Old Mac',lastSeenAt:old,revokedAt:null},
  {id:'bad',name:'Bad date',lastSeenAt:1e20,revokedAt:null},
  {id:'revoked',name:'Revoked Mac',lastSeenAt:old,revokedAt:old},
 ],canManage:false}),gatewayJobs:vi.fn().mockResolvedValue({jobs:[]})}
 let tree:any
 await act(async()=>{tree=create(<HarnessGateways httpBase="https://example.test" orgId="org" sessionToken="session" onClose={()=>{}}/>)})
 const select=tree.root.findByProps({'aria-label':'Execution node'})
 const options=select.findAllByType('option')
 const option=(id:string)=>options.find((node:any)=>node.props.value===id)?.children.join('')
 expect(option('never')).toContain('No contact recorded')
 expect(option('old')).toContain(`Last contact: ${new Date(old).toLocaleString('en')}`)
 expect(option('bad')).toContain('Contact time unavailable')
 expect(option('revoked')).toBeUndefined()
 expect(JSON.stringify(tree.toJSON())).not.toMatch(/Invalid Date|\bonline\b/i)
 expect(JSON.stringify(tree.toJSON())).toContain('Last contact does not guarantee availability')
 act(()=>tree.unmount())
})

test('reloading contact information retains the chosen node and code and input drafts',async()=>{
 const before=Date.UTC(2020,0,2),after=Date.UTC(2021,0,2)
 const gateways=vi.fn().mockResolvedValueOnce({gateways:[{id:'node',name:'Mac',lastSeenAt:before}],canManage:false})
  .mockResolvedValueOnce({gateways:[{id:'node',name:'Mac',lastSeenAt:after}],canManage:false})
 state.api={gateways,gatewayJobs:vi.fn().mockResolvedValue({jobs:[]})}
 let tree:any
 await act(async()=>{tree=create(<HarnessGateways httpBase="https://example.test" orgId="org" sessionToken="session" onClose={()=>{}}/>)})
 const node=()=>tree.root.findByProps({'aria-label':'Execution node'})
 const code=()=>tree.root.findByProps({'aria-label':'JavaScript'})
 const input=()=>tree.root.findByProps({'aria-label':'Input (JSON)'})
 act(()=>{node().props.onChange({target:{value:'node'}});code().props.onChange({target:{value:'return input + 1'}});input().props.onChange({target:{value:'42'}})})
 await act(async()=>{tree.root.findAllByType('button').find((button:any)=>button.children.includes('Reload')).props.onClick()})
 expect(node().props.value).toBe('node')
 expect(code().props.value).toBe('return input + 1')
 expect(input().props.value).toBe('42')
 expect(node().findAllByType('option').find((option:any)=>option.props.value==='node').children.join('')).toContain(new Date(after).toLocaleString('en'))
 expect(gateways).toHaveBeenCalledTimes(2)
 act(()=>tree.unmount())
})

test('uses the chosen locale for contact time and preserves drafts when it changes',async()=>{
 const lastSeenAt=Date.UTC(2020,0,2,3,4,5)
 state.locale='en-US'
 state.api={gateways:vi.fn().mockResolvedValue({gateways:[{id:'node',name:'Mac',lastSeenAt}],canManage:false}),gatewayJobs:vi.fn().mockResolvedValue({jobs:[]})}
 const props={httpBase:'https://example.test',orgId:'org',sessionToken:'session',onClose:()=>{}}
 let tree:any
 try {
  await act(async()=>{tree=create(<HarnessGateways {...props}/>)})
  const node=()=>tree.root.findByProps({'aria-label':'Execution node'})
  const code=()=>tree.root.findByProps({'aria-label':'JavaScript'})
  const option=()=>node().findAllByType('option').find((row:any)=>row.props.value==='node').children.join('')
  act(()=>{node().props.onChange({target:{value:'node'}});code().props.onChange({target:{value:'return 123'}})})
  expect(option()).toContain(new Date(lastSeenAt).toLocaleString('en-US'))
  state.locale='ja-JP'
  act(()=>tree.update(<HarnessGateways {...props}/>))
  expect(option()).toContain(new Date(lastSeenAt).toLocaleString('ja-JP'))
  expect(node().props.value).toBe('node')
  expect(code().props.value).toBe('return 123')
  state.locale='bad_tag'
  act(()=>tree.update(<HarnessGateways {...props}/>))
  expect(option()).toContain(new Date(lastSeenAt).toLocaleString('en'))
 } finally { state.locale='en'; act(()=>tree.unmount()) }
})

test.each(['revoked','missing'])('does not run against a %s node after reload and retains the draft',async(reason)=>{
 const original={id:'node',name:'Mac',lastSeenAt:1000,revokedAt:null}
 const gateways=vi.fn().mockResolvedValueOnce({gateways:[original],canManage:false})
  .mockResolvedValueOnce({gateways:reason==='revoked'?[{...original,revokedAt:2000}]:[],canManage:false})
  .mockResolvedValueOnce({gateways:[original],canManage:false})
 state.api={gateways,gatewayJobs:vi.fn().mockResolvedValue({jobs:[]}),execute:vi.fn()}
 let tree:any
 await act(async()=>{tree=create(<HarnessGateways httpBase="https://example.test" orgId="org" sessionToken="session" onClose={()=>{}}/>)})
 const node=()=>tree.root.findByProps({'aria-label':'Execution node'})
 const code=()=>tree.root.findByProps({'aria-label':'JavaScript'})
 const input=()=>tree.root.findByProps({'aria-label':'Input (JSON)'})
 const button=(label:string)=>tree.root.findAllByType('button').find((row:any)=>row.children.includes(label))
 act(()=>{node().props.onChange({target:{value:'node'}});code().props.onChange({target:{value:'return 99'}});input().props.onChange({target:{value:'42'}})})
 expect(button('Run').props.disabled).toBe(false)
 await act(async()=>button('Reload').props.onClick())
 expect(button('Run').props.disabled).toBe(true)
 expect(tree.root.findByProps({role:'status'}).children.join('')).toContain('The selected node is unavailable')
 expect(code().props.value).toBe('return 99');expect(input().props.value).toBe('42')
 expect(state.api.execute).not.toHaveBeenCalled()
 await act(async()=>button('Reload').props.onClick())
 expect(node().props.value).toBe('node');expect(button('Run').props.disabled).toBe(false)
 expect(code().props.value).toBe('return 99');expect(input().props.value).toBe('42')
 act(()=>tree.unmount())
})

test.each(['already_terminal','cancellation_unconfirmed'])('refreshes history and reports %s without losing the draft',async(codeName)=>{
 const node={id:'node',name:'Mac',lastSeenAt:1000,revokedAt:null}
 const job={id:'job',gatewayId:'node',status:'running',createdAt:1000,result:null}
 const jobs=vi.fn().mockResolvedValueOnce({jobs:[job]}).mockResolvedValueOnce({jobs:[{...job,status:'succeeded'}]})
 state.api={gateways:vi.fn().mockResolvedValue({gateways:[node],canManage:false}),gatewayJobs:jobs,cancelExecution:vi.fn().mockRejectedValue(new HarnessApiError('server',409,codeName))}
 let tree:any
 await act(async()=>{tree=create(<HarnessGateways httpBase="https://example.test" orgId="org" sessionToken="session" onClose={()=>{}}/>)})
 const select=()=>tree.root.findByProps({'aria-label':'Execution node'})
 const code=()=>tree.root.findByProps({'aria-label':'JavaScript'})
 const input=()=>tree.root.findByProps({'aria-label':'Input (JSON)'})
 const button=(label:string)=>tree.root.findAllByType('button').find((row:any)=>row.children.includes(label))
 act(()=>{select().props.onChange({target:{value:'node'}});code().props.onChange({target:{value:'return 99'}});input().props.onChange({target:{value:'42'}})})
 await act(async()=>button('Cancel').props.onClick())
 const message=tree.root.findByProps({role:'alert'}).children[0]
 expect(message).toBe(`Execution job: ${codeName==='already_terminal'?'Execution finished before it could be cancelled.':'Cancellation could not be confirmed. Reload execution history to check.'}`)
 expect(JSON.stringify(tree.toJSON())).toContain('succeeded')
 expect(button('Cancel')).toBeUndefined()
 expect(select().props.value).toBe('node');expect(code().props.value).toBe('return 99');expect(input().props.value).toBe('42')
 expect(jobs).toHaveBeenCalledTimes(2)
 act(()=>tree.unmount())
})

test('distinguishes a failed history refresh from a confirmed cancellation',async()=>{
 const job={id:'job',gatewayId:'node',status:'running',createdAt:1000,result:null}
 const jobs=vi.fn().mockResolvedValueOnce({jobs:[job]}).mockRejectedValueOnce(new Error('offline'))
 state.api={gateways:vi.fn().mockResolvedValue({gateways:[{id:'node',name:'Mac'}],canManage:false}),gatewayJobs:jobs,cancelExecution:vi.fn().mockRejectedValue(new HarnessApiError('server',409,'already_terminal'))}
 let tree:any
 await act(async()=>{tree=create(<HarnessGateways httpBase="https://example.test" orgId="org" sessionToken="session" onClose={()=>{}}/>)})
 const button=tree.root.findAllByType('button').find((row:any)=>row.children.includes('Cancel'))
 await act(async()=>button.props.onClick())
 expect(tree.root.findByProps({role:'alert'}).children[0]).toBe('Execution job: Execution history could not be refreshed. Reload to check the cancellation result.')
 act(()=>tree.unmount())
})

test('successful cancellation still refreshes history',async()=>{
 const job={id:'job',gatewayId:'node',status:'running',createdAt:1000,result:null}
 const jobs=vi.fn().mockResolvedValueOnce({jobs:[job]}).mockResolvedValueOnce({jobs:[{...job,status:'cancelled'}]})
 state.api={gateways:vi.fn().mockResolvedValue({gateways:[{id:'node',name:'Mac'}],canManage:false}),gatewayJobs:jobs,cancelExecution:vi.fn().mockResolvedValue({cancelled:true})}
 let tree:any
 await act(async()=>{tree=create(<HarnessGateways httpBase="https://example.test" orgId="org" sessionToken="session" onClose={()=>{}}/>)})
 await act(async()=>tree.root.findAllByType('button').find((row:any)=>row.children.includes('Cancel')).props.onClick())
 expect(JSON.stringify(tree.toJSON())).toContain('cancelled')
 expect(tree.root.findAllByProps({role:'alert'})).toHaveLength(0)
 expect(jobs).toHaveBeenCalledTimes(2)
 act(()=>tree.unmount())
})

test('an unconfirmed result stays visible across polling and cancellation of another job',async()=>{
 vi.useFakeTimers()
 vi.stubGlobal('window',{setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval})
 const a={id:'a',gatewayId:'node',status:'running',createdAt:1000,result:null}
 const b={id:'b',gatewayId:'node',status:'running',createdAt:2000,result:null}
 let jobs=[a,b]
 const cancelExecution=vi.fn(async(id:string)=>{
  if(id==='a')throw new HarnessApiError('server',409,'cancellation_unconfirmed')
  jobs=[a,{...b,status:'cancelled'}];return {cancelled:true}
 })
 state.api={gateways:vi.fn().mockResolvedValue({gateways:[{id:'node',name:'Mac'}],canManage:false}),gatewayJobs:vi.fn(async()=>({jobs})),cancelExecution}
 let tree:any
 try {
  await act(async()=>{tree=create(<HarnessGateways httpBase="https://example.test" orgId="org" sessionToken="session" onClose={()=>{}}/>)})
  const cancels=()=>tree.root.findAllByType('button').filter((row:any)=>row.children.includes('Cancel'))
  await act(async()=>cancels()[0].props.onClick())
  expect(tree.root.findByProps({role:'alert'}).children[0]).toContain('Execution a: Cancellation could not be confirmed.')
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000)})
  expect(tree.root.findByProps({role:'alert'}).children[0]).toContain('Execution a: Cancellation could not be confirmed.')
  await act(async()=>cancels()[1].props.onClick())
  expect(tree.root.findByProps({role:'alert'}).children[0]).toContain('Execution a: Cancellation could not be confirmed.')
 } finally { if(tree)act(()=>tree.unmount());vi.useRealTimers() }
})

test('retrying the same unconfirmed cancellation during a network failure keeps its notice',async()=>{
 const job={id:'a',gatewayId:'node',status:'running',createdAt:1000,result:null}
 const cancelExecution=vi.fn().mockRejectedValueOnce(new HarnessApiError('server',409,'cancellation_unconfirmed')).mockRejectedValueOnce(new TypeError('offline'))
 state.api={gateways:vi.fn().mockResolvedValue({gateways:[{id:'node',name:'Mac'}],canManage:false}),gatewayJobs:vi.fn().mockResolvedValue({jobs:[job]}),cancelExecution}
 let tree:any
 await act(async()=>{tree=create(<HarnessGateways httpBase="https://example.test" orgId="org" sessionToken="session" onClose={()=>{}}/>)})
 const cancel=()=>tree.root.findAllByType('button').find((row:any)=>row.children.includes('Cancel'))
 await act(async()=>cancel().props.onClick())
 expect(tree.root.findByProps({role:'alert'}).children[0]).toContain('Execution a: Cancellation could not be confirmed.')
 await act(async()=>cancel().props.onClick())
 expect(tree.root.findByProps({role:'alert'}).children[0]).toContain('Execution a: Cancellation could not be confirmed.')
 act(()=>tree.unmount())
})
