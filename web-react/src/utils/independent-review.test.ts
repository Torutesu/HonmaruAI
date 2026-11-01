import {afterEach,expect,test,vi} from 'vitest'
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules()})
function setup(handler:(input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>){
 const values=new Map([['sessionToken','tok'],['userId','alice'],['host','api.test'],['orgId','org-A']])
 const storage={getItem:(k:string)=>values.get(k)||null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)}
 const w=Object.assign(new EventTarget(),{fetch:handler,location:{href:'https://app.test/',protocol:'https:'}})
 vi.stubGlobal('window',w);vi.stubGlobal('localStorage',storage)
 return {values,w}
}
test('workspace switch does not allow a delayed old policy response to log out the current workspace',async()=>{
 let release!:(r:Response)=>void
 const e=setup(()=>new Promise<Response>(r=>{release=r}))
 const {installAuthGuard}=await import('./authGuard');installAuthGuard()
 const policy=vi.fn();e.w.addEventListener('honmaru:session-policy',policy)
 const pending=e.w.fetch('https://api.test/work?orgId=org-A',{headers:{'x-session-token':'tok'}})
 e.values.set('orgId','org-B')
 release(new Response(JSON.stringify({code:'session-policy',orgId:'org-A'}),{status:401}))
 await pending
 expect(policy).not.toHaveBeenCalled()
})
test.each([
 {status:401,code:'reauth-required',event:'honmaru:reauth'},
 {status:409,code:'dlp-warning',event:'honmaru:dlp-warning'},
 {status:403,code:'sso-required',event:'honmaru:sso-required'},
])('delayed $code response cannot prompt or redirect after workspace switch',async({status,code,event})=>{
 let release!:(r:Response)=>void
 const e=setup(()=>new Promise<Response>(r=>{release=r}))
 const {installAuthGuard}=await import('./authGuard');installAuthGuard()
 const seen=vi.fn();e.w.addEventListener(event,seen)
 const pending=e.w.fetch('https://api.test/work',{method:'POST',headers:{'x-session-token':'tok'},body:'{}'})
 e.values.set('orgId','org-B');e.w.dispatchEvent(new Event('honmaru:workspace-changed'))
 release(new Response(JSON.stringify({code,start:'/sso/start?orgId=org-A'}),{status}))
 expect((await pending).status).toBe(status)
 expect(seen).not.toHaveBeenCalled()
})
test.each([
 {status:401,code:'reauth-required',event:'honmaru:reauth'},
 {status:409,code:'dlp-warning',event:'honmaru:dlp-warning'},
])('workspace switch releases a pending $code confirmation even if switched back',async({status,code,event})=>{
 const original=vi.fn(async()=>new Response(JSON.stringify({code}),{status}))
 const e=setup(original)
 const {installAuthGuard,askingAboutData}=await import('./authGuard');installAuthGuard()
 let detail:any
 e.w.addEventListener(event,(ev)=>{ev.preventDefault();detail=(ev as CustomEvent).detail})
 const pending=e.w.fetch('https://api.test/work',{method:'POST',headers:{'x-session-token':'tok'},body:'{}'})
 await vi.waitFor(()=>expect(detail).toBeTruthy())
 e.values.set('orgId','org-B');e.w.dispatchEvent(new Event('honmaru:workspace-changed'))
 e.values.set('orgId','org-A');e.w.dispatchEvent(new Event('honmaru:workspace-changed'))
 detail.resolve(true)
 expect((await pending).status).toBe(status)
 expect(original).toHaveBeenCalledTimes(1)
 expect(askingAboutData()).toBe(false)
})
test('SSO verifier cannot be used after selecting a different workspace',async()=>{
 const e=setup(async()=>new Response('ok'))
 const {bindSsoStart,takeSsoVerifierForCurrentSession}=await import('./ssoBinding')
 await bindSsoStart(localStorage)
 e.values.set('orgId','org-B')
 expect(await takeSsoVerifierForCurrentSession(localStorage)).toBeNull()
})
test('request with a body can be replayed after reauthentication',async()=>{
 let count=0
 const e=setup(async(input)=>{
   if(input instanceof Request)await input.text()
   return ++count===1?new Response(JSON.stringify({code:'reauth-required'}),{status:401}):new Response('ok')
 })
 const {installAuthGuard}=await import('./authGuard');installAuthGuard()
 e.w.addEventListener('honmaru:reauth',(ev)=>{ev.preventDefault();(ev as CustomEvent).detail.resolve(true)})
 const req=new Request('https://api.test/work',{method:'POST',headers:{'x-session-token':'tok'},body:'{"x":1}'})
 expect((await e.w.fetch(req)).status).toBe(200)
})
