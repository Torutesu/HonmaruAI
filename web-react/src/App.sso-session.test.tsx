import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {bindSsoStart} from './utils/ssoBinding'
import {askAboutData,askingAboutData} from './utils/authGuard'

vi.mock('./components/Dashboard',()=>({Dashboard:({userId}:{userId:string})=><div>dashboard:{userId}</div>}))
vi.mock('./components/Dialog',()=>({Dialog:({children,footer}:{children:React.ReactNode;footer:React.ReactNode})=><div>{children}{footer}</div>}))
vi.mock('./screens/Welcome',()=>({Welcome:()=> <div>welcome</div>}))
vi.mock('./utils/onboardingProgress',()=>({onboardingKey:()=>'',needsOnboarding:()=>false,completeOnboarding:()=>{}}))
vi.mock('./utils/githubAuth',()=>({githubWebConfig:async()=>null,beginGitHubSignIn:async()=>{},readCallback:()=>null,finishGitHubSignIn:async()=>({})}))
vi.mock('./utils/cardCache',()=>({clearCardCache:()=>{},accountOwner:()=>'',claimAccountData:()=>{},adoptAccountData:()=>{},releaseAccountData:()=>{}}))
vi.mock('./utils/emojiSearch',()=>({resetEmojiAccount:()=>{}}))
vi.mock('./utils/push',()=>({disableWebPush:async()=>{},sessionIsCurrent:()=>true}))
vi.mock('./utils/i18n',()=>({t:(s:string)=>s,useT:()=>((s:string)=>s),adoptAccountLocale:()=>{}}))

import App from './App'

afterEach(()=>vi.unstubAllGlobals())
function storage(){
 const values=new Map([['sessionToken','old'],['userId','alice'],['orgId','org'],['host','api.test']])
 return {values,getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)}
}
function globals(store:ReturnType<typeof storage>,hash:string,fetcher:typeof fetch){
 const location={hash,protocol:'http:',pathname:'/',search:'',href:'http://app.test/'}
 const w=Object.assign(new EventTarget(),{location})
 vi.stubGlobal('window',w);vi.stubGlobal('location',location);vi.stubGlobal('localStorage',store)
 vi.stubGlobal('history',{replaceState:vi.fn()});vi.stubGlobal('navigator',{onLine:true})
 vi.stubGlobal('document',Object.assign(new EventTarget(),{visibilityState:'visible'}))
 vi.stubGlobal('fetch',fetcher)
 return {w,location}
}

test('an SSO callback started by a different account does not exchange or replace the current account',async()=>{
 const store=storage()
 await bindSsoStart(store as unknown as Storage)
 store.values.set('sessionToken','new');store.values.set('userId','bob')
 const fetcher=vi.fn(async (url:string)=>({ok:true,status:200,json:async()=>url.endsWith('/me')?{login:'bob',orgs:[{id:'org'}]}:{}}))
 globals(store,'#/sso/done?code=old-code',fetcher as unknown as typeof fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<App/>);await new Promise(resolve=>setTimeout(resolve,20))})
 expect(fetcher.mock.calls.some(([url])=>url.endsWith('/sso/exchange'))).toBe(false)
 expect(store.values.get('sessionToken')).toBe('new')
 expect(store.values.get('userId')).toBe('bob')
 act(()=>tree.unmount())
})

test('an in-flight SSO exchange cannot replace a newer account',async()=>{
 const store=storage()
 await bindSsoStart(store as unknown as Storage)
 let finish!: (value:unknown)=>void,started!:()=>void
 const waiting=new Promise<void>(resolve=>{started=resolve})
 const fetcher=vi.fn(async (url:string,init?:RequestInit)=>{
   if(url.endsWith('/sso/exchange')){started();return new Promise(resolve=>{finish=resolve})}
   const token=(init?.headers as Record<string,string>)?.['x-session-token']
   return {ok:true,status:200,json:async()=>({login:token==='new'?'bob':'alice',orgs:[{id:'org'}]})}
 })
 const ui=globals(store,'#/sso/done?code=old-code',fetcher as unknown as typeof fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<App/>);await waiting})
 store.values.set('sessionToken','new');store.values.set('userId','bob')
 await act(async()=>{ui.w.dispatchEvent(new Event('storage'));await Promise.resolve();await Promise.resolve()})
 await act(async()=>{finish({ok:true,status:200,json:async()=>({token:'old-sso-result',login:'alice',orgId:'org'})});await Promise.resolve();await Promise.resolve();await Promise.resolve()})
 expect(store.values.get('sessionToken')).toBe('new')
 expect(store.values.get('userId')).toBe('bob')
 act(()=>tree.unmount())
})

test('a pending SSO start does not navigate after the account changes',async()=>{
 const store=storage()
 const fetcher=vi.fn(async ()=>({ok:true,status:200,json:async()=>({login:'alice',orgs:[{id:'org'}]})}))
 const ui=globals(store,'#/feed',fetcher as unknown as typeof fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<App/>);await Promise.resolve();await Promise.resolve();await Promise.resolve()})
 await act(async()=>{
   ui.w.dispatchEvent(new CustomEvent('honmaru:sso-required',{detail:{base:'http://api.test',start:'/sso/start?orgId=org'}}))
   store.values.set('sessionToken','new');store.values.set('userId','bob')
   await new Promise(resolve=>setTimeout(resolve,20))
 })
 expect(ui.location.href).toBe('http://app.test/')
 expect(store.values.has('sso.pending')).toBe(false)
 act(()=>tree.unmount())
})

test('a matching SSO callback still exchanges and signs in',async()=>{
 const store=storage()
 await bindSsoStart(store as unknown as Storage)
 const fetcher=vi.fn(async (url:string)=>({ok:true,status:200,json:async()=>url.endsWith('/sso/exchange')?{token:'sso-new',login:'alice',orgId:'org'}:{login:'alice',orgs:[{id:'org'}]}}))
 globals(store,'#/sso/done?code=valid-code',fetcher as unknown as typeof fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<App/>);await new Promise(resolve=>setTimeout(resolve,20))})
 expect(fetcher.mock.calls.some(([url])=>url.endsWith('/sso/exchange'))).toBe(true)
 expect(store.values.get('sessionToken')).toBe('sso-new')
 expect(store.values.get('userId')).toBe('alice')
 act(()=>tree.unmount())
})

test('a same-tab SSO session replacement refuses and releases an older DLP confirmation',async()=>{
 const store=storage()
 await bindSsoStart(store as unknown as Storage)
 let finish!: (value:unknown)=>void,started!:()=>void
 const waiting=new Promise<void>(resolve=>{started=resolve})
 const fetcher=vi.fn(async (url:string)=>{
   if(url.endsWith('/sso/exchange')){started();return new Promise(resolve=>{finish=resolve})}
   return {ok:true,status:200,json:async()=>({login:'alice',orgs:[{id:'org'}]})}
 })
 globals(store,'#/sso/done?code=valid-code',fetcher as unknown as typeof fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<App/>);await waiting;await Promise.resolve();await Promise.resolve()})
 let pending!:Promise<boolean>
 await act(async()=>{pending=askAboutData(['private'])})
 expect(askingAboutData()).toBe(true)
 await act(async()=>{finish({ok:true,status:200,json:async()=>({token:'sso-new',login:'alice',orgId:'org'})});await Promise.resolve();await Promise.resolve();await Promise.resolve()})
 expect(store.values.get('sessionToken')).toBe('sso-new')
 expect(await pending).toBe(false)
 expect(askingAboutData()).toBe(false)
 act(()=>tree.unmount())
})
