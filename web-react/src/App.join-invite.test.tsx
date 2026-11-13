import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'

vi.mock('./components/Dashboard',()=>({Dashboard:({orgId}:{orgId:string})=><div>dashboard:{orgId}</div>}))
vi.mock('./components/Dialog',()=>({Dialog:({title,children,footer}:{title:string;children:React.ReactNode;footer:React.ReactNode})=><section aria-label={title}>{children}{footer}</section>}))
vi.mock('./screens/Welcome',()=>({Welcome:()=> <div>welcome</div>}))
vi.mock('./utils/onboardingProgress',()=>({onboardingKey:()=>'',needsOnboarding:()=>false,completeOnboarding:()=>{}}))
vi.mock('./utils/githubAuth',()=>({githubWebConfig:async()=>null,beginGitHubSignIn:async()=>{},readCallback:()=>null,finishGitHubSignIn:async()=>({})}))
vi.mock('./utils/cardCache',()=>({clearCardCache:()=>{},accountOwner:()=>'',claimAccountData:()=>{},adoptAccountData:()=>{},releaseAccountData:()=>{}}))
vi.mock('./utils/emojiSearch',()=>({resetEmojiAccount:()=>{}}))
vi.mock('./utils/push',()=>({disableWebPush:async()=>{},sessionIsCurrent:()=>true}))
vi.mock('./utils/i18n',()=>{
 const t=(s:string,v?:Record<string,string>)=>s.replace(/\{(\w+)\}/g,(_,k)=>v?.[k]??`{${k}}`)
 return {t,useT:()=>t,adoptAccountLocale:()=>{}}
})

import App from './App'

afterEach(()=>vi.unstubAllGlobals())
function storage(){
 const values=new Map([['sessionToken','tok'],['userId','alice'],['orgId','org-home'],['host','api.test']])
 return {values,getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)}
}
function globals(store:ReturnType<typeof storage>,hash:string,fetcher:typeof fetch){
 const location={hash,protocol:'http:',pathname:'/',search:'',href:'http://app.test/'}
 const w=Object.assign(new EventTarget(),{location})
 vi.stubGlobal('window',w);vi.stubGlobal('location',location);vi.stubGlobal('localStorage',store)
 vi.stubGlobal('sessionStorage',storage())
 vi.stubGlobal('history',{replaceState:vi.fn()});vi.stubGlobal('navigator',{onLine:true})
 vi.stubGlobal('document',Object.assign(new EventTarget(),{visibilityState:'visible'}))
 vi.stubGlobal('fetch',fetcher)
 return {w,location}
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,20))
function relay(accept:{status:number;body:unknown}){
 return vi.fn(async (url:string)=>{
  const status=url.endsWith('/invites/accept')?accept.status:200
  const body=url.includes('/invites/peek')?{team:'Acme',inviter:'Mallory',role:'member'}
   :url.endsWith('/invites/accept')?accept.body
   :{login:'alice',orgs:[{id:'org-home'}]}
  return {ok:status>=200&&status<300,status,json:async()=>body}
 })
}
const accepts=(fetcher:ReturnType<typeof relay>)=>fetcher.mock.calls.filter(([url])=>url.endsWith('/invites/accept'))
const button=(tree:ReturnType<typeof create>,label:string)=>tree.root.findAllByType('button').find(b=>b.children.join('')===label)

// #960: a signed-in person opening someone's invite link was made a member
// of that workspace and moved into it, with no question asked.
test('an invite link opened while signed in asks before joining, and Cancel changes nothing',async()=>{
 const store=storage(),fetcher=relay({status:200,body:{orgId:'org-acme',joined:true,role:'member'}})
 globals(store,'#/join/0123456789abcdef0123',fetcher as unknown as typeof fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<App/>);await settle()})
 expect(accepts(fetcher)).toHaveLength(0)
 expect(JSON.stringify(tree.toJSON())).toContain('Join Acme?')
 expect(JSON.stringify(tree.toJSON())).toContain('"dashboard:","org-home"')
 await act(async()=>{button(tree,'Cancel')!.props.onClick();await settle()})
 expect(accepts(fetcher)).toHaveLength(0)
 expect(store.values.get('orgId')).toBe('org-home')
 expect(JSON.stringify(tree.toJSON())).not.toContain('Join Acme?')
 act(()=>tree.unmount())
})

// The desktop app sets this hash in a running window for honmaru://join/….
test('a join link arriving in an open window asks too, and joins only on Join',async()=>{
 const store=storage(),fetcher=relay({status:200,body:{orgId:'org-acme',joined:true,role:'member'}})
 const ui=globals(store,'#/feed',fetcher as unknown as typeof fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<App/>);await settle()})
 ui.location.hash='#/join/0123456789abcdef0123'
 await act(async()=>{ui.w.dispatchEvent(new Event('hashchange'));await settle()})
 expect(accepts(fetcher)).toHaveLength(0)
 await act(async()=>{button(tree,'Join')!.props.onClick();await settle()})
 expect(accepts(fetcher)).toHaveLength(1)
 expect(JSON.stringify(tree.toJSON())).toContain('You joined Acme.')
 expect(JSON.stringify(tree.toJSON())).toContain('"dashboard:","org-home"')
 await act(async()=>{button(tree,'Open Acme')!.props.onClick();await settle()})
 expect(JSON.stringify(tree.toJSON())).toContain('"dashboard:","org-acme"')
 act(()=>tree.unmount())
})

test('a held (202) join neither switches workspace nor says the team was joined',async()=>{
 const store=storage(),fetcher=relay({status:202,body:{orgId:'org-acme',pending:true,role:'member',message:'An admin of this workspace needs to approve you.'}})
 globals(store,'#/join/0123456789abcdef0123',fetcher as unknown as typeof fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<App/>);await settle()})
 await act(async()=>{button(tree,'Join')!.props.onClick();await settle()})
 const shown=JSON.stringify(tree.toJSON())
 expect(shown).toContain('An admin of Acme needs to approve you.')
 expect(shown).not.toContain('You joined')
 expect(shown).toContain('"dashboard:","org-home"')
 expect(store.values.get('orgId')).toBe('org-home')
 act(()=>tree.unmount())
})

// The guest-invitation route next to it redeemed on sight too.
const GUEST_TOKEN='ab'.repeat(32)
function guestRelay(){
 return vi.fn(async (url:string)=>{
  const body=url.endsWith('/external/invites/redeem')?{ok:true,resourceType:'app',orgId:'org-other',appId:'app-1'}:{login:'alice',orgs:[{id:'org-home'}]}
  return {ok:true,status:200,json:async()=>body}
 })
}
const redeems=(fetcher:ReturnType<typeof guestRelay>)=>fetcher.mock.calls.filter(([url])=>url.endsWith('/external/invites/redeem'))

test('a guest invitation opened while signed in asks first, and Cancel redeems nothing',async()=>{
 const store=storage(),fetcher=guestRelay()
 globals(store,`#/external-invite/${GUEST_TOKEN}`,fetcher as unknown as typeof fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<App/>);await settle()})
 expect(redeems(fetcher)).toHaveLength(0)
 expect(JSON.stringify(tree.toJSON())).toContain('Accept this invitation?')
 await act(async()=>{button(tree,'Cancel')!.props.onClick();await settle()})
 expect(redeems(fetcher)).toHaveLength(0)
 expect(JSON.stringify(tree.toJSON())).not.toContain('Accept this invitation?')
 act(()=>tree.unmount())
})

test('a guest invitation is redeemed when Accept is pressed',async()=>{
 const store=storage(),fetcher=guestRelay()
 const ui=globals(store,`#/external-invite/${GUEST_TOKEN}`,fetcher as unknown as typeof fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<App/>);await settle()})
 await act(async()=>{button(tree,'Accept')!.props.onClick();await settle()})
 expect(redeems(fetcher)).toHaveLength(1)
 expect(JSON.parse(String((redeems(fetcher)[0] as unknown as [string,RequestInit])[1].body))).toEqual({token:GUEST_TOKEN})
 expect(ui.location.hash).toBe('#/external-app/org-other/app-1')
 act(()=>tree.unmount())
})
