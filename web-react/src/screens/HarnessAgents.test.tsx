import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { HarnessAgents, HarnessSkillImport } from './HarnessAgents'
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
vi.mock('../utils/mentions', () => ({ useMembers: () => [] }))
vi.mock('../components/AgentAvatar', () => ({ AgentAvatar: () => null }))
vi.mock('../components/Icon', () => ({ Icon: () => null }))
vi.mock('../components/AgentAccessDialog',()=>({AgentAccessDialog:({onClose}:any)=><button data-testid="close-access" onClick={()=>onClose('team')}>Close access</button>}))
vi.mock('../components/AgentPersona',()=>({AgentPersona:()=>null}))

test('Skill-link import previews a public package, optionally installs it on a managed Agent, and reports the private copy',async()=>{
 let tree!:ReturnType<typeof create>
 const requests:Array<{url:URL;init?:RequestInit}> = []
 const fetch=vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=new URL(String(input));requests.push({url,init})
  if(url.pathname.endsWith('/import-agents'))return {ok:true,json:async()=>({agents:[{id:'agent_1',name:'Sales agent'}]})}
  if(init?.method==='POST')return {ok:true,json:async()=>({skill:{id:'skill_copy',name:'Shared procedure',body:'steps',description:'procedure',createdBy:'9401'},installedOnAgent:true})}
  return {ok:true,json:async()=>({share:{name:'Shared procedure',description:'procedure',metadata:{},fileCount:2,totalBytes:200,expiresAt:'2026-11-07T00:00:00Z'}})}
 })
 vi.stubGlobal('fetch',fetch)
 try{
  await act(async()=>{tree=create(<HarnessSkillImport token={`skl_${'ab'.repeat(32)}`} httpBase="https://api.example" orgId="one" sessionToken="session" onClose={vi.fn()}/>)})
  expect(JSON.stringify(tree.toJSON())).toContain('Shared procedure')
  expect(JSON.stringify(tree.toJSON())).toContain('This link imports a new private Skill')
  expect(tree.root.findAllByType('a').find(link=>link.children.includes('Download ZIP'))!.props.href).toBe(`https://api.example/skill-shares/${'skl_'+'ab'.repeat(32)}/download`)
  await act(async()=>tree.root.findByProps({'aria-label':'Name for your copy'}).props.onChange({target:{value:'Local copy'}}))
  await act(async()=>tree.root.findByProps({'aria-label':'Install on agent (optional)'}).props.onChange({target:{value:'agent_1'}}))
  const submit=tree.root.findAllByType('button').find(button=>button.children.includes('Import private copy'))!
  await act(async()=>submit.props.onClick())
  const write=requests.find(item=>item.init?.method==='POST')!
  expect(JSON.parse(String(write.init?.body))).toMatchObject({orgId:'one',name:'Local copy',agentId:'agent_1'})
  expect(JSON.stringify(tree.toJSON())).toContain('Skill imported')
  expect(JSON.stringify(tree.toJSON())).toContain('{name} is now a private Skill in this workspace.')
 }finally{act(()=>tree?.unmount());vi.unstubAllGlobals()}
})

test('public Skill preview and ZIP remain available when the member-only Agent list is unavailable',async()=>{
 let tree!:ReturnType<typeof create>
 vi.stubGlobal('fetch',vi.fn(async(input:string)=>{
  const path=new URL(input).pathname
  if(path.endsWith('/import-agents'))return {ok:false,json:async()=>({message:'No member access'})}
  return {ok:true,json:async()=>({share:{name:'Read-only Skill',description:'Public instructions',metadata:{},fileCount:1,totalBytes:80,expiresAt:'2026-11-07T00:00:00Z'}})}
 }))
 try{
  await act(async()=>{tree=create(<HarnessSkillImport token={`skl_${'cd'.repeat(32)}`} httpBase="https://api.example" orgId="one" sessionToken="guest" onClose={vi.fn()}/>)})
  expect(JSON.stringify(tree.toJSON())).toContain('Read-only Skill')
  expect(tree.root.findAllByType('a').find(link=>link.children.includes('Download ZIP'))!.props.href).toBe(`https://api.example/skill-shares/${'skl_'+'cd'.repeat(32)}/download`)
  expect(tree.root.findAllByProps({role:'alert'})).toHaveLength(0)
 }finally{act(()=>tree?.unmount());vi.unstubAllGlobals()}
})

test('closing access reloads the directory and dismisses an agent whose grant was removed',async()=>{
 let visible=true;let tree!:ReturnType<typeof create>
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({agents:visible?[{id:'a',name:'Shared agent',handle:'shared',scope:'team'}]:[],profile:{tier:'standard',people:[],access:'private'},canEdit:false,memories:[],skills:[],followups:[],scopes:[]})})))
 try{
  await act(async()=>{tree=create(<HarnessAgents httpBase="https://example.test" orgId="one" sessionToken="first" onClose={vi.fn()}/>)})
  await act(async()=>tree.root.findByProps({'data-agent':'a'}).props.onClick())
  expect(tree.root.findAllByType('button').some(n=>n.children.includes('Advanced settings'))).toBe(false)
  expect(tree.root.findAllByProps({'aria-label':'Edit profile'})).toHaveLength(0)
  await act(async()=>tree.root.findAllByType('button').find(n=>n.children.includes('Agent access'))!.props.onClick())
  visible=false
  await act(async()=>tree.root.findByProps({'data-testid':'close-access'}).props.onClick())
  expect(tree.root.findAllByProps({'data-agent':'a'})).toHaveLength(0)
  expect(JSON.stringify(tree.toJSON())).toContain('Choose a member')
 }finally{act(()=>tree?.unmount());vi.unstubAllGlobals()}
})

test('a private Agent access invalidation reloads the directory and closes a revoked profile',async()=>{
 let visible=true;let tree!:ReturnType<typeof create>
 const requests:string[]=[]
 const fetch=vi.fn(async(input:string)=>{requests.push(input);return {ok:true,json:async()=>({agents:visible?[{id:'a',name:'Shared agent',handle:'shared',scope:'team'}]:[]})}})
 vi.stubGlobal('fetch',fetch);vi.stubGlobal('window',new EventTarget())
 try{
  await act(async()=>{tree=create(<HarnessAgents httpBase="https://example.test" orgId="one" sessionToken="first" onClose={vi.fn()}/>)})
  await act(async()=>tree.root.findByProps({'data-agent':'a'}).props.onClick())
  expect(JSON.stringify(tree.toJSON())).toContain('Shared agent')
  visible=false
  await act(async()=>{window.dispatchEvent(new Event('honmaru:agents-changed'))})
  expect(requests.filter(raw=>new URL(raw).pathname==='/channels/agents')).toHaveLength(2)
  expect(tree.root.findAllByProps({'data-agent':'a'})).toHaveLength(0)
  expect(JSON.stringify(tree.toJSON())).toContain('Choose a member')
 }finally{act(()=>tree?.unmount());vi.unstubAllGlobals()}
})

test('a targeted Agent access event reloads the open profile permissions',async()=>{
 let tree!:ReturnType<typeof create>
 const requests:string[]=[]
 let profileReads=0
 const delayedProfile=new Promise<void>(()=>{})
 vi.stubGlobal('fetch',vi.fn(async(input:string)=>{
  requests.push(input)
  const path=new URL(input).pathname
  if(path==='/hx/agents/a/profile'&&++profileReads===2)await delayedProfile
  return {ok:true,json:async()=>({agents:[{id:'a',name:'Shared agent',handle:'shared',scope:'team'}],profile:{tier:'standard',people:[],access:'private'},canEdit:false,memories:[],skills:[],followups:[],scopes:[]})}
 }))
 vi.stubGlobal('window',new EventTarget())
 try{
  await act(async()=>{tree=create(<HarnessAgents httpBase="https://example.test" orgId="one" sessionToken="first" onClose={vi.fn()}/>)})
  await act(async()=>tree.root.findByProps({'data-agent':'a'}).props.onClick())
  const profileReads=()=>requests.filter(raw=>new URL(raw).pathname==='/hx/agents/a/profile').length
  expect(profileReads()).toBe(1)
  await act(async()=>{window.dispatchEvent(new CustomEvent('honmaru:agent-access-changed',{detail:{agentId:'a',version:2}}))})
  expect(profileReads()).toBe(2)
  expect(JSON.stringify(tree.toJSON())).toContain('Loading…')
 }finally{act(()=>tree?.unmount());vi.unstubAllGlobals()}
})

test('late agent responses cannot populate a different workspace or session', async () => {
  const pending: Array<(value: unknown) => void> = []
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => pending.push(resolve))))
  let tree!: ReturnType<typeof create>
  const props = { httpBase: 'https://example.test', orgId: 'one', sessionToken: 'first', onClose: vi.fn() }
  const respond = (index: number, name: string) => pending[index]({ ok: true, json: async () => ({ agents: [{ id: name, name, handle: name }] }) })
  try {
    await act(async () => { tree = create(<HarnessAgents {...props} />) })
    await act(async () => { tree.update(<HarnessAgents {...props} orgId="two" />) })
    await act(async () => { respond(1, 'Current agent') })
    await act(async () => { respond(0, 'Previous agent') })
    expect(JSON.stringify(tree.toJSON())).toContain('Current agent')
    expect(JSON.stringify(tree.toJSON())).not.toContain('Previous agent')
    await act(async () => { tree.update(<HarnessAgents {...props} orgId="two" sessionToken="second" />) })
    expect(JSON.stringify(tree.toJSON())).not.toContain('Current agent')
    await act(async () => { respond(2, 'New session agent') })
    expect(JSON.stringify(tree.toJSON())).toContain('New session agent')
  } finally {
    act(() => tree?.unmount())
    vi.unstubAllGlobals()
  }
})

test('memory search requests saved entries and retries additional pages without losing results',async()=>{
 let tree!:ReturnType<typeof create>, failPage=true
 const entry=(id:string)=>({id,text:id,title:id,body:id,source:'person',createdAt:'2026-01-01T00:00:00Z',kind:'reference'})
 const requests:string[]=[]
 vi.stubGlobal('fetch',vi.fn(async(input:string)=>{
  const url=new URL(input);requests.push(input)
  if(url.pathname.endsWith('/memory')) {
   if(url.searchParams.get('cursor') && failPage) {failPage=false;return {ok:false,status:503,json:async()=>({message:'Temporary search failure'})}}
   return {ok:true,json:async()=>({memories:url.searchParams.get('cursor')?[entry('Older policy')]:url.searchParams.get('query')?[entry('Found policy')]:[],nextCursor:url.searchParams.get('query')&&!url.searchParams.get('cursor')?'next-page':null,canEdit:false})}
  }
  return {ok:true,json:async()=>({agents:[{id:'a',name:'Memory agent',handle:'memory',scope:'team'}],profile:{tier:'standard',people:[],access:'private'},canEdit:false,skills:[],scopes:[]})}
 }))
 try {
  await act(async()=>{tree=create(<HarnessAgents httpBase="https://example.test" orgId="one" sessionToken="session" onClose={vi.fn()}/>)})
  await act(async()=>tree.root.findByProps({'data-agent':'a'}).props.onClick())
  await act(async()=>tree.root.findAllByProps({role:'tab'}).find(t=>t.children.includes('Memory'))!.props.onClick())
  act(()=>tree.root.findByProps({'aria-label':'Search memories'}).props.onChange({target:{value:'policy'}}))
  act(()=>tree.root.findByProps({'aria-label':'Filter memory type'}).props.onChange({target:{value:'reference'}}))
  await act(async()=>tree.root.findByType('form').props.onSubmit({preventDefault:vi.fn()}))
  expect(requests.some(raw=>{const u=new URL(raw);return u.searchParams.get('query')==='policy'&&u.searchParams.get('kind')==='reference'&&u.searchParams.get('paged')==='1'})).toBe(true)
  const more=()=>tree.root.findAllByType('button').find(b=>b.children.includes('Load more'))!
  await act(async()=>{await more().props.onClick()})
  expect(JSON.stringify(tree.toJSON())).toContain('Found policy')
  expect(JSON.stringify(tree.toJSON())).toContain('Temporary search failure')
  await act(async()=>{await more().props.onClick()})
  expect(JSON.stringify(tree.toJSON())).toContain('Found policy')
  expect(JSON.stringify(tree.toJSON())).toContain('Older policy')
  expect(more()).toBeUndefined()
 }finally{act(()=>tree?.unmount());vi.unstubAllGlobals()}
})

vi.mock('../components/Dialog',()=>({Dialog:({children,onClose}:any)=><section role="dialog">{children}<button onClick={onClose}>Close dialog</button></section>}))
test('read-only members can open memory history with the selected conversation scope',async()=>{
 let tree!:ReturnType<typeof create>
 const requests:URL[]=[]
 vi.stubGlobal('fetch',vi.fn(async(input:string)=>{
  const url=new URL(input);requests.push(url)
  if(url.pathname.endsWith('/reviews')) return {ok:true,json:async()=>({reviews:[{id:'r',version:2,by:'owner',reviewerName:'Owner',at:'2026-10-24',verdict:'keep',evidence:'Verified procedure'}],nextCursor:null})}
  if(url.pathname.endsWith('/memory')) return {ok:true,json:async()=>({memories:url.searchParams.get('channel')?[{id:'m',text:'Scoped memory',channel:'b:private',version:2,source:'person',createdAt:'2026-10-24'}]:[],nextCursor:null})}
  return {ok:true,json:async()=>({agents:[{id:'a',name:'Memory agent',handle:'memory',scope:'team'}],profile:{tier:'standard',people:[],access:'private'},canEdit:false,skills:[],scopes:[{channel:'business:private',label:'Private room'}]})}
 }))
 try {
  await act(async()=>{tree=create(<HarnessAgents httpBase="https://example.test" orgId="one" sessionToken="session" onClose={vi.fn()}/>)})
  await act(async()=>tree.root.findByProps({'data-agent':'a'}).props.onClick())
  await act(async()=>tree.root.findAllByProps({role:'tab'}).find(t=>t.children.includes('Memory'))!.props.onClick())
  await act(async()=>tree.root.findByProps({'aria-label':'Memory conversation'}).props.onChange({target:{value:'business:private'}}))
  expect(tree.root.findAllByType('button').some(b=>b.children.includes('Review memory'))).toBe(false)
  await act(async()=>tree.root.findAllByType('button').find(b=>b.children.includes('Memory review history'))!.props.onClick())
  expect(requests.find(u=>u.pathname.endsWith('/memory/m/reviews'))?.searchParams.get('channel')).toBe('business:private')
  expect(JSON.stringify(tree.toJSON())).toContain('Verified procedure')
  act(()=>tree.root.findAllByType('button').find(b=>b.children.includes('Close dialog'))!.props.onClick())
  expect(tree.root.findAllByProps({role:'dialog'})).toHaveLength(0)
 }finally {act(()=>tree?.unmount());vi.unstubAllGlobals()}
})

test('late review-log responses cannot cross a changed conversation scope',async()=>{
 let tree!:ReturnType<typeof create>, resolveOld!:(value:any)=>void
 const queries:string[]=[]
 vi.stubGlobal('fetch',vi.fn(async(input:string)=>{
  const url=new URL(input)
  if(url.pathname.endsWith('/memory/reviews')) {
   queries.push(url.searchParams.get('channel')||'')
   if(!url.searchParams.get('channel')) return new Promise(resolve=>{resolveOld=resolve})
   return {ok:true,json:async()=>({reviews:[{id:'current',memoryId:'m',verdict:'delete',version:1,evidence:'Current conversation evidence',by:'owner',reviewerName:'Owner',at:'2026-10-24'}],nextCursor:null})}
  }
  return {ok:true,json:async()=>({agents:[{id:'a',name:'Memory agent',handle:'memory',scope:'team'}],profile:{tier:'standard',people:[],access:'private'},canEdit:false,memories:[],nextCursor:null,skills:[],scopes:[{channel:'b:ops',label:'Ops'}]})}
 }))
 try {
  await act(async()=>{tree=create(<HarnessAgents httpBase="https://example.test" orgId="one" sessionToken="session" onClose={vi.fn()}/>)})
  await act(async()=>tree.root.findByProps({'data-agent':'a'}).props.onClick())
  await act(async()=>tree.root.findAllByProps({role:'tab'}).find(t=>t.children.includes('Memory'))!.props.onClick())
  const click=(label:string)=>tree.root.findAllByType('button').find(b=>b.children.includes(label))!.props.onClick()
  await act(async()=>click('Review log'))
  act(()=>click('Close dialog'))
  await act(async()=>tree.root.findByProps({'aria-label':'Memory conversation'}).props.onChange({target:{value:'b:ops'}}))
  await act(async()=>click('Review log'))
  await act(async()=>resolveOld({ok:true,json:async()=>({reviews:[{id:'old',evidence:'Previous scope evidence'}],nextCursor:null})}))
  expect(queries).toEqual(['','b:ops'])
  expect(JSON.stringify(tree.toJSON())).toContain('Current conversation evidence')
  expect(JSON.stringify(tree.toJSON())).not.toContain('Previous scope evidence')
 } finally {act(()=>tree?.unmount());vi.unstubAllGlobals()}
})

test('the agent Connections tab toggles only the current member’s own app grant',async()=>{
 let tree!:ReturnType<typeof create>, granted=false
 const requests:Array<{url:URL;method:string;body:any}> = []
 vi.stubGlobal('fetch',vi.fn(async(input:string,init:any={})=>{
  const url=new URL(input), method=init.method||'GET', body=init.body?JSON.parse(init.body):null
  requests.push({url,method,body})
  if(url.pathname==='/channels/agents') return {ok:true,json:async()=>({agents:[{id:'a',name:'Research agent',handle:'research',scope:'team'}]})}
  if(url.pathname==='/hx/agents/a/profile') return {ok:true,json:async()=>({profile:{specialty:'',tier:'standard',mentionOnly:false,access:'everyone',people:[]},canEdit:false})}
  if(url.pathname==='/hx/agents/a/apps') {
   if(method==='POST') granted=true
   if(method==='DELETE') granted=false
   return {ok:true,json:async()=>({connections:[{server:'linear',name:'Linear',description:'Issues',iconUrl:null,verified:true,allowWrites:false,connectedAt:'2026-10-30T00:00:00Z',granted}]})}
  }
  if(url.pathname.endsWith('/memory/scopes')) return {ok:true,json:async()=>({scopes:[]})}
  if(url.pathname.endsWith('/memory')) return {ok:true,json:async()=>({memories:[],nextCursor:null,canEdit:false})}
  if(url.pathname.endsWith('/skills')) return {ok:true,json:async()=>({skills:[]})}
  return {ok:true,json:async()=>({})}
 }))
 try {
  await act(async()=>{tree=create(<HarnessAgents httpBase="https://example.test" orgId="one" sessionToken="session" onClose={vi.fn()}/>)})
  await act(async()=>tree.root.findByProps({'data-agent':'a'}).props.onClick())
  await act(async()=>tree.root.findAllByProps({role:'tab'}).find(tab=>tab.children.includes('Connections'))!.props.onClick())
  const checkbox=()=>tree.root.findByProps({'aria-label':'Allow {agent} to use {app}'})
  expect(checkbox().props.checked).toBe(false)
  await act(async()=>checkbox().props.onChange({currentTarget:{checked:true}}))
  expect(requests.some(r=>r.url.pathname==='/hx/agents/a/apps'&&r.method==='POST'&&r.body.server==='linear')).toBe(true)
  expect(checkbox().props.checked).toBe(true)
  await act(async()=>checkbox().props.onChange({currentTarget:{checked:false}}))
  expect(requests.some(r=>r.url.pathname==='/hx/agents/a/apps'&&r.method==='DELETE'&&r.url.searchParams.get('server')==='linear')).toBe(true)
  expect(checkbox().props.checked).toBe(false)
 } finally {act(()=>tree?.unmount());vi.unstubAllGlobals()}
})
