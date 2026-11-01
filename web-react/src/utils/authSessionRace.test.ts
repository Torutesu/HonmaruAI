import {afterEach,expect,test,vi} from 'vitest'

afterEach(()=>{vi.unstubAllGlobals();vi.resetModules()})

function environment(status:number,body:unknown) {
  const values=new Map([['sessionToken','old-token'],['userId','alice'],['host','api.test']])
  const storage={getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)}
  const fetcher=vi.fn(async()=>new Response(JSON.stringify(body),{status}))
  const windowMock=Object.assign(new EventTarget(),{fetch:fetcher,location:{href:'https://app.test/',protocol:'https:'}})
  vi.stubGlobal('window',windowMock)
  vi.stubGlobal('localStorage',storage)
  return {windowMock,fetcher,values,switchAccount:()=>{values.set('sessionToken','new-token');values.set('userId','bob')}}
}

test.each([
  {status:401,body:{code:'reauth-required'},event:'honmaru:reauth'},
  {status:409,body:{code:'dlp-warning',rules:['secret']},event:'honmaru:dlp-warning'},
])('a confirmation cannot retry an old request after account switch: $event',async ({status,body,event})=>{
  const e=environment(status,body)
  const {installAuthGuard}=await import('./authGuard')
  installAuthGuard()
  let detail: any
  window.addEventListener(event,(received)=>{received.preventDefault();detail=(received as CustomEvent).detail})
  const pending=window.fetch('https://api.test/save',{method:'POST',headers:{'x-session-token':'old-token'},body:JSON.stringify({body:'private'})})
  await vi.waitFor(()=>expect(detail).toBeTruthy())
  expect(Object.keys(detail)).not.toContain('token')
  e.switchAccount()
  detail.resolve(true)
  expect((await pending).status).toBe(status)
  expect(e.fetcher).toHaveBeenCalledTimes(1)
})

test.each([
  {status:401,body:{code:'reauth-required'},event:'honmaru:reauth'},
  {status:409,body:{code:'dlp-warning',rules:['secret']},event:'honmaru:dlp-warning'},
])('a storage change resolves an outstanding confirmation without user input: $event',async ({status,body,event})=>{
  const e=environment(status,body)
  const {installAuthGuard,askingAboutData}=await import('./authGuard')
  installAuthGuard()
  let seen=false
  window.addEventListener(event,received=>{received.preventDefault();seen=true})
  const pending=window.fetch('https://api.test/save',{method:'POST',headers:{'x-session-token':'old-token'},body:'{}'})
  await vi.waitFor(()=>expect(seen).toBe(true))
  e.switchAccount();window.dispatchEvent(new Event('storage'))
  expect((await pending).status).toBe(status)
  expect(e.fetcher).toHaveBeenCalledTimes(1)
  expect(askingAboutData()).toBe(false)
})

test('an old SSO response does not redirect the new account',async()=>{
  const e=environment(403,{})
  let release!: (value:Response)=>void
  const original=vi.fn((_input:RequestInfo|URL,_init?:RequestInit)=>new Promise<Response>(resolve=>{release=resolve}))
  const w=Object.assign(new EventTarget(),{fetch:original,location:{href:'https://app.test/',protocol:'https:'}})
  vi.stubGlobal('window',w)
  const {installAuthGuard}=await import('./authGuard');installAuthGuard()
  const events: unknown[]=[]
  w.addEventListener('honmaru:sso-required',event=>events.push((event as CustomEvent).detail))
  const pending=w.fetch('https://api.test/protected',{headers:{'x-session-token':'old-token'}})
  e.switchAccount()
  release(new Response(JSON.stringify({code:'sso-required',start:'/sso/start?orgId=team:x'}),{status:403}))
  expect((await pending).status).toBe(403)
  expect(events).toEqual([])
})

test('switching away and back cannot revive an old pending confirmation',async()=>{
  const e=environment(401,{})
  let release!: (value:Response)=>void
  const original=vi.fn((_input:RequestInfo|URL,_init?:RequestInit)=>new Promise<Response>(resolve=>{release=resolve}))
  const w=Object.assign(new EventTarget(),{fetch:original,location:{href:'https://app.test/',protocol:'https:'}})
  vi.stubGlobal('window',w)
  const {installAuthGuard}=await import('./authGuard');installAuthGuard()
  let prompts=0
  w.addEventListener('honmaru:reauth',()=>{prompts++})
  const pending=w.fetch('https://api.test/protected',{headers:{'x-session-token':'old-token'}})
  e.switchAccount()
  const changed=new Event('storage');Object.defineProperties(changed,{key:{value:'sessionToken'},newValue:{value:'new-token'}})
  w.dispatchEvent(changed)
  e.values.set('sessionToken','old-token');e.values.set('userId','alice')
  release(new Response(JSON.stringify({code:'reauth-required'}),{status:401}))
  expect((await pending).status).toBe(401)
  expect(prompts).toBe(0)
})
